import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SyncResult } from "../core/types";
import {
  DEFAULT_SETTINGS,
  mergeStoredSettings,
  normalizeSettings,
  splitSettingsForStorage,
  type PluginRuntimeState,
  type PluginSettings,
  type StoredPluginSettings
} from "./defaults";

const PLUGIN_STORAGE_DIRECTORY = "siyuan-dida-revision-win";
/** Storage directory used before the 1.3.1 package rename; migrated on first load. */
const LEGACY_PLUGIN_STORAGE_DIRECTORIES = ["siyuan-dida"];
const MAX_LOG_RECORDS = 20;
let temporaryFileSequence = 0;

export interface WorkspaceStoragePaths {
  configuration: string;
  runtime: string;
  log: string;
}

interface JsonFile<T> {
  exists: boolean;
  value?: T;
}

export class WorkspaceStorage {
  readonly paths: WorkspaceStoragePaths;

  constructor(
    private readonly confDir: string,
    private readonly workspaceDir: string
  ) {
    this.paths = this.pathsFor(PLUGIN_STORAGE_DIRECTORY);
  }

  async initialize(
    loadLegacy: () => Promise<unknown>,
    removeLegacy: () => Promise<unknown>
  ): Promise<PluginSettings> {
    const configurationFile = await readJsonFile<Partial<StoredPluginSettings>>(this.paths.configuration);
    if (configurationFile.exists) {
      const settings = await this.loadFromFiles(configurationFile.value);
      if (configurationFile.value) {
        const legacy = await loadLegacy();
        if (isObject(legacy)) {
          await removeLegacy();
        }
      }
      return settings;
    }

    // Migrate the storage left behind by the previous package name once, then
    // keep using the renamed directory.
    const migrated = await this.loadFromLegacyDirectories();
    if (migrated) {
      await this.saveRuntime(migrated);
      await this.saveLogs(migrated.logs);
      await this.saveConfiguration(migrated);
      return migrated;
    }

    const legacy = await loadLegacy();
    if (!isObject(legacy)) {
      const runtime = (await readJsonFile<Partial<PluginRuntimeState>>(this.paths.runtime)).value;
      return mergeStoredSettings(DEFAULT_SETTINGS, runtime, await this.loadLogs());
    }

    const settings = normalizeSettings(legacy as Partial<PluginSettings>);
    await this.saveRuntime(settings);
    await this.saveLogs(settings.logs);
    await this.saveConfiguration(settings);
    await removeLegacy();
    return settings;
  }

  async saveConfiguration(settings: PluginSettings): Promise<void> {
    const { configuration } = splitSettingsForStorage(settings);
    await writeJsonAtomically(this.paths.configuration, configuration);
  }

  async saveRuntime(settings: PluginSettings): Promise<void> {
    const { runtime } = splitSettingsForStorage(settings);
    await writeJsonAtomically(this.paths.runtime, runtime);
  }

  async appendLog(result: SyncResult): Promise<SyncResult[]> {
    const logs = [result, ...(await this.loadLogs())].slice(0, MAX_LOG_RECORDS);
    await this.saveLogs(logs);
    return logs;
  }

  async recordSync(settings: PluginSettings, result: SyncResult): Promise<SyncResult[]> {
    await this.saveRuntime(settings);
    return this.appendLog(result);
  }

  async loadLogs(): Promise<SyncResult[]> {
    return readLogsFile(this.paths.log);
  }

  async clearLogs(): Promise<void> {
    await writeTextAtomically(this.paths.log, "");
  }

  private pathsFor(directory: string): WorkspaceStoragePaths {
    return {
      configuration: join(this.confDir, directory, "settings.json"),
      runtime: join(this.workspaceDir, "temp", directory, "state.json"),
      log: join(this.workspaceDir, "temp", directory, "sync.log")
    };
  }

  private async loadFromLegacyDirectories(): Promise<PluginSettings | undefined> {
    for (const directory of LEGACY_PLUGIN_STORAGE_DIRECTORIES) {
      const paths = this.pathsFor(directory);
      const configuration = await readJsonFile<Partial<StoredPluginSettings>>(paths.configuration);
      if (!configuration.exists) {
        continue;
      }
      const runtime = (await readJsonFile<Partial<PluginRuntimeState>>(paths.runtime)).value;
      return mergeStoredSettings(configuration.value, runtime, await readLogsFile(paths.log));
    }
    return undefined;
  }

  private async saveLogs(logs: SyncResult[]): Promise<void> {
    const content = logs.slice(0, MAX_LOG_RECORDS).map((result) => JSON.stringify(result)).join("\n");
    await writeTextAtomically(this.paths.log, content ? `${content}\n` : "");
  }

  private async loadFromFiles(configuration: Partial<StoredPluginSettings> | undefined): Promise<PluginSettings> {
    const runtime = (await readJsonFile<Partial<PluginRuntimeState>>(this.paths.runtime)).value;
    return mergeStoredSettings(configuration, runtime, await this.loadLogs());
  }
}

async function readJsonFile<T>(path: string): Promise<JsonFile<T>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { exists: false };
    }
    throw error;
  }

  try {
    return { exists: true, value: JSON.parse(content) as T };
  } catch {
    return { exists: true };
  }
}

async function readLogsFile(path: string): Promise<SyncResult[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SyncResult];
      } catch {
        return [];
      }
    })
    .slice(0, MAX_LOG_RECORDS);
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomically(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  temporaryFileSequence += 1;
  const temporaryPath = join(parent, `.${basename(path)}.${process.pid}.${temporaryFileSequence}.tmp`);
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT" || (error as NodeJS.ErrnoException)?.code === "ENOTDIR";
}
