/**
 * PROVISIONAL renderer for the Dida -> SiYuan document mirror.
 *
 * The final block format has not been specified yet, so each task becomes one
 * plain-text paragraph whose title is escaped so SiYuan renders it literally.
 * Plain paragraphs are deliberate: checkbox/ list blocks would be picked up by
 * the reverse sync as unbound SiYuan todos and could be copied back into Dida.
 *
 * When the requested format arrives, change only this function; the mirror
 * engine treats rendered strings as opaque Markdown.
 */
export function renderDocTask(task: { title?: string | undefined }): string {
  const title = normalizeTaskTitle(task.title);
  if (!title) {
    return "";
  }
  return escapePlainTextBlock(title);
}

/** Collapse whitespace so one task always maps to exactly one block. */
export function normalizeTaskTitle(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

// Backslashes are handled by the dedicated pass above; excluding them here
// keeps the two passes from escaping the same character twice.
const INLINE_MARKDOWN_CHARS = /[`*_[\]{}~|<>#!]/g;

/**
 * Escape inline Markdown so the block renders as the literal task text.
 * Leading list/heading/quote markers are escaped too, which keeps SiYuan from
 * re-typing the paragraph into a different block type.
 */
export function escapePlainTextBlock(text: string): string {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(INLINE_MARKDOWN_CHARS, (char) => `\\${char}`)
    .replace(/^([+\->])(?=\s)/, "\\$1")
    .replace(/^(\d+)([.)])(?=\s)/, "$1\\$2");
  return escaped;
}
