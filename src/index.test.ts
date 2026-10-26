// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PluginSettings } from "./settings/defaults";
import type { SettingsPanelOptions } from "./settings/settingsPanel";

const pluginMocks = vi.hoisted(() => ({
  loadedSettings: undefined as PluginSettings | undefined,
  commandCallback: undefined as (() => void) | undefined,
  panelOnSave: undefined as SettingsPanelOptions["onSave"] | undefined,
  panelOptions: undefined as SettingsPanelOptions | undefined,
  panelDestroy: vi.fn(),
  dialogDestroy: undefined as (() => void) | undefined,
  dialogDestroyMethod: vi.fn(),
  topBarButton: undefined as HTMLElement | undefined,
  addTopBar: vi.fn(),
  showMessage: vi.fn(),
  saveConfiguration: vi.fn(async (_settings: PluginSettings) => undefined),
  saveRuntime: vi.fn(async (_settings: PluginSettings) => undefined),
  recordSync: vi.fn(async () => []),
  engineSync: vi.fn(async () => undefined),
  engineConstructor: vi.fn(),
  didaClientConstructor: vi.fn(),
  resolveDidaCommand: vi.fn(async () => ({ command: "dida", version: "0.1.10" }))
}));

vi.mock("siyuan", () => ({
  Dialog: class {
    private readonly destroyCallback?: () => void;

    constructor(options: { content: string; destroyCallback?: () => void }) {
      const content = document.createElement("div");
      content.innerHTML = options.content;
      document.body.append(content);
      pluginMocks.dialogDestroy = options.destroyCallback;
      this.destroyCallback = options.destroyCallback;
    }

    destroy() {
      pluginMocks.dialogDestroyMethod();
      this.destroyCallback?.();
    }
  },
  Plugin: class {
    addTopBar(options: { callback(): void }) {
      pluginMocks.addTopBar(options);
      pluginMocks.topBarButton = document.createElement("button");
      pluginMocks.topBarButton.addEventListener("click", options.callback);
      return pluginMocks.topBarButton;
    }

    addCommand(options: { callback(): void }) {
      pluginMocks.commandCallback = options.callback;
    }
  },
  showMessage: pluginMocks.showMessage
}));

vi.mock("./settings/settingsPanel", () => ({
  buildSettingsPanel: (options: SettingsPanelOptions) => {
    pluginMocks.panelOnSave = options.onSave;
    pluginMocks.panelOptions = options;
    const element = document.createElement("div");
    return { element, destroy: pluginMocks.panelDestroy };
  }
}));

vi.mock("./settings/workspaceStorage", () => ({
  WorkspaceStorage: class {
    initialize = async () => pluginMocks.loadedSettings!;
    saveConfiguration = pluginMocks.saveConfiguration;
    saveRuntime = pluginMocks.saveRuntime;
    recordSync = pluginMocks.recordSync;
    clearLogs = vi.fn(async () => undefined);
  }
}));

vi.mock("./core/syncEngine", () => ({
  SyncEngine: class {
    constructor() {
      pluginMocks.engineConstructor();
    }
    sync = pluginMocks.engineSync;
  }
}));

vi.mock("./dida/cli", () => ({
  resolveDidaCommand: pluginMocks.resolveDidaCommand,
  DidaCliClient: class {
    constructor(...args: unknown[]) {
      pluginMocks.didaClientConstructor(...args);
    }
  }
}));

import SiyuanDidaPlugin from "./index";

function loadedSettings(kind: "duplicate" | "overlap"): PluginSettings {
  const first = {
    id: "range-1",
    name: "Work",
    notebookId: "box-1",
    hpathPrefix: "/Work",
    includeChildren: true,
    targetProjectId: "project-1",
    targetProjectName: "Work",
    cursorOffset: 3
  };
  return {
    cliCommand: "dida",
    resolvedCliPath: "",
    resolvedCliPaths: {},
    autoSync: true,
    newTaskDate: "today",
    syncIntervalSeconds: 15,
    syncOnStartup: true,
    maxTasksPerRun: 200,
    ranges: [
      first,
      {
        ...first,
        id: kind === "duplicate" ? "range-1" : "range-2",
        hpathPrefix: kind === "duplicate" ? "/Personal" : "/Work/Weekly",
        targetProjectId: "project-2"
      }
    ],
    logs: [],
    docSync: {
      enabled: false,
      projectId: "",
      projectName: "",
      columnId: "",
      columnName: "",
      notebookId: "",
      hpath: ""
    }
  };
}

function loadedSettingsWithMissingField(
  field: "notebookId" | "hpathPrefix" | "targetProjectId"
): PluginSettings {
  const settings = loadedSettings("overlap");
  const range = { ...settings.ranges[0], [field]: "" };
  return {
    ...settings,
    ranges: [range]
  };
}

function syncResult(cursorOffset: number) {
  return {
    created: 0,
    recovered: 0,
    updated: 0,
    completed: 0,
    writtenBack: 0,
    failed: 0,
    skipped: 0,
    scanned: 1,
    rangeResults: [],
    rangeCursorOffsets: { "range-1": cursorOffset },
    events: [],
    failures: [],
    startedAt: "2026-08-20T01:02:02.000Z",
    finishedAt: "2026-08-20T01:02:03.000Z"
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

async function openSettings(plugin: SiyuanDidaPlugin) {
  plugin.openSetting();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  expect(pluginMocks.panelOnSave).toBeTypeOf("function");
}

describe("loaded sync-range safety gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pluginMocks.commandCallback = undefined;
    pluginMocks.panelOnSave = undefined;
    pluginMocks.panelOptions = undefined;
    pluginMocks.dialogDestroy = undefined;
    pluginMocks.topBarButton = undefined;
    document.body.replaceChildren();
    Object.defineProperty(window, "siyuan", {
      configurable: true,
      value: {
        config: {
          lang: "en",
          system: { confDir: "/conf", workspaceDir: "/workspace" }
        }
      }
    });
  });

  test.each(["duplicate", "overlap"] as const)(
    "blocks timers and manual engine entry for loaded %s ranges",
    async (kind) => {
      pluginMocks.loadedSettings = loadedSettings(kind);
      const intervalSpy = vi.spyOn(window, "setInterval");
      const timeoutSpy = vi.spyOn(window, "setTimeout");
      const plugin = new SiyuanDidaPlugin({} as never);

      await plugin.onload();
      plugin.onLayoutReady();

      expect(intervalSpy).not.toHaveBeenCalled();
      expect(timeoutSpy).not.toHaveBeenCalled();
      expect(pluginMocks.topBarButton?.getAttribute("aria-label")).toBe("Dida: configuration invalid");
      expect(pluginMocks.saveConfiguration).toHaveBeenCalledOnce();
      expect(pluginMocks.saveConfiguration.mock.calls[0][0]).toMatchObject({
        autoSync: false,
        syncOnStartup: false
      });

      pluginMocks.commandCallback?.();
      await flushPromises();

      expect(pluginMocks.engineSync).not.toHaveBeenCalled();
      expect(pluginMocks.showMessage).toHaveBeenCalledWith(
        expect.stringContaining("Correct and save them in plugin settings before syncing."),
        7000,
        "error"
      );

      await openSettings(plugin);
      expect(pluginMocks.panelOptions!.status.getSnapshot()).toMatchObject({
        state: "failed",
        message: expect.stringContaining("Saved sync ranges are invalid")
      });
      const states: string[] = [];
      pluginMocks.panelOptions!.status.subscribe((snapshot) => states.push(snapshot.state));
      await pluginMocks.panelOptions!.onSyncNow();
      expect(states).not.toContain("syncing");
      expect(states.at(-1)).toBe("failed");
      expect(pluginMocks.engineSync).not.toHaveBeenCalled();
    }
  );

  test.each([
    ["notebookId", "Sync range 1 is missing a notebook."],
    ["hpathPrefix", "Sync range 1 is missing a document path."],
    ["targetProjectId", "Sync range 1 is missing a Dida list."]
  ] as const)(
    "retains and blocks a persisted range with missing %s",
    async (field, validationMessage) => {
      pluginMocks.loadedSettings = loadedSettingsWithMissingField(field);
      const intervalSpy = vi.spyOn(window, "setInterval");
      const timeoutSpy = vi.spyOn(window, "setTimeout");
      const plugin = new SiyuanDidaPlugin({} as never);

      await plugin.onload();

      const retainedSettings = (plugin as unknown as { settings: PluginSettings }).settings;
      expect(retainedSettings.ranges).toHaveLength(1);
      expect(retainedSettings.ranges[0][field]).toBe("");
      expect(pluginMocks.saveConfiguration.mock.calls[0][0].ranges).toHaveLength(1);
      expect(pluginMocks.saveConfiguration.mock.calls[0][0].ranges[0][field]).toBe("");
      expect(intervalSpy).not.toHaveBeenCalled();
      expect(timeoutSpy).not.toHaveBeenCalled();

      pluginMocks.commandCallback?.();
      await flushPromises();

      expect(pluginMocks.engineSync).not.toHaveBeenCalled();
      expect(pluginMocks.showMessage).toHaveBeenCalledWith(
        `Saved sync ranges are invalid: ${validationMessage} Correct and save them in plugin settings before syncing.`,
        7000,
        "error"
      );
    }
  );

  test.each(["configuration", "runtime"] as const)(
    "keeps an invalid live safety gate when %s persistence rejects a valid save",
    async (failedWrite) => {
      pluginMocks.loadedSettings = loadedSettingsWithMissingField("notebookId");
      const plugin = new SiyuanDidaPlugin({} as never);
      await plugin.onload();
      await openSettings(plugin);

      const previousSettings = (plugin as unknown as { settings: PluginSettings }).settings;
      const saveError = new Error(`${failedWrite} write failed`);
      if (failedWrite === "configuration") {
        pluginMocks.saveConfiguration.mockRejectedValueOnce(saveError);
      } else {
        pluginMocks.saveRuntime.mockRejectedValueOnce(saveError);
      }
      const intervalSpy = vi.spyOn(window, "setInterval");
      const clearIntervalSpy = vi.spyOn(window, "clearInterval");
      const validCandidate: PluginSettings = {
        ...previousSettings,
        autoSync: true,
        syncOnStartup: true,
        ranges: previousSettings.ranges.map((range) => ({
          ...range,
          notebookId: "box-1"
        }))
      };

      await expect(pluginMocks.panelOnSave!(validCandidate)).rejects.toThrow(saveError.message);

      expect(pluginMocks.panelOptions!.status.getSnapshot()).toMatchObject({
        state: "failed",
        message: expect.stringContaining("Saved sync ranges are invalid")
      });

      const liveSettings = (plugin as unknown as { settings: PluginSettings }).settings;
      expect(liveSettings).toBe(previousSettings);
      expect(liveSettings).toMatchObject({ autoSync: false, syncOnStartup: false });
      expect(liveSettings.ranges[0].notebookId).toBe("");
      expect(intervalSpy).not.toHaveBeenCalled();
      expect(clearIntervalSpy).not.toHaveBeenCalled();
      if (failedWrite === "runtime") {
        expect(pluginMocks.saveConfiguration).toHaveBeenLastCalledWith(previousSettings);
      }

      pluginMocks.commandCallback?.();
      await flushPromises();
      pluginMocks.topBarButton?.click();
      await flushPromises();

      expect(pluginMocks.engineSync).not.toHaveBeenCalled();
      expect(pluginMocks.showMessage).toHaveBeenLastCalledWith(
        expect.stringContaining("Correct and save them in plugin settings before syncing."),
        7000,
        "error"
      );
    }
  );

  test("uses the active locale for the sync completion summary", async () => {
    const validSettings = loadedSettings("overlap");
    validSettings.autoSync = false;
    validSettings.syncOnStartup = false;
    validSettings.ranges = validSettings.ranges.slice(0, 1);
    pluginMocks.loadedSettings = validSettings;
    pluginMocks.engineSync.mockResolvedValueOnce({
      created: 2,
      recovered: 1,
      updated: 3,
      completed: 4,
      writtenBack: 5,
      failed: 0,
      skipped: 6,
      scanned: 7,
      rangeResults: [],
      rangeCursorOffsets: { "range-1": 0 },
      events: [],
      failures: [],
      startedAt: "2026-06-27T01:00:00.000Z",
      finishedAt: "2026-06-27T01:00:01.000Z"
    } as never);
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    plugin.onLayoutReady();

    pluginMocks.topBarButton?.click();
    await flushPromises();
    await flushPromises();

    expect(pluginMocks.showMessage).toHaveBeenCalledWith(
      "Dida sync complete: scanned 7, created 2, recovered 1, updated 3, completed 4, written back 5, skipped 6, failed 0"
    );
  });

  test("publishes pending only after a valid save corrects an invalid configuration", async () => {
    pluginMocks.loadedSettings = loadedSettingsWithMissingField("notebookId");
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    await openSettings(plugin);
    const previous = (plugin as unknown as { settings: PluginSettings }).settings;
    const validCandidate: PluginSettings = {
      ...previous,
      ranges: previous.ranges.map((range) => ({ ...range, notebookId: "box-1" }))
    };
    let finishSave!: () => void;
    pluginMocks.saveConfiguration.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => { finishSave = () => resolve(undefined); })
    );

    expect(pluginMocks.panelOptions!.status.getSnapshot().state).toBe("failed");
    const save = pluginMocks.panelOnSave!(validCandidate);
    await flushPromises();
    expect(pluginMocks.panelOptions!.status.getSnapshot().state).toBe("failed");

    finishSave();
    await save;
    expect(pluginMocks.panelOptions!.status.getSnapshot()).toEqual({ state: "pending" });
  });

  test("invalid loaded configuration overrides a previously successful log status", async () => {
    const invalid = loadedSettingsWithMissingField("notebookId");
    invalid.logs = [syncResult(0)];
    pluginMocks.loadedSettings = invalid;
    const plugin = new SiyuanDidaPlugin({} as never);

    await plugin.onload();
    await openSettings(plugin);

    const snapshot = pluginMocks.panelOptions!.status.getSnapshot();
    expect(snapshot).toMatchObject({
      state: "failed",
      message: expect.stringContaining("missing a notebook")
    });
    expect(snapshot).not.toHaveProperty("latestResult");
  });
});

describe("sync status and plugin lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pluginMocks.commandCallback = undefined;
    pluginMocks.panelOnSave = undefined;
    pluginMocks.panelOptions = undefined;
    pluginMocks.dialogDestroy = undefined;
    pluginMocks.topBarButton = undefined;
    document.body.replaceChildren();
    Object.defineProperty(window, "siyuan", {
      configurable: true,
      value: {
        config: {
          lang: "en",
          system: { confDir: "/conf", workspaceDir: "/workspace" }
        }
      }
    });
    const valid = loadedSettings("overlap");
    valid.autoSync = false;
    valid.syncOnStartup = false;
    valid.ranges = valid.ranges.slice(0, 1);
    pluginMocks.loadedSettings = valid;
  });

  test("creates the top-bar action only when layout is ready", async () => {
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();

    expect(pluginMocks.addTopBar).not.toHaveBeenCalled();
    plugin.onLayoutReady();
    expect(pluginMocks.addTopBar).toHaveBeenCalledOnce();
    expect(pluginMocks.topBarButton?.getAttribute("aria-label")).toBe("Dida: pending sync");
  });

  test.each([
    [0, "success"],
    [2, "failed"]
  ] as const)("initializes from the latest stored log with %i failures", async (failed, expectedState) => {
    pluginMocks.loadedSettings!.logs = [{
      created: 1,
      updated: 0,
      completed: 0,
      writtenBack: 0,
      failed,
      skipped: 0,
      scanned: 1,
      rangeResults: [],
      rangeCursorOffsets: {},
      events: [],
      failures: [],
      startedAt: "2026-08-20T01:02:02.000Z",
      finishedAt: "2026-08-20T01:02:03.000Z"
    }];
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    plugin.onLayoutReady();
    plugin.openSetting();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(pluginMocks.panelOptions!.status.getSnapshot()).toMatchObject({
      state: expectedState,
      lastFinishedAt: "2026-08-20T01:02:03.000Z"
    });
    expect(pluginMocks.panelOptions!.status.getSnapshot().latestResult?.recovered ?? 0).toBe(0);

    plugin.onLayoutReady();
    expect(pluginMocks.topBarButton?.getAttribute("aria-label")).toContain(failed ? "sync failed" : "synced");
  });

  test("publishes syncing then a completed result and uses the same manual entry", async () => {
    let resolveSync!: (result: undefined) => void;
    pluginMocks.engineSync.mockImplementationOnce(() => new Promise<undefined>((resolve) => { resolveSync = resolve; }));
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    plugin.onLayoutReady();
    plugin.openSetting();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const transitions: string[] = [];
    pluginMocks.panelOptions!.status.subscribe((snapshot) => transitions.push(snapshot.state));
    const run = pluginMocks.panelOptions!.onSyncNow();
    await flushPromises();
    expect(transitions.at(-1)).toBe("syncing");
    expect(pluginMocks.topBarButton?.getAttribute("aria-label")).toBe("Dida: syncing…");
    await pluginMocks.panelOptions!.onSyncNow();
    expect(pluginMocks.engineSync).toHaveBeenCalledOnce();
    expect(pluginMocks.showMessage).toHaveBeenCalledWith(
      "Dida sync is already running; skipped this trigger"
    );

    resolveSync({
      created: 0, recovered: 1, updated: 0, completed: 0, writtenBack: 0,
      failed: 0, skipped: 0, scanned: 1, rangeResults: [],
      rangeCursorOffsets: { "range-1": 0 }, events: [], failures: [],
      startedAt: "2026-08-20T01:02:02.000Z", finishedAt: "2026-08-20T01:02:03.000Z"
    } as never);
    await run;

    expect(pluginMocks.didaClientConstructor).toHaveBeenCalledWith(
      "dida",
      { cliVersion: "0.1.10" }
    );
    expect(transitions.at(-1)).toBe("success");
    expect(pluginMocks.panelOptions!.status.getSnapshot().latestResult?.recovered).toBe(1);
    expect(pluginMocks.topBarButton?.getAttribute("aria-label")).toContain("synced");
  });

  test("publishes caught errors while silent sync suppresses messages", async () => {
    pluginMocks.engineSync.mockRejectedValueOnce(new Error("offline"));
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    plugin.openSetting();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await (plugin as unknown as { runSync(options: { silentSkip: boolean }): Promise<void> })
      .runSync({ silentSkip: true });
    expect(pluginMocks.panelOptions!.status.getSnapshot()).toMatchObject({
      state: "failed",
      message: "offline",
      latestResult: { failed: 1 }
    });
    expect(pluginMocks.showMessage).not.toHaveBeenCalled();
  });

  test("backs off and reports rate limiting when a sync result hits the Dida quota", async () => {
    pluginMocks.engineSync.mockResolvedValueOnce({
      ...syncResult(0),
      failed: 1,
      failures: [{ message: 'DIDA API 错误 500: {"errorCode":"exceed_query_limit","errorMessage":"Query rate limit exceeded."}' }]
    } as never);
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    plugin.openSetting();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await pluginMocks.panelOptions!.onSyncNow();

    const snapshot = pluginMocks.panelOptions!.status.getSnapshot();
    expect(snapshot.state).toBe("failed");
    expect(snapshot.message).toContain("rate limited");
    expect((plugin as unknown as { backoff: { isBackingOff(): boolean } }).backoff.isBackingOff()).toBe(true);
  });

  test("clears backoff after a successful sync", async () => {
    pluginMocks.engineSync
      .mockResolvedValueOnce({
        ...syncResult(0),
        failed: 1,
        failures: [{ message: "exceed_query_limit" }]
      } as never)
      .mockResolvedValueOnce(syncResult(0) as never);
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    plugin.openSetting();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await pluginMocks.panelOptions!.onSyncNow();
    expect((plugin as unknown as { backoff: { isBackingOff(): boolean } }).backoff.isBackingOff()).toBe(true);

    await pluginMocks.panelOptions!.onSyncNow();
    expect((plugin as unknown as { backoff: { isBackingOff(): boolean } }).backoff.isBackingOff()).toBe(false);
    expect(pluginMocks.panelOptions!.status.getSnapshot().state).toBe("success");
  });

  test("passes the persisted completed watermark to the engine and stores the next one", async () => {
    pluginMocks.loadedSettings!.completedWatermarkSecond = 1_700_000_000;
    pluginMocks.engineSync.mockResolvedValueOnce({
      ...syncResult(0),
      completedWatermarkSecond: 1_700_000_100
    } as never);
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    plugin.openSetting();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await pluginMocks.panelOptions!.onSyncNow();

    expect(pluginMocks.engineSync).toHaveBeenCalledWith(
      expect.objectContaining({ completedWatermarkSecond: 1_700_000_000 })
    );
    expect(pluginMocks.recordSync).toHaveBeenCalledWith(
      expect.objectContaining({ completedWatermarkSecond: 1_700_000_100 }),
      expect.anything()
    );
  });

  test("rebuildCompletedBaseline clears the watermark and triggers a full sync", async () => {
    pluginMocks.loadedSettings!.completedWatermarkSecond = 1_700_000_000;
    pluginMocks.engineSync.mockResolvedValue(syncResult(0) as never);
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();

    await plugin.rebuildCompletedBaseline();

    expect(pluginMocks.saveRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ completedWatermarkSecond: undefined })
    );
    expect(pluginMocks.engineSync).toHaveBeenCalledWith(
      expect.objectContaining({ completedWatermarkSecond: undefined })
    );
  });

  test("publishes a failed result even when persisting the error log also fails", async () => {
    pluginMocks.engineSync.mockRejectedValueOnce(new Error("offline"));
    pluginMocks.recordSync.mockRejectedValueOnce(new Error("log unavailable"));
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    plugin.openSetting();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(pluginMocks.panelOptions!.onSyncNow()).resolves.toBeUndefined();
    expect(pluginMocks.panelOptions!.status.getSnapshot()).toMatchObject({
      state: "failed",
      message: "offline",
      latestResult: { failed: 1 }
    });
  });

  test("clears tracked timers, destroys the dialog view, and ignores work after unload", async () => {
    pluginMocks.loadedSettings!.autoSync = true;
    pluginMocks.loadedSettings!.syncOnStartup = true;
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    plugin.openSetting();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    plugin.onunload();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalled();

    pluginMocks.dialogDestroy?.();
    expect(pluginMocks.panelDestroy).toHaveBeenCalledOnce();

    plugin.onLayoutReady();
    pluginMocks.commandCallback?.();
    await flushPromises();
    expect(pluginMocks.addTopBar).not.toHaveBeenCalled();
    expect(pluginMocks.engineSync).not.toHaveBeenCalled();
  });

  test("cancels a pending settings mount when unloaded", async () => {
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();

    plugin.openSetting();
    plugin.onunload();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(pluginMocks.panelOptions).toBeUndefined();
  });

  test("destroys retained settings dialogs during unload", async () => {
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    plugin.openSetting();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    plugin.onunload();

    expect(pluginMocks.dialogDestroyMethod).toHaveBeenCalledOnce();
    expect(pluginMocks.panelDestroy).toHaveBeenCalledOnce();
  });

  test("removes a dialog from unload tracking when its destroy callback runs", async () => {
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    plugin.openSetting();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    pluginMocks.dialogDestroy?.();
    plugin.onunload();

    expect(pluginMocks.panelDestroy).toHaveBeenCalledOnce();
    expect(pluginMocks.dialogDestroyMethod).not.toHaveBeenCalled();
  });

  test("stops after deferred CLI discovery resolves when unloaded", async () => {
    let resolveCommand!: (value: { command: string; version: string }) => void;
    pluginMocks.resolveDidaCommand.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCommand = resolve; })
    );
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    plugin.openSetting();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const status = pluginMocks.panelOptions!.status;
    const run = pluginMocks.panelOptions!.onSyncNow();
    await flushPromises();
    expect(status.getSnapshot().state).toBe("syncing");
    const snapshotAtUnload = status.getSnapshot();

    plugin.onunload();
    resolveCommand({ command: "/resolved/dida", version: "test" });
    await run;

    expect(pluginMocks.engineConstructor).not.toHaveBeenCalled();
    expect(pluginMocks.engineSync).not.toHaveBeenCalled();
    expect(pluginMocks.recordSync).not.toHaveBeenCalled();
    expect(status.getSnapshot()).toBe(snapshotAtUnload);
    expect((plugin as unknown as { syncRunning: boolean }).syncRunning).toBe(false);
  });

  test("waits for a settings save before syncing the saved configuration", async () => {
    let finishConfigurationSave!: () => void;
    pluginMocks.saveConfiguration.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => { finishConfigurationSave = () => resolve(undefined); })
    );
    pluginMocks.engineSync.mockResolvedValueOnce(syncResult(11) as never);
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    await openSettings(plugin);
    const current = (plugin as unknown as { settings: PluginSettings }).settings;
    const submitted: PluginSettings = {
      ...current,
      cliCommand: "saved-dida",
      ranges: current.ranges.map((range) => ({ ...range, name: "Saved range" }))
    };

    const save = pluginMocks.panelOnSave!(submitted);
    await flushPromises();
    const sync = pluginMocks.panelOptions!.onSyncNow();
    await flushPromises();

    expect(pluginMocks.engineConstructor).not.toHaveBeenCalled();
    finishConfigurationSave();
    await save;
    await sync;

    const finalSettings = (plugin as unknown as { settings: PluginSettings }).settings;
    expect(finalSettings.cliCommand).toBe("saved-dida");
    expect(finalSettings.ranges[0]).toMatchObject({ name: "Saved range", cursorOffset: 11 });
    expect(pluginMocks.panelOptions!.status.getSnapshot().state).toBe("success");
  });

  test("waits for sync persistence before saving while preserving the latest cursor and status", async () => {
    let finishSync!: (result: never) => void;
    pluginMocks.engineSync.mockImplementationOnce(
      () => new Promise<never>((resolve) => { finishSync = resolve; })
    );
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    await openSettings(plugin);
    const sync = pluginMocks.panelOptions!.onSyncNow();
    await flushPromises();
    expect(pluginMocks.engineSync).toHaveBeenCalledOnce();

    const current = (plugin as unknown as { settings: PluginSettings }).settings;
    const submitted: PluginSettings = {
      ...current,
      ranges: current.ranges.map((range) => ({ ...range, name: "Saved after sync" }))
    };
    const save = pluginMocks.panelOnSave!(submitted);
    await flushPromises();
    expect(pluginMocks.saveConfiguration).not.toHaveBeenCalled();

    finishSync(syncResult(17) as never);
    await sync;
    await save;

    const finalSettings = (plugin as unknown as { settings: PluginSettings }).settings;
    expect(finalSettings.ranges[0]).toMatchObject({ name: "Saved after sync", cursorOffset: 17 });
    expect(pluginMocks.panelOptions!.status.getSnapshot().state).toBe("success");
  });

  test("completes sync and resets the running flag when a status subscriber throws", async () => {
    pluginMocks.engineSync.mockResolvedValueOnce(syncResult(4) as never);
    const plugin = new SiyuanDidaPlugin({} as never);
    await plugin.onload();
    await openSettings(plugin);
    const status = pluginMocks.panelOptions!.status;
    status.subscribe((snapshot) => {
      if (snapshot.state === "syncing") throw new Error("view failed");
    });
    const laterSubscriber = vi.fn();
    status.subscribe(laterSubscriber);

    await expect(pluginMocks.panelOptions!.onSyncNow()).resolves.toBeUndefined();

    expect(pluginMocks.engineSync).toHaveBeenCalledOnce();
    expect(laterSubscriber).toHaveBeenLastCalledWith(expect.objectContaining({ state: "success" }));
    expect((plugin as unknown as { syncRunning: boolean }).syncRunning).toBe(false);
  });
});
