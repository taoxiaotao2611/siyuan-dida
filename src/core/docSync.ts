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

/**
 * One-way mirror: one Dida list (or one kanban column) -> one SiYuan document.
 *
 * Every selected Dida task maps to exactly one SiYuan block. Blocks created by
 * this engine carry a hidden task-id attribute, which makes the mirror
 * idempotent: unchanged runs write nothing, changed tasks update in place, new
 * tasks are appended, and tasks that disappear from the open list stay in
 * place with a bold 【已完成】/【已删除】 prefix instead of being removed.
 *
 * The engine is intentionally format-agnostic: it only depends on
 * `renderDocTask` turning a task into one Markdown block.
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
      const ordered: Array<{ taskId: string; markdown: string }> = [];
      const current = new Map<string, string>();
      for (const task of tasks) {
        const markdown = renderDocTask(task) || this.deps.t("docSyncUntitledTask");
        ordered.push({ taskId: task.id, markdown });
        current.set(task.id, markdown);
      }

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

      await this.updateExistingBlocks(config, existing, current, summary, failures);
      const known = new Set(existing.map((block) => block.taskId));
      for (const item of ordered) {
        if (known.has(item.taskId)) {
          continue;
        }
        await this.appendOne(docId, config, item, summary, failures);
      }

      if (documentCreated && ordered.length > 0) {
        await this.deps.siyuan.removeEmptyChildBlocks(docId);
      }
    } catch (error) {
      failures.push({ message: this.deps.t("docSyncFailed", { message: errorMessage(error) }) });
      summary.failed += 1;
    }

    return { summary, events, failures };
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
            await this.deps.siyuan.updateBlock(block.id, rendered);
            summary.updated += 1;
          }
          continue;
        }
        if (isArchivedMarkdown(block.markdown)) {
          continue;
        }
        const kind = await this.classifyArchived(config.projectId, block.taskId);
        if (!kind) {
          continue;
        }
        await this.deps.siyuan.updateBlock(block.id, markDocTaskArchived(block.markdown, kind));
        summary.archived += 1;
      } catch (error) {
        this.fail(failures, summary, error);
      }
    }
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

  private async appendOne(
    docId: string,
    config: DocSyncConfig,
    item: { taskId: string; markdown: string },
    summary: DocSyncSummary,
    failures: Array<{ message: string }>
  ): Promise<void> {
    try {
      const blockId = await this.deps.siyuan.appendBlock(docId, item.markdown);
      await this.deps.siyuan.setBlockAttrs(blockId, {
        [DOC_TASK_ID_ATTR]: item.taskId,
        [DOC_PROJECT_ID_ATTR]: config.projectId
      });
      summary.created += 1;
    } catch (error) {
      this.fail(failures, summary, error);
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

function emptySummary(config: DocSyncConfig): DocSyncSummary {
  return {
    projectName: config.projectName,
    columnName: config.columnName,
    documentPath: config.hpath,
    tasks: 0,
    created: 0,
    updated: 0,
    archived: 0,
    failed: 0
  };
}

function event(level: SyncEvent["level"], message: string): SyncEvent {
  return { time: new Date().toISOString(), level, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
