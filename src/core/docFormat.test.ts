import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DOC_COMPLETED_MARKER,
  DOC_DELETED_MARKER,
  escapePlainTextBlock,
  formatTaskAnchor,
  formatTaskCountdown,
  isArchivedMarkdown,
  markDocTaskArchived,
  normalizeTaskTitle,
  renderDocTask,
  scheduleLabel
} from "./docFormat";

const pointTask = {
  title: "提交作业",
  startDate: "2026-11-01T20:00:00.000Z",
  dueDate: "2026-11-01T20:00:00.000Z",
  timeZone: "UTC"
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T04:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("renderDocTask", () => {
  test("renders a point-in-time task with a countdown line", () => {
    expect(renderDocTask(pointTask)).toBe(
      "提交作业\n 26.11.01(日) 20:00 时间点待办\n距今日还有0w5d（5day）"
    );
  });

  test("renders a duration task with 开始 将历时XhYm and a countdown", () => {
    expect(renderDocTask({
      ...pointTask,
      startDate: "2026-11-03T18:00:00.000Z",
      dueDate: "2026-11-03T22:00:00.000Z"
    })).toBe("提交作业\n 26.11.03(二) 18:00开始 将历时4h0m\n距今日还有1w0d（7day）");

    expect(renderDocTask({
      ...pointTask,
      startDate: "2026-11-03T10:00:00.000Z",
      dueDate: "2026-11-03T11:30:00.000Z"
    })).toBe("提交作业\n 26.11.03(二) 10:00开始 将历时1h30m\n距今日还有1w0d（7day）");
  });

  test("uses the task time zone for the anchor and countdown", () => {
    expect(renderDocTask({
      ...pointTask,
      startDate: "2026-11-01T20:00:00.000Z",
      dueDate: "2026-11-01T20:00:00.000Z",
      timeZone: "Asia/Shanghai"
    })).toBe("提交作业\n 26.11.02(一) 04:00 时间点待办\n距今日还有0w6d（6day）");
  });

  test("keeps only the title when the task has no date", () => {
    expect(renderDocTask({ title: "无日期任务" })).toBe("无日期任务");
  });

  test("escapes markdown in the title but not in the generated lines", () => {
    expect(renderDocTask({ ...pointTask, title: "[ref](siyuan://blocks/x)" })).toBe(
      "\\[ref\\](siyuan://blocks/x)\n 26.11.01(日) 20:00 时间点待办\n距今日还有0w5d（5day）"
    );
  });

  test("returns an empty string for a blank title", () => {
    expect(renderDocTask({ title: "   " })).toBe("");
  });

  test("collapses whitespace so one task stays on one line", () => {
    expect(normalizeTaskTitle("  buy\n  milk\t now ")).toBe("buy milk now");
  });
});

describe("formatTaskCountdown", () => {
  const now = new Date("2026-10-27T04:00:00.000Z");

  test("formats weeks, days and total days", () => {
    expect(formatTaskCountdown("2026-11-10T00:00:00.000Z", undefined, "UTC", now))
      .toBe("距今日还有2w0d（14day）");
    expect(formatTaskCountdown("2026-11-06T00:00:00.000Z", undefined, "UTC", now))
      .toBe("距今日还有1w3d（10day）");
    expect(formatTaskCountdown("2026-11-01T00:00:00.000Z", undefined, "UTC", now))
      .toBe("距今日还有0w5d（5day）");
    expect(formatTaskCountdown("2026-10-27T00:00:00.000Z", undefined, "UTC", now))
      .toBe("距今日还有0w0d（0day）");
  });

  test("reports past dates separately", () => {
    expect(formatTaskCountdown("2026-10-20T00:00:00.000Z", undefined, "UTC", now))
      .toBe("距今日已过1w0d（7day）");
  });

  test("returns nothing when the task has no date", () => {
    expect(formatTaskCountdown(undefined, undefined, "UTC", now)).toBeUndefined();
    expect(formatTaskCountdown("not-a-date", undefined, "UTC", now)).toBeUndefined();
  });
});

describe("scheduleLabel", () => {
  test("falls back to the point-in-time label for equal or missing dates", () => {
    expect(scheduleLabel(pointTask.startDate, pointTask.dueDate)).toBe("时间点待办");
    expect(scheduleLabel(undefined, pointTask.dueDate)).toBe("时间点待办");
  });
});

describe("formatTaskAnchor", () => {
  test("falls back to the due date and tolerates invalid input", () => {
    expect(formatTaskAnchor(undefined, "2026-11-01T20:00:00.000Z", "UTC")).toBe("26.11.01(日) 20:00");
    expect(formatTaskAnchor("not-a-date")).toBe("");
    expect(formatTaskAnchor()).toBe("");
  });
});

describe("archive markers", () => {
  const rendered = "提交作业\n 26.11.01(日) 20:00 时间点待办\n距今日还有0w5d（5day）";

  test("prepends the bold marker and drops the countdown line", () => {
    expect(markDocTaskArchived(rendered, "completed")).toBe(
      `${DOC_COMPLETED_MARKER} 提交作业\n 26.11.01(日) 20:00 时间点待办`
    );
    expect(markDocTaskArchived(rendered, "deleted")).toBe(
      `${DOC_DELETED_MARKER} 提交作业\n 26.11.01(日) 20:00 时间点待办`
    );
    expect(markDocTaskArchived("提交作业", "deleted")).toBe(`${DOC_DELETED_MARKER} 提交作业`);
  });

  test("never re-marks an already archived block", () => {
    expect(markDocTaskArchived(`${DOC_COMPLETED_MARKER} 提交作业`, "deleted"))
      .toBe(`${DOC_COMPLETED_MARKER} 提交作业`);
  });

  test("detects previously archived blocks", () => {
    expect(isArchivedMarkdown(`${DOC_COMPLETED_MARKER} x`)).toBe(true);
    expect(isArchivedMarkdown(`${DOC_DELETED_MARKER} x`)).toBe(true);
    expect(isArchivedMarkdown("x")).toBe(false);
  });
});

describe("escapePlainTextBlock", () => {
  test("escapes leading markers that would change the block type", () => {
    expect(escapePlainTextBlock("- list item")).toBe("\\- list item");
    expect(escapePlainTextBlock("> quote")).toBe("\\> quote");
    expect(escapePlainTextBlock("1. first")).toBe("1\\. first");
  });

  test("escapes backslashes only once", () => {
    const backslash = String.fromCharCode(92);
    expect(escapePlainTextBlock("a" + backslash + "b"))
      .toBe("a" + backslash + backslash + "b");
  });
});
