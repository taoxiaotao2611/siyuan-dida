// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createTranslator } from "../i18n";
import type { PluginSettings } from "./defaults";
import { getRangeValidationMessage, getTargetProjectWarning, RangeValidationError } from "./ranges";
import { createSyncStatusController } from "./statusPanel";

const panelMocks = vi.hoisted(() => ({
  notebooks: Promise.resolve([] as Array<{ id: string; name: string }>),
  projects: Promise.resolve([] as Array<{ id: string; name: string }>),
  columns: [] as Array<{ id: string; name: string }>,
  resolveDidaCommand: vi.fn(async () => ({ command: "dida", version: "test" }))
}));

vi.mock("../siyuan/api", () => ({
  listNotebooks: () => panelMocks.notebooks
}));

vi.mock("../dida/cli", () => ({
  resolveDidaCommand: panelMocks.resolveDidaCommand,
  DidaCliClient: class {
    listProjects() {
      return panelMocks.projects;
    }
    getProjectData(projectId: string) {
      return Promise.resolve({
        project: { id: projectId, name: "Courses" },
        tasks: [],
        columns: panelMocks.columns
      });
    }
  }
}));

import { buildSettingsPanel } from "./settingsPanel";

function buildPanel(options: Omit<Parameters<typeof buildSettingsPanel>[0], "status" | "onSyncNow">) {
  return buildSettingsPanel({
    ...options,
    status: createSyncStatusController({ state: "pending" }),
    onSyncNow: vi.fn()
  }).element;
}

const details = {
  rangeIndex: 2,
  rangeId: "range-2",
  rangeName: "Weekly",
  conflictingRangeIndex: 1,
  conflictingRangeId: "range-1",
  conflictingRangeName: "Work"
};

describe("getRangeValidationMessage", () => {
  test.each([
    ["missing_notebook" as const, "Sync range 2 is missing a notebook."],
    ["missing_path" as const, "Sync range 2 is missing a document path."],
    ["missing_target" as const, "Sync range 2 is missing a Dida list."],
    ["duplicate_range_id" as const, "Sync ranges 1 and 2 have the same internal ID."],
    ["overlapping_ranges" as const, "Sync ranges 1 and 2 overlap."]
  ])("translates %s in English", (code, expected) => {
    expect(getRangeValidationMessage(new RangeValidationError(code, details), createTranslator("en"))).toBe(expected);
  });

  test("translates validation errors in Chinese", () => {
    expect(
      getRangeValidationMessage(
        new RangeValidationError("overlapping_ranges", details),
        createTranslator("zh-CN")
      )
    ).toBe("同步范围 1 和 2 存在重叠。");
  });

  test("preserves unknown error messages", () => {
    expect(getRangeValidationMessage(new Error("original message"), createTranslator("en"))).toBe("original message");
  });
});

describe("getTargetProjectWarning", () => {
  const t = createTranslator("en");

  test("warns when a saved range changes to another non-empty target", () => {
    expect(getTargetProjectWarning(" project-1 ", "project-2", t)).toBe(
      "Existing bindings remain in their original Dida lists; only new tasks use the newly selected list."
    );
  });

  test.each([
    ["project-1", "project-1"],
    [" project-1 ", "project-1"],
    ["", "project-2"],
    ["project-1", ""]
  ])("does not warn for equivalent or non-target values", (original, current) => {
    expect(getTargetProjectWarning(original, current, t)).toBe("");
  });

  test("localizes the warning", () => {
    expect(getTargetProjectWarning("project-1", "project-2", createTranslator("zh-CN"))).toBe(
      "已有绑定仍保留在原滴答清单中；只有新同步的任务会使用新选择的清单。"
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function settings(): PluginSettings {
  return {
    cliCommand: "dida",
    resolvedCliPath: "",
    resolvedCliPaths: {},
    autoSync: false,
    newTaskDate: "today",
    syncIntervalSeconds: 15,
    syncOnStartup: false,
    maxTasksPerRun: 200,
    ranges: [
      {
        id: "range-1",
        name: "Work",
        notebookId: "box-1",
        hpathPrefix: "/Work",
        includeChildren: true,
        targetProjectId: "project-1",
        targetProjectName: "Original list",
        cursorOffset: 0
      }
    ],
    logs: [],
    docSyncs: []
  };
}

async function flushAsyncRendering() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("buildSettingsPanel range target behavior", () => {
  beforeEach(() => {
    panelMocks.resolveDidaCommand.mockClear();
    panelMocks.notebooks = new Promise(() => undefined);
    panelMocks.projects = new Promise(() => undefined);
  });

  test("fallback input clears stale target name across an async rerender before save", async () => {
    const notebooks = deferred<Array<{ id: string; name: string }>>();
    panelMocks.notebooks = notebooks.promise;
    const onSave = vi.fn(async (savedSettings: PluginSettings) => savedSettings);
    const panel = buildPanel({
      settings: settings(),
      t: createTranslator("en"),
      onSave,
      onClearLogs: async () => undefined
    });

    const targetInput = panel.querySelector<HTMLInputElement>('[data-field="targetProjectId"]')!;
    targetInput.value = "typed-project";
    targetInput.dispatchEvent(new Event("input", { bubbles: true }));

    notebooks.resolve([{ id: "box-1", name: "Notebook" }]);
    await flushAsyncRendering();
    panel.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flushAsyncRendering();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].ranges[0]).toMatchObject({
      targetProjectId: "typed-project",
      targetProjectName: ""
    });
  });

  test("fallback input shows the warning for a changed target and hides it after reverting", () => {
    const panel = buildPanel({
      settings: settings(),
      t: createTranslator("en"),
      onSave: async (savedSettings) => savedSettings,
      onClearLogs: async () => undefined
    });
    const targetInput = panel.querySelector<HTMLInputElement>('[data-field="targetProjectId"]')!;
    const warning = panel.querySelector<HTMLElement>('[data-field="targetProjectWarning"]')!;

    expect(warning.classList.contains("dida-sync-range-warning")).toBe(true);
    expect(warning.getAttribute("role")).toBe("status");
    expect(warning.getAttribute("aria-live")).toBe("polite");

    targetInput.value = "project-2";
    targetInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toContain("Existing bindings remain");

    targetInput.value = "project-1";
    targetInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(warning.hidden).toBe(true);
    expect(warning.textContent).toBe("");
  });

  test("loaded target select updates the target name and warning for input and change", async () => {
    panelMocks.projects = Promise.resolve([
      { id: "project-1", name: "Original list" },
      { id: "project-2", name: "Second list" }
    ]);
    const onSave = vi.fn(async (savedSettings: PluginSettings) => savedSettings);
    const panel = buildPanel({
      settings: settings(),
      t: createTranslator("en"),
      onSave,
      onClearLogs: async () => undefined
    });
    await flushAsyncRendering();

    const select = panel.querySelector<HTMLSelectElement>('[data-field="targetProjectId"]')!;
    const warning = panel.querySelector<HTMLElement>('[data-field="targetProjectWarning"]')!;
    expect(select.tagName).toBe("SELECT");

    select.value = "project-2";
    select.dispatchEvent(new Event("input", { bubbles: true }));
    expect(warning.hidden).toBe(false);

    panel.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flushAsyncRendering();
    expect(onSave.mock.calls[0][0].ranges[0]).toMatchObject({
      targetProjectId: "project-2",
      targetProjectName: "Second list"
    });

    select.value = "project-1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(warning.hidden).toBe(true);
  });

  test("rebases the saved target so changing from B back to A warns", async () => {
    const onSave = vi.fn(async (savedSettings: PluginSettings) => savedSettings);
    const panel = buildPanel({
      settings: settings(),
      t: createTranslator("en"),
      onSave,
      onClearLogs: async () => undefined
    });

    const firstTarget = panel.querySelector<HTMLInputElement>('[data-field="targetProjectId"]')!;
    firstTarget.value = "project-2";
    firstTarget.dispatchEvent(new Event("input", { bubbles: true }));
    panel.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flushAsyncRendering();

    const rebasedTarget = panel.querySelector<HTMLInputElement>('[data-field="targetProjectId"]')!;
    const warning = panel.querySelector<HTMLElement>('[data-field="targetProjectWarning"]')!;
    expect(warning.hidden).toBe(true);

    rebasedTarget.value = "project-1";
    rebasedTarget.dispatchEvent(new Event("input", { bubbles: true }));
    expect(warning.hidden).toBe(false);
  });

  test("does not rebase target warnings when the plugin rejects a save", async () => {
    const onSave = vi.fn(async (_savedSettings: PluginSettings) => {
      throw new Error("runtime write failed");
    });
    const panel = buildPanel({
      settings: settings(),
      t: createTranslator("en"),
      onSave,
      onClearLogs: async () => undefined
    });
    const target = panel.querySelector<HTMLInputElement>('[data-field="targetProjectId"]')!;
    const warning = panel.querySelector<HTMLElement>('[data-field="targetProjectWarning"]')!;

    target.value = "project-2";
    target.dispatchEvent(new Event("input", { bubbles: true }));
    panel.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flushAsyncRendering();

    expect(onSave).toHaveBeenCalledOnce();
    expect(target.value).toBe("project-2");
    expect(warning.hidden).toBe(false);

    target.value = "project-1";
    target.dispatchEvent(new Event("input", { bubbles: true }));
    expect(warning.hidden).toBe(true);
  });

  test("uses a newly added range target as its baseline after the first save", async () => {
    const onSave = vi.fn(async (savedSettings: PluginSettings) => savedSettings);
    const panel = buildPanel({
      settings: settings(),
      t: createTranslator("en"),
      onSave,
      onClearLogs: async () => undefined
    });
    panel.querySelector<HTMLButtonElement>('[data-action="addRange"]')!.click();

    const added = panel.querySelectorAll<HTMLElement>(".dida-sync-range")[1];
    const notebook = added.querySelector<HTMLInputElement>('[data-field="notebookId"]')!;
    const path = added.querySelector<HTMLInputElement>('[data-field="hpathPrefix"]')!;
    const target = added.querySelector<HTMLInputElement>('[data-field="targetProjectId"]')!;
    notebook.value = "box-2";
    notebook.dispatchEvent(new Event("input", { bubbles: true }));
    path.value = "/Personal";
    path.dispatchEvent(new Event("input", { bubbles: true }));
    target.value = "project-2";
    target.dispatchEvent(new Event("input", { bubbles: true }));

    panel.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flushAsyncRendering();

    const rebasedAdded = panel.querySelectorAll<HTMLElement>(".dida-sync-range")[1];
    const rebasedTarget = rebasedAdded.querySelector<HTMLInputElement>('[data-field="targetProjectId"]')!;
    const warning = rebasedAdded.querySelector<HTMLElement>('[data-field="targetProjectWarning"]')!;
    rebasedTarget.value = "project-3";
    rebasedTarget.dispatchEvent(new Event("input", { bubbles: true }));

    expect(warning.hidden).toBe(false);
  });

  test("keeps a generated legacy range ID stable across consecutive saves", async () => {
    const initial = settings();
    initial.ranges[0].id = "";
    const savedIds: string[] = [];
    const onSave = vi.fn(async (savedSettings: PluginSettings) => {
      savedIds.push(savedSettings.ranges[0].id);
      return savedSettings;
    });
    const panel = buildPanel({
      settings: initial,
      t: createTranslator("en"),
      onSave,
      onClearLogs: async () => undefined
    });

    panel.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flushAsyncRendering();
    panel.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flushAsyncRendering();

    expect(savedIds[0]).toMatch(/^range-/);
    expect(savedIds[1]).toBe(savedIds[0]);
  });

  test("rebases to the canonical cursor returned by the plugin", async () => {
    const submittedCursors: number[] = [];
    const onSave = vi.fn(async (savedSettings: PluginSettings) => {
      submittedCursors.push(savedSettings.ranges[0].cursorOffset ?? -1);
      return {
        ...savedSettings,
        ranges: savedSettings.ranges.map((range) => ({ ...range, cursorOffset: 91 }))
      };
    });
    const panel = buildPanel({
      settings: settings(),
      t: createTranslator("en"),
      onSave,
      onClearLogs: async () => undefined
    });

    panel.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flushAsyncRendering();
    panel.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flushAsyncRendering();

    expect(submittedCursors).toEqual([0, 91]);
  });

  test("uses the active locale for displayed and copied sync logs", async () => {
    const initial = settings();
    initial.logs = [
      {
        created: 1,
        recovered: 1,
        updated: 0,
        completed: 0,
        writtenBack: 0,
        failed: 0,
        skipped: 0,
        scanned: 1,
        rangeResults: [],
        rangeCursorOffsets: {},
        events: [],
        failures: [],
        startedAt: "2026-06-27T01:00:00.000Z",
        finishedAt: "2026-06-27T01:00:01.000Z"
      }
    ];
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    const panel = buildPanel({
      settings: initial,
      t: createTranslator("en"),
      onSave: async (savedSettings) => savedSettings,
      onClearLogs: async () => undefined
    });

    expect(panel.querySelector<HTMLElement>('[data-field="logs"]')!.textContent).toContain(
      "Summary: scanned 1, created 1, recovered 1"
    );

    panel.querySelector<HTMLButtonElement>('[data-action="copyLogs"]')!.click();
    await flushAsyncRendering();

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Summary: scanned 1, created 1, recovered 1"));
    expect(writeText.mock.calls[0][0]).not.toMatch(/[\u3400-\u9fff]/u);
  });
});

describe("buildSettingsPanel status integration", () => {
  test("mounts the live status panel near the top and exposes cleanup", () => {
    const status = createSyncStatusController({ state: "pending" });
    const onSyncNow = vi.fn();
    const view = buildSettingsPanel({
      settings: settings(),
      t: createTranslator("en"),
      status,
      onSyncNow,
      onSave: async (savedSettings) => savedSettings,
      onClearLogs: async () => undefined
    });

    const sections = view.element.querySelectorAll(".dida-sync-section");
    expect(sections[0].classList.contains("dida-sync-status")).toBe(true);
    view.element.querySelector<HTMLButtonElement>('[data-action="syncNow"]')!.click();
    expect(onSyncNow).toHaveBeenCalledOnce();

    view.destroy();
    status.publish({ state: "failed", message: "after destroy" });
    expect(view.element.textContent).not.toContain("after destroy");
  });

  test("destroy removes all handlers and clears the mounted content", async () => {
    const onSave = vi.fn(async (savedSettings: PluginSettings) => savedSettings);
    const onClearLogs = vi.fn(async () => undefined);
    const onSyncNow = vi.fn();
    const view = buildSettingsPanel({
      settings: settings(),
      t: createTranslator("en"),
      status: createSyncStatusController({ state: "pending" }),
      onSyncNow,
      onSave,
      onClearLogs
    });
    const save = view.element.querySelector<HTMLButtonElement>('[data-action="save"]')!;
    const clear = view.element.querySelector<HTMLButtonElement>('[data-action="clearLogs"]')!;
    const sync = view.element.querySelector<HTMLButtonElement>('[data-action="syncNow"]')!;
    const testConnection = view.element.querySelector<HTMLButtonElement>('[data-action="test"]')!;
    panelMocks.resolveDidaCommand.mockClear();

    view.destroy();
    save.click();
    clear.click();
    sync.click();
    testConnection.click();
    await flushAsyncRendering();

    expect(onSave).not.toHaveBeenCalled();
    expect(onClearLogs).not.toHaveBeenCalled();
    expect(onSyncNow).not.toHaveBeenCalled();
    expect(panelMocks.resolveDidaCommand).not.toHaveBeenCalled();
    expect(view.element.childElementCount).toBe(0);
  });

  test("destroy prevents deferred notebook and project continuations from rerendering", async () => {
    const notebooks = deferred<Array<{ id: string; name: string }>>();
    const projects = deferred<Array<{ id: string; name: string }>>();
    panelMocks.notebooks = notebooks.promise;
    panelMocks.projects = projects.promise;
    const view = buildSettingsPanel({
      settings: settings(),
      t: createTranslator("en"),
      status: createSyncStatusController({ state: "pending" }),
      onSyncNow: vi.fn(),
      onSave: async (savedSettings) => savedSettings,
      onClearLogs: async () => undefined
    });
    const ranges = view.element.querySelector<HTMLElement>('[data-field="ranges"]')!;
    const replaceChildren = vi.spyOn(ranges, "replaceChildren");
    replaceChildren.mockClear();

    view.destroy();
    notebooks.resolve([{ id: "box-1", name: "Notebook" }]);
    projects.resolve([{ id: "project-1", name: "Project" }]);
    await flushAsyncRendering();

    expect(replaceChildren).not.toHaveBeenCalled();
  });
});

describe("buildSettingsPanel list to document sync", () => {
  function prepareMirrorMocks() {
    panelMocks.projects = Promise.resolve([
      { id: "project-1", name: "Courses" },
      { id: "project-2", name: "Inbox" }
    ]);
    panelMocks.notebooks = Promise.resolve([{ id: "box-1", name: "Notes" }]);
    panelMocks.columns = [{ id: "col-1", name: "Later" }];
  }

  async function fillFirstTarget(
    element: HTMLElement,
    projectId: string,
    hpathValue: string
  ) {
    const project = element.querySelector<HTMLSelectElement>('[data-field="docSyncProject"]')!;
    project.value = projectId;
    project.dispatchEvent(new Event("change", { bubbles: true }));
    await flushAsyncRendering();

    const column = element.querySelector<HTMLSelectElement>('[data-field="docSyncColumn"]')!;
    column.value = "col-1";
    column.dispatchEvent(new Event("change", { bubbles: true }));

    const notebook = element.querySelector<HTMLSelectElement>('[data-field="docSyncNotebook"]')!;
    notebook.value = "box-1";
    notebook.dispatchEvent(new Event("change", { bubbles: true }));

    const hpath = element.querySelector<HTMLInputElement>('[data-field="docSyncHpath"]')!;
    hpath.value = hpathValue;
    hpath.dispatchEvent(new Event("input", { bubbles: true }));
  }

  test("persists the mirror configuration and loads its kanban columns", async () => {
    prepareMirrorMocks();
    const onSave = vi.fn(async (savedSettings: PluginSettings) => savedSettings);
    const element = buildPanel({
      settings: settings(),
      t: createTranslator("en"),
      onSave,
      onClearLogs: async () => undefined
    });
    await flushAsyncRendering();

    const enabled = element.querySelector<HTMLInputElement>('[data-field="docSyncEnabled"]')!;
    expect(enabled.checked).toBe(false);
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));

    const sortByTime = element.querySelector<HTMLInputElement>('[data-field="docSyncSortByTime"]')!;
    expect(sortByTime.checked).toBe(false);
    sortByTime.checked = true;
    sortByTime.dispatchEvent(new Event("change", { bubbles: true }));

    const project = element.querySelector<HTMLSelectElement>('[data-field="docSyncProject"]')!;
    project.value = "project-1";
    project.dispatchEvent(new Event("change", { bubbles: true }));
    await flushAsyncRendering();

    const column = element.querySelector<HTMLSelectElement>('[data-field="docSyncColumn"]')!;
    expect(Array.from(column.options).map((option) => option.textContent)).toEqual(["Whole list", "Later"]);
    column.value = "col-1";
    column.dispatchEvent(new Event("change", { bubbles: true }));

    const notebook = element.querySelector<HTMLSelectElement>('[data-field="docSyncNotebook"]')!;
    notebook.value = "box-1";
    notebook.dispatchEvent(new Event("change", { bubbles: true }));

    const hpath = element.querySelector<HTMLInputElement>('[data-field="docSyncHpath"]')!;
    hpath.value = "/Target";
    hpath.dispatchEvent(new Event("input", { bubbles: true }));

    const activeHeading = element.querySelector<HTMLInputElement>('[data-field="docSyncActiveHeading"]')!;
    activeHeading.value = "进行中";
    activeHeading.dispatchEvent(new Event("input", { bubbles: true }));

    element.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flushAsyncRendering();

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0].docSyncs).toHaveLength(1);
    expect(onSave.mock.calls[0][0].docSyncs[0]).toMatchObject({
      enabled: true,
      projectId: "project-1",
      projectName: "Courses",
      columnId: "col-1",
      columnName: "Later",
      notebookId: "box-1",
      hpath: "/Target",
      sortByTime: true,
      activeHeading: "进行中",
      archivedHeading: "已完成归档"
    });
  });

  test("supports adding and removing multiple mirror targets", async () => {
    prepareMirrorMocks();
    const onSave = vi.fn(async (savedSettings: PluginSettings) => savedSettings);
    const element = buildPanel({
      settings: settings(),
      t: createTranslator("en"),
      onSave,
      onClearLogs: async () => undefined
    });
    await flushAsyncRendering();

    element.querySelector<HTMLButtonElement>('[data-action="addDocSync"]')!.click();
    expect(element.querySelectorAll("[data-docsync-id]")).toHaveLength(2);

    const removeButtons = element.querySelectorAll<HTMLButtonElement>('[data-action="removeDocSync"]');
    removeButtons[1].click();
    expect(element.querySelectorAll("[data-docsync-id]")).toHaveLength(1);

    const enabled = element.querySelector<HTMLInputElement>('[data-field="docSyncEnabled"]')!;
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    await fillFirstTarget(element, "project-1", "/Target");

    element.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flushAsyncRendering();

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0].docSyncs).toHaveLength(1);
  });

  test("saves todo ranges with a selected kanban column", async () => {
    prepareMirrorMocks();
    const onSave = vi.fn(async (savedSettings: PluginSettings) => savedSettings);
    const element = buildPanel({
      settings: settings(),
      t: createTranslator("en"),
      onSave,
      onClearLogs: async () => undefined
    });
    await flushAsyncRendering();

    const ranges = element.querySelector<HTMLElement>('[data-field="ranges"]')!;
    const project = ranges.querySelector<HTMLSelectElement>('[data-field="targetProjectId"]')!;
    project.value = "project-1";
    project.dispatchEvent(new Event("change", { bubbles: true }));
    await flushAsyncRendering();

    const column = ranges.querySelector<HTMLSelectElement>('[data-field="columnId"]')!;
    expect(Array.from(column.options).map((option) => option.textContent)).toEqual(["Whole list", "Later"]);
    column.value = "col-1";
    column.dispatchEvent(new Event("change", { bubbles: true }));

    element.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await flushAsyncRendering();

    expect(onSave).toHaveBeenCalledOnce();
    const savedRange = onSave.mock.calls[0][0].ranges[0];
    expect(savedRange).toMatchObject({ columnId: "col-1", columnName: "Later" });
  });
});
