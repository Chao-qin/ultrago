/**
 * The two Books-list conventions that more than one page has to agree on.
 *
 * Both used to live as prose in a comment next to one of their call sites, and
 * both were then applied to some call sites and not others — the cache key
 * carried `includeDeleted` on the Books page while Schedules and FlowEditor
 * still used a bare `["books"]`, so one URL sat behind two cache entries, each
 * polling on its own timer. A convention that only a comment enforces is a
 * convention that drifts; these are importable so that drifting takes an edit.
 */
import type { BookRef } from "./types";

/** Prefix for every books query key. Invalidation targets it: react-query
 *  matches keys by prefix, so this one call covers `["books", false]` and
 *  `["books", true]` both. */
export const BOOKS_QUERY_ROOT = ["books"] as const;

/** The cache key for one books request.
 *
 *  `includeDeleted` is part of the key because it is part of the URL, and it is
 *  passed EXPLICITLY (never left undefined) because `["books", undefined]` and
 *  `["books", false]` are two different keys for one identical request. Callers
 *  that only ever want live rows still say `booksQueryKey(false)`. */
export const booksQueryKey = (includeDeleted: boolean) => ["books", includeDeleted] as const;

/** Can `/books/:id` still be opened for this book?
 *
 *  `BooksService.findById` resolves through `deletedAt: null`, so a deleted book
 *  answers 404 and a link into it is a dead end.
 *
 *  It takes the BOOK, not whatever row is displaying it. The Schedules page's
 *  Book column used to read the SCHEDULE's `deletedAt` — true whenever the
 *  cascade from `books.service.delete()` deleted both, and wrong the other way
 *  round: a schedule deleted on its own leaves its book alive, and that link was
 *  greyed out for no reason.
 *
 *  The parameter is `BookRef` rather than the `{ deletedAt?: string | null }`
 *  it reads, and that is the whole point: a signature that only asks for
 *  `deletedAt` accepts a `Schedule` too — measured, it compiled — so it
 *  documented the rule without enforcing it, and the bug it was written to fix
 *  could be written again. `BookRef` is the shape the one production call site
 *  (`Schedules.tsx`, passing `Schedule["book"]`) actually has, and a `Schedule`
 *  is not assignable to it. What does the separating work is `deliveriesJson`,
 *  the only `BookRef` field a `Schedule` lacks — thin on purpose and pinned by
 *  `scheduleTypeIsNotBookRef`'s `@ts-expect-error` probe in `books.test.ts`.
 *  That probe is typed against the real `Schedule` interface (via `declare
 *  const typedSchedule: Schedule`, never a hand-written literal), so it
 *  actually reacts if `Schedule` grows `deliveriesJson` — the other probes in
 *  that file check a plain object literal and would not. */
export function bookLinkIsLive(book: BookRef): boolean {
  return !book.deletedAt;
}

/** Whether a row survives the Books page's two client-side switches.
 *
 *  The switches are orthogonal: 「包含已禁用」filters on enabled state,
 *  「含已删除」on deleted state. A deleted row is therefore exempt from the
 *  enabled filter — otherwise a book that was disabled first and deleted second
 *  stays hidden with 「含已删除」on, and that switch is silently a no-op for
 *  exactly the rows it exists to reveal.
 *
 *  The price of that exemption, stated plainly because it is a real one:
 *  「包含已禁用」cannot hide a deleted row. With the switch off, a deleted AND
 *  disabled book is still shown. That is deliberate — for a deleted row
 *  `enabled` describes nothing that can happen (the scheduler skips it either
 *  way), and 「含已删除」is the switch the user just used to ask for it — but it
 *  does mean the enabled filter is inoperative on exactly those rows. The truth
 *  table is pinned in books.test.ts so this stays a decision rather than drift.
 *
 *  Deletion is filtered server-side (it changes the request); this predicate
 *  only decides what to do with what came back. */
export function matchesBookFilter(
  book: { name: string; description?: string | null; enabled: boolean; deletedAt?: string | null },
  filter: { search: string; showDisabled: boolean },
): boolean {
  if (!filter.showDisabled && !book.enabled && !book.deletedAt) return false;
  if (!filter.search) return true;
  const needle = filter.search.toLowerCase();
  return book.name.toLowerCase().includes(needle)
    || (book.description ?? "").toLowerCase().includes(needle);
}

/** What the 重新扫描 button reports.
 *
 *  Extracted from `Books.tsx` so it can be tested: `web/` has no renderer in
 *  the suite (only `lib/*.test.ts`, run by the console's `node --test`), and
 *  standing up jsdom + a component harness to cover two strings would cost more
 *  than the thing it verifies. The decision worth pinning is not how the toast
 *  looks — it is that a non-empty `missing` is never silently dropped.
 *
 *  `missing` is the half of a rescan that the scan did not even compute until
 *  2026-08-28: a book whose JSON file is gone stays listed, enabled and
 *  triggerable, and a run executes the last-indexed copy from the database. If
 *  the page swallows that, the drift is invisible again and the fix bought
 *  nothing. */
export function rescanMessages(result: { indexed: number; missing: string[] }): {
  success: string;
  warning: string | null;
} {
  return {
    success: `已索引 ${result.indexed} 个 playbook`,
    warning:
      result.missing.length > 0
        ? `${result.missing.length} 个 book 在磁盘上已无对应文件：${result.missing.join("、")}。` +
          `它们仍可被触发，会跑最后一次索引的副本`
        : null,
  };
}
