import type { DocSyncConfig } from "../core/types";
import { normalizeDocumentPath } from "./ranges";

export type DocSyncIdFactory = () => string;

let fallbackSequence = 0;

export function createDocSyncId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return `docsync-${randomUuid}`;
  }
  fallbackSequence += 1;
  return `docsync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${fallbackSequence.toString(36)}`;
}

export function createEmptyDocSyncConfig(
  _index: number,
  createId: DocSyncIdFactory = createDocSyncId
): DocSyncConfig {
  return {
    id: createId(),
    enabled: false,
    projectId: "",
    projectName: "",
    columnId: "",
    columnName: "",
    notebookId: "",
    hpath: ""
  };
}

export function normalizeDocSyncConfig(
  value: Partial<DocSyncConfig> | null | undefined,
  createId: DocSyncIdFactory = createDocSyncId
): DocSyncConfig {
  return {
    id: normalizeText(value?.id) || createId(),
    enabled: value?.enabled === true,
    projectId: normalizeText(value?.projectId),
    projectName: normalizeText(value?.projectName),
    columnId: normalizeText(value?.columnId),
    columnName: normalizeText(value?.columnName),
    notebookId: normalizeText(value?.notebookId),
    hpath: normalizeDocumentPath(normalizeText(value?.hpath))
  };
}

/** Drops untouched placeholder entries before saving. */
export function prepareDocSyncsForSave(entries: DocSyncConfig[]): DocSyncConfig[] {
  return entries.filter(
    (entry) => entry.enabled || entry.projectId || entry.notebookId || entry.hpath
  );
}

/**
 * Normalizes the current array shape and the single-object shape written by
 * 1.3.x, so upgrading keeps the previously configured target.
 */
export function normalizeDocSyncConfigs(
  value: unknown,
  createId: DocSyncIdFactory = createDocSyncId
): DocSyncConfig[] {
  const entries = Array.isArray(value)
    ? value
    : isObject(value)
      ? [value]
      : [];
  return entries.map((entry) => normalizeDocSyncConfig(entry as Partial<DocSyncConfig>, createId));
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
