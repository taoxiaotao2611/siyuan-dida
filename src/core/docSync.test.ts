import { describe, expect, test } from "vitest";
import { createTranslator } from "../i18n";
import {
  DOC_PROJECT_ID_ATTR,
  DOC_TASK_ID_ATTR,
  DocSyncEngine,
  selectDocSyncTasks
} from "./docSync";
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
  constructor(public data: DidaProjectData) {}
  async getProjectData(projectId: string): Promise<DidaProjectData> {
    this.calls.push(projectId);
    return this.data;
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
    if (block) block.markdown = markdown;
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
  test("creates the target document and one block per task on the first sync", async () => {
    const { engine, siyuan } = build(projectData([
      task({ id: "a", title: "First" }),
      task({ id: "b", title: "Second" })
    ]));

    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ tasks: 2, created: 2, updated: 0, deleted: 0, failed: 0 });
    expect(siyuan.calls).toContain("createDoc");
    expect(siyuan.calls).toContain("removeEmptyChildBlocks");
    expect(siyuan.blocks.map((block) => block.markdown)).toEqual(["First", "Second"]);
    expect(siyuan.blocks.map((block) => block.taskId)).toEqual(["a", "b"]);
    expect(siyuan.blockProjects.get("block-1")).toBe("p1");
  });

  test("writes nothing when nothing changed", async () => {
    const data = projectData([task({ id: "a", title: "First" })]);
    const { engine, siyuan } = build(data);
    await engine.sync(config());

    siyuan.calls = [];
    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ tasks: 1, created: 0, updated: 0, deleted: 0, failed: 0 });
    expect(siyuan.calls).toEqual(["findDocId", "listManagedBlocks"]);
    expect(siyuan.blocks[0].id).toBe("block-1");
  });

  test("updates a changed title in place without recreating the block", async () => {
    const data = projectData([task({ id: "a", title: "First" })]);
    const { engine, siyuan } = build(data);
    await engine.sync(config());

    data.tasks[0].title = "First (renamed)";
    siyuan.calls = [];
    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ updated: 1, created: 0, deleted: 0 });
    expect(siyuan.calls).toContain("updateBlock:block-1");
    expect(siyuan.blocks[0]).toMatchObject({ id: "block-1", markdown: "First (renamed)" });
  });

  test("appends a new task after the existing blocks", async () => {
    const data = projectData([task({ id: "a", title: "First" })]);
    const { engine, siyuan } = build(data);
    await engine.sync(config());

    data.tasks.push(task({ id: "b", title: "Second" }));
    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ created: 1, updated: 0, deleted: 0 });
    expect(siyuan.blocks.map((block) => block.taskId)).toEqual(["a", "b"]);
    expect(siyuan.blocks[0].id).toBe("block-1");
  });

  test("deletes trailing blocks whose tasks disappeared", async () => {
    const data = projectData([task({ id: "a" }), task({ id: "b" })]);
    const { engine, siyuan } = build(data);
    await engine.sync(config());

    data.tasks = [data.tasks[0]];
    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ deleted: 1, created: 0 });
    expect(siyuan.blocks.map((block) => block.taskId)).toEqual(["a"]);
  });

  test("rebuilds the managed segment when the task order changes", async () => {
    const data = projectData([task({ id: "a", title: "First" }), task({ id: "b", title: "Second" })]);
    const { engine, siyuan } = build(data);
    await engine.sync(config());

    data.tasks = [data.tasks[1], data.tasks[0]];
    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ deleted: 2, created: 2 });
    expect(siyuan.blocks.map((block) => block.taskId)).toEqual(["b", "a"]);
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

  test("retries instead of duplicating blocks when attributes are not indexed yet", async () => {
    const data = projectData([task({ id: "a", title: "First" })]);
    const { engine, siyuan, waits } = build(data);
    siyuan.docId = "doc-1";
    siyuan.blocks = [{ id: "block-1", markdown: "First", taskId: "a" }];
    siyuan.listEmptyOnce = true;

    const outcome = await engine.sync(config());

    expect(waits).toEqual([800]);
    expect(outcome.summary).toMatchObject({ created: 0, updated: 0, deleted: 0, failed: 0 });
    expect(siyuan.blocks).toHaveLength(1);
  });

  test("removes all managed blocks when the list becomes empty", async () => {
    const data = projectData([task({ id: "a" })]);
    const { engine, siyuan } = build(data);
    await engine.sync(config());

    data.tasks = [];
    const outcome = await engine.sync(config());

    expect(outcome.summary).toMatchObject({ tasks: 0, deleted: 1, created: 0 });
    expect(siyuan.blocks).toEqual([]);
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
});
