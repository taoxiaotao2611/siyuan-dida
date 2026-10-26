import { describe, expect, test } from "vitest";
import { createTranslator } from "../i18n";
import { taskHash } from "./hash";
import { SyncEngine } from "./syncEngine";
import type {
  CreateDidaTaskOptions,
  DidaGateway,
  DidaTaskSnapshot,
  SiYuanGateway,
  SyncRange,
  SyncSettings,
  SiYuanTodoBlock
} from "./types";

function settings(): SyncSettings {
  return {
    maxTasksPerRun: 100,
    ranges: [
      {
        id: "range-1",
        name: "工作",
        notebookId: "box-1",
        hpathPrefix: "/工作",
        includeChildren: true,
        targetProjectId: "project-1",
        targetProjectName: "工作"
      }
    ]
  };
}

function block(overrides: Partial<SiYuanTodoBlock>): SiYuanTodoBlock {
  return {
    id: "block-1",
    markdown: "- [ ] 整理会议纪要",
    box: "box-1",
    hpath: "/工作/会议",
    attrs: {},
    ...overrides
  };
}

class FakeSiYuan implements SiYuanGateway {
  public attrs: Array<{ blockId: string; attrs: Record<string, string> }> = [];
  public completed: string[] = [];
  public listCalls: Array<{
    range: SyncRange;
    limit: number;
    offset: number;
    recoveryBlockIds: string[];
  }> = [];
  public existingAttrs = new Map<string, Record<string, string>>();
  public setBlockAttrsError: Error | null = null;

  constructor(public blocks: SiYuanTodoBlock[]) {}

  async listTodoBlocks(
    range: SyncRange,
    limit: number,
    offset = 0,
    recoveryBlockIds: ReadonlySet<string> = new Set()
  ) {
    this.listCalls.push({ range, limit, offset, recoveryBlockIds: [...recoveryBlockIds] });
    return this.blocks.slice(offset, offset + limit);
  }

  async setBlockAttrs(blockId: string, attrs: Record<string, string>) {
    if (this.setBlockAttrsError) {
      throw this.setBlockAttrsError;
    }
    this.attrs.push({ blockId, attrs });
    this.existingAttrs.set(blockId, attrs);
  }

  async getBlockAttrs(blockId: string) {
    return this.existingAttrs.get(blockId) ?? {};
  }

  async markBlockCompleted(blockId: string) {
    this.completed.push(blockId);
  }
}

class FakeDida implements DidaGateway {
  public created: Array<{ projectId: string; title: string; options?: CreateDidaTaskOptions }> = [];
  public completed: Array<{ projectId: string; taskId: string }> = [];
  public updated: Array<{ projectId: string; taskId: string; title: string }> = [];
  public parents: Array<{ projectId: string; taskId: string; parentTaskId: string }> = [];
  public incompleteTasks: DidaTaskSnapshot[] = [];
  public incompleteTaskCalls: string[][] = [];
  public completedTaskCalls: string[][] = [];
  public completedTaskStartSeconds: Array<number | undefined> = [];
  public incompleteTaskError: Error | null = null;
  public completedTasks = new Set<string>();
  public completedTaskSnapshots: DidaTaskSnapshot[] = [];
  public completedTaskError: Error | null = null;
  public createTaskError: Error | null = null;
  public createSideEffect: ((task: DidaTaskSnapshot) => void) | null = null;

  async listIncompleteTasks(projectIds: string[]) {
    this.incompleteTaskCalls.push([...projectIds]);
    if (this.incompleteTaskError) {
      throw this.incompleteTaskError;
    }
    return [...this.incompleteTasks];
  }

  async listCompletedTasks(projectIds: string[], startSecond?: number) {
    this.completedTaskCalls.push([...projectIds]);
    this.completedTaskStartSeconds.push(startSecond);
    if (this.completedTaskError) {
      throw this.completedTaskError;
    }
    if (this.completedTaskSnapshots.length > 0) {
      return [...this.completedTaskSnapshots];
    }
    return Array.from(this.completedTasks, (id) => ({ id, projectId: "project-1" }));
  }

  async createTask(projectId: string, title: string, options?: CreateDidaTaskOptions) {
    this.created.push({ projectId, title, options });
    const task = {
      id: `task-${this.created.length}`,
      projectId,
      title,
      content: options?.content
    };
    this.createSideEffect?.(task);
    if (this.createTaskError) {
      throw this.createTaskError;
    }
    return task;
  }

  async updateTaskTitle(projectId: string, taskId: string, title: string) {
    this.updated.push({ projectId, taskId, title });
  }

  async setTaskParent(projectId: string, taskId: string, parentTaskId: string) {
    this.parents.push({ projectId, taskId, parentTaskId });
  }

  async completeTask(projectId: string, taskId: string) {
    this.completed.push({ projectId, taskId });
  }

}

describe("SyncEngine", () => {
  test("creates Dida tasks for unsynced incomplete SiYuan todos", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result.created).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.scanned).toBe(1);
    expect(result.rangeResults[0]).toMatchObject({ rangeName: "工作", scanned: 1, recovered: 0 });
    expect(result.events.some((event) => event.message.includes("创建滴答任务"))).toBe(true);
    expect(dida.created).toEqual([
      {
        projectId: "project-1",
        title: "整理会议纪要",
        options: {
          content: "来源：思源笔记\nSiYuan-Block-ID: block-1",
          allDay: true,
          startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00[+-]\d{4}$/)
        }
      }
    ]);
    expect(siyuan.attrs[0].attrs["custom-dida-task-id"]).toBe("task-1");
  });

  test("creates an undated Dida task when the setting disables a default date", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();

    await new SyncEngine(siyuan, dida).sync({
      ...settings(),
      newTaskDate: "none"
    });

    expect(dida.created).toEqual([
      {
        projectId: "project-1",
        title: "整理会议纪要",
        options: {
          content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
        }
      }
    ]);
  });

  test("creates new child todos under their newly created Dida parent task", async () => {
    const siyuan = new FakeSiYuan([
      block({ id: "child-block", parentId: "parent-block", markdown: "- [ ] 子任务" }),
      block({ id: "parent-block", markdown: "- [ ] 父任务" })
    ]);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result.created).toBe(2);
    expect(dida.created).toEqual([
      {
        projectId: "project-1",
        title: "父任务",
        options: {
          content: "来源：思源笔记\nSiYuan-Block-ID: parent-block",
          allDay: true,
          startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00[+-]\d{4}$/)
        }
      },
      {
        projectId: "project-1",
        title: "子任务",
        options: {
          content: "来源：思源笔记\nSiYuan-Block-ID: child-block",
          allDay: true,
          startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00[+-]\d{4}$/)
        }
      }
    ]);
    expect(dida.parents).toEqual([{ projectId: "project-1", taskId: "task-2", parentTaskId: "task-1" }]);
    expect(siyuan.attrs.map((item) => item.blockId)).toEqual(["parent-block", "child-block"]);
  });

  test("creates a new child todo under an already bound parent block", async () => {
    const siyuan = new FakeSiYuan([block({ id: "child-block", parentId: "parent-block", markdown: "- [ ] 子任务" })]);
    siyuan.existingAttrs.set("parent-block", {
      "custom-dida-task-id": "parent-task",
      "custom-dida-project-id": "project-1"
    });
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result.created).toBe(1);
    expect(dida.created).toEqual([
      {
        projectId: "project-1",
        title: "子任务",
        options: {
          content: "来源：思源笔记\nSiYuan-Block-ID: child-block",
          allDay: true,
          startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00[+-]\d{4}$/)
        }
      }
    ]);
    expect(dida.parents).toEqual([{ projectId: "project-1", taskId: "task-1", parentTaskId: "parent-task" }]);
  });

  test("does not create a child task when its bound parent belongs to another Dida project", async () => {
    const siyuan = new FakeSiYuan([
      block({ id: "child-block", parentId: "parent-block", markdown: "- [ ] 子任务" })
    ]);
    siyuan.existingAttrs.set("parent-block", {
      "custom-dida-task-id": "parent-task",
      "custom-dida-project-id": "parent-project"
    });
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ created: 0, failed: 1 });
    expect(dida.created).toEqual([]);
    expect(dida.parents).toEqual([]);
    expect(siyuan.attrs).toEqual([]);
    expect(result.failures[0].message).toContain("父任务与子任务不在同一滴答清单");
  });

  test("skips a new child todo until its parent has a Dida binding", async () => {
    const siyuan = new FakeSiYuan([block({ id: "child-block", parentId: "parent-block", markdown: "- [ ] 子任务" })]);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(dida.created).toEqual([]);
  });

  test("ignores unsynced completed historical todos", async () => {
    const siyuan = new FakeSiYuan([block({ markdown: "- [x] 历史任务" })]);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result.created).toBe(0);
    expect(dida.created).toEqual([]);
  });

  test("completes Dida task when synced SiYuan todo is completed", async () => {
    const siyuan = new FakeSiYuan([
      block({
        markdown: "- [x] 整理会议纪要",
        attrs: {
          "custom-dida-task-id": "task-1",
          "custom-dida-project-id": "project-1",
          "custom-dida-last-hash": "old"
        }
      })
    ]);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result.completed).toBe(1);
    expect(dida.completed).toEqual([{ projectId: "project-1", taskId: "task-1" }]);
    expect(siyuan.attrs[0].attrs["custom-dida-sync-state"]).toBe("completed-synced");
  });

  test("completes Dida task for SiYuan checked kramdown todo with inline attrs", async () => {
    const siyuan = new FakeSiYuan([
      block({
        markdown: '- {: id="block-1"}[x] 整理会议纪要',
        attrs: {
          "custom-dida-task-id": "task-1",
          "custom-dida-project-id": "project-1",
          "custom-dida-last-hash": taskHash("整理会议纪要", false)
        }
      })
    ]);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result.completed).toBe(1);
    expect(dida.completed).toEqual([{ projectId: "project-1", taskId: "task-1" }]);
    expect(siyuan.attrs[0].attrs["custom-dida-sync-state"]).toBe("completed-synced");
  });

  test("marks SiYuan todo completed when Dida task is completed", async () => {
    const siyuan = new FakeSiYuan([
      block({
        attrs: {
          "custom-dida-task-id": "task-1",
          "custom-dida-project-id": "project-1",
          "custom-dida-last-hash": "old"
        }
      })
    ]);
    const dida = new FakeDida();
    dida.completedTasks.add("task-1");

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result.writtenBack).toBe(1);
    expect(siyuan.completed).toEqual(["block-1"]);
    expect(siyuan.attrs[0].attrs["custom-dida-sync-state"]).toBe("completed-synced");
  });

  test("blocks unbound creation when the completed snapshot fails but still updates bound titles", async () => {
    const siyuan = new FakeSiYuan([
      block({ id: "new-block", markdown: "- [ ] 新任务" }),
      block({
        id: "bound-block",
        markdown: "- [ ] 已绑定任务的新标题",
        attrs: {
          "custom-dida-task-id": "bound-task",
          "custom-dida-project-id": "project-1",
          "custom-dida-last-hash": taskHash("已绑定任务", false)
        }
      })
    ]);
    const dida = new FakeDida();
    dida.completedTaskError = new Error("fetch failed");

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ created: 0, updated: 1, failed: 2 });
    expect(result.failures[0].message).toContain("滴答已完成任务读取失败");
    expect(result.failures[0].message).toContain("已禁止新建任务");
    expect(dida.incompleteTaskCalls).toEqual([["project-1"]]);
    expect(dida.created).toEqual([]);
    expect(dida.updated).toEqual([
      { projectId: "project-1", taskId: "bound-task", title: "已绑定任务的新标题" }
    ]);
  });

  test("updates Dida title when a synced SiYuan todo title changes", async () => {
    const siyuan = new FakeSiYuan([
      block({
        markdown: "- [ ] 整理新版会议纪要",
        attrs: {
          "custom-dida-task-id": "task-1",
          "custom-dida-project-id": "project-1",
          "custom-dida-last-hash": taskHash("整理会议纪要", false)
        }
      })
    ]);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result.updated).toBe(1);
    expect(dida.updated).toEqual([{ projectId: "project-1", taskId: "task-1", title: "整理新版会议纪要" }]);
  });

  test("uses range cursor offset and returns the next cursor", async () => {
    const testSettings = settings();
    testSettings.maxTasksPerRun = 2;
    testSettings.ranges[0].cursorOffset = 2;
    const siyuan = new FakeSiYuan([
      block({ id: "block-1", markdown: "- [ ] 任务 1" }),
      block({ id: "block-2", markdown: "- [ ] 任务 2" }),
      block({ id: "block-3", markdown: "- [ ] 任务 3" }),
      block({ id: "block-4", markdown: "- [ ] 任务 4" }),
      block({ id: "block-5", markdown: "- [ ] 任务 5" })
    ]);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(testSettings);

    expect(siyuan.listCalls.map((call) => call.offset)).toEqual([2]);
    expect(dida.created.map((item) => item.title)).toEqual(["任务 3", "任务 4"]);
    expect(result.rangeResults[0]).toMatchObject({ cursorOffset: 2, nextCursorOffset: 4, hasMore: true });
    expect(result.rangeCursorOffsets).toEqual({ "range-1": 4 });
  });

  test("wraps the range cursor to the first page when the offset reaches the end", async () => {
    const testSettings = settings();
    testSettings.maxTasksPerRun = 2;
    testSettings.ranges[0].cursorOffset = 10;
    const siyuan = new FakeSiYuan([
      block({ id: "block-1", markdown: "- [ ] 任务 1" }),
      block({ id: "block-2", markdown: "- [ ] 任务 2" }),
      block({ id: "block-3", markdown: "- [ ] 任务 3" })
    ]);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(testSettings);

    expect(siyuan.listCalls.map((call) => call.offset)).toEqual([10, 0]);
    expect(dida.created.map((item) => item.title)).toEqual(["任务 1", "任务 2"]);
    expect(result.rangeResults[0]).toMatchObject({ cursorOffset: 0, nextCursorOffset: 2, hasMore: true });
    expect(result.rangeCursorOffsets).toEqual({ "range-1": 2 });
  });

  test("checks a recent priority window while rotating through older candidates", async () => {
    const testSettings = settings();
    testSettings.maxTasksPerRun = 20;
    testSettings.ranges[0].cursorOffset = 50;
    const blocks = Array.from({ length: 80 }, (_, index) => block({ id: `block-${index + 1}`, markdown: `- [ ] 任务 ${index + 1}` }));
    const siyuan = new FakeSiYuan(blocks);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(testSettings);

    expect(siyuan.listCalls.map((call) => ({ limit: call.limit, offset: call.offset }))).toEqual([
      { limit: 5, offset: 0 },
      { limit: 15, offset: 50 }
    ]);
    expect(dida.created.map((item) => item.title)).toContain("任务 1");
    expect(dida.created.map((item) => item.title)).toContain("任务 51");
    expect(result.rangeResults[0]).toMatchObject({ cursorOffset: 50, nextCursorOffset: 65, hasMore: true });
  });

  test("archives unchanged legacy completed todos without completing them again", async () => {
    const siyuan = new FakeSiYuan([
      block({
        markdown: "- [x] 整理会议纪要",
        attrs: {
          "custom-dida-task-id": "task-1",
          "custom-dida-project-id": "project-1",
          "custom-dida-last-hash": taskHash("整理会议纪要", true)
        }
      })
    ]);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result.skipped).toBe(1);
    expect(result.completed).toBe(0);
    expect(dida.completed).toEqual([]);
    expect(siyuan.attrs[0].attrs["custom-dida-sync-state"]).toBe("completed-synced");
  });

  test("skips already archived completed todos without writing attrs again", async () => {
    const siyuan = new FakeSiYuan([
      block({
        markdown: "- [x] 整理会议纪要",
        attrs: {
          "custom-dida-task-id": "task-1",
          "custom-dida-project-id": "project-1",
          "custom-dida-last-hash": taskHash("整理会议纪要", true),
          "custom-dida-sync-state": "completed-synced"
        }
      })
    ]);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result.skipped).toBe(1);
    expect(dida.completed).toEqual([]);
    expect(siyuan.attrs).toEqual([]);
  });

  test("includes the matching SiYuan source marker in every newly created Dida task", async () => {
    const siyuan = new FakeSiYuan([
      block({ id: "block-a", markdown: "- [ ] 任务 A" }),
      block({ id: "block-b", markdown: "- [ ] 任务 B" })
    ]);
    const dida = new FakeDida();

    await new SyncEngine(siyuan, dida).sync(settings());

    expect(dida.created.map((item) => item.options?.content)).toEqual([
      "来源：思源笔记\nSiYuan-Block-ID: block-a",
      "来源：思源笔记\nSiYuan-Block-ID: block-b"
    ]);
  });

  test("restores a unique marked Dida task binding without creating a duplicate", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();
    dida.incompleteTasks = [
      {
        id: "existing-task",
        projectId: "project-1",
        title: "整理会议纪要",
        content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
      }
    ];

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ created: 0, recovered: 1 });
    expect(result.rangeResults[0]).toMatchObject({ created: 0, recovered: 1 });
    expect(dida.created).toEqual([]);
    expect(siyuan.attrs[0]).toMatchObject({
      blockId: "block-1",
      attrs: {
        "custom-dida-task-id": "existing-task",
        "custom-dida-project-id": "project-1",
        "custom-dida-last-hash": taskHash("整理会议纪要", false),
        "custom-dida-sync-state": "synced"
      }
    });
    expect(result.events.some((event) => event.message.includes("读取滴答未完成任务 1 个"))).toBe(true);
    expect(result.events.some((event) => event.message.includes("恢复滴答任务绑定"))).toBe(true);
    expect(result.events.at(-1)?.message).toContain("恢复 1");
  });

  test("updates a recovered Dida title before recording the current SiYuan hash", async () => {
    const siyuan = new FakeSiYuan([
      block({ markdown: "- [ ] 新版会议纪要" })
    ]);
    const dida = new FakeDida();
    dida.incompleteTasks = [
      {
        id: "existing-task",
        projectId: "project-1",
        title: "旧版会议纪要",
        content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
      }
    ];

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ recovered: 1, updated: 1, failed: 0 });
    expect(result.rangeResults[0]).toMatchObject({ recovered: 1, updated: 1 });
    expect(dida.updated).toEqual([
      { projectId: "project-1", taskId: "existing-task", title: "新版会议纪要" }
    ]);
    expect(siyuan.attrs[0].attrs["custom-dida-last-hash"]).toBe(
      taskHash("新版会议纪要", false)
    );
    expect(result.events.some((event) => event.message.includes("更新滴答任务标题"))).toBe(true);
  });

  test("recovers a completed marked Dida task and writes completion back to an unchecked SiYuan todo", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();
    dida.completedTaskSnapshots = [
      {
        id: "completed-task",
        projectId: "project-1",
        title: "整理会议纪要",
        content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
      }
    ];

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ created: 0, recovered: 1, writtenBack: 1, failed: 0 });
    expect(dida.created).toEqual([]);
    expect(siyuan.completed).toEqual(["block-1"]);
    expect(siyuan.attrs[0]).toMatchObject({
      blockId: "block-1",
      attrs: {
        "custom-dida-task-id": "completed-task",
        "custom-dida-project-id": "project-1",
        "custom-dida-last-hash": taskHash("整理会议纪要", true),
        "custom-dida-sync-state": "completed-synced"
      }
    });
  });

  test("recovers an incomplete marked Dida task for a checked SiYuan todo and completes it", async () => {
    const siyuan = new FakeSiYuan([
      block({ markdown: "- [x] 整理会议纪要" })
    ]);
    const dida = new FakeDida();
    dida.incompleteTasks = [
      {
        id: "incomplete-task",
        projectId: "project-1",
        title: "整理会议纪要",
        content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
      }
    ];

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ created: 0, recovered: 1, completed: 1, failed: 0 });
    expect(dida.created).toEqual([]);
    expect(dida.completed).toEqual([
      { projectId: "project-1", taskId: "incomplete-task" }
    ]);
    expect(siyuan.attrs[0].attrs).toMatchObject({
      "custom-dida-task-id": "incomplete-task",
      "custom-dida-project-id": "project-1",
      "custom-dida-last-hash": taskHash("整理会议纪要", true),
      "custom-dida-sync-state": "completed-synced"
    });
  });

  test("recovers an already completed marked Dida task for a checked SiYuan todo without completing it again", async () => {
    const validBlockId = "20260812213000-abcdefg";
    const siyuan = new FakeSiYuan([
      block({ id: validBlockId, markdown: "- [x] 整理会议纪要" })
    ]);
    const dida = new FakeDida();
    dida.completedTaskSnapshots = [
      {
        id: "completed-task",
        projectId: "project-1",
        title: "整理会议纪要",
        content: `来源：思源笔记\nSiYuan-Block-ID: ${validBlockId}`
      },
      {
        id: "invalid-marker-task",
        projectId: "project-1",
        title: "无效标识任务",
        content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
      }
    ];

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ recovered: 1, completed: 0, failed: 0 });
    expect(siyuan.listCalls[0].recoveryBlockIds).toEqual([validBlockId]);
    expect(dida.completed).toEqual([]);
    expect(siyuan.attrs[0].attrs).toMatchObject({
      "custom-dida-task-id": "completed-task",
      "custom-dida-last-hash": taskHash("整理会议纪要", true),
      "custom-dida-sync-state": "completed-synced"
    });
  });

  test("recovers on the next sync after Dida creates a task but its response is lost", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();
    dida.createSideEffect = (task) => dida.incompleteTasks.push(task);
    dida.createTaskError = new Error("lost CLI response");

    const first = await new SyncEngine(siyuan, dida).sync(settings());

    expect(first).toMatchObject({ created: 0, recovered: 0, failed: 1 });
    expect(dida.created).toHaveLength(1);
    expect(siyuan.attrs).toEqual([]);

    dida.createSideEffect = null;
    dida.createTaskError = null;
    const second = await new SyncEngine(siyuan, dida).sync(settings());

    expect(second).toMatchObject({ created: 0, recovered: 1, failed: 0 });
    expect(dida.created).toHaveLength(1);
    expect(siyuan.attrs.at(-1)?.attrs["custom-dida-task-id"]).toBe("task-1");
  });

  test("does not retry an unknown creation outcome for the same block in overlapping ranges", async () => {
    const testSettings = settings();
    testSettings.ranges.push({
      ...testSettings.ranges[0],
      id: "range-2",
      name: "重叠范围"
    });
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();
    dida.createSideEffect = (task) => dida.incompleteTasks.push(task);
    dida.createTaskError = new Error("lost CLI response");

    const first = await new SyncEngine(siyuan, dida).sync(testSettings);

    expect(first).toMatchObject({ created: 0, recovered: 0, failed: 2 });
    expect(dida.created).toHaveLength(1);
    expect(first.failures.map((failure) => failure.message)).toEqual([
      "lost CLI response",
      expect.stringContaining("创建结果未知")
    ]);

    dida.createSideEffect = null;
    dida.createTaskError = null;
    const second = await new SyncEngine(siyuan, dida).sync(testSettings);

    expect(second.recovered).toBeGreaterThanOrEqual(1);
    expect(dida.created).toHaveLength(1);
    expect(siyuan.attrs.at(-1)?.attrs["custom-dida-task-id"]).toBe("task-1");
  });

  test("reports creation immediately and recovers after the SiYuan attribute write fails", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    siyuan.setBlockAttrsError = new Error("attribute write failed");
    const dida = new FakeDida();
    dida.createSideEffect = (task) => dida.incompleteTasks.push(task);

    const first = await new SyncEngine(siyuan, dida).sync(settings());

    expect(first).toMatchObject({ created: 1, recovered: 0, failed: 1 });
    expect(first.rangeResults[0]).toMatchObject({ created: 1, recovered: 0, failed: 1 });
    expect(first.events.some((event) => event.message.includes("创建滴答任务"))).toBe(true);
    expect(dida.created).toHaveLength(1);
    expect(siyuan.attrs).toEqual([]);

    siyuan.setBlockAttrsError = null;
    const second = await new SyncEngine(siyuan, dida).sync(settings());

    expect(second).toMatchObject({ created: 0, recovered: 1, failed: 0 });
    expect(dida.created).toHaveLength(1);
    expect(siyuan.attrs.at(-1)?.attrs["custom-dida-task-id"]).toBe("task-1");
  });

  test("recovers marked parent and child tasks parent-first and restores their relationship", async () => {
    const siyuan = new FakeSiYuan([
      block({ id: "child-block", parentId: "parent-block", markdown: "- [ ] 子任务" }),
      block({ id: "parent-block", markdown: "- [ ] 父任务" })
    ]);
    const dida = new FakeDida();
    dida.incompleteTasks = [
      {
        id: "child-task",
        projectId: "project-1",
        title: "子任务",
        content: "来源：思源笔记\nSiYuan-Block-ID: child-block"
      },
      {
        id: "parent-task",
        projectId: "project-1",
        title: "父任务",
        content: "来源：思源笔记\nSiYuan-Block-ID: parent-block"
      }
    ];

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ created: 0, recovered: 2, failed: 0 });
    expect(siyuan.attrs.map((item) => item.blockId)).toEqual(["parent-block", "child-block"]);
    expect(dida.parents).toEqual([
      { projectId: "project-1", taskId: "child-task", parentTaskId: "parent-task" }
    ]);
  });

  test("does not restore a recovered child relationship across Dida projects", async () => {
    const siyuan = new FakeSiYuan([
      block({ id: "child-block", parentId: "parent-block", markdown: "- [ ] 子任务" })
    ]);
    siyuan.existingAttrs.set("parent-block", {
      "custom-dida-task-id": "parent-task",
      "custom-dida-project-id": "parent-project"
    });
    const dida = new FakeDida();
    dida.incompleteTasks = [
      {
        id: "child-task",
        projectId: "child-project",
        title: "子任务",
        content: "来源：思源笔记\nSiYuan-Block-ID: child-block"
      }
    ];

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    expect(dida.parents).toEqual([]);
    expect(dida.updated).toEqual([]);
    expect(siyuan.attrs).toEqual([]);
    expect(result.failures[0].message).toContain("父任务与子任务不在同一滴答清单");
  });

  test("fails safely when multiple Dida tasks share one source marker", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();
    dida.incompleteTasks = [
      {
        id: "duplicate-1",
        projectId: "project-1",
        content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
      },
      {
        id: "duplicate-2",
        projectId: "project-1",
        content: "Source: SiYuan Notes\nSiYuan-Block-ID: block-1"
      }
    ];

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ created: 0, recovered: 0, failed: 1 });
    expect(dida.created).toEqual([]);
    expect(siyuan.attrs).toEqual([]);
    expect(result.failures[0]).toMatchObject({ blockId: "block-1" });
    expect(result.failures[0].message).toContain("多个滴答任务使用同一思源来源标识");
  });

  test("deduplicates the same remote task returned by incomplete and completed snapshots", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();
    const duplicatedTask = {
      id: "same-task",
      projectId: "project-1",
      title: "整理会议纪要",
      content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
    };
    dida.incompleteTasks = [duplicatedTask];
    dida.completedTaskSnapshots = [{ ...duplicatedTask }];

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ created: 0, recovered: 1, writtenBack: 1, failed: 0 });
    expect(dida.created).toEqual([]);
    expect(siyuan.completed).toEqual(["block-1"]);
  });

  test("keeps richer marker data while deduplicating the same remote task across snapshots", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();
    dida.incompleteTasks = [{ id: "same-task", projectId: "project-1" }];
    dida.completedTaskSnapshots = [
      {
        id: "same-task",
        projectId: "project-1",
        title: "整理会议纪要",
        content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
      }
    ];

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ created: 0, recovered: 1, writtenBack: 1, failed: 0 });
    expect(dida.created).toEqual([]);
  });

  test("does not treat the same task ID in another Dida project as completed", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();
    dida.incompleteTasks = [
      {
        id: "shared-id",
        projectId: "project-1",
        title: "整理会议纪要",
        content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
      }
    ];
    dida.completedTaskSnapshots = [
      {
        id: "shared-id",
        projectId: "project-2",
        title: "另一清单的任务"
      }
    ];

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ recovered: 1, writtenBack: 0, failed: 0 });
    expect(siyuan.completed).toEqual([]);
    expect(siyuan.attrs[0].attrs["custom-dida-sync-state"]).toBe("synced");
  });

  test("blocks all unbound creation after an incomplete snapshot failure but still updates bound titles", async () => {
    const siyuan = new FakeSiYuan([
      block({ id: "new-block", markdown: "- [ ] 新任务" }),
      block({
        id: "bound-block",
        markdown: "- [ ] 已绑定任务的新标题",
        attrs: {
          "custom-dida-task-id": "bound-task",
          "custom-dida-project-id": "project-1",
          "custom-dida-last-hash": taskHash("已绑定任务", false)
        }
      })
    ]);
    const dida = new FakeDida();
    dida.incompleteTaskError = new Error("network offline");

    const result = await new SyncEngine(siyuan, dida, createTranslator("en")).sync(settings());

    expect(result).toMatchObject({ created: 0, recovered: 0, updated: 1, failed: 2 });
    expect(dida.created).toEqual([]);
    expect(dida.updated).toEqual([
      { projectId: "project-1", taskId: "bound-task", title: "已绑定任务的新标题" }
    ]);
    expect(result.failures.map((failure) => failure.message)).toEqual([
      expect.stringContaining("Failed to load incomplete Dida tasks"),
      expect.stringContaining("Blocked creating Dida task")
    ]);
  });

  test("does not recover from a completed marker when the incomplete snapshot failed", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();
    dida.incompleteTaskError = new Error("incomplete unavailable");
    dida.completedTaskSnapshots = [
      {
        id: "completed-task",
        projectId: "project-1",
        title: "整理会议纪要",
        content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
      }
    ];

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ recovered: 0, updated: 0, completed: 0, writtenBack: 0, failed: 2 });
    expect(result.failures[1].message).toContain("恢复快照不完整");
    expect(dida.created).toEqual([]);
    expect(dida.updated).toEqual([]);
    expect(dida.parents).toEqual([]);
    expect(dida.completed).toEqual([]);
    expect(siyuan.completed).toEqual([]);
    expect(siyuan.attrs).toEqual([]);
  });

  test("does not recover from an incomplete marker when the completed snapshot failed", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();
    dida.incompleteTasks = [
      {
        id: "incomplete-task",
        projectId: "project-1",
        title: "旧标题",
        content: "来源：思源笔记\nSiYuan-Block-ID: block-1"
      }
    ];
    dida.completedTaskError = new Error("completed unavailable");

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result).toMatchObject({ recovered: 0, updated: 0, completed: 0, writtenBack: 0, failed: 2 });
    expect(result.failures[1].message).toContain("恢复快照不完整");
    expect(dida.created).toEqual([]);
    expect(dida.updated).toEqual([]);
    expect(dida.parents).toEqual([]);
    expect(dida.completed).toEqual([]);
    expect(siyuan.completed).toEqual([]);
    expect(siyuan.attrs).toEqual([]);
  });

  test("loads incomplete and completed snapshots once with unique configured project IDs", async () => {
    const testSettings = settings();
    testSettings.ranges.push(
      {
        ...testSettings.ranges[0],
        id: "range-2",
        name: "工作副本"
      },
      {
        ...testSettings.ranges[0],
        id: "range-3",
        name: "个人",
        targetProjectId: "project-2",
        targetProjectName: "个人"
      }
    );
    const siyuan = new FakeSiYuan([]);
    const dida = new FakeDida();

    await new SyncEngine(siyuan, dida).sync(testSettings);

    expect(dida.incompleteTaskCalls).toEqual([["project-1", "project-2"]]);
    expect(dida.completedTaskCalls).toEqual([["project-1", "project-2"]]);
  });

  test("runs a full baseline and sets the watermark when no watermark is configured", async () => {
    const siyuan = new FakeSiYuan([]);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(dida.completedTaskStartSeconds).toEqual([0]);
    expect(typeof result.completedWatermarkSecond).toBe("number");
    expect(result.completedWatermarkSecond).toBeGreaterThan(0);
  });

  test("runs an incremental snapshot from the configured watermark", async () => {
    const testSettings = settings();
    testSettings.completedWatermarkSecond = 1_700_000_000;
    const siyuan = new FakeSiYuan([]);
    const dida = new FakeDida();

    const result = await new SyncEngine(siyuan, dida).sync(testSettings);

    expect(dida.completedTaskStartSeconds).toEqual([1_700_000_000]);
    expect(typeof result.completedWatermarkSecond).toBe("number");
  });

  test("does not set a watermark when the completed snapshot fails (fail-closed)", async () => {
    const siyuan = new FakeSiYuan([]);
    const dida = new FakeDida();
    dida.completedTaskError = new Error("boom");

    const result = await new SyncEngine(siyuan, dida).sync(settings());

    expect(result.completedWatermarkSecond).toBeUndefined();
    expect(result.failed).toBeGreaterThan(0);
  });

  test("recovers a marker match only when it is in the configured column", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();
    dida.incompleteTasks = [
      {
        id: "task-1",
        projectId: "project-1",
        title: "整理会议纪要",
        content: "来源：思源笔记\nSiYuan-Block-ID: block-1",
        columnId: "col-later"
      }
    ];
    const testSettings = settings();
    testSettings.ranges[0].columnId = "col-now";
    testSettings.ranges[0].columnName = "Now";

    const result = await new SyncEngine(siyuan, dida, createTranslator("zh-CN")).sync(testSettings);

    expect(dida.created).toEqual([]);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.events.some((event) => event.message.includes("不在所选分栏"))).toBe(true);
  });

  test("recovers a marker match that is inside the configured column", async () => {
    const siyuan = new FakeSiYuan([block({})]);
    const dida = new FakeDida();
    dida.incompleteTasks = [
      {
        id: "task-1",
        projectId: "project-1",
        title: "整理会议纪要",
        content: "来源：思源笔记\nSiYuan-Block-ID: block-1",
        columnId: "col-now"
      }
    ];
    const testSettings = settings();
    testSettings.ranges[0].columnId = "col-now";

    const result = await new SyncEngine(siyuan, dida).sync(testSettings);

    expect(result.recovered).toBe(1);
    expect(siyuan.attrs[0].attrs["custom-dida-task-id"]).toBe("task-1");
  });
});
