/**
 * Failover across the channels that serve one model.
 *
 * `channels.json` already lets two entries share an `id` — that is how "several
 * keys for the same model" is expressed, and `candidateChannels` rotates
 * between them. Until now a failure on the chosen one was simply returned to
 * the caller, which made the arrangement a load balancer that could not survive
 * losing a member. This module is the other half: when an attempt fails in a way
 * that another source could plausibly answer, try the next one.
 *
 * Three boundaries keep that from doing harm, and all three are load-bearing:
 *
 *   1. **Only retryable failures.** A 429 or a dead socket is worth another
 *      channel; a 400 or a 401 is the same answer everywhere, and retrying it
 *      turns one clear error into N identical ones plus latency.
 *   2. **Never after the response has started.** The status line and the first
 *      chunks are already on the wire; a second attempt cannot unsend them, and
 *      splicing a fresh completion onto a half-sent one produces a corrupt
 *      answer that reads as a complete one. gateway.ts makes the same point
 *      about mid-stream errors — the honest move once committed is to report,
 *      not to retry.
 *   3. **Every attempt is logged.** A retry that leaves no trace turns an
 *      upstream that fails half the time into an upstream that looks healthy,
 *      which is precisely the visibility the call log exists to provide.
 */
import { RequestError, UpstreamError, type ChannelConfig } from "./adapters/types.js";

/**
 * Upstream statuses worth trying elsewhere.
 *
 * 408 request timeout / 425 too early / 429 rate limited / 5xx — all mean "this
 * source, right now", which is exactly what another source can fix. Everything
 * else 4xx describes the REQUEST, and the request does not change by being sent
 * somewhere else.
 *
 * 501 is excluded on purpose: "not implemented" is a durable statement about
 * the upstream, not a transient one.
 */
const RETRYABLE_UPSTREAM = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

/**
 * Consecutive failures before a channel is demoted, and for how long.
 *
 * Deliberately not configurable. These two numbers only decide the ORDER
 * attempts are made in — never whether a channel is reachable at all (see
 * `orderByHealth`) — so being somewhat wrong costs a little latency, not
 * availability. A knob here would be a knob nobody could set from evidence.
 */
const DEMOTE_AFTER_FAILURES = 3;
const DEMOTE_FOR_MS = 30_000;

/**
 * Is this worth trying on another channel?
 *
 * Errors arrive in four shapes and each has exactly one right answer:
 *
 *   · `UpstreamError` — decided by the table above.
 *   · `RequestError` — the caller made a mistake (400) or ran out of its own
 *     budget (504). Neither is fixed by a different upstream. In particular
 *     **our own 504 must not retry**: the request's deadline is already spent,
 *     so a second attempt cannot finish either, it can only delay the error.
 *   · Abort — same reasoning; the signal is already dead.
 *   · Anything else — a network-layer failure (DNS, refused, reset, TLS). These
 *     are the single best reason failover exists, so they retry.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof UpstreamError) return RETRYABLE_UPSTREAM.has(error.upstreamStatus);
  if (error instanceof RequestError) return false;
  if (error instanceof Error && error.name === "AbortError") return false;
  return true;
}

export type ChannelHealthState = {
  consecutiveFailures: number;
  /** epoch ms; null = not demoted. */
  demotedUntil: number | null;
};

/**
 * Tracks which channels have been failing, so they can be tried LAST.
 *
 * Deliberately not a circuit breaker. A breaker's job is to stop calling a dead
 * dependency, and that is the wrong goal here: if every source of a model is
 * failing, the caller still needs us to try one — refusing outright would turn
 * a degraded model into an absent one. So a demoted channel is moved to the back
 * of the queue, never removed. When it is the only candidate it still gets the
 * call, which gives us half-open probing without a state machine to get wrong.
 */
export type HealthTracker = {
  recordSuccess(channel: ChannelConfig): void;
  recordFailure(channel: ChannelConfig, now?: number): void;
  /** Candidates reordered: healthy ones first, demoted ones last, order kept
   *  stable within each group so round-robin still round-robins. */
  orderByHealth(candidates: ChannelConfig[], now?: number): ChannelConfig[];
  snapshot(): Record<string, ChannelHealthState>;
};

export function createHealthTracker(): HealthTracker {
  const state = new Map<string, ChannelHealthState>();

  const entry = (id: string): ChannelHealthState => {
    const existing = state.get(id);
    if (existing) return existing;
    const created: ChannelHealthState = { consecutiveFailures: 0, demotedUntil: null };
    state.set(id, created);
    return created;
  };

  // No record at all reads as healthy (0 > now is false), which is what an
  // as-yet-unused channel should be.
  const demoted = (channel: ChannelConfig, now: number): boolean =>
    (state.get(key(channel))?.demotedUntil ?? 0) > now;

  return {
    recordSuccess(channel) {
      const current = entry(key(channel));
      current.consecutiveFailures = 0;
      current.demotedUntil = null;
    },

    recordFailure(channel, now = Date.now()) {
      const current = entry(key(channel));
      current.consecutiveFailures += 1;
      if (current.consecutiveFailures >= DEMOTE_AFTER_FAILURES) {
        current.demotedUntil = now + DEMOTE_FOR_MS;
      }
    },

    orderByHealth(candidates, now = Date.now()) {
      const healthy: ChannelConfig[] = [];
      const sick: ChannelConfig[] = [];
      for (const channel of candidates) (demoted(channel, now) ? sick : healthy).push(channel);
      return [...healthy, ...sick];
    },

    snapshot() {
      const out: Record<string, ChannelHealthState> = {};
      for (const [id, value] of state) out[id] = { ...value };
      return out;
    },
  };
}

/**
 * The key a channel is tracked under.
 *
 * `channelLabel`'s id@host rather than the bare id, because the whole point of
 * two entries sharing an id is that they are DIFFERENT upstreams — tracking
 * them together would let a dead vendor demote the healthy one beside it.
 * Duplicated here rather than imported to keep this module free of the config
 * layer; the format only has to be internally consistent, and the one consumer
 * (gateway) passes the same value to both sides.
 */
function key(channel: ChannelConfig): string {
  if (!channel.baseUrl) return `${channel.id}@${channel.adapter}`;
  try {
    return `${channel.id}@${new URL(channel.baseUrl).host}`;
  } catch {
    return `${channel.id}@${channel.baseUrl}`;
  }
}

export type AttemptOutcome = {
  channel: ChannelConfig;
  /** 1-based, as it appears in the log. */
  attempt: number;
  error: unknown;
  willRetry: boolean;
};

export type FailoverOptions = {
  tracker?: HealthTracker;
  /**
   * Has anything been written to the caller yet?
   *
   * Asked AFTER the failure, not before the attempt: a streaming call only
   * becomes uninterruptible once its first chunk is out, and that can happen
   * at any point inside the attempt.
   */
  committed?: () => boolean;
  /** Called once per failed attempt, before the next one starts. */
  onAttemptFailed?(outcome: AttemptOutcome): void;
};

/**
 * Run `attempt` against each candidate until one succeeds.
 *
 * Bounded by the candidate list — there is no retry count to tune, because
 * "try each source once" is the only policy that makes sense when the sources
 * are the thing being chosen between. Retrying the SAME upstream is left to the
 * caller, who can express it by declaring the channel twice.
 */
export async function withFailover<T>(
  candidates: ChannelConfig[],
  attempt: (channel: ChannelConfig) => Promise<T>,
  options: FailoverOptions = {},
): Promise<T> {
  const ordered = options.tracker?.orderByHealth(candidates) ?? candidates;
  if (ordered.length === 0) throw new RequestError("no channel available", 503);

  let lastError: unknown;
  for (let index = 0; index < ordered.length; index += 1) {
    const channel = ordered[index];
    try {
      const result = await attempt(channel);
      options.tracker?.recordSuccess(channel);
      return result;
    } catch (error) {
      lastError = error;
      options.tracker?.recordFailure(channel);
      const willRetry =
        index < ordered.length - 1 && isRetryable(error) && !options.committed?.();
      options.onAttemptFailed?.({ channel, attempt: index + 1, error, willRetry });
      if (!willRetry) throw error;
    }
  }
  // Unreachable: the loop either returns or throws. Kept so the types do not
  // need a non-null assertion that would outlive the reason for it.
  throw lastError;
}
