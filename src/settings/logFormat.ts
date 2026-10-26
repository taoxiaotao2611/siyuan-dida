import type { DocSyncSummary, SyncResult } from "../core/types";
import { createTranslator, type Translate } from "../i18n";

export function formatSyncLogs(logs: SyncResult[], t: Translate = createTranslator("zh-CN")): string {
  if (logs.length === 0) {
    return t("syncLogEmpty");
  }

  return logs
    .map((log, index) => {
      const lines = [
        t("syncLogRecordHeader", { number: index + 1, time: log.finishedAt || log.startedAt }),
        t("syncLogAggregateSummary", { summary: summarizeSyncLog(log, t) })
      ];

      for (const range of log.rangeResults ?? []) {
        const cursorText =
          range.hasMore === undefined
            ? ""
            : range.hasMore
              ? t("syncLogCursorContinue", {
                  start: range.cursorOffset + 1,
                  next: range.nextCursorOffset + 1
                })
              : t("syncLogCursorComplete");
        lines.push(
          t("syncLogRangeSummary", {
            range: range.rangeName,
            path: range.hpathPrefix,
            summary: summarizeCounters(range, t),
            cursor: cursorText
          })
        );
      }

      const docSyncs = log.docSyncs ?? (log.docSync ? [log.docSync] : []);
      for (const docSync of docSyncs) {
        lines.push(
          t("syncLogDocSyncSummary", {
            project: docSync.projectName || "?",
            column: docSync.columnName
              ? t("docSyncColumnSuffix", { column: docSync.columnName })
              : "",
            path: docSync.documentPath,
            created: docSync.created,
            updated: docSync.updated,
            archived: docSync.archived ?? 0,
            deduplicated: docSync.deduplicated ?? 0,
            reordered: docSync.reordered ?? 0,
            failed: docSync.failed
          })
        );
      }

      for (const failure of log.failures ?? []) {
        lines.push(
          failure.blockId
            ? t("syncLogFailureBlock", { blockId: failure.blockId, message: failure.message })
            : t("syncLogFailure", { message: failure.message })
        );
      }

      for (const event of (log.events ?? []).slice(-30)) {
        lines.push(
          event.blockId
            ? t("syncLogEventBlock", {
                level: event.level,
                time: event.time,
                blockId: event.blockId,
                message: event.message
              })
            : t("syncLogEvent", { level: event.level, time: event.time, message: event.message })
        );
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

export function summarizeSyncLog(log: SyncResult, t: Translate = createTranslator("zh-CN")): string {
  return summarizeCounters(log, t);
}

/** Human readable label for one list-to-document target. */
export function docSyncTargetLabel(docSync: DocSyncSummary, t: Translate): string {
  return t("docSyncTargetLabel", {
    project: docSync.projectName || "?",
    column: docSync.columnName
      ? t("docSyncColumnSuffix", { column: docSync.columnName })
      : "",
    path: docSync.documentPath
  });
}

export function formatDocSyncCounters(docSync: DocSyncSummary, t: Translate): string {
  return t("docSyncCounters", {
    created: docSync.created ?? 0,
    updated: docSync.updated ?? 0,
    archived: docSync.archived ?? 0,
    deduplicated: docSync.deduplicated ?? 0,
    reordered: docSync.reordered ?? 0,
    failed: docSync.failed ?? 0
  });
}

/** All mirror targets of a run, e.g. "list (column) → path: counters". */
export function summarizeDocSyncTargets(result: SyncResult, t: Translate): string | undefined {
  const docSyncs = result.docSyncs ?? (result.docSync ? [result.docSync] : []);
  if (docSyncs.length === 0) {
    return undefined;
  }
  return docSyncs
    .map(
      (docSync) =>
        `${docSyncTargetLabel(docSync, t)}${t("docSyncLabelSeparator")}${formatDocSyncCounters(docSync, t)}`
    )
    .join(t("docSyncJoinSeparator"));
}

/** Completion summary for the toast: todo counters plus mirror results. */
export function summarizeSyncOutcome(log: SyncResult, t: Translate = createTranslator("zh-CN")): string {
  const base = summarizeSyncLog(log, t);
  const docSyncs = summarizeDocSyncTargets(log, t);
  return docSyncs ? `${base} | ${t("syncDocSyncMessage", { summary: docSyncs })}` : base;
}

function summarizeCounters(
  result: Pick<
    SyncResult,
    "scanned" | "created" | "recovered" | "updated" | "completed" | "writtenBack" | "skipped" | "failed"
  >,
  t: Translate
): string {
  return t("syncLogCounters", {
    scanned: result.scanned ?? "?",
    created: result.created,
    recovered: result.recovered ?? 0,
    updated: result.updated,
    completed: result.completed,
    writtenBack: result.writtenBack,
    skipped: result.skipped,
    failed: result.failed
  });
}
