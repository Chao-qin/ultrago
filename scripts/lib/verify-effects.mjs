/**
 * What a read-only `verify.evalCheck` may not contain — the static half of the
 * rule whose runtime half is `bcpReadOnlyGuard` (packages/extension/src/content/dom-runtime.ts).
 *
 * The runtime guard refuses page effects as they happen; this catches the same
 * shapes in a book before it ever runs, plus the one effect the guard cannot
 * see: writes to page JS state such as `window.__x = …`. A step that has to act
 * puts that code in `verify.evalUntil` instead.
 *
 * Shared by check-books (enforces it) and census-books (reports it), so the two
 * can never disagree about what counts as a side effect.
 */
const SHAPES = [
  ["click / focus / blur", /\.(click|focus|blur)\s*\(/],
  ["bcpDom actions", /bcpDom\.(click|press|hover|setValue|setFiles)\s*\(/],
  ["scrolling", /scroll(IntoView|To|By)?\s*\(|scroll(Top|Left)\s*=(?!=)/],
  ["dispatching events", /dispatchEvent\s*\(/],
  ["DOM writes", /\.(value|checked|selected|selectedIndex|textContent|innerHTML|innerText|outerHTML|className|src|href|hidden|disabled)\s*=(?!=)|\.style\.\w+\s*=(?!=)|(set|remove|toggle)Attribute\s*\(|classList\.(add|remove|toggle|replace)\s*\(|\.(append|prepend|appendChild|removeChild|insertBefore|replaceChild|replaceWith|insertAdjacent\w*)\s*\(|\.remove\s*\(\s*\)/],
  ["forms, network and storage", /\.(submit|requestSubmit)\s*\(|\bfetch\s*\(|XMLHttpRequest|sendBeacon|\.(setItem|removeItem)\s*\(|document\.cookie\s*=(?!=)/],
  ["navigation and windows", /history\.(push|replace)State|location\.(assign|replace|reload)\s*\(|location(\.href)?\s*=(?!=)|window\.open\s*\(/],
  ["page state writes", /window\.__\w+\s*=(?!=)/],
  ["waiting", /\bawait\b|\.then\s*\(|bcpWait\./],
];

/** The first side effect `code` shows, as `{ what, snippet }`, or null when it reads only. */
export function verifySideEffect(code) {
  for (const [what, re] of SHAPES) {
    const m = re.exec(code);
    if (m) return { what, snippet: m[0] };
  }
  return null;
}
