import type { DocSyncConfig, NewTaskDate, SyncRange, SyncResult } from "../core/types";
import {
  createRangeId,
  inspectLoadedRanges,
  normalizeDocumentPath,
  type RangeIdFactory,
  type RangeValidationError
} from "./ranges";

export interface PluginSettings {
  cliCommand: string;
  resolvedCliPath: string;
  resolvedCliPaths: Record<string, string>;
  autoSync: boolean;
  newTaskDate: NewTaskDate;
  syncIntervalSeconds: number;
  syncOnStartup: boolean;
  maxTasksPerRun: number;
  ranges: SyncRange[];
  logs: SyncResult[];
  /** Dida list -> SiYuan document mirror configuration. */
  docSync: DocSyncConfig;
  /** Epoch-second watermark for incremental completed-tasks snapshots. */
  completedWatermarkSecond?: number;
}

export type StoredSyncRange = Omit<SyncRange, "cursorOffset">;

export interface StoredPluginSettings {
  cliCommand: string;
  autoSync: boolean;
  newTaskDate: NewTaskDate;
  syncIntervalSeconds: number;
  syncOnStartup: boolean;
  maxTasksPerRun: number;
  ranges: StoredSyncRange[];
  docSync?: DocSyncConfig;
}

export interface PluginRuntimeState {
  resolvedCliPath: string;
  resolvedCliPaths: Record<string, string>;
  rangeCursorOffsets: Record<string, number>;
  completedWatermarkSecond?: number;
}

export const DEFAULT_DOC_SYNC: DocSyncConfig = {
  enabled: false,
  projectId: "",
  projectName: "",
  columnId: "",
  columnName: "",
  notebookId: "",
  hpath: ""
};

export const DEFAULT_SETTINGS: PluginSettings = {
  cliCommand: "dida",
  resolvedCliPath: "",
  resolvedCliPaths: {},
  autoSync: false,
  newTaskDate: "today",
  syncIntervalSeconds: 15,
  syncOnStartup: false,
  maxTasksPerRun: 200,
  ranges: [],
  logs: [],
  docSync: DEFAULT_DOC_SYNC
};

export function normalizeDocSyncConfig(
  value: Partial<DocSyncConfig> | null | undefined
): DocSyncConfig {
  return {
    enabled: value?.enabled === true,
    projectId: normalizeText(value?.projectId),
    projectName: normalizeText(value?.projectName),
    columnId: normalizeText(value?.columnId),
    columnName: normalizeText(value?.columnName),
    notebookId: normalizeText(value?.notebookId),
    hpath: normalizeDocumentPath(normalizeText(value?.hpath))
  };
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeSettings(value: Partial<PluginSettings> | null | undefined): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    newTaskDate: value?.newTaskDate === "none" ? "none" : "today",
    resolvedCliPaths: value?.resolvedCliPaths ?? {},
    ranges: value?.ranges ?? [],
    logs: value?.logs ?? [],
    docSync: normalizeDocSyncConfig(value?.docSync)
  };
}

export interface LoadedSettingsPreparation {
  settings: PluginSettings;
  error?: RangeValidationError;
  changed: boolean;
}

export function prepareLoadedSettings(
  value: PluginSettings,
  createId: RangeIdFactory = createRangeId
): LoadedSettingsPreparation {
  const current = normalizeSettings(value);
  const inspected = inspectLoadedRanges(current.ranges, createId);
  const settings: PluginSettings = {
    ...current,
    autoSync: inspected.error ? false : current.autoSync,
    syncOnStartup: inspected.error ? false : current.syncOnStartup,
    ranges: inspected.ranges
  };

  return {
    settings,
    error: inspected.error,
    changed: JSON.stringify(settings) !== JSON.stringify(current)
  };
}

export function settingsForSave(current: PluginSettings, updates: Partial<PluginSettings>): PluginSettings {
  const next = normalizeSettings({
    ...current,
    ...updates
  });
  if (next.cliCommand !== current.cliCommand) {
    next.resolvedCliPath = "";
    next.resolvedCliPaths = {};
  }
  return next;
}

export function reconcileSettingsForSave(
  current: PluginSettings,
  submitted: PluginSettings
): PluginSettings {
  const latestCursorByRangeId = new Map(
    current.ranges.map((range) => [range.id, range.cursorOffset ?? 0])
  );
  const commandChanged = submitted.cliCommand !== current.cliCommand;
  return normalizeSettings({
    ...submitted,
    resolvedCliPath: commandChanged ? submitted.resolvedCliPath : current.resolvedCliPath,
    resolvedCliPaths: commandChanged ? submitted.resolvedCliPaths : current.resolvedCliPaths,
    logs: current.logs,
    ranges: submitted.ranges.map((range) => ({
      ...range,
      cursorOffset: latestCursorByRangeId.get(range.id) ?? range.cursorOffset ?? 0
    }))
  });
}

export function splitSettingsForStorage(settings: PluginSettings): {
  configuration: StoredPluginSettings;
  runtime: PluginRuntimeState;
} {
  return {
    configuration: {
      cliCommand: settings.cliCommand,
      autoSync: settings.autoSync,
      newTaskDate: settings.newTaskDate,
      syncIntervalSeconds: settings.syncIntervalSeconds,
      syncOnStartup: settings.syncOnStartup,
      maxTasksPerRun: settings.maxTasksPerRun,
      ranges: settings.ranges.map(({ cursorOffset: _cursorOffset, ...range }) => range),
      docSync: { ...settings.docSync }
    },
    runtime: {
      resolvedCliPath: settings.resolvedCliPath,
      resolvedCliPaths: { ...settings.resolvedCliPaths },
      completedWatermarkSecond: settings.completedWatermarkSecond,
      rangeCursorOffsets: Object.fromEntries(
        settings.ranges
          .filter((range) => typeof range.cursorOffset === "number")
          .map((range) => [range.id, range.cursorOffset as number])
      )
    }
  };
}

export function mergeStoredSettings(
  configuration: Partial<StoredPluginSettings> | null | undefined,
  runtime: Partial<PluginRuntimeState> | null | undefined,
  logs: SyncResult[] = []
): PluginSettings {
  const ranges = (configuration?.ranges ?? []).map((range) => ({
    ...range,
    cursorOffset: runtime?.rangeCursorOffsets?.[range.id] ?? 0
  }));
  return normalizeSettings({
    ...configuration,
    resolvedCliPath: runtime?.resolvedCliPath ?? "",
    resolvedCliPaths: runtime?.resolvedCliPaths ?? {},
    completedWatermarkSecond: runtime?.completedWatermarkSecond,
    ranges,
    logs
  });
}
