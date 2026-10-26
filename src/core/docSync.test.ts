import { describe, expect, test } from "vitest";
import { createTranslator } from "../i18n";
import {
  DOC_PROJECT_ID_ATTR,
  DOC_TASK_ID_ATTR,
  DocSyncEngine,
  selectDocSyncTasks
} from "./docSync";
import { renderDocTask } from "./docFormat";
import type {
  DidaListGateway,
  DidaProjectData,
  DidaProjectTask,
  DocSyncConfig,
  SiYuanDocBlock,
  SiYuanDocGateway
} from "./types";

const t = createTranslator("en");

function task(overrides: Partial<DidaProjectTask> = {}): DidaProjectTask {
  return { id: "task-1", projectId: "p1", title: "Task 1", status: 0, ...overrides };
}

function projectData(tasks: DidaProjectTask[]): DidaProjectData {
  return { project: { id: "p1", name: "Dida list" }, tasks, columns: [] };
}

function config(overrides: Partial<DocSyncConfig> = {}): DocSyncConfig {
  return {
    id: "docsync-1",
    enabled: true,
    projectId: "p1",
    projectName: "Dida list",
    columnId: "",
    columnName: "",
    notebookId: "box-1",
    hpath: "/Target",
    ...overrides
  };
}

class FakeDida implements DidaListGateway {
  calls: string[] = [];
  taskLookups: string[] = [];
  existingTasks = new Map<string, DidaProjectTask | undefined>();
  constructor(public data: DidaProjectData) {}
  async getProjectData(projectId: string): Promise<DidaProjectData> {
    this.calls.push(projectId);
    return this.data;
  }
  async getTask(_projectId: string, taskId: string): Promise<DidaProjectTask | undefined> {
    this.taskLookups.push(taskId);
    return this.existingTasks.get(taskId);
  }
}

class FakeSiYuan implements SiYuanDocGateway {
  docId: string | undefined;
  blocks: SiYuanDocBlock[] = [];
  calls: string[] = [];
  blockProjects = new Map<string, string>();
  appendFailures = 0;
  listEmptyOnce = false;
  private sequence = 0;

  async findDocId(): Promise<string | undefined> {
    this.calls.push("findDocId");
    return this.docId;
  }

  async createDoc(): Promise<string> {
    this.calls.push("createDoc");
    this.docId = "doc-1";
    return this.docId;
  }

  async listManagedBlocks(): Promise<SiYuanDocBlock[]> {
    this.calls.push("listManagedBlocks");
    if (this.listEmptyOnce) {
      this.listEmptyOnce = false;
      return [];
    }
    return this.blocks.map((block) => ({ ...block }));
  }

  async appendBlock(_docId: string, markdown: string): Promise<string> {
    this.calls.push("appendBlock");
    if (this.appendFailures > 0) {
      this.appendFailures -= 1;
      throw new Error("append failed");
    }
    const id = `block-${++this.sequence}`;
    this.blocks.push({ id, markdown, taskId: "" });
    return id;
  }

  async updateBlock(blockId: string, markdown: string): Promise<void> {
    this.calls.push(`updateBlock:${blockId}`);
    const block = this.blocks.find((item) => item.id === blockId);
    if (block) {
      // SiYuan's updateBlock replaces content and drops custom block attrs.
      block.markdown = markdown;
      block.taskId = "";
      this.blockProjects.delete(blockId);
    }
  }

  async deleteBlock(blockId: string): Promise<void> {
    this.calls.push(`deleteBlock:${blockId}`);
    this.blocks = this.blocks.filter((item) => item.id !== blockId);
  }

  async setBlockAttrs(blockId: string, attrs: Record<string, string>): Promise<void> {
    this.calls.push(`setBlockAttrs:${blockId}`);
    const block = this.blocks.find((item) => item.id === blockId);
    if (!block) return;
    block.taskId = attrs[DOC_TASK_ID_ATTR] ?? "";
    const projectId = attrs[DOC_PROJECT_ID_ATTR];
    if (projectId) this.blockProjects.set(blockId, projectId);
  }

  async removeEmptyChildBlocks(): Promise<void> {
    this.calls.push("removeEmptyChildBlocks");
  }
}

function build(data: DidaProjectData) {
  const dida = new FakeDida(data);
  const siyuan = new FakeSiYuan();
  const waits: number[] = [];
  const engine = new DocSyncEngine({
    dida,
    siyuan,
    t,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    }
  });
  return { dida, siyuan, engine, waits };
}

describe("selectDocSyncTasks", () => {
  test("keeps open tasks in order, filters columns, and ignores duplicates", () => {
    const selected = selectDocSyncTasks(
      [
        task({ id: "a" }),
        task({ id: "a" }),
        task({ id: "b", status: 2 }),
        task({ id: "c", columnId: "col-2" }),
        task({ id: "d", columnId: "col-1" })
      ],
      "col-1"
    );

    expect(selected.map((item) => item.id)).toEqual(["d"]);
  });
});

describe("DocSyncEngine", () => {
  test("creates the target document and one formatted block per task", async () => {
    const data = projectData([
      task({
        id: "a",
        title: "提交作业",
        startDate: "2026-11-01T20:00:00.000Z",
        dueDate: "2026-11-01T20:00:00.000Z",
        timeZone: "UTC"
      }),
      task({ id: "b", title: "无日期任务" })
    ]);
    const { engine, siyuan } = build(data);

    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ tasks: 2, created: 2, updated: 0, archived: 0, failed: 0 });
    expect(siyuan.blocks.map((block) => block.markdown)).toEqual([
      "提交作业\n 26.11.01 20:00 时间点待办",
      "无日期任务"
    ]);
    expect(siyuan.blocks.map((block) => block.taskId)).toEqual(["a", "b"]);
  });

  test("writes nothing when nothing changed", async () => {
    const data = projectData([task({ id: "a", title: "First" })]);
    const { engine, siyuan } = build(data);
    await engine.sync(config());

    siyuan.calls = [];
    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ tasks: 1, created: 0, updated: 0, archived: 0, failed: 0 });
    expect(siyuan.calls).toEqual(["findDocId", "listManagedBlocks"]);
  });

  test("updates a changed task in place", async () => {
    const data = projectData([task({ id: "a", title: "First" })]);
    const { engine, siyuan } = build(data);
    await engine.sync(config());

    data.tasks[0].title = "First (renamed)";
    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ updated: 1, created: 0, archived: 0 });
    expect(siyuan.blocks[0]).toMatchObject({ id: "block-1", markdown: "First (renamed)" });
  });

  test("re-applies the hidden task attribute after a content update", async () => {
    const data = projectData([task({ id: "a", title: "First" })]);
    const { engine, siyuan } = build(data);
    await engine.sync(config());

    data.tasks[0].title = "First (renamed)";
    const outcome = await engine.sync(config());

    expect(outcome.summary.updated).toBe(1);
    expect(siyuan.blocks[0]).toMatchObject({ id: "block-1", markdown: "First (renamed)", taskId: "a" });
    expect(siyuan.blockProjects.get("block-1")).toBe("p1");
    expect(siyuan.calls.indexOf("updateBlock:block-1")).toBeLessThan(
      siyuan.calls.lastIndexOf("setBlockAttrs:block-1")
    );
  });

  test("appends new tasks after the existing blocks", async () => {
    const data = projectData([task({ id: "a", title: "First" })]);
    const { engine, siyuan } = build(data);
    await engine.sync(config());

    data.tasks.push(task({ id: "b", title: "Second" }));
    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ created: 1, updated: 0, archived: 0 });
    expect(siyuan.blocks.map((block) => block.taskId)).toEqual(["a", "b"]);
    expect(siyuan.blocks[0].id).toBe("block-1");
  });

  test("marks a completed task instead of deleting its block", async () => {
    const data = projectData([task({ id: "a", title: "First" }), task({ id: "b", title: "Second" })]);
    const { engine, siyuan, dida } = build(data);
    await engine.sync(config());

    data.tasks = [data.tasks[1]];
    dida.existingTasks.set("a", task({ id: "a", title: "First", status: 2 }));
    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ tasks: 1, created: 0, archived: 1, failed: 0 });
    expect(siyuan.blocks.map((block) => block.markdown)).toEqual([
      "**【已完成】** First",
      "Second"
    ]);
    expect(siyuan.blocks[0].id).toBe("block-1");
  });

  test("marks a task missing from both queries as deleted", async () => {
    const data = projectData([task({ id: "a", title: "First" })]);
    const { engine, siyuan } = build(data);
    await engine.sync(config());

    data.tasks = [];
    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ tasks: 0, archived: 1, failed: 0 });
    expect(siyuan.blocks).toHaveLength(1);
    expect(siyuan.blocks[0].markdown).toBe("**【已删除】** First");
  });

  test("does not re-classify or rewrite an already archived block", async () => {
    const data = projectData([task({ id: "a", title: "First" })]);
    const { engine, siyuan, dida } = build(data);
    await engine.sync(config());
    data.tasks = [];
    await engine.sync(config());
    expect(siyuan.blocks[0].markdown).toContain("【已删除】");

    siyuan.calls = [];
    dida.taskLookups = [];
    const outcome = await engine.sync(config());

    expect(outcome.summary.archived).toBe(0);
    expect(dida.taskLookups).toEqual([]);
    expect(siyuan.calls).toEqual(["findDocId", "listManagedBlocks"]);
  });

  test("mirrors only the configured kanban column", async () => {
    const data = projectData([
      task({ id: "a", columnId: "col-1" }),
      task({ id: "b", columnId: "col-2", title: "Other" })
    ]);
    const { engine, siyuan } = build(data);

    await engine.sync(config({ columnId: "col-2", columnName: "Later" }));

    expect(siyuan.blocks.map((block) => block.taskId)).toEqual(["b"]);
  });

  test("keeps blocks when the list becomes empty after completion", async () => {
    const data = projectData([task({ id: "a" })]);
    const { engine, siyuan, dida } = build(data);
    await engine.sync(config());

    data.tasks = [];
    dida.existingTasks.set("a", task({ id: "a", status: 2 }));
    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ tasks: 0, created: 0, archived: 1 });
    expect(siyuan.blocks).toHaveLength(1);
  });

  test("retries instead of duplicating blocks when attributes are not indexed yet", async () => {
    const data = projectData([task({ id: "a", title: "First" })]);
    const { engine, siyuan, waits } = build(data);
    siyuan.docId = "doc-1";
    siyuan.blocks = [{ id: "block-1", markdown: "First", taskId: "a" }];
    siyuan.listEmptyOnce = true;

    const outcome = await engine.sync(config());

    expect(waits).toEqual([800]);
    expect(outcome.summary).toMatchObject({ created: 0, updated: 0, archived: 0, failed: 0 });
    expect(siyuan.blocks).toHaveLength(1);
  });

  test("does nothing when disabled", async () => {
    const { engine, dida, siyuan } = build(projectData([task()]));

    const outcome = await engine.sync(config({ enabled: false }));

    expect(outcome.summary.failed).toBe(0);
    expect(dida.calls).toEqual([]);
    expect(siyuan.calls).toEqual([]);
  });

  test("reports incomplete configuration without touching either side", async () => {
    const { engine, dida, siyuan } = build(projectData([task()]));

    const outcome = await engine.sync(config({ notebookId: "" }));

    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0].message).toContain("configuration is incomplete");
    expect(dida.calls).toEqual([]);
    expect(siyuan.calls).toEqual([]);
  });

  test("keeps going when one block operation fails", async () => {
    const { engine, siyuan } = build(projectData([task({ id: "a" }), task({ id: "b" })]));
    siyuan.appendFailures = 1;

    const outcome = await engine.sync(config());

    expect(outcome.summary.created).toBe(1);
    expect(outcome.summary.failed).toBe(1);
    expect(outcome.failures[0].message).toContain("block operation failed");
  });

  test("renders the same text through the shared renderer", () => {
    expect(renderDocTask(task({ title: "First" }))).toBe("First");
  });
});
