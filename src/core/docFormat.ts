import type { DidaProjectTask } from "./types";

/** Bold prefixes for mirrored tasks that left the open list. */
export const DOC_COMPLETED_MARKER = "**【已完成】**";
export const DOC_DELETED_MARKER = "**【已删除】**";

/**
 * Renders one Dida task into exactly one SiYuan paragraph block. The block has
 * an intentional in-block line break:
 *
 *   <title>
 *    YY.MM.DD HH:MM 时间点待办
 *   <title>
 *    YY.MM.DD HH:MM开始 将历时XhYm
 *
 * Tasks without a date keep only the title. Markdown characters in the title
 * are escaped so the block renders as literal text.
 */
export function renderDocTask(
  task: Pick<DidaProjectTask, "title" | "startDate" | "dueDate" | "timeZone">
): string {
  const title = escapePlainTextBlock(normalizeTaskTitle(task.title));
  if (!title) {
    return "";
  }
  const anchor = formatTaskAnchor(task.startDate, task.dueDate, task.timeZone);
  if (!anchor) {
    return title;
  }
  const schedule = taskScheduleLabel(task.startDate, task.dueDate);
  const separator = schedule.startsWith("开始") ? "" : " ";
  return `${title}\n ${anchor}${separator}${schedule}`;
}

/** Collapse whitespace so one task always maps to exactly one block. */
export function normalizeTaskTitle(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** `YY.MM.DD HH:MM` in the task time zone (falls back to the local zone). */
export function formatTaskAnchor(
  startDate?: string,
  dueDate?: string,
  timeZone?: string
): string {
  const raw = [startDate, dueDate].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  if (!raw) {
    return "";
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const parts = anchorFormatter(timeZone).formatToParts(new Date(timestamp));
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  const hour = pick("hour");
  const minute = pick("minute");
  if (!year || !month || !day || !hour || !minute) {
    return "";
  }
  return `${year}.${month}.${day} ${hour}:${minute}`;
}

/** `时间点待办` for point tasks, `开始 将历时XhYm` for time ranges. */
export function taskScheduleLabel(startDate?: string, dueDate?: string): string {
  const start = typeof startDate === "string" ? Date.parse(startDate) : Number.NaN;
  const due = typeof dueDate === "string" ? Date.parse(dueDate) : Number.NaN;
  if (Number.isFinite(start) && Number.isFinite(due) && due > start) {
    const totalMinutes = Math.round((due - start) / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `开始 将历时${hours}h${minutes}m`;
  }
  return "时间点待办";
}

export function isArchivedMarkdown(markdown: string): boolean {
  return markdown.startsWith(DOC_COMPLETED_MARKER) || markdown.startsWith(DOC_DELETED_MARKER);
}

/** Prepends the bold completed/deleted marker once; later calls are no-ops. */
export function markDocTaskArchived(
  markdown: string,
  kind: "completed" | "deleted"
): string {
  if (isArchivedMarkdown(markdown)) {
    return markdown;
  }
  const marker = kind === "completed" ? DOC_COMPLETED_MARKER : DOC_DELETED_MARKER;
  return `${marker} ${markdown}`.trim();
}

function anchorFormatter(timeZone?: string): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  };
  const zone = typeof timeZone === "string" && timeZone.trim() ? timeZone.trim() : undefined;
  try {
    return new Intl.DateTimeFormat("en-GB", zone ? { ...options, timeZone: zone } : options);
  } catch {
    return new Intl.DateTimeFormat("en-GB", options);
  }
}

// Backslashes are handled by the dedicated pass below; excluding them here
// keeps the two passes from escaping the same character twice.
const INLINE_MARKDOWN_CHARS = /[`*_[\]{}~|<>#!]/g;

/**
 * Escape inline Markdown so the block renders as the literal task text.
 * Leading list/heading/quote markers are escaped too, which keeps SiYuan from
 * re-typing the paragraph into a different block type.
 */
export function escapePlainTextBlock(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(INLINE_MARKDOWN_CHARS, (char) => `\\${char}`)
    .replace(/^([+\->])(?=\s)/, "\\$1")
    .replace(/^(\d+)([.)])(?=\s)/, "$1\\$2");
}
