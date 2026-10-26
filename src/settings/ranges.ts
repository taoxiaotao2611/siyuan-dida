import type { SyncRange } from "../core/types";
import type { Translate } from "../i18n";

export type RangeValidationErrorCode =
  | "missing_notebook"
  | "missing_path"
  | "missing_target"
  | "duplicate_range_id"
  | "overlapping_ranges";

export interface RangeValidationErrorDetails {
  rangeIndex: number;
  rangeId: string;
  rangeName: string;
  conflictingRangeIndex?: number;
  conflictingRangeId?: string;
  conflictingRangeName?: string;
}

export class RangeValidationError extends Error {
  readonly code: RangeValidationErrorCode;
  readonly details: RangeValidationErrorDetails;

  constructor(code: RangeValidationErrorCode, details: RangeValidationErrorDetails) {
    super(`Invalid sync range: ${code}`);
    this.name = "RangeValidationError";
    this.code = code;
    this.details = details;
  }
}

export type RangeIdFactory = () => string;

let fallbackRangeIdSequence = 0;

export function createRangeId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return `range-${randomUuid}`;
  }

  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2);
  fallbackRangeIdSequence += 1;
  return `range-${timestamp}-${random}-${fallbackRangeIdSequence.toString(36)}`;
}

export function createEmptyRange(index: number, createId: RangeIdFactory = createRangeId): SyncRange {
  return {
    id: createId(),
    name: `同步范围 ${index}`,
    notebookId: "",
    hpathPrefix: "",
    includeChildren: true,
    targetProjectId: "",
    targetProjectName: "",
    cursorOffset: 0
  };
}

export function prepareRangesForSave(ranges: SyncRange[]): SyncRange[] {
  const normalized = ranges
    .map((range, index) => ({ range: normalizeRange(range, index + 1), sourceIndex: index + 1 }))
    .filter(({ range }) => !isEmptyRange(range));

  validateNormalizedRanges(normalized);
  return normalized.map(({ range }) => range);
}

export interface LoadedRangesInspection {
  ranges: SyncRange[];
  error?: RangeValidationError;
}

export function inspectLoadedRanges(
  ranges: SyncRange[],
  createId: RangeIdFactory = createRangeId
): LoadedRangesInspection {
  const normalized = ranges.map((range, index) => ({
    range: normalizeRange(range, index + 1, createId),
    sourceIndex: index + 1
  }));

  try {
    validateNormalizedRanges(normalized);
    return { ranges: normalized.map(({ range }) => range) };
  } catch (error) {
    if (!(error instanceof RangeValidationError)) {
      throw error;
    }
    return {
      ranges: normalized.map(({ range }) => range),
      error
    };
  }
}

export function getRangeValidationMessage(error: unknown, t: Translate): string {
  if (!(error instanceof RangeValidationError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const { rangeIndex, conflictingRangeIndex } = error.details;
  switch (error.code) {
    case "missing_notebook":
      return t("rangeValidationMissingNotebook", { range: rangeIndex });
    case "missing_path":
      return t("rangeValidationMissingPath", { range: rangeIndex });
    case "missing_target":
      return t("rangeValidationMissingTarget", { range: rangeIndex });
    case "duplicate_range_id":
      return t("rangeValidationDuplicateId", {
        firstRange: conflictingRangeIndex ?? rangeIndex,
        secondRange: rangeIndex
      });
    case "overlapping_ranges":
      return t("rangeValidationOverlap", {
        firstRange: conflictingRangeIndex ?? rangeIndex,
        secondRange: rangeIndex
      });
  }
}

export function getTargetProjectWarning(originalTargetProjectId: string, targetProjectId: string, t: Translate): string {
  const original = originalTargetProjectId.trim();
  const current = targetProjectId.trim();
  if (!original || !current || original === current) {
    return "";
  }
  return t("targetProjectChangedWarning");
}

function normalizeRange(
  range: SyncRange,
  index: number,
  createId: RangeIdFactory = createRangeId
): SyncRange {
  return {
    id: normalizeText(range.id) || createId(),
    name: normalizeText(range.name) || `同步范围 ${index}`,
    notebookId: normalizeText(range.notebookId),
    hpathPrefix: normalizeDocumentPath(range.hpathPrefix),
    includeChildren: range.includeChildren !== false,
    targetProjectId: normalizeText(range.targetProjectId),
    targetProjectName: normalizeText(range.targetProjectName),
    cursorOffset: normalizeCursorOffset(range.cursorOffset)
  };
}

export function normalizeDocumentPath(value: string): string {
  const trimmed = normalizeText(value);
  if (!trimmed) {
    return "";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

function isEmptyRange(range: SyncRange): boolean {
  return !range.notebookId && !range.hpathPrefix && !range.targetProjectId;
}

function validateRequiredFields(range: SyncRange, index: number): void {
  const details = rangeDetails(range, index);
  if (!range.notebookId) {
    throw new RangeValidationError("missing_notebook", details);
  }
  if (!range.hpathPrefix) {
    throw new RangeValidationError("missing_path", details);
  }
  if (!range.targetProjectId) {
    throw new RangeValidationError("missing_target", details);
  }
}

interface IndexedRange {
  range: SyncRange;
  sourceIndex: number;
}

function validateNormalizedRanges(ranges: IndexedRange[]): void {
  ranges.forEach(({ range, sourceIndex }) => validateRequiredFields(range, sourceIndex));
  validateUniqueIds(ranges);
  validateNonOverlappingRanges(ranges);
}

function validateUniqueIds(ranges: IndexedRange[]): void {
  const firstIndexById = new Map<string, number>();
  ranges.forEach(({ range, sourceIndex }, index) => {
    const conflictingIndex = firstIndexById.get(range.id);
    if (conflictingIndex !== undefined) {
      const conflictingRange = ranges[conflictingIndex];
      throw new RangeValidationError(
        "duplicate_range_id",
        conflictDetails(range, sourceIndex, conflictingRange.range, conflictingRange.sourceIndex)
      );
    }
    firstIndexById.set(range.id, index);
  });
}

function validateNonOverlappingRanges(ranges: IndexedRange[]): void {
  for (let index = 0; index < ranges.length; index += 1) {
    for (let conflictingIndex = 0; conflictingIndex < index; conflictingIndex += 1) {
      const current = ranges[index];
      const conflict = ranges[conflictingIndex];
      if (rangesOverlap(current.range, conflict.range)) {
        throw new RangeValidationError(
          "overlapping_ranges",
          conflictDetails(current.range, current.sourceIndex, conflict.range, conflict.sourceIndex)
        );
      }
    }
  }
}

function rangesOverlap(first: SyncRange, second: SyncRange): boolean {
  if (first.notebookId !== second.notebookId) {
    return false;
  }
  if (first.hpathPrefix === second.hpathPrefix) {
    return true;
  }
  if (first.includeChildren && isAncestorPath(first.hpathPrefix, second.hpathPrefix)) {
    return true;
  }
  return second.includeChildren && isAncestorPath(second.hpathPrefix, first.hpathPrefix);
}

function isAncestorPath(ancestor: string, descendant: string): boolean {
  if (ancestor === "/") {
    return descendant !== "/" && descendant.startsWith("/");
  }
  return descendant.startsWith(`${ancestor}/`);
}

function rangeDetails(range: SyncRange, index: number): RangeValidationErrorDetails {
  return {
    rangeIndex: index,
    rangeId: range.id,
    rangeName: range.name
  };
}

function conflictDetails(
  range: SyncRange,
  rangeIndex: number,
  conflictingRange: SyncRange,
  conflictingRangeIndex: number
): RangeValidationErrorDetails {
  return {
    ...rangeDetails(range, rangeIndex),
    conflictingRangeIndex,
    conflictingRangeId: conflictingRange.id,
    conflictingRangeName: conflictingRange.name
  };
}

function normalizeCursorOffset(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
