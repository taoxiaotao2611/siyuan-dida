import { localAllDayStart } from "./date";
import { createTranslator, type Translate } from "../i18n";
import { taskHash } from "./hash";
import { buildTaskSourceContent, isSiYuanBlockId, parseSourceBlockId } from "./sourceMarker";
import { parseTodoMarkdown } from "./todoParser";
import type {
  DidaGateway,
  DidaTaskSnapshot,
  SiYuanGateway,
  SyncEvent,
  SyncRange,
  SyncRangeResult,
  SyncResult,
  SyncSettings,
  SiYuanTodoBlock
} from "./types";

const TASK_ID_ATTR = "custom-dida-task-id";
const PROJECT_ID_ATTR = "custom-dida-project-id";
const LAST_SYNC_ATTR = "custom-dida-last-sync";
const LAST_HASH_ATTR = "custom-dida-last-hash";
const SYNC_STATE_ATTR = "custom-dida-sync-state";
const SYNC_STATE_SYNCED = "synced";
const SYNC_STATE_COMPLETED_SYNCED = "completed-synced";

interface TaskBinding {
  taskId: string;
  projectId: string;
}

interface RangeSyncContext {
  blocksById: Map<string, SiYuanTodoBlock>;
  knownBindings: Map<string, TaskBinding>;
}

interface RecoveryContext {
  tasksBySourceBlockId: Map<string, DidaTaskSnapshot[]>;
  indexedTasksByKey: Map<string, DidaTaskSnapshot>;
  creationAttemptedBlockIds: Set<string>;
  snapshotComplete: boolean;
}

function emptyResult(): SyncResult {
  const now = new Date().toISOString();
  return {
    created: 0,
    recovered: 0,
    updated: 0,
    completed: 0,
    writtenBack: 0,
    failed: 0,
    skipped: 0,
    scanned: 0,
    rangeResults: [],
    rangeCursorOffsets: {},
    events: [],
    failures: [],
    startedAt: now,
    finishedAt: now
  };
}

function addEvent(
  result: SyncResult,
  level: SyncEvent["level"],
  message: string,
  extra: Pick<SyncEvent, "blockId" | "rangeId"> = {}
) {
  result.events.push({
    time: new Date().toISOString(),
    level,
    message,
    ...extra
  });
}

function bindingFromAttrs(attrs: Record<string, string>): TaskBinding | null {
  const taskId = attrs[TASK_ID_ATTR];
  const projectId = attrs[PROJECT_ID_ATTR];
  if (!taskId || !projectId) {
    return null;
  }
  return { taskId, projectId };
}

function binding(block: SiYuanTodoBlock): TaskBinding | null {
  return bindingFromAttrs(block.attrs);
}

function attrsFor(taskId: string, projectId: string, hash: string, syncState = SYNC_STATE_SYNCED): Record<string, string> {
  return {
    [TASK_ID_ATTR]: taskId,
    [PROJECT_ID_ATTR]: projectId,
    [LAST_SYNC_ATTR]: new Date().toISOString(),
    [LAST_HASH_ATTR]: hash,
    [SYNC_STATE_ATTR]: syncState
  };
}

export class SyncEngine {
  constructor(
    private readonly siyuan: SiYuanGateway,
    private readonly dida: DidaGateway,
    private readonly t: Translate = createTranslator("zh-CN")
  ) {}

  async sync(settings: SyncSettings): Promise<SyncResult> {
    const result = emptyResult();
    const projectIds = [...new Set(settings.ranges.map((range) => range.targetProjectId).filter(Boolean))];
    addEvent(result, "info", this.t("syncStarted", { ranges: settings.ranges.length, max: settings.maxTasksPerRun }));
    const recoveryContext: RecoveryContext = {
      tasksBySourceBlockId: new Map(),
      indexedTasksByKey: new Map(),
      creationAttemptedBlockIds: new Set(),
      snapshotComplete: true
    };
    try {
      const incompleteTasks = await this.dida.listIncompleteTasks(projectIds);
      for (const task of incompleteTasks) {
        indexTaskBySourceBlockId(recoveryContext, task);
      }
      addEvent(result, "debug", this.t("incompleteTasksLoaded", { count: incompleteTasks.length }));
    } catch (error) {
      recoveryContext.snapshotComplete = false;
      const message = this.t("incompleteTasksLoadFailed", { message: (error as Error).message });
      result.failed += 1;
      result.failures.push({ message });
      addEvent(result, "warn", message);
    }
    let completedTaskKeys = new Set<string>();
    try {
      // Incremental snapshot: pull only tasks completed since the last
      // watermark instead of the full multi-year history. This drops the
      // per-run Dida request count from dozens (date-range bisection over
      // ~2000 completed tasks) to a single-window query, keeping a short
      // sync interval within the Dida API rate limits.
      //
      // Trade-off: recovering bindings for tasks completed long ago via
      // source markers only sees the recent window. Normal operation does not
      // rely on that path (bindings live on block attrs); a full baseline
      // (watermark cleared) covers history.
      const watermarkSecond = normalizeWatermark(settings.completedWatermarkSecond);
      const pullStartSecond = Math.floor(Date.now() / 1_000);
      const completedTasks = await this.dida.listCompletedTasks(projectIds, watermarkSecond);
      completedTaskKeys = new Set(completedTasks.map(remoteTaskKey));
      for (const task of completedTasks) {
        indexTaskBySourceBlockId(recoveryContext, task);
      }
      // Advance the watermark to when this pull started so tasks completed
      // mid-pull are re-included next run (idempotent; already-synced blocks
      // are skipped).
      result.completedWatermarkSecond = pullStartSecond;
      addEvent(result, "debug", this.t("completedTasksLoaded", { count: completedTasks.length }));
    } catch (error) {
      recoveryContext.snapshotComplete = false;
      result.failed += 1;
      result.failures.push({
        message: this.t("completedTasksLoadFailed", { message: (error as Error).message })
      });
      addEvent(result, "warn", this.t("completedTasksLoadFailed", { message: (error as Error).message }));
    }

    const recoveryBlockIds = new Set(
      [...recoveryContext.tasksBySourceBlockId.keys()].filter(isSiYuanBlockId)
    );
    for (const range of settings.ranges) {
      let cursorOffset = normalizeOffset(range.cursorOffset);
      const page = await this.listRangePage(
        range,
        settings.maxTasksPerRun,
        cursorOffset,
        recoveryBlockIds
      );
      let blocks = page.blocks;
      let rotatingCount = page.rotatingCount;
      let rotatingLimit = page.rotatingLimit;
      if (rotatingCount === 0 && cursorOffset > 0) {
        addEvent(result, "debug", this.t("rangeRestarted", { range: range.name }), { rangeId: range.id });
        cursorOffset = 0;
        blocks = await this.siyuan.listTodoBlocks(
          range,
          settings.maxTasksPerRun,
          cursorOffset,
          recoveryBlockIds
        );
        rotatingCount = blocks.length;
        rotatingLimit = settings.maxTasksPerRun;
      }
      const hasMore = rotatingCount >= rotatingLimit;
      const nextCursorOffset = hasMore ? cursorOffset + rotatingCount : 0;
      const rangeResult: SyncRangeResult = {
        rangeId: range.id,
        rangeName: range.name,
        notebookId: range.notebookId,
        hpathPrefix: range.hpathPrefix,
        scanned: blocks.length,
        created: 0,
        recovered: 0,
        updated: 0,
        completed: 0,
        writtenBack: 0,
        failed: 0,
        skipped: 0,
        cursorOffset,
        nextCursorOffset,
        hasMore
      };
      result.rangeCursorOffsets[range.id] = nextCursorOffset;
      result.scanned += blocks.length;
      result.rangeResults.push(rangeResult);
      addEvent(result, "info", this.t("rangeScanned", { range: range.name, count: blocks.length }), { rangeId: range.id });
      const orderedBlocks = orderBlocksForParentSync(blocks);
      const context: RangeSyncContext = {
        blocksById: new Map(blocks.map((block) => [block.id, block])),
        knownBindings: new Map(
          blocks
            .map((block) => [block.id, binding(block)] as const)
            .filter((item): item is readonly [string, TaskBinding] => item[1] !== null)
        )
      };
      for (const block of orderedBlocks) {
        await this.syncBlock(
          block,
          range.targetProjectId,
          completedTaskKeys,
          result,
          rangeResult,
          context,
          recoveryContext,
          settings.newTaskDate ?? "today",
          range.columnId ?? ""
        );
      }
      addEvent(
        result,
        "debug",
        hasMore ? this.t("rangeNextCursor", { range: range.name, cursor: nextCursorOffset + 1 }) : this.t("rangeComplete", { range: range.name }),
        { rangeId: range.id }
      );
    }

    result.finishedAt = new Date().toISOString();
    addEvent(
      result,
      result.failed > 0 ? "warn" : "info",
      this.t("syncFinished", {
        scanned: result.scanned,
        created: result.created,
        recovered: result.recovered ?? 0,
        updated: result.updated,
        completed: result.completed,
        writtenBack: result.writtenBack,
        failed: result.failed
      })
    );
    return result;
  }

  private async syncBlock(
    block: SiYuanTodoBlock,
    targetProjectId: string,
    completedTaskKeys: Set<string>,
    result: SyncResult,
    rangeResult: SyncRangeResult,
    context: RangeSyncContext,
    recoveryContext: RecoveryContext,
    newTaskDate: "today" | "none",
    columnId: string
  ) {
    try {
      const parsed = parseTodoMarkdown(block.markdown);
      if (!parsed) {
        result.skipped += 1;
        rangeResult.skipped += 1;
        addEvent(result, "debug", this.t("skippedNonTodo"), { blockId: block.id, rangeId: rangeResult.rangeId });
        return;
      }

      const currentHash = taskHash(parsed.title, parsed.checked);
      const existing = binding(block);

      if (!existing) {
        const allRecoveryMatches = recoveryContext.tasksBySourceBlockId.get(block.id) ?? [];
        const recoveryMatches = columnId
          ? allRecoveryMatches.filter((task) => (task.columnId ?? "") === columnId)
          : allRecoveryMatches;
        if (columnId && recoveryMatches.length === 0 && allRecoveryMatches.length > 0) {
          result.skipped += 1;
          rangeResult.skipped += 1;
          addEvent(result, "warn", this.t("rangeColumnMismatch", { title: parsed.title }), {
            blockId: block.id,
            rangeId: rangeResult.rangeId
          });
          return;
        }
        if (!recoveryContext.snapshotComplete && recoveryMatches.length > 0) {
          throw new Error(this.t("recoverySnapshotIncomplete", { title: parsed.title }));
        }
        if (recoveryMatches.length > 1) {
          throw new Error(this.t("ambiguousSourceMarker", { title: parsed.title }));
        }
        if (recoveryMatches.length === 0 && parsed.checked) {
          result.skipped += 1;
          rangeResult.skipped += 1;
          addEvent(result, "debug", this.t("skippedLegacyCompleted", { title: parsed.title }), {
            blockId: block.id,
            rangeId: rangeResult.rangeId
          });
          return;
        }
        const parent = await this.resolveParentBinding(block, context);
        if (parent.hasParent && !parent.binding) {
          result.skipped += 1;
          rangeResult.skipped += 1;
          addEvent(result, "debug", this.t("skippedUnboundChild", { title: parsed.title }), {
            blockId: block.id,
            rangeId: rangeResult.rangeId
          });
          return;
        }
        if (recoveryMatches.length === 1) {
          const recovered = recoveryMatches[0];
          if (parent.binding && parent.binding.projectId !== recovered.projectId) {
            throw new Error(this.t("parentProjectMismatch", {
              title: parsed.title,
              parentProjectId: parent.binding.projectId,
              childProjectId: recovered.projectId
            }));
          }
          if (recovered.title !== parsed.title) {
            await this.dida.updateTaskTitle(recovered.projectId, recovered.id, parsed.title);
            result.updated += 1;
            rangeResult.updated += 1;
            addEvent(result, "info", this.t("taskUpdated", { title: parsed.title }), {
              blockId: block.id,
              rangeId: rangeResult.rangeId
            });
          }
          if (parent.binding) {
            await this.dida.setTaskParent(recovered.projectId, recovered.id, parent.binding.taskId);
          }
          const recoveredIsCompleted = completedTaskKeys.has(remoteTaskKey(recovered));
          if (recoveredIsCompleted && !parsed.checked) {
            await this.siyuan.markBlockCompleted(block.id);
            await this.siyuan.setBlockAttrs(
              block.id,
              attrsFor(
                recovered.id,
                recovered.projectId,
                taskHash(parsed.title, true),
                SYNC_STATE_COMPLETED_SYNCED
              )
            );
            context.knownBindings.set(block.id, { taskId: recovered.id, projectId: recovered.projectId });
            result.recovered = (result.recovered ?? 0) + 1;
            rangeResult.recovered = (rangeResult.recovered ?? 0) + 1;
            result.writtenBack += 1;
            rangeResult.writtenBack += 1;
            addEvent(result, "info", this.t("taskBindingRecovered", { title: parsed.title }), {
              blockId: block.id,
              rangeId: rangeResult.rangeId
            });
            addEvent(result, "info", this.t("didaCompletionWrittenBack", { title: parsed.title }), {
              blockId: block.id,
              rangeId: rangeResult.rangeId
            });
            return;
          }
          if (parsed.checked) {
            if (!recoveredIsCompleted) {
              await this.dida.completeTask(recovered.projectId, recovered.id);
              result.completed += 1;
              rangeResult.completed += 1;
              addEvent(result, "info", this.t("siyuanCompletionSynced", { title: parsed.title }), {
                blockId: block.id,
                rangeId: rangeResult.rangeId
              });
            }
            await this.siyuan.setBlockAttrs(
              block.id,
              attrsFor(recovered.id, recovered.projectId, currentHash, SYNC_STATE_COMPLETED_SYNCED)
            );
            context.knownBindings.set(block.id, { taskId: recovered.id, projectId: recovered.projectId });
            result.recovered = (result.recovered ?? 0) + 1;
            rangeResult.recovered = (rangeResult.recovered ?? 0) + 1;
            addEvent(result, "info", this.t("taskBindingRecovered", { title: parsed.title }), {
              blockId: block.id,
              rangeId: rangeResult.rangeId
            });
            return;
          }
          await this.siyuan.setBlockAttrs(block.id, attrsFor(recovered.id, recovered.projectId, currentHash));
          context.knownBindings.set(block.id, { taskId: recovered.id, projectId: recovered.projectId });
          result.recovered = (result.recovered ?? 0) + 1;
          rangeResult.recovered = (rangeResult.recovered ?? 0) + 1;
          addEvent(result, "info", this.t("taskBindingRecovered", { title: parsed.title }), {
            blockId: block.id,
            rangeId: rangeResult.rangeId
          });
          return;
        }
        if (parent.binding && parent.binding.projectId !== targetProjectId) {
          throw new Error(this.t("parentProjectMismatch", {
            title: parsed.title,
            parentProjectId: parent.binding.projectId,
            childProjectId: targetProjectId
          }));
        }
        if (!recoveryContext.snapshotComplete) {
          throw new Error(this.t("taskCreationBlocked", { title: parsed.title }));
        }
        if (recoveryContext.creationAttemptedBlockIds.has(block.id)) {
          throw new Error(this.t("taskCreationOutcomeUnknown", { title: parsed.title }));
        }
        recoveryContext.creationAttemptedBlockIds.add(block.id);
        const sourceContent = buildTaskSourceContent(this.t("sourceContent"), block.id);
        const created = await this.dida.createTask(
          targetProjectId,
          parsed.title,
          newTaskDate === "today"
            ? { content: sourceContent, allDay: true, startDate: localAllDayStart() }
            : { content: sourceContent }
        );
        indexTaskBySourceBlockId(recoveryContext, {
          id: created.id,
          projectId: created.projectId,
          title: parsed.title,
          content: sourceContent,
          columnId: created.columnId
        });
        result.created += 1;
        rangeResult.created += 1;
        addEvent(result, "info", this.t("taskCreated", { title: parsed.title }), {
          blockId: block.id,
          rangeId: rangeResult.rangeId
        });
        if (columnId && created.columnId && created.columnId !== columnId) {
          addEvent(result, "warn", this.t("rangeColumnDefaultWarning", { title: parsed.title }), {
            blockId: block.id,
            rangeId: rangeResult.rangeId
          });
        }
        if (parent.binding) {
          await this.dida.setTaskParent(created.projectId, created.id, parent.binding.taskId);
        }
        await this.siyuan.setBlockAttrs(block.id, attrsFor(created.id, created.projectId, currentHash));
        context.knownBindings.set(block.id, { taskId: created.id, projectId: created.projectId });
        return;
      }

      if (
        !parsed.checked
        && completedTaskKeys.has(remoteTaskKey({ id: existing.taskId, projectId: existing.projectId }))
      ) {
        await this.siyuan.markBlockCompleted(block.id);
        await this.siyuan.setBlockAttrs(block.id, attrsFor(existing.taskId, existing.projectId, taskHash(parsed.title, true), SYNC_STATE_COMPLETED_SYNCED));
        result.writtenBack += 1;
        rangeResult.writtenBack += 1;
        addEvent(result, "info", this.t("didaCompletionWrittenBack", { title: parsed.title }), { blockId: block.id, rangeId: rangeResult.rangeId });
        return;
      }

      if (block.attrs[LAST_HASH_ATTR] === currentHash) {
        if (parsed.checked && block.attrs[SYNC_STATE_ATTR] !== SYNC_STATE_COMPLETED_SYNCED) {
          await this.siyuan.setBlockAttrs(block.id, attrsFor(existing.taskId, existing.projectId, currentHash, SYNC_STATE_COMPLETED_SYNCED));
          addEvent(result, "debug", this.t("completedTaskArchived", { title: parsed.title }), {
            blockId: block.id,
            rangeId: rangeResult.rangeId
          });
        }
        result.skipped += 1;
        rangeResult.skipped += 1;
        addEvent(result, "debug", this.t("skippedUnchanged", { title: parsed.title }), {
          blockId: block.id,
          rangeId: rangeResult.rangeId
        });
        return;
      }

      if (parsed.checked) {
        await this.dida.completeTask(existing.projectId, existing.taskId);
        await this.siyuan.setBlockAttrs(block.id, attrsFor(existing.taskId, existing.projectId, currentHash, SYNC_STATE_COMPLETED_SYNCED));
        result.completed += 1;
        rangeResult.completed += 1;
        addEvent(result, "info", this.t("siyuanCompletionSynced", { title: parsed.title }), { blockId: block.id, rangeId: rangeResult.rangeId });
        return;
      }

      if (block.attrs[LAST_HASH_ATTR] !== currentHash) {
        await this.dida.updateTaskTitle(existing.projectId, existing.taskId, parsed.title);
        await this.siyuan.setBlockAttrs(block.id, attrsFor(existing.taskId, existing.projectId, currentHash));
        result.updated += 1;
        rangeResult.updated += 1;
        addEvent(result, "info", this.t("taskUpdated", { title: parsed.title }), { blockId: block.id, rangeId: rangeResult.rangeId });
      }
    } catch (error) {
      result.failed += 1;
      rangeResult.failed += 1;
      result.failures.push({ blockId: block.id, message: (error as Error).message });
      addEvent(result, "error", (error as Error).message, { blockId: block.id, rangeId: rangeResult.rangeId });
    }
  }

  private async listRangePage(
    range: SyncRange,
    limit: number,
    cursorOffset: number,
    recoveryBlockIds: ReadonlySet<string>
  ) {
    if (cursorOffset <= 0 || limit < 20) {
      const blocks = await this.siyuan.listTodoBlocks(range, limit, cursorOffset, recoveryBlockIds);
      return { blocks, rotatingCount: blocks.length, rotatingLimit: limit };
    }

    const priorityLimit = Math.max(1, Math.floor(limit / 4));
    const rotatingLimit = limit - priorityLimit;
    const priorityBlocks = await this.siyuan.listTodoBlocks(range, priorityLimit, 0, recoveryBlockIds);
    const rotatingBlocks = await this.siyuan.listTodoBlocks(
      range,
      rotatingLimit,
      cursorOffset,
      recoveryBlockIds
    );
    return {
      blocks: uniqueBlocks([...priorityBlocks, ...rotatingBlocks]),
      rotatingCount: rotatingBlocks.length,
      rotatingLimit
    };
  }

  private async resolveParentBinding(block: SiYuanTodoBlock, context: RangeSyncContext): Promise<{ hasParent: boolean; binding?: TaskBinding }> {
    if (!block.parentId) {
      return { hasParent: false };
    }

    const known = context.knownBindings.get(block.parentId);
    if (known) {
      return { hasParent: true, binding: known };
    }

    const parentBlock = context.blocksById.get(block.parentId);
    if (parentBlock) {
      const parentBinding = binding(parentBlock);
      if (parentBinding) {
        context.knownBindings.set(block.parentId, parentBinding);
        return { hasParent: true, binding: parentBinding };
      }
      return { hasParent: true };
    }

    try {
      const parentAttrs = await this.siyuan.getBlockAttrs(block.parentId);
      const parentBinding = bindingFromAttrs(parentAttrs);
      if (parentBinding) {
        context.knownBindings.set(block.parentId, parentBinding);
        return { hasParent: true, binding: parentBinding };
      }
    } catch {
      // Keep the child unsynced rather than creating it as a top-level task.
    }

    return { hasParent: true };
  }
}

function indexTaskBySourceBlockId(
  recoveryContext: RecoveryContext,
  task: DidaTaskSnapshot
): void {
  const taskKey = remoteTaskKey(task);
  const existing = recoveryContext.indexedTasksByKey.get(taskKey);
  if (existing) {
    const existingSourceBlockId = parseSourceBlockId(existing.content ?? "");
    const merged = {
      ...existing,
      title: task.title ?? existing.title,
      content: task.content ?? existing.content
    };
    const mergedSourceBlockId = parseSourceBlockId(merged.content ?? "");
    recoveryContext.indexedTasksByKey.set(taskKey, merged);
    if (existingSourceBlockId && existingSourceBlockId !== mergedSourceBlockId) {
      removeIndexedTask(recoveryContext.tasksBySourceBlockId, existingSourceBlockId, taskKey);
    }
    if (mergedSourceBlockId) {
      replaceOrAddIndexedTask(
        recoveryContext.tasksBySourceBlockId,
        mergedSourceBlockId,
        taskKey,
        merged
      );
    }
    return;
  }
  recoveryContext.indexedTasksByKey.set(taskKey, task);
  const sourceBlockId = parseSourceBlockId(task.content ?? "");
  if (!sourceBlockId) {
    return;
  }
  const tasks = recoveryContext.tasksBySourceBlockId.get(sourceBlockId);
  if (tasks) {
    tasks.push(task);
    return;
  }
  recoveryContext.tasksBySourceBlockId.set(sourceBlockId, [task]);
}

function replaceOrAddIndexedTask(
  tasksBySourceBlockId: Map<string, DidaTaskSnapshot[]>,
  sourceBlockId: string,
  taskKey: string,
  task: DidaTaskSnapshot
): void {
  const tasks = tasksBySourceBlockId.get(sourceBlockId) ?? [];
  const index = tasks.findIndex((candidate) => remoteTaskKey(candidate) === taskKey);
  if (index >= 0) {
    tasks[index] = task;
  } else {
    tasks.push(task);
  }
  tasksBySourceBlockId.set(sourceBlockId, tasks);
}

function removeIndexedTask(
  tasksBySourceBlockId: Map<string, DidaTaskSnapshot[]>,
  sourceBlockId: string,
  taskKey: string
): void {
  const remaining = (tasksBySourceBlockId.get(sourceBlockId) ?? [])
    .filter((candidate) => remoteTaskKey(candidate) !== taskKey);
  if (remaining.length > 0) {
    tasksBySourceBlockId.set(sourceBlockId, remaining);
  } else {
    tasksBySourceBlockId.delete(sourceBlockId);
  }
}

function remoteTaskKey(task: Pick<DidaTaskSnapshot, "projectId" | "id">): string {
  return `${task.projectId}\u0000${task.id}`;
}

function normalizeOffset(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeWatermark(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function uniqueBlocks(blocks: SiYuanTodoBlock[]): SiYuanTodoBlock[] {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    if (seen.has(block.id)) {
      return false;
    }
    seen.add(block.id);
    return true;
  });
}

function orderBlocksForParentSync(blocks: SiYuanTodoBlock[]): SiYuanTodoBlock[] {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const emitted = new Set<string>();
  const ordered: SiYuanTodoBlock[] = [];

  const emit = (block: SiYuanTodoBlock) => {
    if (emitted.has(block.id)) {
      return;
    }
    if (block.parentId) {
      const parent = byId.get(block.parentId);
      if (parent) {
        emit(parent);
      }
    }
    emitted.add(block.id);
    ordered.push(block);
  };

  for (const block of blocks) {
    emit(block);
  }

  return ordered;
}
