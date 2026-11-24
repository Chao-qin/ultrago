/**
 * One way of deciding whether a piece of text matches what was asked for — used by snapshot's query, the plan
 * verifiers (elementName / elementChecked / elementEnabled / elementValue) and pick_option.
 *
 * Six places each had their own rule: query was case-insensitive substring, the verifiers case-SENSITIVE substring
 * ("同意" matched a checked "不同意并退出"), pick_option exact-then-substring, wait_for case-sensitive without
 * whitespace folding. The same words then matched in one tool and not the next, and an agent answers that by
 * guessing other words. Nothing here knows a site, a tag or a word: text is normalized (case, every kind of
 * whitespace, invisible formatting characters) and graded; the caller decides what a grade is worth.
 *
 * The injected page runtime cannot import this (it is serialized into the page), so its locators and wait_for keep
 * a copy of `normalizeText`; check:dom runs the same cases against both.
 */

/** Case-folded, every run of whitespace (no-break spaces included) one space, invisible formatting characters
 *  (zero-width space / non-joiner / joiner, byte-order mark, soft hyphen) removed, trimmed. */
export function normalizeText(s: string): string {
  return s.replace(/[\u200b-\u200d\ufeff\u00ad]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** How well `text` matches `want`, best first: the whole text equals it ("exact"); it occurs in the text as one piece
 *  ("substring"); every word of a several-word `want` occurs, in any order ("words" — a search ranking only, never
 *  evidence: "I agree" is in "I don't agree" word by word). Undefined when it does not match at all, or when `want`
 *  normalizes to nothing — an empty expectation matches everything, which is no evidence of anything. */
export type MatchGrade = "exact" | "words" | "substring";

export function matchGrade(text: string | undefined, want: string): MatchGrade | undefined {
  const w = normalizeText(want);
  if (!w || text == null) return undefined;
  const t = normalizeText(text);
  if (t === w) return "exact";
  if (t.includes(w)) return "substring";
  const words = w.split(" ");
  return words.length > 1 && words.every((x) => t.includes(x)) ? "words" : undefined;
}

const RANK: Record<MatchGrade, number> = { exact: 0, words: 2, substring: 1 };

/** The better of two grades (undefined counts as no match). */
export function bestGrade(a: MatchGrade | undefined, b: MatchGrade | undefined): MatchGrade | undefined {
  if (!a) return b;
  if (!b) return a;
  return RANK[a] <= RANK[b] ? a : b;
}

/** Sort key: lower is better. */
export const gradeRank = (g: MatchGrade): number => RANK[g];

/** Inputs and what they normalize to — the cases both copies of the rule must agree on (the shared one in the
 *  backend's text-match.test.ts, the page runtime's in check:dom). */
export const TEXT_MATCH_CASES: readonly [string, string][] = [
  ["Save Draft", "save draft"],
  ["  Save\u00a0\u00a0Draft\n", "save draft"],
  ["保\u200b存", "保存"],
  ["co\u00adoperate", "cooperate"],
  ["\ufeff保\u200c存\u200d", "保存"],
  ["ＡＢＣ", "ａｂｃ"],
];
