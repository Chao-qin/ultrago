/**
 * Inbound API keys.
 *
 * Separate from channels.json on purpose. That file is commit-safe by contract
 * — its own `_readme` promises "apiKey 写 env.NAME，真值放 .env，这里永远只存
 * 引用" — and inbound keys are machine-local credentials that must never reach
 * git. Mixing them would quietly break the promise the other file makes.
 *
 * Three rules decide everything here:
 *
 *   1. **明文留存，但按需取。** 认证走 sha256；明文另存一份，以便回显与复制。
 *      这里一度只存哈希，理由是「能读回明文的 key，一次屏幕共享就泄了」——理由
 *      成立，但它在这个系统里换不到安全：keys.json 与 channels.json 同机同用户
 *      同 0600，而后者本来就存着明文的上游 key。哈希防的是服务端被拖库，而这里
 *      没有服务端。代价却是实打实的：key 一丢只能吊销重签，而重签意味着去改每
 *      一个用到它的客户端。所以防线改放在真正有效处——明文**不进列表响应**，只
 *      有 `/admin/keys/<id>/secret` 按需取，界面默认打码、点一下才显示。
 *   2. **No keys = no auth.** An empty store means the gateway is open, which is
 *      what a fresh clone and the current single-machine deployment need. This
 *      is the same stance telemetry.ts takes on its URL ("置空 = 关掉，比再加
 *      一个 ENABLE 变量少一个状态") — the presence of configuration IS the
 *      switch.
 *   3. **Loopback may be exempt.** `allowLoopback` (default true) lets the three
 *      existing local callers keep working the moment the first key is minted.
 *      Set it false and the gateway is closed to everyone without a key — that
 *      single flag is the whole 对内 → 对外 switch.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RequestError, type JsonRecord } from "./adapters/types.js";

const KEYS_URL = new URL("../keys.json", import.meta.url);

/** Minted keys carry this so one is recognisable on sight in a log or a shell. */
const KEY_PREFIX = "bcp-";

/** How much of the plaintext is kept for display. Enough to tell two keys
 *  apart in a list, far too little to guess the rest of a 256-bit secret. */
const VISIBLE_CHARS = 12;

export type ApiKeyRecord = {
  id: string;
  /** Human label. Doubles as the telemetry `caller` — see authenticate(). */
  name: string;
  /** sha256 of the plaintext, hex. 认证只看它。 */
  hash: string;
  /**
   * 明文，**留存以便回显**。
   *
   * 这里原本只有 `hash`，理由是「能读回明文的 key，一次屏幕共享就泄了」。那条
   * 理由本身成立，但它在这个系统里换不到安全：`keys.json` 与 `channels.json`
   * 同机、同用户、同一个 0600，而后者里本来就躺着**明文的上游 key**。哈希防的
   * 是「服务端被拖库」，而这里没有服务端——能读到这个文件的人已经什么都有了。
   * 换来的却是一个真实的日常代价：key 丢了只能吊销重签，而重签意味着去改每一个
   * 用到它的客户端。
   *
   * 所以改成留存，并把防线放在真正有效的地方：明文**不进列表响应**（只有
   * `/admin/keys/<id>/secret` 按需取），界面上默认打码、点一下才显示。这挡的是
   * 截图与屏幕共享，也就是这个场景下真正会发生的泄漏方式。
   *
   * 可选：旧版签发的 key 只有哈希，认证照常，但回显不出来——如实说，不假装。
   */
  secret?: string;
  /** First VISIBLE_CHARS of the plaintext, for "which key is this" in the UI. */
  prefix: string;
  createdAt: string;
  /** null = live. Revocation is soft: old log rows still name this key. */
  disabledAt: string | null;

  /**
   * 到期时刻（ISO）。`null` = 永不过期。
   *
   * 到点即拒，没有宽限期：一个「差不多过期了」的 key 还能用，就等于没有有效期。
   */
  expiresAt?: string | null;

  /**
   * 每分钟最多几个请求。缺省 = 不限。
   *
   * 与并发上限管的是两件事：并发管「同时几个」，这个管「多快」。一个把并发设成
   * 1 的调用方仍然可以一分钟串行打上千发。
   */
  rateLimitPerMinute?: number;

  /**
   * 这把 key 允许打哪些**对外模型名**。缺省或空数组 = 全部。
   *
   * 空表示全部而不是全禁：加白名单是「收紧」这个显式动作，而把缺省定义成全禁会
   * 让每一把已经签发的 key 在升级的瞬间集体失效。
   */
  allowedModels?: string[];

  /** 这把 key 最多同时几个请求在飞。缺省 = 不限（渠道级与全局仍然管着）。 */
  maxConcurrency?: number;
};

export type KeyStore = {
  /**
   * Whether 127.0.0.1 may call without a key.
   *
   * True is correct while the gateway serves only this machine's own callers
   * (captcha-verifier / product-preprocess / console flows). Flip to false when
   * the port is exposed — at that point "on this machine" stops being a
   * meaningful statement about who is asking.
   */
  allowLoopback: boolean;
  keys: ApiKeyRecord[];
};

const DEFAULT_STORE: KeyStore = { allowLoopback: true, keys: [] };

/** 模块私有：外面只通过 readKeyStore / writeKeyStore 的可选 path 参数表达位置。 */
function keysPath(): string {
  return process.env.BCP_LLM_KEYS_PATH || fileURLToPath(KEYS_URL);
}

export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/**
 * Mint one key.
 *
 * 32 bytes from the CSPRNG, base64url so it survives a shell, a header and a
 * copy-paste without escaping. The caller gets the plaintext back exactly once.
 */
export function generateKey(): { plaintext: string; prefix: string; hash: string } {
  const plaintext = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, VISIBLE_CHARS),
    hash: hashKey(plaintext),
  };
}

function asRecord(raw: unknown, index: number): ApiKeyRecord {
  const where = `keys[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where} must be an object`);
  }
  const entry = raw as JsonRecord;
  const str = (field: string): string => {
    const value = entry[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${where}: ${field} must be a non-empty string`);
    }
    return value;
  };
  const positiveInt = (field: "rateLimitPerMinute" | "maxConcurrency"): number | undefined => {
    const value = entry[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${where}: ${field} must be a positive integer, got ${JSON.stringify(value)}`);
    }
    return value;
  };
  const models = entry.allowedModels;
  if (models !== undefined && models !== null && !Array.isArray(models)) {
    throw new Error(`${where}: allowedModels must be an array of strings`);
  }
  return {
    id: str("id"),
    name: str("name"),
    hash: str("hash"),
    prefix: typeof entry.prefix === "string" ? entry.prefix : "",
    // 旧版签发的没有这一项，回显时如实降级（见 ApiKeyRecord.secret）。
    ...(typeof entry.secret === "string" && entry.secret ? { secret: entry.secret } : {}),
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
    disabledAt: typeof entry.disabledAt === "string" ? entry.disabledAt : null,
    expiresAt: typeof entry.expiresAt === "string" ? entry.expiresAt : null,
    ...(positiveInt("rateLimitPerMinute") !== undefined
      ? { rateLimitPerMinute: positiveInt("rateLimitPerMinute") }
      : {}),
    ...(positiveInt("maxConcurrency") !== undefined
      ? { maxConcurrency: positiveInt("maxConcurrency") }
      : {}),
    ...(Array.isArray(models)
      ? { allowedModels: models.filter((m): m is string => typeof m === "string" && !!m.trim()) }
      : {}),
  };
}

/** 到期了没有。没有 expiresAt = 永不过期。 */
export function isExpired(key: ApiKeyRecord, now: number = Date.now()): boolean {
  if (!key.expiresAt) return false;
  const at = Date.parse(key.expiresAt);
  // 解析不出来的时间戳按**已过期**处理：一个坏掉的有效期字段不该悄悄变成
  // 「永久有效」——那是这两种失败里更糟的一种。
  return Number.isNaN(at) || at <= now;
}

/**
 * 这把 key 能不能打这个模型。
 *
 * 判定的是**解析后**的对外模型名。别名不能成为绕过白名单的路径：调用方写
 * `task.vision`、网关把它解析成某个模型，那个模型才是真正被访问的东西。
 */
export function allowsModel(key: ApiKeyRecord | undefined, model: string): boolean {
  if (!key?.allowedModels?.length) return true;
  return key.allowedModels.includes(model);
}

/**
 * Read the store.
 *
 * A missing file is the open, unconfigured gateway — not an error. A file that
 * exists but cannot be parsed IS an error: reading it as "no keys" would turn a
 * corrupted key file into a silently unauthenticated gateway, which is the one
 * failure mode this module must never have.
 */
export function readKeyStore(path: string = keysPath()): KeyStore {
  const file = path || keysPath();
  if (!existsSync(file)) return { ...DEFAULT_STORE, keys: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must be a JSON object`);
  }
  const entry = parsed as JsonRecord;
  const list = entry.keys;
  if (list !== undefined && !Array.isArray(list)) {
    throw new Error(`${file}: "keys" must be an array`);
  }
  return {
    // Only an explicit `false` closes loopback. An absent field means the file
    // predates the flag, and defaulting it closed would lock out every local
    // caller on upgrade.
    allowLoopback: entry.allowLoopback !== false,
    keys: (list ?? []).map(asRecord),
  };
}

/** Write via temp + rename, same reason as channels.json: no truncated file. */
export function writeKeyStore(store: KeyStore, path: string = keysPath()): void {
  const target = path || keysPath();
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * 未吊销的 key，**包括已过期的**。
 *
 * 「过期」和「不存在」必须分开，理由全在 authRequired 那一行：一把过期的 key
 * 仍然是「这个网关配置过鉴权」的证据。
 */
function liveKeys(store: KeyStore): ApiKeyRecord[] {
  return store.keys.filter((k) => !k.disabledAt);
}

/**
 * Is authentication in force at all?
 *
 * Exported because more than one place needs to answer it the same way — the
 * admin surface warns before minting the first key precisely because this flips
 * from false to true at that moment, and every non-loopback caller that has no
 * key starts getting 401 on the next request.
 *
 * **用 liveKeys 而不是「还能用的 key」**：如果所有 key 都过期了，正确的行为是
 * 继续鉴权、把所有人拒之门外，而不是退回「没有 key = 敞开」那一档。后者意味着
 * 有效期到点的那一刻网关对全世界打开，而那正是它本该收紧的时刻。
 */
export function authRequired(store: KeyStore): boolean {
  return liveKeys(store).length > 0;
}

/** Addresses that mean "this machine", in the spellings Node actually hands us. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

/** `Authorization: Bearer <key>` → the key. Anything else → undefined. */
export function bearerToken(authorization: string | string[] | undefined): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

/**
 * Constant-time hex compare.
 *
 * Both sides are sha256 digests, so a timing leak here reveals nothing an
 * attacker could invert. It is cheap, though, and this function is the one that
 * will still be here when the port faces a network — at which point "it was
 * only ever loopback" stops being true and nobody re-audits this line.
 */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Decide whether this request may proceed, and say WHICH key it came in on.
 *
 * Returns the record rather than a boolean, because everything downstream is
 * per-key: the rate limit, the concurrency slot, the model allow-list, and the
 * telemetry `caller` (which is just the key's name). Handing back the record
 * makes "which key made this call" a derived fact of the call log instead of a
 * second piece of state — the alternative, stamping `lastUsedAt` on the record,
 * would mean a disk write on the hot path of every single request to reproduce
 * information the log already has.
 *
 * `undefined` means "allowed, but anonymous" (auth off, or an exempt loopback
 * caller). Rejection throws 401 rather than returning a flag, so no caller can
 * forget to check the result.
 */
export type AuthContext = {
  now?: number;
  /**
   * 这次请求打的是管理面（`/admin/*`）而不是 `/v1/*`。
   *
   * **管理面对 loopback 永远开放，不受 `allowLoopback` 影响。** 理由是它锁不住
   * 任何东西：能连到 127.0.0.1 的进程与网关同机同用户，直接打开 keys.json 就
   * 什么都有了，绕过管理面比用管理面还省事。
   *
   * 而把它锁上的代价是具体的：`allowLoopback:false` 曾经让 Console 读不到渠道、
   * 读不到 key 列表，连「本机免 key」那个开关本身都点不回去 —— 一扇连自己也进
   * 不去的门。安全开关最不该有的性质就是把管理员锁在外面，因为那会逼出比它想
   * 防的更糟的操作（手改凭据文件）。
   *
   * 对**外部地址**没有这条豁免：非 loopback 打管理面照样要 key。
   */
  adminSurface?: boolean;
};

export function authenticate(
  store: KeyStore,
  authorization: string | string[] | undefined,
  remoteAddress: string | undefined,
  context: number | AuthContext = {},
): ApiKeyRecord | undefined {
  // 第四个参数一度就是 `now`，保留数字形态以免调用点各写各的。
  const { now = Date.now(), adminSurface = false } =
    typeof context === "number" ? { now: context, adminSurface: false } : context;

  const live = liveKeys(store);
  if (live.length === 0) return undefined;

  const token = bearerToken(authorization);
  if (token) {
    const digest = hashKey(token);
    const match = live.find((k) => sameDigest(k.hash, digest));
    if (match && !isExpired(match, now)) return match;
    // 过期说成「过期」，不说成「无效」。两者的下一步动作完全不同——一个是去续
    // 期或重签，一个是去查是不是抄错了——而调用方只看得见我们说的这句话。
    if (match) {
      throw new RequestError(`API key「${match.name}」已于 ${match.expiresAt} 过期`, 401);
    }
    // A presented-but-wrong key is always rejected, even from loopback. The
    // exemption below is for callers that send NO key; honouring a bad one
    // would make a revoked key keep working on this machine.
    throw new RequestError("invalid API key", 401);
  }

  if (isLoopback(remoteAddress) && (adminSurface || store.allowLoopback)) return undefined;

  throw new RequestError(
    "missing API key — send `Authorization: Bearer <key>`",
    401,
  );
}

/** 一把 key 上可调的那几项。全部可选，缺省一律是「不限 / 不过期」。 */
export type KeySettings = {
  expiresAt?: string | null;
  rateLimitPerMinute?: number | null;
  allowedModels?: string[] | null;
  maxConcurrency?: number | null;
};

/**
 * 校验并归一。
 *
 * `null` 与 `undefined` 在这里是同一个意思——「清掉这一项」。界面上清空一个
 * 数字输入框给的是 null，而 JSON 里省略一个键给的是 undefined，两者表达的是
 * 同一个意图，不该产生不同的结果。
 */
function normalizeSettings(settings: KeySettings): Partial<ApiKeyRecord> {
  const out: Partial<ApiKeyRecord> = {};

  if (settings.expiresAt) {
    const at = Date.parse(settings.expiresAt);
    if (Number.isNaN(at)) {
      throw new RequestError(`有效期不是一个可解析的时间：${settings.expiresAt}`);
    }
    out.expiresAt = new Date(at).toISOString();
  } else {
    out.expiresAt = null;
  }

  for (const field of ["rateLimitPerMinute", "maxConcurrency"] as const) {
    const value = settings[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new RequestError(`${field} 必须是正整数，收到 ${JSON.stringify(value)}`);
    }
    out[field] = value;
  }

  if (settings.allowedModels) {
    if (!Array.isArray(settings.allowedModels)) {
      throw new RequestError("allowedModels 必须是字符串数组");
    }
    const models = [
      ...new Set(
        settings.allowedModels
          .filter((m): m is string => typeof m === "string")
          .map((m) => m.trim())
          .filter(Boolean),
      ),
    ];
    // 空数组归成「不设白名单」而不是「一个都不许」：界面上把标签全删光，意思是
    // 「不限制了」，而不是「把这把 key 锁死」。要锁死请吊销它。
    if (models.length) out.allowedModels = models;
  }

  return out;
}

/** Mint and store. The plaintext in the result is the only copy that will exist. */
export function createKey(
  name: string,
  store: KeyStore,
  settings: KeySettings = {},
): { store: KeyStore; record: ApiKeyRecord; plaintext: string } {
  const label = name.trim();
  if (!label) throw new RequestError("key name must be a non-empty string");
  const { plaintext, prefix, hash } = generateKey();
  const record: ApiKeyRecord = {
    id: `key_${randomBytes(8).toString("hex")}`,
    name: label,
    hash,
    secret: plaintext,
    prefix,
    createdAt: new Date().toISOString(),
    disabledAt: null,
    ...normalizeSettings(settings),
  };
  return { store: { ...store, keys: [...store.keys, record] }, record, plaintext };
}

/**
 * 改一把已签发 key 的配置。
 *
 * 改不了的是 `hash` / `prefix` / `createdAt` —— 它们是这把 key 的身份，不是它的
 * 设置。想换一把新的密钥就签发新的，这也是唯一诚实的做法：我们没有旧明文，
 * 「重置密钥」除了重签之外没有别的实现。
 */
export function updateKey(id: string, settings: KeySettings, store: KeyStore): KeyStore {
  const found = store.keys.find((k) => k.id === id);
  if (!found) throw new RequestError(`unknown key "${id}"`, 404);
  const patch = normalizeSettings(settings);
  return {
    ...store,
    keys: store.keys.map((k) =>
      k.id === id
        ? {
            // 先摘掉三个可清空的字段再合并：normalizeSettings 对「没给」的项
            // 不会产出键，而这里的语义是整份设置的替换，漏掉就变成了只增不减。
            ...k,
            rateLimitPerMinute: undefined,
            maxConcurrency: undefined,
            allowedModels: undefined,
            ...patch,
          }
        : k,
    ),
  };
}

/** Soft revoke. The record stays so historical log rows still resolve a name. */
export function revokeKey(id: string, store: KeyStore): KeyStore {
  const found = store.keys.find((k) => k.id === id);
  if (!found) throw new RequestError(`unknown key "${id}"`, 404);
  return {
    ...store,
    keys: store.keys.map((k) =>
      k.id === id ? { ...k, disabledAt: k.disabledAt ?? new Date().toISOString() } : k,
    ),
  };
}

export function restoreKey(id: string, store: KeyStore): KeyStore {
  const found = store.keys.find((k) => k.id === id);
  if (!found) throw new RequestError(`unknown key "${id}"`, 404);
  return { ...store, keys: store.keys.map((k) => (k.id === id ? { ...k, disabledAt: null } : k)) };
}

/** Hard delete. Separate from revoke because it also drops the name that old
 *  log rows refer to — an intentional, different decision. */
export function deleteKey(id: string, store: KeyStore): KeyStore {
  const found = store.keys.find((k) => k.id === id);
  if (!found) throw new RequestError(`unknown key "${id}"`, 404);
  return { ...store, keys: store.keys.filter((k) => k.id !== id) };
}

/**
 * 一把 key 的明文，**按需取**。
 *
 * 单独一个函数（对应单独一个端点）而不是塞进列表：列表每隔几秒刷一次，明文会
 * 跟着进网络面板、进日志、进前端的查询缓存。只在有人真的点「显示」时取一次，
 * 泄漏面小得多。
 *
 * 取不到时给出**原因**而不是空字符串——「这把 key 是旧版签发的」和「这把 key
 * 不存在」是两件事，而界面要照着它说人话。
 */
export function revealKey(id: string, store: KeyStore): { secret: string | null; reason?: string } {
  const found = store.keys.find((k) => k.id === id);
  if (!found) throw new RequestError(`unknown key "${id}"`, 404);
  if (!found.secret) {
    return { secret: null, reason: "这把 key 由旧版本签发，磁盘上只有哈希，明文取不回来——需要的话请重新签发一把" };
  }
  return { secret: found.secret };
}

/** The store as the admin surface may see it — 明文与哈希都不在其中。 */
export function describeKeys(store: KeyStore, now: number = Date.now()): JsonRecord {
  return {
    allowLoopback: store.allowLoopback,
    authRequired: authRequired(store),
    keys: store.keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      createdAt: k.createdAt,
      disabledAt: k.disabledAt,
      expiresAt: k.expiresAt ?? null,
      // 算好给界面，而不是让它自己拿 expiresAt 和当前时间比 —— 判定规则（包括
      // 「解析不出来的时间按已过期」）只该有一份实现。
      expired: isExpired(k, now),
      // 能不能回显。**只是一个布尔**，明文本身要走 revealKey 单独取。
      revealable: Boolean(k.secret),
      rateLimitPerMinute: k.rateLimitPerMinute ?? null,
      allowedModels: k.allowedModels ?? [],
      maxConcurrency: k.maxConcurrency ?? null,
    })),
  };
}
