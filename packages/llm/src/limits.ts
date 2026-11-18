/**
 * Concurrency gates.
 *
 * Two levels, because two different things are being protected:
 *
 *   · **Per channel** (`ChannelConfig.maxConcurrency`) — a fact about the
 *     upstream. A local Ollama shares one box's VRAM and serialises internally
 *     anyway; a paid endpoint is bounded by whatever RPM the account has. Both
 *     belong to the other side, so they are declared on the channel.
 *   · **Global** (`limits.maxConcurrency`) — a fact about this machine. It is
 *     what stops several busy channels from collectively exhausting sockets and
 *     file handles on a laptop that is also running a browser, a NestJS console
 *     and a WeClaw sidecar.
 *
 * **Over the limit means WAIT, not 429.** Every caller here is a batch job
 * (product-preprocess walks a whole catalogue) that would rather queue than
 * fail, and every request already carries how long it is willing to wait —
 * `X-BCP-Request-Timeout-Ms`, enforced by the same AbortSignal passed in here.
 * So the queue needs no depth limit of its own: a request that waits past its
 * budget is aborted and removed, which is exactly the backpressure a separate
 * "queue full" threshold would have approximated with a number nobody can pick
 * correctly. A 429 would also cost a round trip to tell the caller something it
 * already told us.
 */
import { RequestError } from "./adapters/types.js";

/**
 * 撞上了每分钟上限。
 *
 * 单独一个类型，只为了把「还要等几秒」一路带到响应头上：一个不带 `Retry-After`
 * 的 429 会让调用方自己瞎猜退避时长，而我们恰好精确知道答案——最早那一发滑出
 * 窗口的时刻。
 */
export class RateLimitError extends RequestError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message: string) {
    super(message, 429);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type GateStats = { active: number; queued: number };

type Waiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
};

type Semaphore = {
  acquire(signal: AbortSignal): Promise<void>;
  release(): void;
  stats(): GateStats;
};

function createSemaphore(limit: number): Semaphore {
  let active = 0;
  const queue: Waiter[] = [];

  function detach(waiter: Waiter): void {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  return {
    async acquire(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, signal, onAbort: () => {} };
        waiter.onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          // The abort reason is the request's own deadline error when it timed
          // out, so the caller is told it ran out of budget — not that some
          // internal queue rejected it.
          reject(signal.reason ?? new RequestError("request aborted while queued", 504));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        queue.push(waiter);
      });
    },

    release(): void {
      active -= 1;
      // FIFO. LIFO would be marginally better for latency under light load and
      // would starve the oldest request under sustained load, which is the case
      // that actually matters here.
      const next = queue.shift();
      if (!next) return;
      detach(next);
      // Hand the slot straight over rather than letting the waiter re-check:
      // releasing to zero and re-acquiring opens a window for a brand-new
      // request to jump the whole queue.
      active += 1;
      next.resolve();
    },

    stats: () => ({ active, queued: queue.length }),
  };
}

/**
 * 一道闸。`limit` 缺省表示这一层不限（那一层直接跳过，连计数器都不建）。
 *
 * `id` 是这一层内部的分组键：渠道层用渠道调试名，key 层用 key id。
 */
export type GateScope = { id: string; limit?: number };

export type ConcurrencyGate = {
  /**
   * 依次穿过若干道闸，全部拿到才返回；返回的是释放函数。
   *
   * 传数组而不是固定的两三个参数，是因为闸的层数会长：一开始只有渠道与全局，
   * 后来加了「每把 key」。硬编码层数的签名每加一层都要改一次调用点，而每一次
   * 改动都是一次漏掉某条解锁路径的机会。
   *
   * **调用方必须在 `finally` 里调用返回值** —— 泄漏一个名额不会报任何错，只会
   * 把上限永久调小，直到进程重启。
   */
  acquire(scopes: GateScope[], signal: AbortSignal): Promise<() => void>;
  stats(): { global: GateStats; channels: Record<string, GateStats> };
};

export function createGate(globalLimit?: number): ConcurrencyGate {
  const global = globalLimit === undefined ? null : createSemaphore(globalLimit);
  const perScope = new Map<string, Semaphore>();

  return {
    async acquire(scopes, signal) {
      // 先问一次再动手：一个已经中止的请求不该在任何地方留下痕迹，连一个空的
      // 计数器条目都不该。下面 semaphore 内部还会再查一次，那是给"创建之后、
      // 真正排队之前"这一小段用的。
      signal.throwIfAborted();

      const taken: Semaphore[] = [];
      const release = (): void => {
        // 反序释放，与获取顺序对称。
        for (const semaphore of taken.reverse()) semaphore.release();
        taken.length = 0;
      };

      try {
        // 按传入顺序逐道穿过，窄的在前、全局在最后。窄闸先吸住队列，于是只有
        // 真能跑起来的请求才去竞争全局名额；反过来会让请求占着全局名额排在某
        // 条渠道的队里，白白压缩**其它**渠道可用的额度。
        //
        // 顺序对所有调用方一致，这是不死锁的全部理由——各层之间没有循环等待。
        for (const scope of scopes) {
          if (scope.limit === undefined) continue;
          let semaphore = perScope.get(scope.id);
          if (!semaphore) {
            semaphore = createSemaphore(scope.limit);
            perScope.set(scope.id, semaphore);
          }
          await semaphore.acquire(signal);
          taken.push(semaphore);
        }
        if (global) {
          await global.acquire(signal);
          taken.push(global);
        }
      } catch (error) {
        // 已经拿到的必须还回去：中途被 abort 时若不还，每个超时的请求都会永久
        // 吃掉一个名额，那条渠道会悄无声息地把自己掐到零。
        release();
        throw error;
      }

      let released = false;
      return () => {
        // Idempotent: the retry path can unwind the same attempt through more
        // than one code path, and double-release would inflate the limit.
        if (released) return;
        released = true;
        release();
      };
    },

    stats() {
      const channels: Record<string, GateStats> = {};
      for (const [id, semaphore] of perScope) channels[id] = semaphore.stats();
      return { global: global?.stats() ?? { active: 0, queued: 0 }, channels };
    },
  };
}

/**
 * 每分钟请求数上限。
 *
 * 滑动窗口而不是固定窗口：固定窗口在两个窗口的交界处允许瞬间打进两倍的量
 * （59 秒打满、01 秒再打满），而限流要防的恰恰是那个瞬间。
 *
 * **纯内存，重启归零。** 这是刻意的：持久化一份计数意味着网关要么自己存盘（每
 * 请求一次写），要么依赖 console（它现在不依赖，console 没起也能跑）。RPM 防的
 * 是「打爆上游」这种秒级现象，重启后放开一分钟的额度没有实际后果——真正要防
 * 「一天花多少钱」的是配额，那是另一件事，需要另一套机制。
 */
export type RateLimiter = {
  /**
   * 记一次请求。放行返回 `undefined`；超限返回**还要等几秒**（给 Retry-After）。
   *
   * 超限时不计入窗口：否则一个在猛撞限流的调用方会把自己的窗口一直续着，
   * 变成「越撞越久」，而它本来只需要等到最早那一发滑出窗口。
   */
  take(id: string, limitPerMinute: number, now?: number): number | undefined;
  stats(): Record<string, number>;
};

const MINUTE_MS = 60_000;

export function createRateLimiter(): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    take(id, limitPerMinute, now = Date.now()) {
      const cutoff = now - MINUTE_MS;
      const recent = (hits.get(id) ?? []).filter((at) => at > cutoff);
      if (recent.length >= limitPerMinute) {
        // 最早那一发滑出窗口的时刻，就是下一个名额空出来的时刻。
        const waitMs = recent[0] - cutoff;
        hits.set(id, recent);
        return Math.max(1, Math.ceil(waitMs / 1000));
      }
      recent.push(now);
      hits.set(id, recent);
      return undefined;
    },

    stats() {
      const now = Date.now();
      const out: Record<string, number> = {};
      for (const [id, times] of hits) {
        const recent = times.filter((at) => at > now - MINUTE_MS);
        // 空了就删：一把用过一次就再没出现的 key 不该永久占着一个条目。
        if (recent.length === 0) hits.delete(id);
        else {
          hits.set(id, recent);
          out[id] = recent.length;
        }
      }
      return out;
    },
  };
}
