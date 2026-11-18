/**
 * How the console renders the handful of values that show up on every page.
 *
 * These existed before, one copy per call site, and had drifted into four
 * different answers for the same question: a 146-second run read as
 * `146303ms` on 运行记录 and the run detail, `146.3s` on 流程运行, and
 * `2.4s` in the LLM log. Same number, three formats, and the raw-millisecond
 * ones are unreadable at a glance — nobody converts six digits in their head.
 */

/**
 * A duration, in the largest unit that still says something useful.
 *
 * Sub-second stays in milliseconds because that is the range where the exact
 * figure matters (a 40ms call and a 900ms call are different animals). Past a
 * second it switches to seconds, and past a minute to `m s`, because by then
 * you are asking "roughly how long" and the trailing digits are noise.
 *
 * `null` means "not measured", which is not the same as zero, so it renders as
 * an em dash rather than `0ms`.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  // 5m 0s reads worse than 5m — drop the tail when it rounds away.
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/**
 * A count, with thousands separators — `16,882`, not `16882`.
 *
 * antd's `<Statistic>` did this for free, which is why the dashboard lost it
 * the moment those cards became plain markup. Six unbroken digits is the
 * difference between reading a number and counting it.
 */
export function formatCount(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US");
}

/**
 * 花费。存的是 micro（货币的百万分之一），显示的是人看的金额。
 *
 * 小额多给两位小数：单次调用常在千分之一的量级，`0.01` 会把一串差了十倍的
 * 调用显示成同一个数。总额则两位就够——那时候关心的是量级不是尾数。
 *
 * `null` 是**算不出来**（渠道没填单价，或上游不报 usage），不是免费，所以和
 * 其它「未测量」一样渲染成破折号而不是 0。
 */
export function formatCost(
  micros: number | null | undefined,
  currency?: string | null,
): string {
  if (micros == null || Number.isNaN(micros)) return "—";
  const value = micros / 1_000_000;
  const digits = value !== 0 && Math.abs(value) < 1 ? 4 : 2;
  const amount = value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return currency ? `${amount} ${currency}` : amount;
}

/** 27.3 MB rather than 28652646. This list is scanned for "which of these is
 *  huge", and raw byte counts don't answer that at a glance.
 *
 *  Lifted verbatim from SchemaRecords, which already had it — the only change
 *  is the null branch, so the run-detail artifact table can share it. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
