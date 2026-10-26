import { afterEach, describe, expect, test, vi } from "vitest";
import type { SyncRange } from "../core/types";
import {
  createEmptyRange,
  createRangeId,
  inspectLoadedRanges,
  prepareRangesForSave,
  RangeValidationError
} from "./ranges";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function configuredRange(overrides: Partial<SyncRange> = {}): SyncRange {
  return {
    id: "legacy-range-1",
    name: "Work",
    notebookId: "box-1",
    hpathPrefix: "/Work",
    includeChildren: true,
    targetProjectId: "project-1",
    targetProjectName: "Work list",
    cursorOffset: 0,
    ...overrides
  };
}

function expectRangeError(
  action: () => unknown,
  code: RangeValidationError["code"],
  details: Partial<RangeValidationError["details"]>
) {
  try {
    action();
    throw new Error("Expected a RangeValidationError");
  } catch (error) {
    expect(error).toBeInstanceOf(RangeValidationError);
    expect(error).toMatchObject({ code, details });
  }
}

describe("createEmptyRange", () => {
  test("accepts an ID factory for deterministic callers", () => {
    expect(createEmptyRange(2, () => "range-fixed").id).toBe("range-fixed");
  });

  test("creates consecutive drafts with collision-resistant IDs independent of display index", () => {
    const first = createEmptyRange(2);
    const second = createEmptyRange(2);
    const anotherIndex = createEmptyRange(200);

    expect(first).toMatchObject({ name: "同步范围 2", includeChildren: true });
    expect(first.id).toMatch(/^range-/);
    expect(new Set([first.id, second.id, anotherIndex.id])).toHaveLength(3);
  });

  test("keeps fallback IDs unique when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const first = createRangeId();
    const second = createRangeId();

    expect(first).toMatch(/^range-/);
    expect(second).toMatch(/^range-/);
    expect(second).not.toBe(first);
  });
});

describe("inspectLoadedRanges", () => {
  test("retains duplicate ranges and reports them as invalid", () => {
    const ranges = [
      configuredRange(),
      configuredRange({ hpathPrefix: "/Personal", targetProjectId: "project-2" })
    ];

    const result = inspectLoadedRanges(ranges);

    expect(result.ranges).toHaveLength(2);
    expect(result.error).toMatchObject({ code: "duplicate_range_id" });
  });

  test("retains overlapping ranges and reports them as invalid after harmless path normalization", () => {
    const result = inspectLoadedRanges([
      configuredRange({ id: "range-a", hpathPrefix: " Work// " }),
      configuredRange({ id: "range-b", hpathPrefix: "/Work/Weekly" })
    ]);

    expect(result.ranges.map((range) => range.hpathPrefix)).toEqual(["/Work", "/Work/Weekly"]);
    expect(result.error).toMatchObject({ code: "overlapping_ranges" });
  });

  test("does not treat a fully blank persisted range as an expendable draft", () => {
    const result = inspectLoadedRanges([createEmptyRange(1, () => "persisted-range")]);

    expect(result.ranges).toHaveLength(1);
    expect(result.error).toMatchObject({ code: "missing_notebook" });
  });

  test("generates a blank legacy ID once and keeps it stable after persistence and reload", () => {
    const firstLoad = inspectLoadedRanges(
      [configuredRange({ id: "", hpathPrefix: " Work//Weekly/// " })],
      () => "range-generated"
    );
    const secondLoad = inspectLoadedRanges(firstLoad.ranges, () => "range-unexpected");

    expect(firstLoad.error).toBeUndefined();
    expect(firstLoad.ranges[0]).toMatchObject({ id: "range-generated", hpathPrefix: "/Work/Weekly" });
    expect(secondLoad.ranges[0].id).toBe("range-generated");
  });
});

describe("prepareRangesForSave", () => {
  test("drops fully empty draft ranges", () => {
    expect(prepareRangesForSave([createEmptyRange(1)])).toEqual([]);
  });

  test("normalizes whitespace and document paths without changing a legacy ID", () => {
    expect(
      prepareRangesForSave([
        configuredRange({
          id: " legacy-range-1 ",
          name: " Work ",
          notebookId: " box-1 ",
          hpathPrefix: " Work//Weekly/// ",
          targetProjectId: " project-1 ",
          targetProjectName: " Work list ",
          cursorOffset: 400.8
        })
      ])
    ).toEqual([
      {
        id: "legacy-range-1",
        name: "Work",
        notebookId: "box-1",
        hpathPrefix: "/Work/Weekly",
        includeChildren: true,
        targetProjectId: "project-1",
        targetProjectName: "Work list",
        columnId: "",
        columnName: "",
        cursorOffset: 400
      }
    ]);
  });

  test("normalizes the root document path without stripping its slash", () => {
    expect(prepareRangesForSave([configuredRange({ hpathPrefix: "////" })])[0].hpathPrefix).toBe("/");
  });

  test.each([
    {
      label: "notebook",
      range: configuredRange({ notebookId: "" }),
      code: "missing_notebook" as const
    },
    {
      label: "document path",
      range: configuredRange({ hpathPrefix: "" }),
      code: "missing_path" as const
    },
    {
      label: "target list",
      range: configuredRange({ targetProjectId: "" }),
      code: "missing_target" as const
    }
  ])("reports a typed error for a missing $label", ({ range, code }) => {
    expectRangeError(() => prepareRangesForSave([range]), code, {
      rangeIndex: 1,
      rangeId: "legacy-range-1"
    });
  });

  test("preserves the original card index after dropping an empty draft", () => {
    expectRangeError(
      () => prepareRangesForSave([createEmptyRange(1), configuredRange({ notebookId: "" })]),
      "missing_notebook",
      { rangeIndex: 2 }
    );
  });

  test("drops a fully empty draft even when it retains a stale target list name", () => {
    expect(
      prepareRangesForSave([
        {
          ...createEmptyRange(1),
          targetProjectName: "Former list"
        }
      ])
    ).toEqual([]);
  });

  test("rejects duplicate range IDs", () => {
    expectRangeError(
      () =>
        prepareRangesForSave([
          configuredRange(),
          configuredRange({ hpathPrefix: "/Personal", targetProjectId: "project-2" })
        ]),
      "duplicate_range_id",
      {
        rangeIndex: 2,
        rangeId: "legacy-range-1",
        conflictingRangeIndex: 1,
        conflictingRangeId: "legacy-range-1"
      }
    );
  });

  test("rejects identical paths in the same notebook", () => {
    expectRangeError(
      () =>
        prepareRangesForSave([
          configuredRange({ id: "range-a", hpathPrefix: "/Work/" }),
          configuredRange({ id: "range-b", hpathPrefix: "//Work" })
        ]),
      "overlapping_ranges",
      { rangeIndex: 2, conflictingRangeIndex: 1 }
    );
  });

  test("preserves original card indices for conflicts around an empty draft", () => {
    expectRangeError(
      () =>
        prepareRangesForSave([
          configuredRange({ id: "range-a" }),
          createEmptyRange(2),
          configuredRange({ id: "range-b" })
        ]),
      "overlapping_ranges",
      { rangeIndex: 3, conflictingRangeIndex: 1 }
    );
  });

  test.each([
    ["ancestor first", "/Work", true, "/Work/Weekly", false],
    ["descendant first", "/Work/Weekly", false, "/Work", true]
  ])("rejects an ancestor range that includes children ($label)", (_label, firstPath, firstChildren, secondPath, secondChildren) => {
    expectRangeError(
      () =>
        prepareRangesForSave([
          configuredRange({ id: "range-a", hpathPrefix: firstPath, includeChildren: firstChildren }),
          configuredRange({ id: "range-b", hpathPrefix: secondPath, includeChildren: secondChildren })
        ]),
      "overlapping_ranges",
      { rangeIndex: 2, conflictingRangeIndex: 1 }
    );
  });

  test("allows an ancestor without children even when the descendant includes its children", () => {
    expect(
      prepareRangesForSave([
        configuredRange({ id: "range-a", hpathPrefix: "/Work", includeChildren: false }),
        configuredRange({ id: "range-b", hpathPrefix: "/Work/Weekly", includeChildren: true })
      ])
    ).toHaveLength(2);
  });

  test("allows sibling paths", () => {
    expect(
      prepareRangesForSave([
        configuredRange({ id: "range-a", hpathPrefix: "/Work/Weekly" }),
        configuredRange({ id: "range-b", hpathPrefix: "/Work/Monthly" })
      ])
    ).toHaveLength(2);
  });

  test("allows identical paths in different notebooks", () => {
    expect(
      prepareRangesForSave([
        configuredRange({ id: "range-a", notebookId: "box-1" }),
        configuredRange({ id: "range-b", notebookId: "box-2" })
      ])
    ).toHaveLength(2);
  });
});
