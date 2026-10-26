import "./index.scss";
import { Dialog, Plugin, showMessage } from "siyuan";
import { SyncEngine } from "./core/syncEngine";
import { DocSyncEngine } from "./core/docSync";
import { resolveDidaCommand, DidaCliClient } from "./dida/cli";
import { DidaCliGateway } from "./dida/gateway";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  prepareLoadedSettings,
  reconcileSettingsForSave,
  type PluginSettings
} from "./settings/defaults";
import { getResolvedCliPathForCurrentDevice, withResolvedCliPathForCurrentDevice } from "./settings/deviceCli";
import { summarizeSyncLog } from "./settings/logFormat";
import { buildSettingsPanel } from "./settings/settingsPanel";
import {
  createSyncStatusController,
  type SyncStatusController,
  type SyncStatusSnapshot
} from "./settings/statusPanel";
import { WorkspaceStorage } from "./settings/workspaceStorage";
import { getRangeValidationMessage, type RangeValidationError } from "./settings/ranges";
import { SiYuanRepository } from "./siyuan/repository";
import { SiYuanDocRepository } from "./siyuan/docRepository";
import { setSyncTooltip } from "./syncTooltip";
import type { DocSyncSummary, SyncResult } from "./core/types";
import { createBackoffController, isRateLimitError, type BackoffController } from "./core/rateLimit";
import { createTranslator, type Translate } from "./i18n";

const LEGACY_STORAGE_NAME = "settings.json";

export default class SiyuanDidaPlugin extends Plugin {
  private settings!: PluginSettings;
  private syncTimer: number | undefined;
  private startupTimer: number | undefined;
  private settingsMountTimers = new Set<number>();
  private settingsViews = new Set<{ destroy(): void }>();
  private settingsDialogs = new Set<Dialog>();
  private operationTail: Promise<void> = Promise.resolve();
  private syncRunning = false;
  private syncButton: HTMLElement | undefined;
  private t!: Translate;
  private storage!: WorkspaceStorage;
  private status!: SyncStatusController;
  private statusTooltip = "";
  private rangeConfigurationError: RangeValidationError | undefined;
  private backoff: BackoffController = createBackoffController();
  private unloaded = false;

  async onload() {
    this.unloaded = false;
    const config = window.siyuan.config;
    if (!config) {
      throw new Error("SiYuan configuration is unavailable");
    }
    this.t = createTranslator(config.lang ?? navigator.language);
    this.storage = new WorkspaceStorage(
      config.system.confDir,
      config.system.workspaceDir
    );
    const loadedSettings = await this.storage.initialize(
      () => this.loadData(LEGACY_STORAGE_NAME),
      () => this.removeData(LEGACY_STORAGE_NAME)
    );
    const prepared = prepareLoadedSettings(loadedSettings);
    this.settings = prepared.settings;
    this.rangeConfigurationError = prepared.error;
    const initialStatus = this.rangeConfigurationError
      ? this.invalidConfigurationStatus(this.rangeConfigurationError)
      : statusFromLatestLog(this.settings.logs[0]);
    this.status = createSyncStatusController(initialStatus);
    this.statusTooltip = this.rangeConfigurationError
      ? this.t("configurationInvalidStatus")
      : this.tooltipForStatus(initialStatus);
    if (prepared.changed) {
      await this.persistSettings(this.settings);
    }
    this.addCommand({
      langKey: "sync-dida-now",
      hotkey: "",
      callback: () => void this.runSync()
    });

    this.resetTimer();
    if (!this.rangeConfigurationError && this.settings.syncOnStartup) {
      this.startupTimer = window.setTimeout(() => {
        this.startupTimer = undefined;
        if (!this.unloaded) void this.runSync();
      }, 1000);
    }
  }

  onLayoutReady() {
    if (this.unloaded || this.syncButton) return;
    this.syncButton = this.addTopBar({
      icon: "iconRefresh",
      title: this.t("syncDida"),
      position: "right",
      callback: () => void this.runSync()
    });
    this.updateStatus(this.statusTooltip);
  }

  onunload() {
    this.unloaded = true;
    if (this.syncTimer !== undefined) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
    if (this.startupTimer !== undefined) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    this.settingsMountTimers.forEach((timer) => window.clearTimeout(timer));
    this.settingsMountTimers.clear();
    for (const dialog of [...this.settingsDialogs]) {
      dialog.destroy();
    }
    this.settingsDialogs.clear();
    this.settingsViews.forEach((view) => view.destroy());
    this.settingsViews.clear();
  }

  openSetting() {
    if (this.unloaded) return;
    const mountId = `dida-sync-settings-${Date.now()}`;
    let view: ReturnType<typeof buildSettingsPanel> | undefined;
    let mountTimer: number | undefined;
    let dialog!: Dialog;
    dialog = new Dialog({
      title: this.t("settingsTitle"),
      content: `<div id="${mountId}"></div>`,
      width: "760px",
      destroyCallback: () => {
        this.settingsDialogs.delete(dialog);
        if (mountTimer !== undefined) {
          window.clearTimeout(mountTimer);
          this.settingsMountTimers.delete(mountTimer);
          mountTimer = undefined;
        }
        if (view) {
          if (this.settingsViews.delete(view)) {
            view.destroy();
          }
          view = undefined;
        }
      }
    });
    this.settingsDialogs.add(dialog);

    mountTimer = window.setTimeout(() => {
      const currentTimer = mountTimer;
      mountTimer = undefined;
      if (currentTimer !== undefined) this.settingsMountTimers.delete(currentTimer);
      if (this.unloaded) return;
      const mount = document.getElementById(mountId);
      if (!mount) {
        return;
      }
      view = buildSettingsPanel({
        settings: this.settings,
        t: this.t,
        status: this.status,
        onSyncNow: () => this.runSync(),
        onSave: (settings) => this.enqueueOperation(async () => {
          if (this.unloaded) return this.settings;
          const previousSettings = this.settings;
          const previousConfigurationError = this.rangeConfigurationError;
          const reconciled = reconcileSettingsForSave(previousSettings, normalizeSettings(settings));
          const prepared = prepareLoadedSettings(reconciled);
          await this.persistSettings(prepared.settings, previousSettings);
          if (this.unloaded) return this.settings;
          this.settings = prepared.settings;
          this.rangeConfigurationError = prepared.error;
          this.resetTimer();
          if (this.rangeConfigurationError) {
            this.publishStatus(this.invalidConfigurationStatus(this.rangeConfigurationError));
          } else if (previousConfigurationError) {
            this.publishStatus({ state: "pending" });
          }
          return this.settings;
        }),
        onClearLogs: () => this.enqueueOperation(async () => {
          if (this.unloaded) return;
          await this.storage.clearLogs();
          if (this.unloaded) return;
          this.settings.logs = [];
        }),
        onRebuildBaseline: () => this.rebuildCompletedBaseline()
      });
      this.settingsViews.add(view);
      mount.appendChild(view.element);
    }, 0);
    this.settingsMountTimers.add(mountTimer);
  }

  private async persistSettings(settings: PluginSettings, previousSettings?: PluginSettings) {
    let configurationSaved = false;
    try {
      await this.storage.saveConfiguration(settings);
      configurationSaved = true;
      await this.storage.saveRuntime(settings);
    } catch (error) {
      if (configurationSaved && previousSettings) {
        try {
          await this.storage.saveConfiguration(previousSettings);
        } catch (rollbackError) {
          throw new SettingsPersistenceRollbackError(error, rollbackError);
        }
      }
      throw error;
    }
  }

  private resetTimer() {
    if (this.syncTimer !== undefined) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }

    if (this.unloaded || this.rangeConfigurationError || !this.settings.autoSync) {
      return;
    }

    const intervalMs = Math.max(5, this.settings.syncIntervalSeconds) * 1000;
    this.syncTimer = window.setInterval(() => {
      if (this.backoff.isBackingOff()) {
        return;
      }
      void this.runSync({ silentSkip: true });
    }, intervalMs);
  }

  private async runSync(options: { silentSkip?: boolean } = {}) {
    if (this.unloaded) return;
    if (this.rangeConfigurationError) {
      this.publishStatus(this.invalidConfigurationStatus(this.rangeConfigurationError));
      if (!options.silentSkip) {
        showMessage(
          this.t("configurationInvalidSyncBlocked", {
            message: getRangeValidationMessage(this.rangeConfigurationError, this.t)
          }),
          7000,
          "error"
        );
      }
      return;
    }

    if (this.syncRunning) {
      if (!options.silentSkip) {
        showMessage(this.t("syncInProgress"));
      }
      return;
    }

    if (this.settings.ranges.length === 0) {
      showMessage(this.t("configureRanges"), 5000, "info");
      return;
    }

    this.syncRunning = true;
    try {
      this.publishStatus({
        ...this.status.getSnapshot(),
        state: "syncing",
        message: undefined
      });
      await this.enqueueOperation(() => this.executeSync(options));
    } finally {
      this.syncRunning = false;
    }
  }

  private async executeSync(options: { silentSkip?: boolean }) {
    try {
      if (this.unloaded) return;
      const resolved = await resolveDidaCommand(getResolvedCliPathForCurrentDevice(this.settings) || this.settings.cliCommand || "dida");
      if (this.unloaded) return;
      this.settings = withResolvedCliPathForCurrentDevice(this.settings, resolved.command);
      const didaGateway = new DidaCliGateway(new DidaCliClient(resolved.command, {
        cliVersion: resolved.version
      }));
      const engine = new SyncEngine(new SiYuanRepository(), didaGateway, this.t);
      const result = await engine.sync({
        maxTasksPerRun: this.settings.maxTasksPerRun || DEFAULT_SETTINGS.maxTasksPerRun,
        newTaskDate: this.settings.newTaskDate,
        ranges: this.settings.ranges,
        completedWatermarkSecond: this.settings.completedWatermarkSecond
      });
      if (this.unloaded) return;
      if (this.settings.docSyncs.some((entry) => entry.enabled)) {
        await this.runDocSyncs(didaGateway, result);
        if (this.unloaded) return;
      }
      if (typeof result.completedWatermarkSecond === "number") {
        this.settings.completedWatermarkSecond = result.completedWatermarkSecond;
      }
      this.settings.ranges = this.settings.ranges.map((range) => ({
        ...range,
        cursorOffset: result.rangeCursorOffsets[range.id] ?? range.cursorOffset ?? 0
      }));
      this.settings.logs = await this.storage.recordSync(this.settings, result);
      if (this.unloaded) return;
      if (this.resultHasRateLimit(result)) {
        this.applyRateLimitBackoff(result);
        return;
      }
      this.backoff.onSuccess();
      this.publishStatus({
        state: result.failed > 0 ? "failed" : "success",
        latestResult: result,
        lastFinishedAt: result.finishedAt,
        message: result.failed > 0 ? result.failures[0]?.message : undefined
      });
      if (!options.silentSkip) {
        showMessage(this.t("syncComplete", { summary: summarizeSyncLog(result, this.t) }));
      }
    } catch (error) {
      if (this.unloaded) return;
      if (isRateLimitError(error)) {
        const result = createErrorSyncResult((error as Error).message);
        this.settings.logs = await this.safeRecordSync(result);
        this.applyRateLimitBackoff(result);
        return;
      }
      this.backoff.onSuccess();
      const result = createErrorSyncResult((error as Error).message);
      this.publishStatus({
        state: "failed",
        latestResult: result,
        lastFinishedAt: result.finishedAt,
        message: (error as Error).message
      });
      this.settings.logs = await this.safeRecordSync(result);
      if (this.unloaded) return;
      if (!options.silentSkip) {
        showMessage(this.t("syncFailed", { message: (error as Error).message }), 7000, "error");
      }
    }
  }

  private async runDocSyncs(didaGateway: DidaCliGateway, result: SyncResult): Promise<void> {
    const summaries: DocSyncSummary[] = [];
    for (const config of this.settings.docSyncs) {
      if (!config.enabled || this.unloaded) {
        continue;
      }
      try {
        const engine = new DocSyncEngine({
          dida: didaGateway,
          siyuan: new SiYuanDocRepository(),
          t: this.t
        });
        const outcome = await engine.sync(config);
        summaries.push(outcome.summary);
        result.events.push(...outcome.events);
        result.failures.push(...outcome.failures);
        result.failed += outcome.failures.length;
      } catch (error) {
        const message = this.t("docSyncFailed", {
          message: error instanceof Error ? error.message : String(error)
        });
        result.failures.push({ message });
        result.events.push({ time: new Date().toISOString(), level: "error", message });
        result.failed += 1;
      }
    }
    if (summaries.length > 0) {
      result.docSyncs = summaries;
    }
    result.finishedAt = new Date().toISOString();
  }

  async rebuildCompletedBaseline() {
    if (this.unloaded) return;
    await this.enqueueOperation(async () => {
      if (this.unloaded) return;
      this.settings.completedWatermarkSecond = undefined;
      await this.storage.saveRuntime(this.settings);
    });
    await this.runSync();
  }

  private resultHasRateLimit(result: SyncResult): boolean {
    return result.failures.some((failure) => isRateLimitError(failure.message))
      || result.events.some((event) => isRateLimitError(event.message));
  }

  private applyRateLimitBackoff(result: SyncResult) {
    this.backoff.onRateLimit();
    const retrySeconds = Math.ceil(this.backoff.currentDelayMs() / 1000);
    this.publishStatus({
      state: "failed",
      latestResult: result,
      lastFinishedAt: result.finishedAt,
      message: this.t("statusRateLimited", { seconds: retrySeconds })
    });
  }

  private async safeRecordSync(result: SyncResult): Promise<SyncResult[]> {
    try {
      return await this.storage.recordSync(this.settings, result);
    } catch {
      // The live failure remains visible even when its log cannot be persisted.
      return this.settings.logs;
    }
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private updateStatus(text: string) {
    this.statusTooltip = text;
    if (this.syncButton) {
      setSyncTooltip(this.syncButton, text);
    }
  }

  private publishStatus(snapshot: SyncStatusSnapshot) {
    if (this.unloaded) return;
    this.status.publish(snapshot);
    this.updateStatus(this.tooltipForStatus(snapshot));
  }

  private tooltipForStatus(snapshot: SyncStatusSnapshot): string {
    if (this.rangeConfigurationError && snapshot.state === "failed") {
      return this.t("configurationInvalidStatus");
    }
    if (snapshot.state === "syncing") return this.t("statusSyncing");
    if (snapshot.state === "pending" || !snapshot.lastFinishedAt) return this.t("syncPending");
    const time = new Date(snapshot.lastFinishedAt).toLocaleTimeString();
    return snapshot.state === "failed"
      ? this.t("statusFailed", { time })
      : this.t("statusSynced", { time });
  }

  private invalidConfigurationStatus(error: RangeValidationError): SyncStatusSnapshot {
    return {
      state: "failed",
      message: this.t("configurationInvalidSyncBlocked", {
        message: getRangeValidationMessage(error, this.t)
      })
    };
  }

}

function statusFromLatestLog(latest: SyncResult | undefined): SyncStatusSnapshot {
  if (!latest) return { state: "pending" };
  return {
    state: latest.failed > 0 ? "failed" : "success",
    latestResult: latest,
    lastFinishedAt: latest.finishedAt,
    message: latest.failed > 0 ? latest.failures[0]?.message : undefined
  };
}

class SettingsPersistenceRollbackError extends Error {
  readonly persistenceError: unknown;
  readonly rollbackError: unknown;

  constructor(persistenceError: unknown, rollbackError: unknown) {
    super(
      `Failed to persist settings (${errorMessage(persistenceError)}) and failed to restore the previous configuration (${errorMessage(rollbackError)})`
    );
    this.name = "SettingsPersistenceRollbackError";
    this.persistenceError = persistenceError;
    this.rollbackError = rollbackError;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createErrorSyncResult(message: string): SyncResult {
  const now = new Date().toISOString();
  return {
    created: 0,
    recovered: 0,
    updated: 0,
    completed: 0,
    writtenBack: 0,
    failed: 1,
    skipped: 0,
    scanned: 0,
    rangeResults: [],
    rangeCursorOffsets: {},
    events: [{ time: now, level: "error", message }],
    failures: [{ message }],
    startedAt: now,
    finishedAt: now
  };
}
