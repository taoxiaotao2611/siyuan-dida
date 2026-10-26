import { describe, expect, test } from "vitest";
import {
  DEFAULT_SETTINGS,
  mergeStoredSettings,
  normalizeSettings,
  prepareLoadedSettings,
  reconcileSettingsForSave,
  settingsForSave,
  splitSettingsForStorage
} from "./defaults";

function configuredRange(overrides: Record<string, unknown> = {}) {
  return {
    id: "range-1",
    name: "Work",
    notebookId: "box-1",
    hpathPrefix: "/Work",
    includeChildren: true,
    targetProjectId: "project-1",
    targetProjectName: "Work list",
    cursorOffset: 7,
    ...overrides
  };
}

describe("prepareLoadedSettings", () => {
  test.each([
    {
      label: "duplicate IDs",
      ranges: [
        configuredRange(),
        configuredRange({ hpathPrefix: "/Personal", targetProjectId: "project-2" })
      ],
      code: "duplicate_range_id"
    },
    {
      label: "overlapping paths",
      ranges: [
        configuredRange({ id: "range-1" }),
        configuredRange({ id: "range-2", hpathPrefix: "/Work/Weekly" })
      ],
      code: "overlapping_ranges"
    }
  ])("disables automatic and startup sync for loaded $label without removing ranges", ({ ranges, code }) => {
    const result = prepareLoadedSettings(
      normalizeSettings({ ...DEFAULT_SETTINGS, autoSync: true, syncOnStartup: true, ranges })
    );

    expect(result.settings.ranges).toHaveLength(2);
    expect(result.settings).toMatchObject({ autoSync: false, syncOnStartup: false });
    expect(result.error).toMatchObject({ code });
    expect(result.changed).toBe(true);
  });

  test("persists harmless normalization once while retaining the matching runtime cursor", () => {
    const loaded = normalizeSettings({
      ...DEFAULT_SETTINGS,
      ranges: [configuredRange({ id: "", hpathPrefix: " Work//Weekly/// ", cursorOffset: 43 })]
    });

    const first = prepareLoadedSettings(loaded, () => "range-generated");
    const second = prepareLoadedSettings(first.settings, () => "range-unexpected");

    expect(first).toMatchObject({ changed: true, error: undefined });
    expect(first.settings.ranges[0]).toMatchObject({
      id: "range-generated",
      hpathPrefix: "/Work/Weekly",
      cursorOffset: 43
    });
    expect(second.changed).toBe(false);
    expect(second.settings.ranges[0].id).toBe("range-generated");
  });
});

describe("settingsForSave", () => {
  test("defaults legacy settings to creating new tasks with today's date", () => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      newTaskDate: undefined
    });

    expect(settings.newTaskDate).toBe("today");
  });

  test("keeps a resolved CLI path when the configured command is unchanged", () => {
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      cliCommand: "dida",
      resolvedCliPath: "/opt/homebrew/bin/dida",
      resolvedCliPaths: {
        "darwin:desk-1": "/opt/homebrew/bin/dida"
      }
    });

    expect(settingsForSave(current, { cliCommand: "dida" }).resolvedCliPath).toBe("/opt/homebrew/bin/dida");
    expect(settingsForSave(current, { cliCommand: "dida" }).resolvedCliPaths).toEqual({
      "darwin:desk-1": "/opt/homebrew/bin/dida"
    });
  });

  test("clears resolved CLI path caches when the configured command changes", () => {
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      cliCommand: "dida",
      resolvedCliPath: "/opt/homebrew/bin/dida",
      resolvedCliPaths: {
        "darwin:desk-1": "/opt/homebrew/bin/dida",
        "win32:desk-2": "C:\\Users\\me\\AppData\\Roaming\\npm\\dida.cmd"
      }
    });

    const next = settingsForSave(current, { cliCommand: "/custom/bin/dida" });

    expect(next.resolvedCliPath).toBe("");
    expect(next.resolvedCliPaths).toEqual({});
  });
});

describe("reconcileSettingsForSave", () => {
  test("preserves the latest runtime cursor for matching range IDs", () => {
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      ranges: [configuredRange({ cursorOffset: 82 })]
    });
    const submitted = normalizeSettings({
      ...current,
      ranges: [configuredRange({ targetProjectId: "project-2", cursorOffset: 7 })]
    });

    const canonical = reconcileSettingsForSave(current, submitted);

    expect(canonical.ranges[0]).toMatchObject({ targetProjectId: "project-2", cursorOffset: 82 });
  });

  test("keeps the submitted cursor for a newly added range", () => {
    const current = normalizeSettings({ ...DEFAULT_SETTINGS, ranges: [] });
    const submitted = normalizeSettings({
      ...DEFAULT_SETTINGS,
      ranges: [configuredRange({ id: "range-new", cursorOffset: 4 })]
    });

    expect(reconcileSettingsForSave(current, submitted).ranges[0].cursorOffset).toBe(4);
  });
});

describe("workspace storage shapes", () => {
  test("separates stable configuration from device paths, cursors, and logs", () => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      resolvedCliPath: "/opt/homebrew/bin/dida",
      resolvedCliPaths: { "darwin:desk-1": "/opt/homebrew/bin/dida" },
      ranges: [
        {
          id: "range-1",
          name: "Work",
          notebookId: "box-1",
          hpathPrefix: "/Work",
          includeChildren: true,
          targetProjectId: "project-1",
          targetProjectName: "Dida Work",
          cursorOffset: 42
        }
      ],
      logs: [{ startedAt: "2026-08-11T00:00:00.000Z" } as never]
    });

    const stored = splitSettingsForStorage(settings);

    expect(stored.configuration).not.toHaveProperty("resolvedCliPath");
    expect(stored.configuration).not.toHaveProperty("resolvedCliPaths");
    expect(stored.configuration).not.toHaveProperty("logs");
    expect(stored.configuration.ranges[0]).not.toHaveProperty("cursorOffset");
    expect(stored.runtime).toEqual({
      resolvedCliPath: "/opt/homebrew/bin/dida",
      resolvedCliPaths: { "darwin:desk-1": "/opt/homebrew/bin/dida" },
      rangeCursorOffsets: { "range-1": 42 }
    });
  });

  test("merges persisted configuration, runtime state, and logs", () => {
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      cliCommand: "/custom/dida",
      ranges: [
        {
          id: "range-1",
          name: "Work",
          notebookId: "box-1",
          hpathPrefix: "/Work",
          includeChildren: true,
          targetProjectId: "project-1",
          targetProjectName: "Dida Work",
          cursorOffset: 7
        }
      ],
      logs: [{ startedAt: "2026-08-11T00:00:00.000Z" } as never]
    });
    const stored = splitSettingsForStorage(current);

    const merged = mergeStoredSettings(stored.configuration, stored.runtime, current.logs);

    expect(merged.cliCommand).toBe("/custom/dida");
    expect(merged.ranges[0].cursorOffset).toBe(7);
    expect(merged.logs).toEqual(current.logs);
  });

  test("round-trips the completed watermark through runtime storage", () => {
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      completedWatermarkSecond: 1_700_000_000,
      ranges: []
    });

    const stored = splitSettingsForStorage(current);
    expect(stored.runtime.completedWatermarkSecond).toBe(1_700_000_000);
    expect(stored.configuration).not.toHaveProperty("completedWatermarkSecond");

    const merged = mergeStoredSettings(stored.configuration, stored.runtime, []);
    expect(merged.completedWatermarkSecond).toBe(1_700_000_000);
  });

  test("omits the watermark from runtime storage when unset", () => {
    const stored = splitSettingsForStorage(normalizeSettings({ ...DEFAULT_SETTINGS, ranges: [] }));
    expect(stored.runtime.completedWatermarkSecond).toBeUndefined();
    const merged = mergeStoredSettings(stored.configuration, stored.runtime, []);
    expect(merged.completedWatermarkSecond).toBeUndefined();
  });
});

describe("list to document sync settings", () => {
  test("defaults document sync to an empty list", () => {
    expect(normalizeSettings({}).docSyncs).toEqual([]);
  });

  test("normalizes multiple entries with whitespace and target paths", () => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      docSyncs: [
        {
          id: "docsync-1",
          enabled: true,
          projectId: " project-1 ",
          projectName: " Courses ",
          columnId: " col-1 ",
          columnName: " Later ",
          notebookId: " box-1 ",
          hpath: " Target//Sub/// "
        },
        {
          id: "docsync-2",
          enabled: false,
          projectId: "project-2",
          projectName: "Home",
          columnId: "",
          columnName: "",
          notebookId: "box-1",
          hpath: "Home"
        }
      ]
    });

    expect(settings.docSyncs).toHaveLength(2);
    expect(settings.docSyncs[0]).toEqual({
      id: "docsync-1",
      enabled: true,
      projectId: "project-1",
      projectName: "Courses",
      columnId: "col-1",
      columnName: "Later",
      notebookId: "box-1",
      hpath: "/Target/Sub",
      sortByTime: false
    });
    expect(settings.docSyncs[1].hpath).toBe("/Home");
  });

  test("migrates the 1.3.x single document sync object into the list", () => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      docSync: {
        enabled: true,
        projectId: "project-1",
        projectName: "Courses",
        columnId: "",
        columnName: "",
        notebookId: "box-1",
        hpath: "/Target"
      }
    } as never);

    expect(settings.docSyncs).toHaveLength(1);
    expect(settings.docSyncs[0]).toMatchObject({
      enabled: true,
      projectId: "project-1",
      notebookId: "box-1",
      hpath: "/Target"
    });
    expect(settings.docSyncs[0].id).toMatch(/^docsync-/);
  });

  test("round-trips every document sync entry through configuration storage", () => {
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      docSyncs: [
        {
          id: "docsync-1",
          enabled: true,
          projectId: "project-1",
          projectName: "Courses",
          columnId: "col-1",
          columnName: "Later",
          notebookId: "box-1",
          hpath: "/Target"
        }
      ]
    });

    const stored = splitSettingsForStorage(current);
    expect(stored.configuration.docSyncs).toEqual(current.docSyncs);
    expect(mergeStoredSettings(stored.configuration, stored.runtime, []).docSyncs).toEqual(
      current.docSyncs
    );
  });

  test("tolerates older stored settings without document sync", () => {
    const merged = mergeStoredSettings({ cliCommand: "dida" }, {}, []);
    expect(merged.docSyncs).toEqual([]);
  });
});
