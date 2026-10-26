import { showMessage } from "siyuan";
import type { DidaProjectColumn, DocSyncConfig, SyncRange } from "../core/types";
import { DidaCliClient, type DidaProject, resolveDidaCommand } from "../dida/cli";
import { listNotebooks, type SiYuanNotebook } from "../siyuan/api";
import { settingsForSave, type PluginSettings } from "./defaults";
import { getResolvedCliPathForCurrentDevice, withResolvedCliPathForCurrentDevice } from "./deviceCli";
import {
  createEmptyDocSyncConfig,
  prepareDocSyncsForSave
} from "./docSyncs";
import { formatSyncLogs } from "./logFormat";
import {
  createEmptyRange,
  getRangeValidationMessage,
  getTargetProjectWarning,
  prepareRangesForSave
} from "./ranges";
import type { Translate } from "../i18n";
import { buildStatusPanel, type SyncStatusController } from "./statusPanel";

export interface SettingsPanelOptions {
  settings: PluginSettings;
  t: Translate;
  status: SyncStatusController;
  onSyncNow(): void | Promise<void>;
  onSave(settings: PluginSettings): Promise<PluginSettings>;
  onClearLogs(): Promise<void>;
  onRebuildBaseline?(): void | Promise<void>;
}

export interface SettingsPanelView {
  element: HTMLElement;
  destroy(): void;
}

interface PanelState {
  ranges: SyncRange[];
  notebooks: SiYuanNotebook[];
  projects: DidaProject[];
  originalTargetProjectIds: WeakMap<SyncRange, string>;
  docSyncs: DocSyncConfig[];
  columnsByProject: Map<string, DidaProjectColumn[]>;
  loadColumns: (projectId: string) => void;
  t: Translate;
}

export function buildSettingsPanel(options: SettingsPanelOptions): SettingsPanelView {
  const { t } = options;
  const eventController = new AbortController();
  const eventOptions = { signal: eventController.signal };
  let disposed = false;
  const ranges = options.settings.ranges.length > 0
    ? options.settings.ranges.map((range) => ({ ...range }))
    : [createEmptyRange(1)];
  const originalTargetProjectIds = new WeakMap<SyncRange, string>();
  ranges.forEach((range) => originalTargetProjectIds.set(range, range.targetProjectId));
  const state: PanelState = {
    ranges,
    notebooks: [],
    projects: [],
    originalTargetProjectIds,
    docSyncs: options.settings.docSyncs.length > 0
      ? options.settings.docSyncs.map((entry) => ({ ...entry }))
      : [createEmptyDocSyncConfig(1)],
    columnsByProject: new Map(),
    loadColumns: (projectId: string) => {
      void loadColumnsByProject(projectId);
    },
    t
  };

  const root = document.createElement("div");
  root.className = "dida-sync-settings";
  root.innerHTML = `
    <div class="dida-sync-summary">
      <div>
        <div class="dida-sync-title">${t("connectionAndSync")}</div>
        <div class="dida-sync-muted">${t("deviceDiscovery")}</div>
      </div>
      <div class="dida-sync-summary__actions">
        <span class="dida-sync-version">v${escapeHtml(__PLUGIN_VERSION__)}</span>
        <button class="b3-button b3-button--text" data-action="save">${t("saveSettings")}</button>
      </div>
    </div>

    <div class="dida-sync-grid">
      <section class="dida-sync-section">
        <div class="dida-sync-section__title">Dida CLI</div>
        <label class="dida-sync-field">
          <span>${t("commandOrPath")}</span>
          <input class="b3-text-field" data-field="cliCommand" placeholder="dida" />
        </label>
        <div class="dida-sync-actions">
          <button class="b3-button" data-action="test">${t("testConnection")}</button>
          <button class="b3-button b3-button--outline" data-action="loadProjects">${t("refreshProjects")}</button>
        </div>
      </section>

      <section class="dida-sync-section">
        <div class="dida-sync-section__title">${t("automaticSync")}</div>
        <label class="dida-sync-toggle">
          <input type="checkbox" data-field="autoSync" />
          <span>${t("enableAutomaticSync")}</span>
        </label>
        <label class="dida-sync-field">
          <span>${t("syncInterval")}</span>
          <input class="b3-text-field" data-field="syncIntervalSeconds" type="number" min="10" />
        </label>
        <div class="dida-sync-muted">${t("syncIntervalHint")}</div>
        <div class="dida-sync-field">
          <span>${t("completedWatermarkLabel")}</span>
          <span class="dida-sync-muted" data-field="completedWatermark"></span>
        </div>
        <div class="dida-sync-actions">
          <button class="b3-button b3-button--outline" data-action="rebuildBaseline">${t("rebuildBaseline")}</button>
        </div>
        <label class="dida-sync-field">
          <span>${t("newTaskDate")}</span>
          <select class="b3-select fn__block" data-field="newTaskDate">
            <option value="today">${t("newTaskDateToday")}</option>
            <option value="none">${t("newTaskDateNone")}</option>
          </select>
        </label>
      </section>
    </div>

    <section class="dida-sync-section">
      <div class="dida-sync-section__bar">
        <div>
          <div class="dida-sync-section__title">${t("syncRanges")}</div>
          <div class="dida-sync-muted">${t("selectSourceAndTarget")}</div>
          <div class="dida-sync-muted">${t("rangeColumnHint")}</div>
        </div>
        <div class="dida-sync-actions">
          <button class="b3-button b3-button--outline" data-action="loadNotebooks">${t("refreshNotebooks")}</button>
          <button class="b3-button" data-action="addRange">${t("addRange")}</button>
        </div>
      </div>
      <div class="dida-sync-ranges" data-field="ranges"></div>
    </section>

    <section class="dida-sync-section" data-field="docSyncSection"></section>

    <section class="dida-sync-section">
      <div class="dida-sync-section__bar">
        <div>
          <div class="dida-sync-section__title">${t("syncLogs")}</div>
          <div class="dida-sync-muted">${t("syncLogHelp")}</div>
        </div>
        <div class="dida-sync-actions">
          <button class="b3-button b3-button--outline" data-action="copyLogs">${t("copyLogs")}</button>
          <button class="b3-button b3-button--outline" data-action="clearLogs">${t("clearLogs")}</button>
        </div>
      </div>
      <pre class="dida-sync-log" data-field="logs"></pre>
    </section>
  `;

  const statusView = buildStatusPanel({
    status: options.status,
    t,
    locale: window.siyuan?.config?.lang ?? navigator.language,
    onSyncNow: options.onSyncNow
  });
  root.querySelector(".dida-sync-summary")!.after(statusView.element);

  const cliCommand = root.querySelector<HTMLInputElement>('[data-field="cliCommand"]')!;
  const autoSync = root.querySelector<HTMLInputElement>('[data-field="autoSync"]')!;
  const syncIntervalSeconds = root.querySelector<HTMLInputElement>('[data-field="syncIntervalSeconds"]')!;
  const newTaskDate = root.querySelector<HTMLSelectElement>('[data-field="newTaskDate"]')!;
  const rangesEl = root.querySelector<HTMLElement>('[data-field="ranges"]')!;
  const logs = root.querySelector<HTMLElement>('[data-field="logs"]')!;
  const watermarkEl = root.querySelector<HTMLElement>('[data-field="completedWatermark"]')!;
  const docSyncSection = root.querySelector<HTMLElement>('[data-field="docSyncSection"]')!;

  cliCommand.value = options.settings.cliCommand;
  autoSync.checked = options.settings.autoSync;
  syncIntervalSeconds.value = String(options.settings.syncIntervalSeconds);
  newTaskDate.value = options.settings.newTaskDate;
  logs.textContent = formatSyncLogs(options.settings.logs.slice(0, 10), t);
  const renderWatermark = () => {
    const watermark = options.settings.completedWatermarkSecond;
    watermarkEl.textContent = typeof watermark === "number" && watermark > 0
      ? new Date(watermark * 1000).toLocaleString(window.siyuan?.config?.lang ?? navigator.language)
      : t("completedWatermarkNone");
  };
  renderWatermark();

  const renderRanges = () => {
    if (disposed) return;
    rangesEl.replaceChildren(...state.ranges.map((range, index) =>
      renderRange(range, index, state, renderRanges, eventController.signal)
    ));
  };

  const renderDocSyncSection = () => {
    if (disposed) return;
    docSyncSection.innerHTML = `
      <div class="dida-sync-section__bar">
        <div>
          <div class="dida-sync-section__title">${t("docSyncTitle")}</div>
          <div class="dida-sync-muted">${t("docSyncHelp")}</div>
        </div>
        <div class="dida-sync-actions">
          <button class="b3-button" data-action="addDocSync">${t("docSyncAddEntry")}</button>
        </div>
      </div>
      ${state.docSyncs.map((entry, index) => renderDocSyncEntry(entry, index, state)).join("")}
    `;
  };

  async function loadColumnsByProject(projectId: string) {
    if (!projectId || state.columnsByProject.has(projectId)) {
      return;
    }
    try {
      const resolved = await resolveDidaCommand(
        getResolvedCliPathForCurrentDevice(options.settings) || options.settings.cliCommand || "dida"
      );
      const data = await new DidaCliClient(resolved.command).getProjectData(projectId);
      if (disposed) return;
      state.columnsByProject.set(projectId, data.columns);
      renderRanges();
      renderDocSyncSection();
    } catch (error) {
      if (disposed) return;
      showMessage(t("docSyncColumnsFailed", { message: (error as Error).message }), 5000, "error");
    }
  }

  const docSyncEntryFromEvent = (event: Event): DocSyncConfig | undefined => {
    const target = event.target as HTMLElement;
    const wrapper = target.closest("[data-docsync-id]") as HTMLElement | null;
    const id = wrapper?.dataset.docsyncId;
    return state.docSyncs.find((entry) => entry.id === id);
  };

  docSyncSection.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-action="addDocSync"]')) {
      state.docSyncs.push(createEmptyDocSyncConfig(state.docSyncs.length + 1));
      renderDocSyncSection();
      return;
    }
    const removeButton = target.closest('[data-action="removeDocSync"]');
    if (!removeButton) return;
    const entry = docSyncEntryFromEvent(event);
    state.docSyncs = state.docSyncs.filter((item) => item.id !== entry?.id);
    if (state.docSyncs.length === 0) {
      state.docSyncs.push(createEmptyDocSyncConfig(1));
    }
    renderDocSyncSection();
  }, eventOptions);

  docSyncSection.addEventListener("change", (event) => {
    const entry = docSyncEntryFromEvent(event);
    if (!entry) return;
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    switch (target.dataset.field) {
      case "docSyncEnabled":
        entry.enabled = (target as HTMLInputElement).checked;
        return;
      case "docSyncNotebook":
        entry.notebookId = target.value;
        return;
      case "docSyncProject": {
        if (entry.projectId === target.value) return;
        entry.projectId = target.value;
        entry.projectName = state.projects.find((item) => item.id === target.value)?.name ?? "";
        entry.columnId = "";
        entry.columnName = "";
        renderDocSyncSection();
        void loadColumnsByProject(target.value);
        return;
      }
      case "docSyncColumn":
        entry.columnId = target.value;
        entry.columnName = (state.columnsByProject.get(entry.projectId) ?? [])
          .find((column) => column.id === target.value)?.name ?? "";
        return;
    }
  }, eventOptions);

  docSyncSection.addEventListener("input", (event) => {
    const entry = docSyncEntryFromEvent(event);
    if (!entry) return;
    const target = event.target as HTMLInputElement;
    if (target.dataset.field === "docSyncHpath") {
      entry.hpath = target.value;
    } else if (target.dataset.field === "docSyncNotebook" && !state.notebooks.length) {
      entry.notebookId = target.value;
    } else if (target.dataset.field === "docSyncProject" && !state.projects.length) {
      entry.projectId = target.value;
    }
  }, eventOptions);

  const rebaseAfterSave = (savedSettings: PluginSettings) => {
    options.settings = savedSettings;
    state.ranges = savedSettings.ranges.length > 0
      ? savedSettings.ranges.map((range) => ({ ...range }))
      : [createEmptyRange(1)];
    state.originalTargetProjectIds = new WeakMap<SyncRange, string>();
    state.ranges.forEach((range) => {
      state.originalTargetProjectIds.set(range, range.targetProjectId);
    });
    state.docSyncs = savedSettings.docSyncs.length > 0
      ? savedSettings.docSyncs.map((entry) => ({ ...entry }))
      : [createEmptyDocSyncConfig(1)];
    cliCommand.value = savedSettings.cliCommand;
    autoSync.checked = savedSettings.autoSync;
    syncIntervalSeconds.value = String(savedSettings.syncIntervalSeconds);
    newTaskDate.value = savedSettings.newTaskDate;
    renderWatermark();
    renderDocSyncSection();
    renderRanges();
  };

  const rememberResolvedCliPath = async (resolvedCommand: string) => {
    if (disposed) return false;
    const savedSettings = await options.onSave(
      withResolvedCliPathForCurrentDevice(options.settings, resolvedCommand)
    );
    if (disposed) return false;
    options.settings = savedSettings;
    return true;
  };

  root.querySelector('[data-action="test"]')?.addEventListener("click", async () => {
    try {
      const resolved = await resolveDidaCommand(cliCommand.value || "dida");
      if (disposed || !await rememberResolvedCliPath(resolved.command)) return;
      showMessage(t("cliAvailable", { command: resolved.command, version: resolved.version }));
      const projects = await new DidaCliClient(resolved.command).listProjects();
      if (disposed) return;
      state.projects = projects;
      renderDocSyncSection();
      renderRanges();
    } catch (error) {
      if (disposed) return;
      showMessage(t("cliUnavailable", { message: (error as Error).message }), 5000, "error");
    }
  }, eventOptions);

  root.querySelector('[data-action="loadProjects"]')?.addEventListener("click", async () => {
    try {
      const resolved = await resolveDidaCommand(cliCommand.value || "dida");
      if (disposed || !await rememberResolvedCliPath(resolved.command)) return;
      const projects = await new DidaCliClient(resolved.command).listProjects();
      if (disposed) return;
      state.projects = projects;
      renderDocSyncSection();
      renderRanges();
      showMessage(t("projectsRefreshed"));
    } catch (error) {
      if (disposed) return;
      showMessage(t("projectsRefreshFailed", { message: (error as Error).message }), 5000, "error");
    }
  }, eventOptions);

  root.querySelector('[data-action="loadNotebooks"]')?.addEventListener("click", async () => {
    try {
      const notebooks = await listNotebooks();
      if (disposed) return;
      state.notebooks = notebooks;
      renderDocSyncSection();
      renderRanges();
      showMessage(t("notebooksRefreshed"));
    } catch (error) {
      if (disposed) return;
      showMessage(t("notebooksRefreshFailed", { message: (error as Error).message }), 5000, "error");
    }
  }, eventOptions);

  root.querySelector('[data-action="addRange"]')?.addEventListener("click", () => {
    const range = createEmptyRange(state.ranges.length + 1);
    state.originalTargetProjectIds.set(range, "");
    state.ranges.push(range);
    renderRanges();
  }, eventOptions);

  root.querySelector('[data-action="rebuildBaseline"]')?.addEventListener("click", async () => {
    if (!options.onRebuildBaseline) return;
    try {
      await options.onRebuildBaseline();
      if (disposed) return;
      showMessage(t("rebuildBaselineDone"));
      renderWatermark();
    } catch (error) {
      if (disposed) return;
      showMessage(t("syncFailed", { message: (error as Error).message }), 7000, "error");
    }
  }, eventOptions);

  root.querySelector('[data-action="save"]')?.addEventListener("click", async () => {
    try {
      const ranges = prepareRangesForSave(state.ranges);
      const savedSettings = await options.onSave(settingsForSave(options.settings, {
        cliCommand: cliCommand.value || "dida",
        autoSync: autoSync.checked,
        newTaskDate: newTaskDate.value === "none" ? "none" : "today",
        syncIntervalSeconds: Number(syncIntervalSeconds.value || 15),
        ranges,
        docSyncs: prepareDocSyncsForSave(state.docSyncs.map((entry) => ({ ...entry })))
      }));
      if (disposed) return;
      rebaseAfterSave(savedSettings);
      showMessage(t("settingsSaved"));
    } catch (error) {
      if (disposed) return;
      showMessage(t("settingsSaveFailed", { message: getRangeValidationMessage(error, t) }), 5000, "error");
    }
  }, eventOptions);

  root.querySelector('[data-action="copyLogs"]')?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(formatSyncLogs(options.settings.logs.slice(0, 20), t));
      if (disposed) return;
      showMessage(t("logsCopied"));
    } catch (error) {
      if (disposed) return;
      showMessage(t("logsCopyFailed", { message: (error as Error).message }), 5000, "error");
    }
  }, eventOptions);

  root.querySelector('[data-action="clearLogs"]')?.addEventListener("click", async () => {
    try {
      await options.onClearLogs();
      if (disposed) return;
      options.settings.logs = [];
      logs.textContent = formatSyncLogs([], t);
      showMessage(t("logsCleared"));
    } catch (error) {
      if (disposed) return;
      showMessage(t("logsClearFailed", { message: (error as Error).message }), 5000, "error");
    }
  }, eventOptions);

  renderRanges();
  renderDocSyncSection();
  state.ranges.forEach((range) => state.loadColumns(range.targetProjectId));
  state.docSyncs.forEach((entry) => state.loadColumns(entry.projectId));
  void listNotebooks()
    .then((notebooks) => {
      if (disposed) return;
      state.notebooks = notebooks;
      renderDocSyncSection();
      renderRanges();
    })
    .catch(() => undefined);

  void resolveDidaCommand(getResolvedCliPathForCurrentDevice(options.settings) || options.settings.cliCommand || "dida")
    .then((resolved) => disposed ? [] : new DidaCliClient(resolved.command).listProjects())
    .then((projects) => {
      if (disposed) return;
      state.projects = projects;
      renderDocSyncSection();
      renderRanges();
    })
    .catch(() => undefined);

  return {
    element: root,
    destroy() {
      if (disposed) return;
      disposed = true;
      eventController.abort();
      statusView.destroy();
      root.replaceChildren();
    }
  };
}

function renderDocSyncEntry(entry: DocSyncConfig, index: number, state: PanelState): string {
  const { t } = state;
  const columns = state.columnsByProject.get(entry.projectId) ?? [];
  return `
    <div class="dida-sync-range" data-docsync-id="${escapeAttribute(entry.id)}">
      <div class="dida-sync-range__header">
        <div>
          <div class="dida-sync-range__title">${escapeHtml(entry.projectName || t("docSyncEntryFallback", { number: index + 1 }))}</div>
          <div class="dida-sync-muted">${t("rangeNumber", { number: index + 1 })}</div>
        </div>
        <button class="b3-button b3-button--outline" data-action="removeDocSync">${t("delete")}</button>
      </div>
      <label class="dida-sync-toggle dida-sync-toggle--compact">
        <input type="checkbox" data-field="docSyncEnabled" ${entry.enabled ? "checked" : ""} />
        <span>${t("docSyncEnable")}</span>
      </label>
      <div class="dida-sync-range__grid">
        <label class="dida-sync-field">
          <span>${t("didaList")}</span>
          ${renderDocSyncProjectControl(entry, state.projects, t)}
        </label>
        <label class="dida-sync-field">
          <span>${t("docSyncColumn")}</span>
          ${renderDocSyncColumnControl(entry, columns, t)}
        </label>
        <label class="dida-sync-field">
          <span>${t("docSyncTargetNotebook")}</span>
          ${renderDocSyncNotebookControl(entry, state.notebooks, t)}
        </label>
        <label class="dida-sync-field">
          <span>${t("docSyncTargetPath")}</span>
          <input class="b3-text-field" data-field="docSyncHpath" placeholder="${t("docSyncPathPlaceholder")}" value="${escapeAttribute(entry.hpath)}" />
        </label>
      </div>
    </div>
  `;
}

function renderDocSyncProjectControl(
  docSync: DocSyncConfig,
  projects: DidaProject[],
  t: Translate
): string {
  if (projects.length === 0) {
    return `<input class="b3-text-field" data-field="docSyncProject" placeholder="${t("didaListId")}" value="${escapeAttribute(docSync.projectId)}" />`;
  }
  const options = [
    `<option value="">${t("selectDidaList")}</option>`,
    ...projects.map(
      (project) =>
        `<option value="${escapeAttribute(project.id)}" ${project.id === docSync.projectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`
    )
  ].join("");
  return `<select class="b3-select fn__block" data-field="docSyncProject">${options}</select>`;
}

function renderDocSyncColumnControl(
  docSync: DocSyncConfig,
  columns: DidaProjectColumn[],
  t: Translate
): string {
  const options = [
    `<option value="">${t("docSyncWholeList")}</option>`,
    ...columns.map(
      (column) =>
        `<option value="${escapeAttribute(column.id)}" ${column.id === docSync.columnId ? "selected" : ""}>${escapeHtml(column.name)}</option>`
    )
  ].join("");
  return `<select class="b3-select fn__block" data-field="docSyncColumn">${options}</select>`;
}

function renderDocSyncNotebookControl(
  docSync: DocSyncConfig,
  notebooks: SiYuanNotebook[],
  t: Translate
): string {
  if (notebooks.length === 0) {
    return `<input class="b3-text-field" data-field="docSyncNotebook" placeholder="${t("notebookId")}" value="${escapeAttribute(docSync.notebookId)}" />`;
  }
  const options = [
    `<option value="">${t("selectNotebook")}</option>`,
    ...notebooks.map(
      (notebook) =>
        `<option value="${escapeAttribute(notebook.id)}" ${notebook.id === docSync.notebookId ? "selected" : ""}>${escapeHtml(notebook.name)}</option>`
    )
  ].join("");
  return `<select class="b3-select fn__block" data-field="docSyncNotebook">${options}</select>`;
}

function renderRange(
  range: SyncRange,
  index: number,
  state: PanelState,
  rerender: () => void,
  signal: AbortSignal
): HTMLElement {
  const wrapper = document.createElement("div");
  const { t } = state;
  wrapper.className = "dida-sync-range";
  wrapper.innerHTML = `
    <div class="dida-sync-range__header">
      <div>
        <div class="dida-sync-range__title">${escapeHtml(range.name || t("rangeFallback", { number: index + 1 }))}</div>
        <div class="dida-sync-muted">${t("rangeNumber", { number: index + 1 })}</div>
      </div>
      <button class="b3-button b3-button--outline" data-action="removeRange">${t("delete")}</button>
    </div>
    <div class="dida-sync-range__grid">
      <label class="dida-sync-field">
        <span>${t("rangeName")}</span>
        <input class="b3-text-field" data-field="name" />
      </label>
      <label class="dida-sync-field">
        <span>${t("notebook")}</span>
        ${renderNotebookControl(range, state.notebooks, t)}
      </label>
      <label class="dida-sync-field">
        <span>${t("documentPath")}</span>
        <input class="b3-text-field" data-field="hpathPrefix" placeholder="${t("documentPathPlaceholder")}" />
      </label>
      <label class="dida-sync-field">
        <span>${t("didaList")}</span>
        ${renderProjectControl(range, state.projects, t)}
      </label>
      <label class="dida-sync-field">
        <span>${t("docSyncColumn")}</span>
        ${renderRangeColumnControl(range, state.columnsByProject.get(range.targetProjectId) ?? [], t)}
      </label>
    </div>
    <div class="dida-sync-range-warning" data-field="targetProjectWarning" role="status" aria-live="polite" hidden></div>
    <label class="dida-sync-toggle dida-sync-toggle--compact">
      <input type="checkbox" data-field="includeChildren" />
      <span>${t("includeChildDocuments")}</span>
    </label>
  `;

  bindInput(wrapper, "name", range, "name", signal);
  bindInput(wrapper, "notebookId", range, "notebookId", signal);
  bindInput(wrapper, "hpathPrefix", range, "hpathPrefix", signal);
  bindInput(wrapper, "targetProjectId", range, "targetProjectId", signal);

  const updateTargetProjectWarning = () => {
    const warning = wrapper.querySelector<HTMLElement>('[data-field="targetProjectWarning"]')!;
    const message = getTargetProjectWarning(
      state.originalTargetProjectIds.get(range) ?? "",
      range.targetProjectId,
      t
    );
    warning.textContent = message;
    warning.hidden = !message;
  };

  const includeChildren = wrapper.querySelector<HTMLInputElement>('[data-field="includeChildren"]')!;
  includeChildren.checked = range.includeChildren;
  includeChildren.addEventListener("change", () => {
    range.includeChildren = includeChildren.checked;
  }, { signal });

  const columnControl = wrapper.querySelector<HTMLSelectElement>('[data-field="columnId"]');
  const handleColumnChange = () => {
    range.columnId = columnControl?.value ?? "";
    range.columnName = (state.columnsByProject.get(range.targetProjectId) ?? [])
      .find((column) => column.id === range.columnId)?.name ?? "";
  };
  columnControl?.addEventListener("change", handleColumnChange, { signal });
  columnControl?.addEventListener("input", handleColumnChange, { signal });

  const handleTargetProjectInput = (event: Event) => {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    const changed = range.targetProjectId !== value;
    range.targetProjectId = value;
    const project = state.projects.find((item) => item.id === value);
    range.targetProjectName = project?.name ?? "";
    if (changed) {
      range.columnId = "";
      range.columnName = "";
      rerender();
      state.loadColumns(value);
      return;
    }
    updateTargetProjectWarning();
  };
  const targetProjectControl = wrapper.querySelector('[data-field="targetProjectId"]');
  targetProjectControl?.addEventListener("input", handleTargetProjectInput, { signal });
  targetProjectControl?.addEventListener("change", handleTargetProjectInput, { signal });

  wrapper.querySelector('[data-action="removeRange"]')?.addEventListener("click", () => {
    state.ranges.splice(index, 1);
    if (state.ranges.length === 0) {
      const emptyRange = createEmptyRange(1);
      state.originalTargetProjectIds.set(emptyRange, "");
      state.ranges.push(emptyRange);
    }
    rerender();
  }, { signal });

  updateTargetProjectWarning();

  return wrapper;
}

function renderRangeColumnControl(range: SyncRange, columns: DidaProjectColumn[], t: Translate): string {
  const options = [
    `<option value="">${t("docSyncWholeList")}</option>`,
    ...columns.map(
      (column) =>
        `<option value="${escapeAttribute(column.id)}" ${column.id === range.columnId ? "selected" : ""}>${escapeHtml(column.name)}</option>`
    )
  ].join("");
  return `<select class="b3-select fn__block" data-field="columnId">${options}</select>`;
}

function renderNotebookControl(range: SyncRange, notebooks: SiYuanNotebook[], t: Translate): string {
  if (notebooks.length === 0) {
    return `<input class="b3-text-field" data-field="notebookId" placeholder="${t("notebookId")}" value="${escapeAttribute(range.notebookId)}" />`;
  }

  const options = [
    `<option value="">${t("selectNotebook")}</option>`,
    ...notebooks.map(
      (notebook) =>
        `<option value="${escapeAttribute(notebook.id)}" ${notebook.id === range.notebookId ? "selected" : ""}>${escapeHtml(notebook.name)}</option>`
    )
  ].join("");
  return `<select class="b3-select fn__block" data-field="notebookId">${options}</select>`;
}

function renderProjectControl(range: SyncRange, projects: DidaProject[], t: Translate): string {
  if (projects.length === 0) {
    return `<input class="b3-text-field" data-field="targetProjectId" placeholder="${t("didaListId")}" value="${escapeAttribute(range.targetProjectId)}" />`;
  }

  const options = [
    `<option value="">${t("selectDidaList")}</option>`,
    ...projects.map(
      (project) =>
        `<option value="${escapeAttribute(project.id)}" ${project.id === range.targetProjectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`
    )
  ].join("");
  return `<select class="b3-select fn__block" data-field="targetProjectId">${options}</select>`;
}

function bindInput<K extends keyof SyncRange>(
  root: HTMLElement,
  field: string,
  range: SyncRange,
  key: K,
  signal: AbortSignal
) {
  const input = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${field}"]`);
  if (!input) {
    return;
  }
  input.value = String(range[key] ?? "");
  input.addEventListener("input", () => {
    range[key] = input.value as SyncRange[K];
  }, { signal });
  input.addEventListener("change", () => {
    range[key] = input.value as SyncRange[K];
  }, { signal });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
