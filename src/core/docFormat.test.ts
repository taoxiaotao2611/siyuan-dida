import { describe, expect, test } from "vitest";
import {
  DOC_COMPLETED_MARKER,
  DOC_DELETED_MARKER,
  escapePlainTextBlock,
  formatTaskAnchor,
  isArchivedMarkdown,
  markDocTaskArchived,
  normalizeTaskTitle,
  renderDocTask,
  taskScheduleLabel
} from "./docFormat";

const pointTask = {
  title: "提交作业",
  startDate: "2026-11-01T20:00:00.000Z",
  dueDate: "2026-11-01T20:00:00.000Z",
  timeZone: "UTC"
};

describe("renderDocTask", () => {
  test("renders a point-in-time task on two lines", () => {
    expect(renderDocTask(pointTask)).toBe("提交作业\n 26.11.01 20:00 时间点待办");
  });

  test("renders a duration task with 开始 将历时XhYm", () => {
    expect(renderDocTask({
      ...pointTask,
      startDate: "2026-11-03T18:00:00.000Z",
      dueDate: "2026-11-03T22:00:00.000Z"
    })).toBe("提交作业\n 26.11.03 18:00开始 将历时4h0m");

    expect(renderDocTask({
      ...pointTask,
      startDate: "2026-11-03T10:00:00.000Z",
      dueDate: "2026-11-03T11:30:00.000Z"
    })).toBe("提交作业\n 26.11.03 10:00开始 将历时1h30m");
  });

  test("uses the task time zone for the anchor", () => {
    expect(formatTaskAnchor("2026-11-01T12:00:00.000Z", undefined, "Asia/Shanghai"))
      .toBe("26.11.01 20:00");
  });

  test("keeps only the title when the task has no date", () => {
    expect(renderDocTask({ title: "无日期任务" })).toBe("无日期任务");
  });

  test("escapes markdown in the title but not in the generated lines", () => {
    expect(renderDocTask({ ...pointTask, title: "[ref](siyuan://blocks/x)" }))
      .toBe("\\[ref\\](siyuan://blocks/x)\n 26.11.01 20:00 时间点待办");
  });

  test("returns an empty string for a blank title", () => {
    expect(renderDocTask({ title: "   " })).toBe("");
  });

  test("collapses whitespace so one task stays on one line", () => {
    expect(normalizeTaskTitle("  buy\n  milk\t now ")).toBe("buy milk now");
  });
});

describe("taskScheduleLabel", () => {
  test("falls back to the point-in-time label for equal or missing dates", () => {
    expect(taskScheduleLabel(pointTask.startDate, pointTask.dueDate)).toBe("时间点待办");
    expect(taskScheduleLabel(undefined, pointTask.dueDate)).toBe("时间点待办");
  });
});

describe("formatTaskAnchor", () => {
  test("falls back to the due date and tolerates invalid input", () => {
    expect(formatTaskAnchor(undefined, "2026-11-01T20:00:00.000Z", "UTC")).toBe("26.11.01 20:00");
    expect(formatTaskAnchor("not-a-date")).toBe("");
    expect(formatTaskAnchor()).toBe("");
  });
});

describe("archive markers", () => {
  test("prepends the bold completed or deleted marker once", () => {
    expect(markDocTaskArchived("提交作业\n 26.11.01 20:00 时间点待办", "completed"))
      .toBe(`${DOC_COMPLETED_MARKER} 提交作业\n 26.11.01 20:00 时间点待办`);
    expect(markDocTaskArchived("提交作业", "deleted")).toBe(`${DOC_DELETED_MARKER} 提交作业`);
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
