import type { Translate } from "../i18n";
import {
  isArchivedMarkdown,
  markDocTaskArchived,
  renderDocTask
} from "./docFormat";
import type {
  DidaListGateway,
  DidaProjectTask,
  DocSyncConfig,
  DocSyncSummary,
  SiYuanDocBlock,
  SiYuanDocChild,
  SiYuanDocGateway,
  SyncEvent
} from "./types";

export const DOC_TASK_ID_ATTR = "custom-dida-doc-task-id";
export const DOC_PROJECT_ID_ATTR = "custom-dida-doc-project-id";

export interface DocSyncDependencies {
  dida: DidaListGateway;
  siyuan: SiYuanDocGateway;
  t: Translate;
  /** Optional wait hook; overridden in tests to avoid real delays. */
  wait?: (milliseconds: number) => Promise<void>;
}

export interface DocSyncOutcome {
  summary: DocSyncSummary;
  events: SyncEvent[];
  failures: Array<{ message: string }>;
}

interface DesiredBlock {
  taskId: string;
  markdown: string;
  /** Sort key: task start (or due) time in milliseconds; undefined = no date. */
  time?: number;
}

interface SectionHeadings {
  active: string;
  archived: string;
}

/**
 * One-way mirror: one Dida list (or one kanban column) -> one SiYuan document.
 *
 * Every selected Dida task maps to exactly one SiYuan block. Blocks carry a
 * hidden task-id attribute, which keeps the mirror idempotent: unchanged runs
 * write nothing, changed tasks update in place, new tasks are inserted, and
 * duplicate managed blocks are removed.
 *
 * When active/archived heading names are configured, active blocks live under
 * the active heading and completed/deleted blocks move under the archived
 * heading; blocks are inserted with the heading as the previous block, so
 * SiYuan keeps them inside that section. Without headings the mirror keeps the
 * legacy behavior of appending at the end of the document.
 */
export class DocSyncEngine {
  constructor(private readonly deps: DocSyncDependencies) {}

  async sync(config: DocSyncConfig): Promise<DocSyncOutcome> {
    const summary = emptySummary(config);
    const events: SyncEvent[] = [];
    const failures: Array<{ message: string }> = [];
    if (!config.enabled) {
      return { summary, events, failures };
    }
    if (!config.projectId || !config.notebookId || !config.hpath) {
      failures.push({ message: this.deps.t("docSyncConfigIncomplete") });
      summary.failed += 1;
      return { summary, events, failures };
    }

    try {
      const data = await this.deps.dida.getProjectData(config.projectId);
      summary.projectName = config.projectName || data.project.name;
      const tasks = selectDocSyncTasks(data.tasks, config.columnId);
      summary.tasks = tasks.length;
      const ordered: DesiredBlock[] = tasks.map((task) => ({
        taskId: task.id,
        markdown: renderDocTask(task) || this.deps.t("docSyncUntitledTask"),
        time: taskTime(task)
      }));
      if (config.sortByTime) {
        sortByTaskTime(ordered);
      }
      const current = new Map(ordered.map((item) => [item.taskId, item.markdown]));

      let docId = await this.deps.siyuan.findDocId(config.notebookId, config.hpath);
      let documentCreated = false;
      if (!docId) {
        docId = await this.deps.siyuan.createDoc(config.notebookId, config.hpath);
        documentCreated = true;
        events.push(event("info", this.deps.t("docSyncDocCreated", { path: config.hpath })));
      }

      let existing = await this.deps.siyuan.listManagedBlocks(docId, DOC_TASK_ID_ATTR);
      if (existing.length === 0 && current.size > 0 && !documentCreated) {
        // SiYuan indexes block attributes asynchronously. An unindexed doc can
        // briefly look empty right after it was written; retry once before
        // appending, otherwise a fast second sync could duplicate every block.
        await this.wait(800);
        existing = await this.deps.siyuan.listManagedBlocks(docId, DOC_TASK_ID_ATTR);
      }
      existing = await this.removeDuplicateBlocks(existing, summary, failures);

      const headings = resolveHeadings(config);
      if (headings) {
        await this.syncSectioned(
          docId,
          config,
          headings,
          ordered,
          current,
          existing,
          summary,
          failures
        );
      } else {
        await this.syncFlat(docId, config, ordered, current, existing, summary, failures);
      }

      if (documentCreated && current.size > 0) {
        await this.deps.siyuan.removeEmptyChildBlocks(docId);
      }
    } catch (error) {
      failures.push({ message: this.deps.t("docSyncFailed", { message: errorMessage(error) }) });
      summary.failed += 1;
    }

    return { summary, events, failures };
  }

  /** Legacy layout: managed blocks live at document level, appended in order. */
  private async syncFlat(
    docId: string,
    config: DocSyncConfig,
    ordered: DesiredBlock[],
    current: Map<string, string>,
    existing: SiYuanDocBlock[],
    summary: DocSyncSummary,
    failures: Array<{ message: string }>
  ): Promise<void> {
    const tombstones = existing.filter((block) => !current.has(block.taskId));
    if (config.sortByTime && !isOrderPreserved(existing, ordered, tombstones)) {
      await this.rebuildFlat(docId, config, ordered, tombstones, existing, summary, failures);
      return;
    }
    await this.updateExistingBlocks(config, existing, current, summary, failures);
    const known = new Set(existing.map((block) => block.taskId));
    for (const item of ordered) {
      if (known.has(item.taskId)) {
        continue;
      }
      await this.appendManagedBlock(docId, item, config, summary, failures, true);
    }
  }

  /**
   * Sectioned layout: active blocks under the active heading, archived blocks
   * under the archived heading.
   */
  private async syncSectioned(
    docId: string,
    config: DocSyncConfig,
    headings: SectionHeadings,
    ordered: DesiredBlock[],
    current: Map<string, string>,
    existing: SiYuanDocBlock[],
    summary: DocSyncSummary,
    failures: Array<{ message: string }>
  ): Promise<void> {
    const docBlocks = await this.deps.siyuan.listChildBlocks(docId);
    const activeHeadingId = findHeadingId(docBlocks, headings.active)
      ?? await this.appendHeading(docId, headings.active);
    const archivedHeadingId = findHeadingId(docBlocks, headings.archived)
      ?? await this.appendHeading(docId, headings.archived);

    const activeChildren = await this.deps.siyuan.listChildBlocks(activeHeadingId);
    const archivedChildren = await this.deps.siyuan.listChildBlocks(archivedHeadingId);
    const managedById = new Map(existing.map((block) => [block.id, block]));
    const activeManaged = pickManaged(activeChildren, managedById);
    const archivedManaged = pickManaged(archivedChildren, managedById);
    const sectionBlockIds = new Set([...activeManaged, ...archivedManaged].map((block) => block.id));
    const misplaced = existing.filter((block) => !sectionBlockIds.has(block.id));

    const tombstoneBlocks = [
      ...archivedManaged,
      ...activeManaged,
      ...misplaced
    ].filter((block) => !current.has(block.taskId));
    const desiredActiveIds = ordered.map((item) => item.taskId);
    const desiredArchivedIds = tombstoneBlocks.map((block) => block.taskId);
    const layoutOk = misplaced.length === 0
      && isPrefixIds(activeManaged.map((block) => block.taskId), desiredActiveIds)
      && isPrefixIds(archivedManaged.map((block) => block.taskId), desiredArchivedIds);

    if (!layoutOk) {
      await this.rebuildSectioned(
        config,
        ordered,
        tombstoneBlocks,
        existing,
        activeHeadingId,
        archivedHeadingId,
        summary,
        failures
      );
      return;
    }

    await this.updateExistingBlocks(config, existing, current, summary, failures);

    let activePrevious = lastChildId(activeChildren, activeHeadingId);
    for (const item of ordered.slice(activeManaged.length)) {
      const blockId = await this.insertManagedBlock(
        activePrevious,
        item,
        config,
        summary,
        failures,
        true
      );
      if (blockId) {
        activePrevious = blockId;
      }
    }

    let archivedPrevious = lastChildId(archivedChildren, archivedHeadingId);
    for (const block of tombstoneBlocks.slice(archivedManaged.length)) {
      const markdown = await this.resolveArchivedMarkdown(
        config.projectId,
        block,
        summary,
        failures
      );
      const blockId = await this.insertManagedBlock(
        archivedPrevious,
        { taskId: block.taskId, markdown },
        config,
        summary,
        failures,
        false
      );
      if (blockId) {
        archivedPrevious = blockId;
      }
    }
  }

  private async rebuildSectioned(
    config: DocSyncConfig,
    ordered: DesiredBlock[],
    tombstoneBlocks: SiYuanDocBlock[],
    existing: SiYuanDocBlock[],
    activeHeadingId: string,
    archivedHeadingId: string,
    summary: DocSyncSummary,
    failures: Array<{ message: string }>
  ): Promise<void> {
    const existingIds = new Set(existing.map((block) => block.taskId));
    for (const block of existing) {
      try {
        await this.deps.siyuan.deleteBlock(block.id);
        summary.reordered += 1;
      } catch (error) {
        this.fail(failures, summary, error);
      }
    }

    let activePrevious = activeHeadingId;
    for (const item of ordered) {
      const blockId = await this.insertManagedBlock(
        activePrevious,
        item,
        config,
        summary,
        failures,
        !existingIds.has(item.taskId)
      );
      if (blockId) {
        activePrevious = blockId;
      }
    }

    let archivedPrevious = archivedHeadingId;
    for (const block of tombstoneBlocks) {
      const markdown = await this.resolveArchivedMarkdown(
        config.projectId,
        block,
        summary,
        failures
      );
      const blockId = await this.insertManagedBlock(
        archivedPrevious,
        { taskId: block.taskId, markdown },
        config,
        summary,
        failures,
        false
      );
      if (blockId) {
        archivedPrevious = blockId;
      }
    }
  }

  private async rebuildFlat(
    docId: string,
    config: DocSyncConfig,
    ordered: DesiredBlock[],
    tombstones: SiYuanDocBlock[],
    existing: SiYuanDocBlock[],
    summary: DocSyncSummary,
    failures: Array<{ message: string }>
  ): Promise<void> {
    const existingIds = new Set(existing.map((block) => block.taskId));
    for (const block of existing) {
      try {
        await this.deps.siyuan.deleteBlock(block.id);
        summary.reordered += 1;
      } catch (error) {
        this.fail(failures, summary, error);
      }
    }
    for (const item of ordered) {
      await this.appendManagedBlock(
        docId,
        item,
        config,
        summary,
        failures,
        !existingIds.has(item.taskId)
      );
    }
    for (const block of tombstones) {
      const markdown = await this.resolveArchivedMarkdown(
        config.projectId,
        block,
        summary,
        failures
      );
      await this.appendManagedBlock(
        docId,
        { taskId: block.taskId, markdown },
        config,
        summary,
        failures,
        false
      );
    }
  }

  private async appendHeading(docId: string, name: string): Promise<string> {
    return this.deps.siyuan.appendBlock(docId, `## ${name}`);
  }

  /**
   * Self-healing guard: older releases could append the same task several
   * times when a block was re-parented or lost its attributes. Keep the first
   * managed block per task and remove the rest.
   */
  private async removeDuplicateBlocks(
    existing: SiYuanDocBlock[],
    summary: DocSyncSummary,
    failures: Array<{ message: string }>
  ): Promise<SiYuanDocBlock[]> {
    const seen = new Set<string>();
    const unique: SiYuanDocBlock[] = [];
    for (const block of existing) {
      if (!seen.has(block.taskId)) {
        seen.add(block.taskId);
        unique.push(block);
        continue;
      }
      try {
        await this.deps.siyuan.deleteBlock(block.id);
        summary.deduplicated += 1;
      } catch (error) {
        this.fail(failures, summary, error);
      }
    }
    return unique;
  }

  private async updateExistingBlocks(
    config: DocSyncConfig,
    existing: SiYuanDocBlock[],
    current: Map<string, string>,
    summary: DocSyncSummary,
    failures: Array<{ message: string }>
  ): Promise<void> {
    for (const block of existing) {
      const rendered = current.get(block.taskId);
      try {
        if (rendered !== undefined) {
          if (rendered !== block.markdown) {
            await this.writeManagedBlock(block.id, rendered, block.taskId, config);
            summary.updated += 1;
          }
          continue;
        }
        const markdown = await this.resolveArchivedMarkdown(
          config.projectId,
          block,
          summary,
          failures
        );
        if (markdown !== block.markdown) {
          await this.writeManagedBlock(block.id, markdown, block.taskId, config);
        }
      } catch (error) {
        this.fail(failures, summary, error);
      }
    }
  }

  /** Marks a vanished task as completed/deleted once and returns the markdown. */
  private async resolveArchivedMarkdown(
    projectId: string,
    block: SiYuanDocBlock,
    summary: DocSyncSummary,
    failures: Array<{ message: string }>
  ): Promise<string> {
    if (isArchivedMarkdown(block.markdown)) {
      return block.markdown;
    }
    try {
      const kind = await this.classifyArchived(projectId, block.taskId);
      if (!kind) {
        return block.markdown;
      }
      summary.archived += 1;
      return markDocTaskArchived(block.markdown, kind);
    } catch (error) {
      this.fail(failures, summary, error);
      return block.markdown;
    }
  }

  /**
   * SiYuan's updateBlock replaces the block content and drops custom block
   * attributes, so re-apply the hidden task marker after every content update.
   */
  private async writeManagedBlock(
    blockId: string,
    markdown: string,
    taskId: string,
    config: DocSyncConfig
  ): Promise<void> {
    await this.deps.siyuan.updateBlock(blockId, markdown);
    await this.deps.siyuan.setBlockAttrs(blockId, {
      [DOC_TASK_ID_ATTR]: taskId,
      [DOC_PROJECT_ID_ATTR]: config.projectId
    });
  }

  /** Distinguishes a completed task (still queryable) from a deleted one (404). */
  private async classifyArchived(
    projectId: string,
    taskId: string
  ): Promise<"completed" | "deleted" | undefined> {
    try {
      const task = await this.deps.dida.getTask(projectId, taskId);
      return task ? "completed" : "deleted";
    } catch {
      return undefined;
    }
  }

  private async appendManagedBlock(
    docId: string,
    item: { taskId: string; markdown: string },
    config: DocSyncConfig,
    summary: DocSyncSummary,
    failures: Array<{ message: string }>,
    countAsCreated: boolean
  ): Promise<string | undefined> {
    try {
      const blockId = await this.deps.siyuan.appendBlock(docId, item.markdown);
      await this.deps.siyuan.setBlockAttrs(blockId, {
        [DOC_TASK_ID_ATTR]: item.taskId,
        [DOC_PROJECT_ID_ATTR]: config.projectId
      });
      if (countAsCreated) {
        summary.created += 1;
      }
      return blockId;
    } catch (error) {
      this.fail(failures, summary, error);
      return undefined;
    }
  }

  private async insertManagedBlock(
    previousId: string,
    item: { taskId: string; markdown: string },
    config: DocSyncConfig,
    summary: DocSyncSummary,
    failures: Array<{ message: string }>,
    countAsCreated: boolean
  ): Promise<string | undefined> {
    try {
      const blockId = await this.deps.siyuan.insertBlockAfter(previousId, item.markdown);
      await this.deps.siyuan.setBlockAttrs(blockId, {
        [DOC_TASK_ID_ATTR]: item.taskId,
        [DOC_PROJECT_ID_ATTR]: config.projectId
      });
      if (countAsCreated) {
        summary.created += 1;
      }
      return blockId;
    } catch (error) {
      this.fail(failures, summary, error);
      return undefined;
    }
  }

  private wait(milliseconds: number): Promise<void> {
    return this.deps.wait
      ? this.deps.wait(milliseconds)
      : new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private fail(
    failures: Array<{ message: string }>,
    summary: DocSyncSummary,
    error: unknown
  ): void {
    failures.push({
      message: this.deps.t("docSyncBlockFailed", { message: errorMessage(error) })
    });
    summary.failed += 1;
  }
}

/** Keep only open tasks in the configured column, preserving Dida list order. */
export function selectDocSyncTasks(tasks: DidaProjectTask[], columnId: string): DidaProjectTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    if (!task || typeof task.id !== "string" || task.id.length === 0 || seen.has(task.id)) {
      return false;
    }
    const status = typeof task.status === "number" ? task.status : 0;
    if (status !== 0) {
      return false;
    }
    if (columnId && task.columnId !== columnId) {
      return false;
    }
    seen.add(task.id);
    return true;
  });
}

/** Task start (or due) time as epoch ms; undefined when the task has no date. */
export function taskTime(task: Pick<DidaProjectTask, "startDate" | "dueDate">): number | undefined {
  const raw = [task.startDate, task.dueDate].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  if (!raw) {
    return undefined;
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** Stable ascending sort; undated tasks move to the end. */
function sortByTaskTime(blocks: DesiredBlock[]): void {
  blocks.sort((left, right) => {
    if (left.time === undefined && right.time === undefined) return 0;
    if (left.time === undefined) return 1;
    if (right.time === undefined) return -1;
    return left.time - right.time;
  });
}

function resolveHeadings(config: DocSyncConfig): SectionHeadings | undefined {
  const active = (config.activeHeading ?? "").trim();
  const archived = (config.archivedHeading ?? "").trim();
  if (!active || !archived) {
    return undefined;
  }
  return { active, archived };
}

function findHeadingId(blocks: SiYuanDocChild[], name: string): string | undefined {
  const match = blocks.find(
    (block) => block.type === "h" && headingText(block.markdown ?? "") === name
  );
  return match?.id;
}

function headingText(markdown: string): string {
  return markdown.replace(/^#+\s*/, "").trim();
}

function lastChildId(children: SiYuanDocChild[], fallback: string): string {
  return children.length > 0 ? children[children.length - 1].id : fallback;
}

function pickManaged(
  children: SiYuanDocChild[],
  managedById: Map<string, SiYuanDocBlock>
): SiYuanDocBlock[] {
  return children.flatMap((child) => {
    const block = managedById.get(child.id);
    return block ? [block] : [];
  });
}

function isPrefixIds(existingIds: string[], desiredIds: string[]): boolean {
  if (existingIds.length > desiredIds.length) {
    return false;
  }
  return existingIds.every((id, index) => id === desiredIds[index]);
}

/** True when the flat document order already matches desired + tombstones. */
function isOrderPreserved(
  existing: SiYuanDocBlock[],
  ordered: DesiredBlock[],
  tombstones: SiYuanDocBlock[]
): boolean {
  const expected = [...ordered.map((item) => item.taskId), ...tombstones.map((block) => block.taskId)];
  if (existing.length > expected.length) {
    return false;
  }
  return existing.every((block, index) => block.taskId === expected[index]);
}

function emptySummary(config: DocSyncConfig): DocSyncSummary {
  return {
    projectName: config.projectName,
    columnName: config.columnName,
    documentPath: config.hpath,
    tasks: 0,
    created: 0,
    updated: 0,
    archived: 0,
    deduplicated: 0,
    reordered: 0,
    failed: 0
  };
}

function event(level: SyncEvent["level"], message: string): SyncEvent {
  return { time: new Date().toISOString(), level, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
