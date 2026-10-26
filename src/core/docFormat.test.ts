import { describe, expect, test } from "vitest";
import { escapePlainTextBlock, normalizeTaskTitle, renderDocTask } from "./docFormat";

describe("renderDocTask", () => {
  test("returns an empty string for a blank title", () => {
    expect(renderDocTask({ title: "   " })).toBe("");
    expect(renderDocTask({ title: undefined })).toBe("");
  });

  test("collapses whitespace so one task stays on one line", () => {
    expect(normalizeTaskTitle("  buy\n  milk\t now ")).toBe("buy milk now");
    expect(renderDocTask({ title: "  buy\n milk " })).toBe("buy milk");
  });

  test("escapes inline markdown so the block renders literally", () => {
    expect(renderDocTask({ title: "[ref](siyuan://blocks/20260101000000-abcdefg)" }))
      .toBe("\\[ref\\](siyuan://blocks/20260101000000-abcdefg)");
    expect(renderDocTask({ title: "**bold** _em_ `code`" })).toBe("\\*\\*bold\\*\\* \\_em\\_ \\`code\\`");
  });

  test("keeps plain chinese text unchanged", () => {
    expect(renderDocTask({ title: "补全个人储蓄管理数据库" })).toBe("补全个人储蓄管理数据库");
  });

  test("escapes leading markers that would change the block type", () => {
    expect(renderDocTask({ title: "- list item" })).toBe("\\- list item");
    expect(renderDocTask({ title: "> quote" })).toBe("\\> quote");
    expect(renderDocTask({ title: "1. first" })).toBe("1\\. first");
  });

  test("escapes backslashes first so they stay literal", () => {
    const backslash = String.fromCharCode(92);
    expect(escapePlainTextBlock("a" + backslash + "b")).toBe("a" + backslash + backslash + "b");
  });
});
