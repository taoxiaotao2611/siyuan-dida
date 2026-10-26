// @vitest-environment happy-dom

import { describe, expect, test, vi } from "vitest";
import { createTranslator } from "../i18n";
import type { SyncResult } from "../core/types";
import {
  buildStatusPanel,
  createSyncStatusController,
  type SyncStatusSnapshot
} from "./statusPanel";

function result(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    scanned: 8,
    created: 2,
    recovered: 1,
    updated: 3,
    completed: 4,
    writtenBack: 5,
    skipped: 6,
    failed: 0,
    rangeResults: [],
    rangeCursorOffsets: {},
    events: [],
    failures: [],
    startedAt: "2026-08-20T01:02:02.000Z",
    finishedAt: "2026-08-20T01:02:03.000Z",
    ...overrides
  };
}

function statusText(panel: HTMLElement) {
  return panel.querySelector<HTMLElement>('[data-field="syncStatus"]')!.textContent;
}

describe("sync status controller", () => {
  test("notifies subscribers and returns an unsubscribe function", () => {
    const initial: SyncStatusSnapshot = { state: "pending" };
    const controller = createSyncStatusController(initial);
    const subscriber = vi.fn();
    const unsubscribe = controller.subscribe(subscriber);

    expect(subscriber).toHaveBeenCalledWith(initial);
    controller.publish({ state: "syncing" });
    expect(subscriber).toHaveBeenLastCalledWith({ state: "syncing" });

    unsubscribe();
    controller.publish({ state: "failed", message: "offline" });
    expect(subscriber).toHaveBeenCalledTimes(2);
  });

  test("isolates throwing subscribers so later subscribers still receive updates", () => {
    const controller = createSyncStatusController({ state: "pending" });
    controller.subscribe((snapshot) => {
      if (snapshot.state === "syncing") throw new Error("subscriber failed");
    });
    const laterSubscriber = vi.fn();
    controller.subscribe(laterSubscriber);

    expect(() => controller.publish({ state: "syncing" })).not.toThrow();
    expect(laterSubscriber).toHaveBeenLastCalledWith({ state: "syncing" });
  });

  test("uses a stable subscriber snapshot during reentrant unsubscribe", () => {
    const controller = createSyncStatusController({ state: "pending" });
    let unsubscribeLater: () => void = () => undefined;
    controller.subscribe((snapshot) => {
      if (snapshot.state === "syncing") unsubscribeLater();
    });
    const laterSubscriber = vi.fn();
    unsubscribeLater = controller.subscribe(laterSubscriber);
    laterSubscriber.mockClear();

    controller.publish({ state: "syncing" });

    expect(laterSubscriber).toHaveBeenCalledOnce();
    controller.publish({ state: "success" });
    expect(laterSubscriber).toHaveBeenCalledOnce();
  });
});

describe("buildStatusPanel", () => {
  test.each([
    [{ state: "pending" } as SyncStatusSnapshot, "Pending"],
    [{ state: "syncing" } as SyncStatusSnapshot, "Syncing…"],
    [{ state: "success" } as SyncStatusSnapshot, "Synced"],
    [{ state: "failed", message: "offline" } as SyncStatusSnapshot, "Failed"]
  ])("renders the %s state", (snapshot, label) => {
    const controller = createSyncStatusController(snapshot);
    const view = buildStatusPanel({
      status: controller,
      t: createTranslator("en"),
      onSyncNow: vi.fn()
    });

    expect(statusText(view.element)).toContain(label);
    if (snapshot.message) {
      expect(view.element.textContent).toContain(snapshot.message);
    }
  });

  test("updates the status, localized time, and all counters", () => {
    const controller = createSyncStatusController({ state: "pending" });
    const view = buildStatusPanel({
      status: controller,
      t: createTranslator("en"),
      locale: "en-US",
      onSyncNow: vi.fn()
    });

    controller.publish({
      state: "success",
      latestResult: result(),
      lastFinishedAt: "2026-08-20T01:02:03.000Z"
    });

    expect(view.element.querySelector('[data-field="lastFinishedAt"]')!.textContent).not.toBe("—");
    expect(view.element.textContent).toContain("Scanned 8");
    expect(view.element.textContent).toContain("Created 2");
    expect(view.element.textContent).toContain("Recovered 1");
    expect(view.element.textContent).toContain("Updated 3");
    expect(view.element.textContent).toContain("Completed 4");
    expect(view.element.textContent).toContain("Written back 5");
    expect(view.element.textContent).toContain("Skipped 6");
    expect(view.element.textContent).toContain("Failed 0");
  });

  test("renders list to document sync results", () => {
    const controller = createSyncStatusController({
      state: "success",
      latestResult: result({
        docSyncs: [
          {
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
          }
        ]
      })
    });
    const view = buildStatusPanel({
      status: controller,
      t: createTranslator("en"),
      onSyncNow: vi.fn()
    });

    expect(view.element.textContent).toContain("List → document sync");
    expect(view.element.textContent).toContain("Courses (Later) → /Target");
    expect(view.element.textContent).toContain(
      "created 1, updated 2, archived 1, deduplicated 0, reordered 0, failed 0"
    );
  });

  test("hides the mirror section when no mirror ran", () => {
    const controller = createSyncStatusController({ state: "success", latestResult: result() });
    const view = buildStatusPanel({
      status: controller,
      t: createTranslator("en"),
      onSyncNow: vi.fn()
    });

    const section = view.element.querySelector<HTMLElement>('[data-field="docSyncStatus"]')!;
    expect(section.hidden).toBe(true);
    expect(view.element.textContent).not.toContain("List → document sync");
  });

  test("treats missing recovered from an old log as zero", () => {
    const oldResult = result();
    delete oldResult.recovered;
    const controller = createSyncStatusController({ state: "success", latestResult: oldResult });
    const view = buildStatusPanel({
      status: controller,
      t: createTranslator("en"),
      onSyncNow: vi.fn()
    });

    expect(view.element.textContent).toContain("Recovered 0");
  });

  test("runs manual sync and disables the button while syncing", async () => {
    const controller = createSyncStatusController({ state: "pending" });
    const onSyncNow = vi.fn(async () => undefined);
    const view = buildStatusPanel({ status: controller, t: createTranslator("en"), onSyncNow });
    const button = view.element.querySelector<HTMLButtonElement>('[data-action="syncNow"]')!;

    button.click();
    expect(onSyncNow).toHaveBeenCalledOnce();

    controller.publish({ state: "syncing" });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");

    controller.publish({ state: "success" });
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });

  test("destroy unsubscribes and removes the click callback", () => {
    const controller = createSyncStatusController({ state: "pending" });
    const onSyncNow = vi.fn();
    const view = buildStatusPanel({ status: controller, t: createTranslator("en"), onSyncNow });
    const button = view.element.querySelector<HTMLButtonElement>('[data-action="syncNow"]')!;

    view.destroy();
    controller.publish({ state: "failed", message: "late failure" });
    button.click();

    expect(statusText(view.element)).toContain("Pending");
    expect(view.element.textContent).not.toContain("late failure");
    expect(onSyncNow).not.toHaveBeenCalled();
  });

  test("announces a failure message through a live region", () => {
    const controller = createSyncStatusController({ state: "failed", message: "offline" });
    const view = buildStatusPanel({
      status: controller,
      t: createTranslator("en"),
      onSyncNow: vi.fn()
    });
    const message = view.element.querySelector<HTMLElement>('[data-field="statusMessage"]')!;
    const liveRegion = message.closest<HTMLElement>('[aria-live]');

    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.getAttribute("aria-live")).toBe("polite");
  });
});
