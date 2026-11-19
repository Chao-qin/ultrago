/**
 * Leaf module for numeric limits that agent-facing text must quote.
 *
 * No imports, so `mcp-instructions.ts` can read these without the
 * index → mcp-instructions → index cycle. `index.ts` re-exports them.
 */

/** Hard cap on ONE `browser.eval`, enforced page-side inside the injected
 * function. It is deliberately BELOW the RPC transport ceiling: whichever
 * timer fires first owns the error, and a transport-first timeout would
 * abandon the injected async code still running in the page with nobody left
 * to collect it. Deriving the transport ceiling from this constant (see
 * ws-server's RPC_TIMEOUT) keeps that ordering true by construction instead of
 * leaving it to whatever BCP_RPC_TIMEOUT_MS happens to be set to.
 *
 * eval is for COMPUTING a value, not for WAITING on one — a wait longer than
 * this belongs in a book signal gate (`browser.waitSignal`), which carries its
 * own deadline. `scripts/check-books.mjs` reads this constant and rejects any
 * book that tries to out-wait it.
 *
 * Raised 15s → 60s: the "don't wait here" rule still holds, but some steps do
 * BOUNDED WORK rather than waiting — e.g. matching 17 spec values means 17
 * sequential dropdown interactions, which a signal cannot perform on the step's
 * behalf (signals gate; they don't act). At 15s that work had to be split
 * across idempotent retries. The cost of the higher ceiling is that a runaway
 * eval now occupies its tab for a minute before the page-side timer reclaims
 * it. */
/* 60s → 90s（2026-09-07）：抖店规格图匹配一件商品实测 21 行 × 两遍，每行是一次
 * 独立的下拉交互（开面板 → 选值 → 收面板），signal 替不了它——门只判、不动手。
 * 48s 的预算实测刚好在临界点上：run f3c9434c 挤进去了，run b50a7db3 只多花了几秒
 * 关一次残留编辑器就翻车，21 行 0 匹配还报"配不上规格值"，症状离真因很远。
 * 提高上限不是给"等待"更多时间（那条规矩没变），是给【有界工作】的行数留余量。
 * 代价照旧：跑飞的 eval 会多占用那个 tab 半分钟。 */
export const EVAL_TIMEOUT_MS = 90_000;

/** `wait_for` timeout when the caller gives a text/selector but no `ms`. The
 *  backend always sends it explicitly, so the page-side runtime's own fallback
 *  never decides it. */
export const WAIT_FOR_DEFAULT_MS = 5_000;

/** Longest `wait_for` the transport will carry. The RPC ceiling for
 *  browser.waitFor is derived from it, so a wait the tool accepts can never be
 *  cut off by the transport first. */
export const WAIT_FOR_MAX_MS = 60_000;

/** How many XHR/fetch entries the extension keeps per tab for `read_network`
 *  (oldest dropped first). */
export const NETWORK_LOG_PER_TAB = 100;

/** Longest a read_content / analyze_page text dump survives on the backend
 *  host. It is also removed earlier, before the next browser operation. */
export const READ_DUMP_TTL_MS = 5 * 60_000;
