import type { DidaProjectTask } from "./types";

/** Bold prefixes for mirrored tasks that left the open list. */
export const DOC_COMPLETED_MARKER = "**【已完成】**";
export const DOC_DELETED_MARKER = "**【已删除】**";

const COUNTDOWN_PREFIXES = ["距今日还有", "距今日已过"];

/**
 * Renders one Dida task into exactly one SiYuan paragraph block with in-block
 * line breaks:
 *
 *   <title>
 *    YY.MM.DD HH:MM 时间点待办
 *   距今日还有XwYd（Zday）
 *
 *   <title>
 *    YY.MM.DD HH:MM开始 将历时XhYm
 *   距今日还有XwYd（Zday）
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
  const schedule = scheduleLabel(task.startDate, task.dueDate);
  const separator = schedule.startsWith("开始") ? "" : " ";
  const lines = [title, ` ${anchor}${separator}${schedule}`];
  const countdown = formatTaskCountdown(task.startDate, task.dueDate, task.timeZone);
  if (countdown) {
    lines.push(countdown);
  }
  return lines.join("\n");
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
  const parts = taskDateParts(startDate, dueDate, timeZone);
  if (!parts) {
    return "";
  }
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
}

/** `时间点待办` for point tasks, `开始 将历时XhYm` for time ranges. */
export function scheduleLabel(startDate?: string, dueDate?: string): string {
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

/**
 * `距今日还有XwYd（Zday）` for today/future dates and
 * `距今日已过XwYd（Zday）` for dates that already passed.
 */
export function formatTaskCountdown(
  startDate?: string,
  dueDate?: string,
  timeZone?: string,
  now: Date = new Date()
): string | undefined {
  const target = taskDateParts(startDate, dueDate, timeZone);
  if (!target) {
    return undefined;
  }
  const today = dateParts(now, timeZone);
  if (!today) {
    return undefined;
  }
  const totalDays = differenceInDays(today, target);
  const absoluteDays = Math.abs(totalDays);
  const weeks = Math.floor(absoluteDays / 7);
  const days = absoluteDays % 7;
  const prefix = totalDays < 0 ? "距今日已过" : "距今日还有";
  return `${prefix}${weeks}w${days}d（${absoluteDays}day）`;
}

export function isArchivedMarkdown(markdown: string): boolean {
  return markdown.startsWith(DOC_COMPLETED_MARKER) || markdown.startsWith(DOC_DELETED_MARKER);
}

/**
 * Prepends the bold completed/deleted marker once and drops the stale countdown
 * line, so archived blocks keep only the title and schedule lines.
 */
export function markDocTaskArchived(
  markdown: string,
  kind: "completed" | "deleted"
): string {
  if (isArchivedMarkdown(markdown)) {
    return markdown;
  }
  const marker = kind === "completed" ? DOC_COMPLETED_MARKER : DOC_DELETED_MARKER;
  const withoutCountdown = markdown
    .split("\n")
    .filter((line) => !COUNTDOWN_PREFIXES.some((prefix) => line.startsWith(prefix)))
    .join("\n");
  return `${marker} ${withoutCountdown}`.trim();
}

interface DateParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

function taskDateParts(
  startDate?: string,
  dueDate?: string,
  timeZone?: string
): DateParts | undefined {
  const raw = [startDate, dueDate].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  if (!raw) {
    return undefined;
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return dateParts(new Date(timestamp), timeZone);
}

function dateParts(date: Date, timeZone?: string): DateParts | undefined {
  const parts = formatter(timeZone).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const parsed: DateParts = {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute")
  };
  return parsed.year && parsed.month && parsed.day && parsed.hour && parsed.minute
    ? parsed
    : undefined;
}

function differenceInDays(from: DateParts, to: DateParts): number {
  const fromTime = Date.UTC(Number(from.year), Number(from.month) - 1, Number(from.day));
  const toTime = Date.UTC(Number(to.year), Number(to.month) - 1, Number(to.day));
  return Math.round((toTime - fromTime) / 86_400_000);
}

function formatter(timeZone?: string): Intl.DateTimeFormat {
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
