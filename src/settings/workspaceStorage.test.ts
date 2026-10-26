import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SyncResult } from "../core/types";
import { DEFAULT_SETTINGS, normalizeSettings } from "./defaults";
import { WorkspaceStorage } from "./workspaceStorage";

const temporaryDirectories: string[] = [];

function createStorage() {
  const workspaceDir = mkdtempSync(join(tmpdir(), "siyuan-dida-workspace-"));
  temporaryDirectories.push(workspaceDir);
  return {
    workspaceDir,
    storage: new WorkspaceStorage(join(workspaceDir, "conf"), workspaceDir)
  };
}

function result(index: number): SyncResult {
  const time = new Date(Date.UTC(2026, 7, 11, 0, index)).toISOString();
  return {
    created: index,
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
    startedAt: time,
    finishedAt: time
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WorkspaceStorage", () => {
  test("uses workspace conf for settings and workspace temp for runtime data", () => {
    const { workspaceDir, storage } = createStorage();

    expect(storage.paths).toEqual({
      configuration: join(workspaceDir, "conf", "siyuan-dida-revision-win", "settings.json"),
      runtime: join(workspaceDir, "temp", "siyuan-dida-revision-win", "state.json"),
      log: join(workspaceDir, "temp", "siyuan-dida-revision-win", "sync.log")
    });
  });

  test("persists separated configuration and runtime state", async () => {
    const { storage } = createStorage();
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      cliCommand: "/custom/dida",
      resolvedCliPath: "/resolved/dida",
      resolvedCliPaths: { "darwin:desk": "/resolved/dida" },
      ranges: [
        {
          id: "range-1",
          name: "Work",
          notebookId: "box-1",
          hpathPrefix: "/Work",
          includeChildren: true,
          targetProjectId: "project-1",
          targetProjectName: "Dida Work",
          cursorOffset: 9
        }
      ],
      logs: [result(1)]
    });

    await storage.saveConfiguration(settings);
    await storage.saveRuntime(settings);

    const configuration = JSON.parse(readFileSync(storage.paths.configuration, "utf8"));
    const runtime = JSON.parse(readFileSync(storage.paths.runtime, "utf8"));
    expect(configuration.cliCommand).toBe("/custom/dida");
    expect(configuration).not.toHaveProperty("logs");
    expect(configuration).not.toHaveProperty("resolvedCliPaths");
    expect(configuration.ranges[0]).not.toHaveProperty("cursorOffset");
    expect(runtime).toEqual({
      resolvedCliPath: "/resolved/dida",
      resolvedCliPaths: { "darwin:desk": "/resolved/dida" },
      rangeCursorOffsets: { "range-1": 9 }
    });
  });

  test("keeps only the newest 20 sync results in NDJSON", async () => {
    const { storage } = createStorage();

    for (let index = 0; index < 23; index += 1) {
      await storage.appendLog(result(index));
    }

    const logs = await storage.loadLogs();
    expect(logs).toHaveLength(20);
    expect(logs[0].created).toBe(22);
    expect(logs[19].created).toBe(3);
    expect(readFileSync(storage.paths.log, "utf8").trim().split("\n")).toHaveLength(20);
  });

  test("clears persisted logs", async () => {
    const { storage } = createStorage();
    await storage.appendLog(result(1));

    await storage.clearLogs();

    expect(await storage.loadLogs()).toEqual([]);
    expect(readFileSync(storage.paths.log, "utf8")).toBe("");
  });

  test("records automatic sync runtime and logs without rewriting configuration", async () => {
    const { storage } = createStorage();
    const initial = normalizeSettings({ ...DEFAULT_SETTINGS, cliCommand: "/configured/dida" });
    await storage.saveConfiguration(initial);
    const duringSync = normalizeSettings({
      ...initial,
      cliCommand: "/must-not-replace-config/dida",
      resolvedCliPaths: { "darwin:desk": "/resolved/dida" },
      ranges: [
        {
          id: "range-1",
          name: "Work",
          notebookId: "box-1",
          hpathPrefix: "/Work",
          includeChildren: true,
          targetProjectId: "project-1",
          targetProjectName: "Dida Work",
          cursorOffset: 12
        }
      ]
    });

    const logs = await storage.recordSync(duringSync, result(4));

    expect(JSON.parse(readFileSync(storage.paths.configuration, "utf8")).cliCommand).toBe("/configured/dida");
    expect(JSON.parse(readFileSync(storage.paths.runtime, "utf8")).rangeCursorOffsets).toEqual({ "range-1": 12 });
    expect(logs).toEqual([result(4)]);
  });

  test("migrates legacy settings before removing the legacy file", async () => {
    const { storage } = createStorage();
    const legacy = normalizeSettings({
      ...DEFAULT_SETTINGS,
      cliCommand: "/legacy/dida",
      resolvedCliPaths: { "darwin:desk": "/legacy/dida" },
      ranges: [
        {
          id: "range-1",
          name: "Work",
          notebookId: "box-1",
          hpathPrefix: "/Work",
          includeChildren: true,
          targetProjectId: "project-1",
          targetProjectName: "Dida Work",
          cursorOffset: 15
        }
      ],
      logs: [result(2)]
    });
    const removal = vi.fn(async () => {
      expect(readFileSync(storage.paths.configuration, "utf8")).toContain("/legacy/dida");
      expect(readFileSync(storage.paths.runtime, "utf8")).toContain('"range-1": 15');
      expect(readFileSync(storage.paths.log, "utf8")).toContain('"created":2');
    });

    const loaded = await storage.initialize(async () => legacy, removal);

    expect(loaded.cliCommand).toBe("/legacy/dida");
    expect(loaded.ranges[0].cursorOffset).toBe(15);
    expect(loaded.logs).toEqual([result(2)]);
    expect(removal).toHaveBeenCalledOnce();
  });

  test("migrates settings from the previous package storage directory", async () => {
    const { storage, workspaceDir } = createStorage();
    const legacySettings = join(workspaceDir, "conf", "siyuan-dida", "settings.json");
    const legacyRuntime = join(workspaceDir, "temp", "siyuan-dida", "state.json");
    const legacyLog = join(workspaceDir, "temp", "siyuan-dida", "sync.log");
    mkdirSync(dirname(legacySettings), { recursive: true });
    mkdirSync(dirname(legacyRuntime), { recursive: true });
    writeFileSync(legacySettings, JSON.stringify({
      cliCommand: "/legacy/dida",
      autoSync: true,
      newTaskDate: "none",
      syncIntervalSeconds: 30,
      syncOnStartup: false,
      maxTasksPerRun: 200,
      ranges: []
    }));
    writeFileSync(legacyRuntime, JSON.stringify({
      resolvedCliPath: "/resolved/dida",
      resolvedCliPaths: { "win32:desk": "/resolved/dida" },
      rangeCursorOffsets: {},
      completedWatermarkSecond: 1_700_000_000
    }));
    writeFileSync(legacyLog, `${JSON.stringify(result(2))}\n`);
    const loadLegacy = vi.fn(async () => undefined);
    const removeLegacy = vi.fn(async () => undefined);

    const loaded = await storage.initialize(loadLegacy, removeLegacy);

    expect(loaded).toMatchObject({
      cliCommand: "/legacy/dida",
      autoSync: true,
      completedWatermarkSecond: 1_700_000_000
    });
    expect(loaded.logs).toEqual([result(2)]);
    expect(loadLegacy).not.toHaveBeenCalled();
    expect(removeLegacy).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(storage.paths.configuration, "utf8")).cliCommand).toBe("/legacy/dida");
    expect(JSON.parse(readFileSync(storage.paths.runtime, "utf8")).completedWatermarkSecond).toBe(1_700_000_000);
    expect(readFileSync(storage.paths.log, "utf8")).toContain('"created":2');
  });

  test("does not remove legacy data when migration persistence fails", async () => {
    const { storage, workspaceDir } = createStorage();
    writeFileSync(join(workspaceDir, "conf"), "not-a-directory");
    const removal = vi.fn(async () => undefined);

    await expect(storage.initialize(async () => DEFAULT_SETTINGS, removal)).rejects.toThrow();

    expect(removal).not.toHaveBeenCalled();
  });
});
