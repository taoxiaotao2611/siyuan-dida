import type { Translate } from "../i18n";
import { renderDocTask } from "./docFormat";
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

interface DesiredBlock {
  taskId: string;
  markdown: string;
}

/**
 * One-way mirror: one Dida list (or one kanban column) -> one SiYuan document.
 *
 * Every selected Dida task maps to exactly one SiYuan block. Blocks created by
 * this engine carry a hidden task-id attribute, which makes the mirror
 * idempotent: unchanged runs write nothing, changed titles update in place,
 * appended/removed tasks are added or deleted, and order changes rebuild the
 * managed segment.
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
      const desired: DesiredBlock[] = tasks.map((task) => ({
        taskId: task.id,
        markdown: renderDocTask(task) || this.deps.t("docSyncUntitledTask")
      }));

      let docId = await this.deps.siyuan.findDocId(config.notebookId, config.hpath);
      let documentCreated = false;
      if (!docId) {
        docId = await this.deps.siyuan.createDoc(config.notebookId, config.hpath);
        documentCreated = true;
        events.push(event("info", this.deps.t("docSyncDocCreated", { path: config.hpath })));
      }

      let existing = await this.deps.siyuan.listManagedBlocks(docId, DOC_TASK_ID_ATTR);
      if (existing.length === 0 && desired.length > 0 && !documentCreated) {
        // SiYuan indexes block attributes asynchronously. An unindexed doc can
        // briefly look empty right after it was written; retry once before
        // appending, otherwise a fast second sync could duplicate every block.
        await this.wait(800);
        existing = await this.deps.siyuan.listManagedBlocks(docId, DOC_TASK_ID_ATTR);
      }
      await this.applyDesired(docId, config, desired, existing, summary, failures);

      if (documentCreated && desired.length > 0) {
        await this.deps.siyuan.removeEmptyChildBlocks(docId);
      }
    } catch (error) {
      failures.push({ message: this.deps.t("docSyncFailed", { message: errorMessage(error) }) });
      summary.failed += 1;
    }

    return { summary, events, failures };
  }

  private async applyDesired(
    docId: string,
    config: DocSyncConfig,
    desired: DesiredBlock[],
    existing: SiYuanDocBlock[],
    summary: DocSyncSummary,
    failures: Array<{ message: string }>
  ): Promise<void> {
    if (sameSequence(desired, existing)) {
      await this.updateChanged(desired, existing, summary, failures);
      return;
    }

    if (isPrefix(existing, desired)) {
      await this.updateChanged(desired.slice(0, existing.length), existing, summary, failures);
      for (const item of desired.slice(existing.length)) {
        await this.appendOne(docId, config, item, summary, failures);
      }
      return;
    }

    if (isPrefix(desired, existing)) {
      await this.updateChanged(desired, existing.slice(0, desired.length), summary, failures);
      for (const block of existing.slice(desired.length)) {
        await this.deleteOne(block, summary, failures);
      }
      return;
    }

    // Order or shape changed: rebuild the managed segment in the desired order.
    for (const block of existing) {
      await this.deleteOne(block, summary, failures);
    }
    for (const item of desired) {
      await this.appendOne(docId, config, item, summary, failures);
    }
  }

  private async updateChanged(
    desired: DesiredBlock[],
    existing: SiYuanDocBlock[],
    summary: DocSyncSummary,
    failures: Array<{ message: string }>
  ): Promise<void> {
    for (let index = 0; index < desired.length && index < existing.length; index += 1) {
      const item = desired[index];
      const block = existing[index];
      if (item.taskId !== block.taskId || item.markdown === block.markdown) {
        continue;
      }
      try {
        await this.deps.siyuan.updateBlock(block.id, item.markdown);
        summary.updated += 1;
      } catch (error) {
        this.fail(failures, summary, error);
      }
    }
  }

  private async appendOne(
    docId: string,
    config: DocSyncConfig,
    item: DesiredBlock,
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

  private async deleteOne(
    block: SiYuanDocBlock,
    summary: DocSyncSummary,
    failures: Array<{ message: string }>
  ): Promise<void> {
    try {
      await this.deps.siyuan.deleteBlock(block.id);
      summary.deleted += 1;
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

function sameSequence(desired: DesiredBlock[], existing: SiYuanDocBlock[]): boolean {
  return desired.length === existing.length
    && desired.every((item, index) => item.taskId === existing[index].taskId);
}

function isPrefix(shorter: Array<{ taskId: string }>, longer: Array<{ taskId: string }>): boolean {
  return shorter.length < longer.length
    && shorter.every((item, index) => item.taskId === longer[index].taskId);
}

function emptySummary(config: DocSyncConfig): DocSyncSummary {
  return {
    projectName: config.projectName,
    columnName: config.columnName,
    documentPath: config.hpath,
    tasks: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    failed: 0
  };
}

function event(level: SyncEvent["level"], message: string): SyncEvent {
  return { time: new Date().toISOString(), level, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
