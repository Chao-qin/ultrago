import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BOOKS_QUERY_ROOT, bookLinkIsLive, booksQueryKey, matchesBookFilter, rescanMessages } from "./books.js";
import type { BookRef, Schedule } from "./types";

/** The whole frontend source tree, minus `lib/` — where the literal legitimately
 *  lives, inside `booksQueryKey` itself.
 *
 *  It is the whole tree and not a list of directories because the earlier
 *  version listed `pages/` and `components/` while calling itself "everything
 *  that renders", and `web/src/` has three files sitting beside those
 *  directories: `App.tsx` (which renders — it is the router), `main.tsx` and
 *  `studio-main.tsx` (the two Vite entries). Measured before the widening:
 *  appending `["books", false]` to App.tsx left the suite at 179 pass / 0 fail.
 *  Scanning down from the root also means a directory added later is covered on
 *  the day it is added rather than on the day someone remembers this list. */
const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCAN_EXEMPT_DIR = "lib";

// ── the cache key ─────────────────────────────────────────────────────────

test("booksQueryKey distinguishes the two requests it can produce", async () => {
  // The flag is in the URL, so it has to be in the key: one entry serving both
  // would hand the live-only view whatever the deleted-inclusive view fetched.
  assert.notDeepEqual(booksQueryKey(false), booksQueryKey(true));
});

test("booksQueryKey is invalidated by the shared root", async () => {
  // react-query matches by prefix. This is what lets one invalidate() reach
  // both entries — assert the prefix relation rather than trusting it.
  for (const includeDeleted of [false, true]) {
    const key = booksQueryKey(includeDeleted);
    assert.deepEqual(key.slice(0, BOOKS_QUERY_ROOT.length), [...BOOKS_QUERY_ROOT]);
  }
});

test("booksQueryKey(false) is not the same key as an omitted flag", async () => {
  // The bug this convention exists to stop: `["books"]` and `["books", false]`
  // are two cache entries for one identical request, each on its own timer.
  assert.notDeepEqual(booksQueryKey(false), [...BOOKS_QUERY_ROOT]);
});

test("nothing that renders builds a books query key by hand", async () => {
  // The convention used to live only in a comment, and half the call sites
  // ignored it. Prose cannot fail; this can. Every books key and every books
  // invalidation goes through lib/books.ts, so the literal must not reappear in
  // anything that renders.
  //
  // Three gaps have been closed in this guard, kept together so the next one is
  // easier to spot: `readdirSync` without `recursive` never descended into a
  // subdirectory; the pattern only accepted double quotes while `['books', …]`
  // is the same key (1f0dbb5); and the scan covered two named directories while
  // the comment claimed "anything that renders" (see SRC_ROOT above).
  //
  // It matches text, so a comment quoting the literal counts as an offender.
  // That is the intended strictness: a file outside lib/ has no reason to spell
  // it at all.
  const offenders: string[] = [];
  const files = readdirSync(SRC_ROOT, { recursive: true, encoding: "utf8" });
  const scanned = files.filter((f) =>
    (f.endsWith(".tsx") || f.endsWith(".ts")) && f.split(sep)[0] !== SCAN_EXEMPT_DIR);
  // Guard the guard: a scan that silently walked an empty tree would pass just
  // as loudly as a clean one. The three root-level files are the ones the
  // directory list used to miss, so name them.
  for (const must of ["App.tsx", "main.tsx", "studio-main.tsx"]) {
    assert.ok(scanned.includes(must), `${must} must be in scope: ${scanned.join(", ")}`);
  }
  for (const file of scanned) {
    const src = readFileSync(join(SRC_ROOT, file), "utf8");
    for (const [i, line] of src.split("\n").entries()) {
      if (/\[\s*['"]books['"]/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `use booksQueryKey() / BOOKS_QUERY_ROOT instead:\n${offenders.join("\n")}`);
});

// ── the client-side filter ────────────────────────────────────────────────

const book = (over: Partial<Parameters<typeof matchesBookFilter>[0]> = {}) => ({
  name: "nightly-report", description: "runs at 3am", enabled: true, deletedAt: null, ...over,
});
const filter = (over: Partial<Parameters<typeof matchesBookFilter>[1]> = {}) => ({
  search: "", showDisabled: false, ...over,
});

test("a disabled book is hidden until 包含已禁用 is on", async () => {
  assert.equal(matchesBookFilter(book({ enabled: false }), filter()), false);
  assert.equal(matchesBookFilter(book({ enabled: false }), filter({ showDisabled: true })), true);
});

test("a book that was disabled BEFORE it was deleted still shows up as deleted", async () => {
  // The hole this test exists for. Deletion is filtered server-side: if the row
  // came back at all, 「含已删除」is on and the user asked to see it. Letting the
  // enabled filter drop it again makes that switch silently a no-op for exactly
  // the rows it was added to reveal — and a row that is both disabled and
  // deleted is the normal case, not a corner one.
  const disabledThenDeleted = book({ enabled: false, deletedAt: "2026-08-01T00:00:00Z" });
  assert.equal(matchesBookFilter(disabledThenDeleted, filter({ showDisabled: false })), true);
});

test("an enabled live book shows with both switches off", async () => {
  assert.equal(matchesBookFilter(book(), filter()), true);
});

test("search matches name and description, case-insensitively", async () => {
  assert.equal(matchesBookFilter(book(), filter({ search: "NIGHTLY" })), true);
  assert.equal(matchesBookFilter(book(), filter({ search: "3AM" })), true);
  assert.equal(matchesBookFilter(book(), filter({ search: "weekly" })), false);
});

test("search tolerates a null description", async () => {
  assert.equal(matchesBookFilter(book({ description: null }), filter({ search: "nightly" })), true);
  assert.equal(matchesBookFilter(book({ description: null }), filter({ search: "runs" })), false);
});

test("search still applies to a deleted row", async () => {
  // The deleted exemption is from the ENABLED filter only. A deleted book that
  // does not match the search box must stay out, or the box stops working the
  // moment 「含已删除」is switched on.
  const deleted = book({ enabled: false, deletedAt: "2026-08-01T00:00:00Z" });
  assert.equal(matchesBookFilter(deleted, filter({ search: "weekly" })), false);
  assert.equal(matchesBookFilter(deleted, filter({ search: "nightly" })), true);
});

test("the enabled filter is inoperative on deleted rows, by decision", async () => {
  // The cell that reads backwards, pinned so it stays a decision rather than
  // drift: 「包含已禁用」off + disabled + deleted still shows. The exemption that
  // rescues the disabled-then-deleted book (test above) is the same exemption
  // that makes the switch unable to hide it. Whoever wants to change that has to
  // change this assertion and read the comment in books.ts first.
  const deleted = book({ enabled: false, deletedAt: "2026-08-01T00:00:00Z" });
  assert.equal(matchesBookFilter(deleted, filter({ showDisabled: false })), true);
  assert.equal(matchesBookFilter(deleted, filter({ showDisabled: true })), true);
  // Contrast: on a LIVE row the switch works both ways.
  const live = book({ enabled: false });
  assert.equal(matchesBookFilter(live, filter({ showDisabled: false })), false);
  assert.equal(matchesBookFilter(live, filter({ showDisabled: true })), true);
});

// ── linking into a book ───────────────────────────────────────────────────

const bookRef = (over: Partial<BookRef> = {}): BookRef => ({
  id: "b1", name: "nightly-report", enabled: true, deliveriesJson: "[]", deletedAt: null, ...over,
});

/** A schedule row, cut down to the fields that decide whether it can be
 *  mistaken for a book. It carries `id` / `name` / `enabled` / `deletedAt` —
 *  everything `bookLinkIsLive` actually READS — which is why a signature
 *  written against what it reads let the original bug compile. */
const scheduleRow = { id: "s1", name: "nightly", enabled: true, deletedAt: "2026-08-01T00:00:00Z", book: bookRef() };

test("a live book is linkable and a deleted one is not", async () => {
  assert.equal(bookLinkIsLive(bookRef()), true);
  assert.equal(bookLinkIsLive(bookRef({ deletedAt: "2026-08-01T00:00:00Z" })), false);
});

test("linkability follows the book, not the row that displays it", async () => {
  // The Schedules page's Book column bug: it judged the SCHEDULE's deletedAt.
  // These two cases are the ones that separate the predicates — a schedule
  // deleted on its own (book alive, link must stay) and the cascade (both gone).
  assert.equal(bookLinkIsLive(scheduleRow.book), true, "the book outlived its schedule");
  const cascaded = { ...scheduleRow, book: bookRef({ deletedAt: "2026-08-01T00:00:00Z" }) };
  assert.equal(bookLinkIsLive(cascaded.book), false);
});

test("the schedule itself cannot be passed where its book belongs", async () => {
  // The assertion IS the directive. 67e83e3 said the signature "spells out what
  // it judges", but a parameter of `{ deletedAt?: string | null }` accepts a
  // schedule as readily as a book — so the fix documented the rule and left it
  // unenforced. `BookRef` enforces it.
  //
  // This directive guards `scheduleRow`'s own literal shape (it has no
  // `deliveriesJson` key at all), NOT the real `Schedule` interface — mutating
  // `Schedule` cannot change whether this line compiles, since `scheduleRow`
  // was never typed as `Schedule` in the first place (2026-08-28 measured: gave
  // `Schedule` a `deliveriesJson` field, rebuilt `@bcp/shared`, ran `build:web`
  // — zero TS2578, this line unaffected). The probe that actually reacts to
  // `Schedule`'s definition is `scheduleTypeIsNotBookRef` below.
  // @ts-expect-error — a schedule is not a book.
  const wrong = bookLinkIsLive(scheduleRow);
  // Spelled out because it reads backwards: at RUNTIME this returns false (the
  // schedule's own deletedAt is set) while its book is alive — the exact wrong
  // answer, greying out a link that still works. Only the type stops it.
  assert.equal(wrong, false);
  assert.equal(bookLinkIsLive(scheduleRow.book), true, "…while the right argument says true");
});

test("a bare deletedAt blob cannot be passed either", async () => {
  // How the bug was actually written: an anonymous object with just the field
  // the predicate reads. Nothing about it says which row it came from.
  // @ts-expect-error — `{ deletedAt }` alone is not a book.
  const bare = bookLinkIsLive({ deletedAt: null });
  assert.equal(bare, true, "runtime is fine; the type check is what must not pass");
});

// ── the real TS2578 tripwire ─────────────────────────────────────────────
//
// Everything above type-checks `scheduleRow`, a hand-written literal — its
// assignability to `BookRef` is decided by its own shape, never by the real
// `Schedule` interface, so none of it reacts to `Schedule` changing. This one
// is typed against the actual interface instead: `typedSchedule` is `declare`d
// as `Schedule` (never initialized — it must never run, only compile), so the
// `@ts-expect-error` below is checked against whatever fields `Schedule`
// really has today. If `Schedule` ever grows a `deliveriesJson: string` field,
// `typedSchedule` becomes assignable to `BookRef`, the directive goes unused,
// and `build:web`'s tsc fails with TS2578 (2026-08-28 measured: adding
// `deliveriesJson: string` to `Schedule`, rebuilding `@bcp/shared`, then
// running `build:web` reproduces exactly that — `error TS2578: Unused
// '@ts-expect-error' directive.` at the line below).
declare const typedSchedule: Schedule;
function scheduleTypeIsNotBookRef(): boolean {
  // @ts-expect-error — `Schedule` (the real interface) is not a `BookRef`.
  return bookLinkIsLive(typedSchedule);
}
void scheduleTypeIsNotBookRef; // never called — exists only for tsc to check

// ── rescanMessages ──────────────────────────────────────────────────────────

test("a clean rescan reports the count and warns about nothing", () => {
  const { success, warning } = rescanMessages({ indexed: 6, missing: [] });
  assert.match(success, /6/);
  assert.equal(warning, null, "no missing files means no warning to show");
});

test("a rescan that found orphans names every one of them", () => {
  const { warning } = rescanMessages({ indexed: 5, missing: ["ghost", "retired"] });
  assert.ok(warning, "a non-empty `missing` must never be dropped silently");
  assert.match(warning, /2/, "the count");
  assert.match(warning, /ghost/);
  assert.match(warning, /retired/, "every name, not just the first");
});

test("the orphan warning says the books are still runnable", () => {
  // The actionable part. "File is gone" alone reads as "it stopped working";
  // the truth is the opposite and more dangerous — it still runs, from a copy
  // in the database that nothing on disk corresponds to any more.
  const { warning } = rescanMessages({ indexed: 1, missing: ["ghost"] });
  assert.match(String(warning), /仍可被触发/);
});

test("the success line is reported even when orphans exist", () => {
  // The two are independent: a scan that indexed five books AND found an orphan
  // did both, and reporting only the alarming half hides that the scan worked.
  const { success, warning } = rescanMessages({ indexed: 5, missing: ["ghost"] });
  assert.match(success, /5/);
  assert.ok(warning);
});
