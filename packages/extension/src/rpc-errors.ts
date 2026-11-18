/**
 * Carrying a diagnosis across the injection boundary.
 *
 * Failures arrive by two routes and only one of them can carry an Error:
 *   - A DOM op runs inside a function serialised into the page, so an Error's
 *     own properties cannot survive the return trip. Its diagnosis rides back
 *     in the result object as `{error, errorInfo}` instead (see `domOpError`).
 *   - Anything that throws on the worker's side of the boundary still carries
 *     the raw `bcp*` tags on the Error itself.
 *
 * Both have to end up as the same `RpcErrorInfo`, or half the failures reach
 * the agent as bare strings.
 */
import type { RpcErrorInfo } from "@bcp/shared";

/** Tags an Error may carry when it was thrown on this side of the boundary. */
type TaggedError = Error & {
  errorInfo?: RpcErrorInfo;
  bcpCode?: string;
  bcpCandidates?: unknown;
  bcpRelaxedBy?: string;
};

export function errorInfoOf(e: unknown): RpcErrorInfo | undefined {
  if (!(e instanceof Error)) return undefined;
  const tagged = e as TaggedError;
  if (tagged.errorInfo) return tagged.errorInfo;
  if (!tagged.bcpCode) return undefined;
  const info: RpcErrorInfo = { code: tagged.bcpCode as RpcErrorInfo["code"] };
  if (Array.isArray(tagged.bcpCandidates)) info.candidates = tagged.bcpCandidates as RpcErrorInfo["candidates"];
  if (tagged.bcpRelaxedBy) info.relaxedBy = tagged.bcpRelaxedBy;
  return info;
}

/** A DOM op's `{error, errorInfo}` as a throwable that keeps both halves. */
export function domOpError(r: { error?: string; errorInfo?: unknown }): Error {
  const e = new Error(r.error ?? "dom op failed") as TaggedError;
  if (r.errorInfo) e.errorInfo = r.errorInfo as RpcErrorInfo;
  return e;
}
