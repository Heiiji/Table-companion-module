/** Escape the five HTML-significant characters so untrusted text can be safely
 * interpolated into the DialogV2 `content` strings we build by concatenation. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

/** Plain text as escaped HTML paragraphs (a blank line separates two): how
 * app-authored text lands in a Foundry HTML field (an editor or `{{{ }}}`). */
export function paragraphsHtml(plain: string): string {
  return plain
    .split(/\r?\n[ \t]*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");
}
