import { describe, expect, test } from "vitest";
import { createTranslator } from "../i18n";
import type { SyncResult } from "../core/types";
import { formatSyncLogs, summarizeSyncLog } from "./logFormat";

function fullLog(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    created: 2,
    recovered: 1,
    updated: 3,
    completed: 4,
    writtenBack: 5,
    failed: 6,
    skipped: 7,
    scanned: 8,
    rangeResults: [
      {
        rangeId: "range-1",
        rangeName: "Work",
        notebookId: "box-1",
        hpathPrefix: "/Work",
        scanned: 8,
        created: 2,
        recovered: 1,
        updated: 3,
        completed: 4,
        writtenBack: 5,
        failed: 6,
        skipped: 7,
        cursorOffset: 10,
        nextCursorOffset: 20,
        hasMore: true
      }
    ],
    rangeCursorOffsets: { "range-1": 20 },
    events: [
      {
        time: "2026-06-27T01:00:00.000Z",
        level: "info",
        blockId: "block-event",
        message: "Already localized event message"
      }
    ],
    failures: [
      { blockId: "block-failure", message: "network unavailable" },
      { message: "snapshot unavailable" }
    ],
    startedAt: "2026-06-27T01:00:00.000Z",
    finishedAt: "2026-06-27T01:00:01.000Z",
    ...overrides
  };
}

describe("formatSyncLogs", () => {
  test("defaults old calls without a translator to Chinese", () => {
    expect(formatSyncLogs([])).toBe("暂无同步日志。");
  });

  test.each([
    ["en", "No sync logs yet."],
    ["zh-CN", "暂无同步日志。"]
  ])("formats an empty log list in %s", (locale, expected) => {
    expect(formatSyncLogs([], createTranslator(locale))).toBe(expected);
  });

  test("formats every fixed label in English and preserves localized event messages", () => {
    const text = formatSyncLogs([fullLog()], createTranslator("en"));

    expect(text).toContain("#1 2026-06-27T01:00:01.000Z");
    expect(text).toContain(
      "Summary: scanned 8, created 2, recovered 1, updated 3, completed 4, written back 5, skipped 7, failed 6"
    );
    expect(text).toContain(
      "Range Work (/Work): scanned 8, created 2, recovered 1, updated 3, completed 4, written back 5, skipped 7, failed 6"
    );
    expect(text).toContain("this run started at candidate 11; next run continues at candidate 21");
    expect(text).toContain("Failure [block block-failure]: network unavailable");
    expect(text).toContain("Failure: snapshot unavailable");
    expect(text).toContain(
      "[info] 2026-06-27T01:00:00.000Z [block block-event] Already localized event message"
    );
    expect(text).not.toMatch(/[\u3400-\u9fff]/u);
  });

  test("formats every fixed label naturally in Chinese", () => {
    const log = fullLog({
      events: [{ time: "2026-06-27T01:00:00.000Z", level: "info", message: "创建滴答任务：A" }]
    });
    const text = formatSyncLogs([log], createTranslator("zh-CN"));

    expect(text).toContain(
      "汇总：扫描 8，新增 2，恢复 1，更新 3，完成 4，回写 5，跳过 7，失败 6"
    );
    expect(text).toContain(
      "范围 Work（/Work）：扫描 8，新增 2，恢复 1，更新 3，完成 4，回写 5，跳过 7，失败 6"
    );
    expect(text).toContain("本轮从第 11 个候选任务开始，下轮从第 21 个候选任务继续");
    expect(text).toContain("失败（块 block-failure）：network unavailable");
    expect(text).toContain("失败：snapshot unavailable");
    expect(text).toContain("[info] 2026-06-27T01:00:00.000Z 创建滴答任务：A");
  });

  test("formats a completed cursor", () => {
    const log = fullLog({
      rangeResults: [{ ...fullLog().rangeResults[0], hasMore: false }]
    });

    expect(formatSyncLogs([log], createTranslator("en"))).toContain("reached the end");
    expect(formatSyncLogs([log], createTranslator("zh-CN"))).toContain("已扫到末尾");
  });

  test("renders missing recovered counts from legacy logs as zero", () => {
    const log = fullLog({ recovered: undefined });
    delete log.rangeResults[0].recovered;

    const text = formatSyncLogs([log], createTranslator("en"));

    expect(text).toContain("recovered 0");
    expect(text.match(/recovered 0/g)).toHaveLength(2);
  });

  test("formats a compact historical log without optional detail collections", () => {
    const historicalLog = {
      created: 1,
      updated: 2,
      completed: 3,
      writtenBack: 4,
      failed: 0,
      skipped: 5,
      scanned: 6,
      rangeCursorOffsets: {},
      startedAt: "2025-01-02T03:04:05.000Z",
      finishedAt: "2025-01-02T03:04:06.000Z"
    } as SyncResult;

    expect(() => formatSyncLogs([historicalLog])).not.toThrow();
    expect(formatSyncLogs([historicalLog])).toContain(
      "汇总：扫描 6，新增 1，恢复 0，更新 2，完成 3，回写 4，跳过 5，失败 0"
    );
  });
});

describe("summarizeSyncLog", () => {
  test("defaults old calls without a translator to Chinese", () => {
    expect(summarizeSyncLog(fullLog({ recovered: undefined }))).toBe(
      "扫描 8，新增 2，恢复 0，更新 3，完成 4，回写 5，跳过 7，失败 6"
    );
  });

  test("summarizes all counters in English", () => {
    expect(summarizeSyncLog(fullLog(), createTranslator("en"))).toBe(
      "scanned 8, created 2, recovered 1, updated 3, completed 4, written back 5, skipped 7, failed 6"
    );
  });

  test("summarizes all counters in Chinese and defaults legacy recovery to zero", () => {
    expect(summarizeSyncLog(fullLog({ recovered: undefined }), createTranslator("zh-CN"))).toBe(
      "扫描 8，新增 2，恢复 0，更新 3，完成 4，回写 5，跳过 7，失败 6"
    );
  });
});

describe("formatSyncLogs document sync summaries", () => {
  const docSync = {
    projectName: "Courses",
    columnName: "Later",
    documentPath: "/Target",
    tasks: 4,
    created: 1,
    updated: 2,
    archived: 1,
    deduplicated: 0,
    reordered: 0,
    failed: 0
  };

  test("renders every mirror result in English", () => {
    const text = formatSyncLogs([fullLog({ docSyncs: [docSync, { ...docSync, projectName: "Home", columnName: "", documentPath: "/Home", created: 0 }] })], createTranslator("en"));

    expect(text).toContain(
      "List → document sync Courses (Later) → /Target: created 1, updated 2, archived 1, deduplicated 0, reordered 0, failed 0"
    );
    expect(text).toContain(
      "List → document sync Home → /Home: created 0, updated 2, archived 1, deduplicated 0, reordered 0, failed 0"
    );
  });

  test("renders the mirror result in Chinese", () => {
    const text = formatSyncLogs([fullLog({ docSyncs: [docSync] })], createTranslator("zh-CN"));

    expect(text).toContain("清单 → 文档同步 Courses（Later） → /Target：新增 1，更新 2，归档 1，去重 0，重排 0，失败 0");
  });

  test("still renders the legacy single summary from old logs", () => {
    const text = formatSyncLogs(
      [fullLog({ docSync: { ...docSync, deleted: 1 } as never })],
      createTranslator("en")
    );

    expect(text).toContain("List → document sync Courses (Later) → /Target");
  });

  test("omits the line when document sync did not run", () => {
    expect(formatSyncLogs([fullLog()], createTranslator("en"))).not.toContain("List → document sync");
  });
});
