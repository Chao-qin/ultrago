/**
 * Inbound key tests.
 *
 * The assertions that matter are the ones about being OPEN vs CLOSED: this
 * module is the only thing standing between the outside world and somebody
 * else's token budget, and both of its failure directions are silent. Locking
 * out the three local callers looks like an outage with no error in the
 * gateway's own log; staying open when it should not looks like nothing at all.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RequestError } from "./adapters/types.js";
import {
  authRequired,
  authenticate,
  bearerToken,
  createKey,
  deleteKey,
  describeKeys,
  generateKey,
  hashKey,
  isExpired,
  isLoopback,
  allowsModel,
  updateKey,
  readKeyStore,
  restoreKey,
  revealKey,
  revokeKey,
  writeKeyStore,
  type KeyStore,
} from "./keys.js";

const EMPTY: KeyStore = { allowLoopback: true, keys: [] };

function tempFile(name = "keys.json"): string {
  return join(mkdtempSync(join(tmpdir(), "bcp-keys-")), name);
}

/** A store with one live key, plus the plaintext needed to present it. */
function withOneKey(allowLoopback = true): { store: KeyStore; plaintext: string } {
  const { store, plaintext } = createKey("预处理流水线", { ...EMPTY, allowLoopback });
  return { store, plaintext };
}

test("no keys means no auth — a fresh clone must serve without configuration", () => {
  assert.equal(authRequired(EMPTY), false);
  // Not from loopback, no Authorization header, still allowed.
  assert.equal(authenticate(EMPTY, undefined, "203.0.113.9"), undefined);
});

test("minting the first key closes the gateway to everyone without one", () => {
  const { store } = withOneKey();
  assert.equal(authRequired(store), true);
  assert.throws(
    () => authenticate(store, undefined, "203.0.113.9"),
    (error: unknown) => error instanceof RequestError && error.status === 401,
  );
});

test("a correct key is accepted and reports its name as the caller", () => {
  const { store, plaintext } = withOneKey();
  assert.equal(authenticate(store, `Bearer ${plaintext}`, "203.0.113.9")?.name, "预处理流水线");
});

test("loopback is exempt only when it presents NO key — a wrong one still fails", () => {
  const { store } = withOneKey();
  // The exemption is for callers that send nothing.
  assert.equal(authenticate(store, undefined, "127.0.0.1"), undefined);
  // But honouring a bad key from loopback would let a REVOKED key keep working
  // on this machine, which is the whole point of revoking it.
  assert.throws(
    () => authenticate(store, "Bearer bcp-not-a-real-key", "127.0.0.1"),
    /invalid API key/,
  );
});

test("allowLoopback:false closes the local door too", () => {
  const { store, plaintext } = withOneKey(false);
  assert.throws(
    () => authenticate(store, undefined, "127.0.0.1"),
    /missing API key/,
  );
  // The key itself still works from anywhere.
  assert.equal(authenticate(store, `Bearer ${plaintext}`, "127.0.0.1")?.name, "预处理流水线");
});

test("a revoked key stops working, and restoring brings it back", () => {
  const { store, plaintext } = withOneKey();
  const id = store.keys[0].id;

  const revoked = revokeKey(id, store);
  // Revoking the ONLY key turns auth off entirely — there are no live keys
  // left. That is the documented "no keys = open" rule, not an oversight, so
  // pin it here rather than let a future reader think it is a bug.
  assert.equal(authRequired(revoked), false);
  // The record survives so old log rows can still resolve the name.
  assert.equal(revoked.keys.length, 1);
  assert.ok(revoked.keys[0].disabledAt);

  const restored = restoreKey(id, revoked);
  assert.equal(authRequired(restored), true);
  assert.equal(authenticate(restored, `Bearer ${plaintext}`, "203.0.113.9")?.name, "预处理流水线");
});

test("a revoked key is rejected while another key keeps auth switched on", () => {
  const first = createKey("旧的", EMPTY);
  const second = createKey("新的", first.store);
  const store = revokeKey(first.record.id, second.store);

  assert.equal(authRequired(store), true);
  assert.throws(() => authenticate(store, `Bearer ${first.plaintext}`, "10.0.0.5"), /invalid API key/);
  assert.equal(authenticate(store, `Bearer ${second.plaintext}`, "10.0.0.5")?.name, "新的");
});

test("deleting drops the record entirely, unlike revoking", () => {
  const { store } = withOneKey();
  assert.equal(deleteKey(store.keys[0].id, store).keys.length, 0);
  assert.throws(() => deleteKey("key_nope", store), /unknown key/);
  assert.throws(() => revokeKey("key_nope", store), /unknown key/);
});

test("明文留在 store 里（为了回显），但不经 describeKeys 漏出去", () => {
  // 这条断言曾经是「明文永不存储」。它随 ApiKeyRecord.secret 的理由一起改了：
  // 哈希防的是服务端被拖库，而这里没有服务端——keys.json 与 channels.json 同机
  // 同用户同 0600，后者本来就存着明文的上游 key。防线改放在真正有效处：明文不
  // 进列表响应，界面默认打码。
  const { store, plaintext } = withOneKey();
  const serialised = JSON.stringify(store);
  assert.ok(serialised.includes(plaintext), "明文要能回显，就得留着");
  assert.ok(serialised.includes(hashKey(plaintext)), "认证仍然只看哈希");

  const described = JSON.stringify(describeKeys(store));
  assert.ok(!described.includes(plaintext), "列表响应每几秒刷一次，明文不该跟着走");
  assert.ok(!described.includes(hashKey(plaintext)), "hashes are not the admin surface's business");
  // The prefix is deliberately visible — it is how a human tells two keys apart.
  assert.ok(described.includes(store.keys[0].prefix));
});

test("a minted key is long, prefixed, and distinct every time", () => {
  const a = generateKey();
  const b = generateKey();
  assert.notEqual(a.plaintext, b.plaintext);
  assert.match(a.plaintext, /^bcp-[A-Za-z0-9_-]{40,}$/);
  assert.equal(a.prefix, a.plaintext.slice(0, 12));
  assert.equal(a.hash, hashKey(a.plaintext));
});

test("bearerToken reads only what it should", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer abc"), "abc", "the scheme is case-insensitive");
  assert.equal(bearerToken(["Bearer abc", "Bearer def"]), "abc");
  assert.equal(bearerToken("Basic abc"), undefined);
  assert.equal(bearerToken(undefined), undefined);
});

test("isLoopback recognises the spellings Node actually hands us", () => {
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.53"]) {
    assert.equal(isLoopback(address), true, address);
  }
  for (const address of ["10.0.0.1", "203.0.113.9", "", undefined]) {
    assert.equal(isLoopback(address), false, String(address));
  }
});

test("an absent file is an open gateway; a CORRUPT one is an error", () => {
  const missing = tempFile();
  assert.deepEqual(readKeyStore(missing), { allowLoopback: true, keys: [] });

  const broken = tempFile();
  writeFileSync(broken, "{ not json");
  // Reading a corrupted key file as "no keys" would silently turn auth OFF —
  // the single worst thing this module could do.
  assert.throws(() => readKeyStore(broken), /not valid JSON/);
});

test("a store round-trips through disk, and the file is owner-only", () => {
  const path = tempFile();
  const { store, plaintext } = withOneKey(false);
  writeKeyStore(store, path);

  const loaded = readKeyStore(path);
  assert.equal(loaded.allowLoopback, false);
  assert.equal(authenticate(loaded, `Bearer ${plaintext}`, "10.0.0.1")?.name, "预处理流水线");
  // 文件里**有**明文（回显要用），所以这个文件的权限就是它唯一的防线。
  assert.ok(readFileSync(path, "utf8").includes(plaintext));
  assert.equal(statSync(path).mode & 0o077, 0, "group/other 一位权限都不该有");
});

test("an absent allowLoopback reads as true, so upgrades do not lock out local callers", () => {
  const path = tempFile();
  const { store } = withOneKey();
  // A file written before the flag existed.
  writeFileSync(path, JSON.stringify({ keys: store.keys }));
  assert.equal(readKeyStore(path).allowLoopback, true);
});

test("a key needs a name", () => {
  assert.throws(() => createKey("   ", EMPTY), /name must be a non-empty string/);
});

// --- 有效期 / 白名单 / 设置编辑 -----------------------------------------

const HOUR = 3600_000;

test("过期的 key 被拒，而且说的是「过期」不是「无效」", () => {
  const { store, plaintext } = createKey("短期", { ...EMPTY, allowLoopback: false }, {
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
  });
  assert.equal(authenticate(store, `Bearer ${plaintext}`, "10.0.0.1")?.name, "短期");

  // 两小时后。两种错误的下一步动作完全不同——续期 vs 查是不是抄错了。
  assert.throws(
    () => authenticate(store, `Bearer ${plaintext}`, "10.0.0.1", Date.now() + 2 * HOUR),
    /已于 .* 过期/,
  );
});

test("所有 key 都过期时，网关必须继续鉴权而不是变敞开", () => {
  // 这是这个模块最危险的一条边界：如果 authRequired 看的是「还能用的 key」，
  // 有效期到点的那一刻网关会对全世界打开——而那正是它本该收紧的时刻。
  const { store } = createKey("已过期", { ...EMPTY, allowLoopback: false }, {
    expiresAt: new Date(Date.now() - HOUR).toISOString(),
  });
  assert.equal(authRequired(store), true, "过期 ≠ 不存在");
  assert.throws(() => authenticate(store, undefined, "10.0.0.1"), /missing API key/);
});

test("坏掉的有效期按已过期处理，不按永久有效", () => {
  const { store, plaintext } = createKey("坏时间", EMPTY);
  const broken = { ...store, keys: [{ ...store.keys[0], expiresAt: "不是时间" }] };
  // 两种失败方向里，「悄悄变成永久有效」是更糟的那一个。
  assert.equal(isExpired(broken.keys[0]), true);
  assert.throws(() => authenticate(broken, `Bearer ${plaintext}`, "10.0.0.1"), /过期/);
});

test("没有 expiresAt 就是永不过期", () => {
  const { store } = withOneKey();
  assert.equal(isExpired(store.keys[0]), false);
  assert.equal(isExpired(store.keys[0], Date.now() + 100 * 365 * 24 * HOUR), false);
});

test("白名单为空 = 全部可用；配了就只认配的", () => {
  const open = createKey("不限", EMPTY).record;
  assert.equal(allowsModel(open, "任何模型"), true);
  // 未鉴权（没有 key）时同样不限。
  assert.equal(allowsModel(undefined, "任何模型"), true);

  const scoped = createKey("限两个", EMPTY, { allowedModels: ["a", "b"] }).record;
  assert.equal(allowsModel(scoped, "a"), true);
  assert.equal(allowsModel(scoped, "c"), false);
});

test("签发时的设置被校验：正整数、可解析的时间", () => {
  assert.throws(() => createKey("k", EMPTY, { rateLimitPerMinute: 0 }), /必须是正整数/);
  assert.throws(() => createKey("k", EMPTY, { maxConcurrency: -1 }), /必须是正整数/);
  assert.throws(() => createKey("k", EMPTY, { expiresAt: "明天" }), /不是一个可解析的时间/);
});

test("白名单里的空串与重复被清掉；全清空 = 不限，而不是全禁", () => {
  const { record } = createKey("k", EMPTY, { allowedModels: [" a ", "a", "", "b"] });
  assert.deepEqual(record.allowedModels, ["a", "b"]);

  // 界面上把标签全删光，意思是「不限制了」。要锁死请吊销它。
  const cleared = createKey("k2", EMPTY, { allowedModels: [] }).record;
  assert.equal(cleared.allowedModels, undefined);
  assert.equal(allowsModel(cleared, "随便什么"), true);
});

test("updateKey 改设置，并且能把一项真正清掉", () => {
  const { store } = createKey("k", EMPTY, {
    rateLimitPerMinute: 60,
    maxConcurrency: 4,
    allowedModels: ["a"],
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
  });
  const id = store.keys[0].id;

  const tightened = updateKey(id, { rateLimitPerMinute: 10 }, store);
  assert.equal(tightened.keys[0].rateLimitPerMinute, 10);
  // 整份设置的替换：没给的项要被清掉，否则「只增不减」——清空一个输入框会毫无
  // 反应，而那种无反应没有报错。
  assert.equal(tightened.keys[0].maxConcurrency, undefined);
  assert.equal(tightened.keys[0].allowedModels, undefined);
  assert.equal(tightened.keys[0].expiresAt, null);

  // 身份不可改。
  assert.equal(tightened.keys[0].hash, store.keys[0].hash);
  assert.equal(tightened.keys[0].prefix, store.keys[0].prefix);
  assert.equal(tightened.keys[0].createdAt, store.keys[0].createdAt);

  assert.throws(() => updateKey("key_nope", {}, store), /unknown key/);
});

test("新字段能落盘再读回来", () => {
  const path = tempFile();
  const { store } = createKey("full", EMPTY, {
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
    rateLimitPerMinute: 30,
    maxConcurrency: 2,
    allowedModels: ["m1", "m2"],
  });
  writeKeyStore(store, path);
  const back = readKeyStore(path).keys[0];
  assert.equal(back.rateLimitPerMinute, 30);
  assert.equal(back.maxConcurrency, 2);
  assert.deepEqual(back.allowedModels, ["m1", "m2"]);
  assert.equal(back.expiresAt, store.keys[0].expiresAt);
});

test("describeKeys 把「过期了没有」算好给界面", () => {
  const { store } = createKey("k", EMPTY, { expiresAt: new Date(Date.now() - HOUR).toISOString() });
  const view = describeKeys(store) as { keys: { expired: boolean; allowedModels: string[] }[] };
  assert.equal(view.keys[0].expired, true);
  // 判定规则（含"坏时间算过期"）只该有一份实现，界面不自己拿时间比。
  assert.deepEqual(view.keys[0].allowedModels, []);
});

test("管理面对本机永远开放，即使 allowLoopback 关着", () => {
  // 这条防的是一个真实事故：关掉「本机免 key」之后，Console 连渠道列表和 key
  // 列表都读不到，界面上那个开关本身也点不回去——一扇连自己也进不去的门。
  // 它锁不住任何东西：能连到 127.0.0.1 的进程直接打开 keys.json 就什么都有了。
  const { store } = withOneKey(false);
  assert.equal(authenticate(store, undefined, "127.0.0.1", { adminSurface: true }), undefined);
  // /v1/* 不在此列 —— allowLoopback:false 对它照常生效。
  assert.throws(() => authenticate(store, undefined, "127.0.0.1"), /missing API key/);
});

test("管理面的豁免只给 loopback，外部地址照样要 key", () => {
  const { store } = withOneKey(false);
  assert.throws(
    () => authenticate(store, undefined, "203.0.113.9", { adminSurface: true }),
    /missing API key/,
  );
});

test("呈上一把错 key 时，管理面也拒 —— 豁免只针对「没带 key」", () => {
  const { store } = withOneKey(false);
  assert.throws(
    () => authenticate(store, "Bearer bcp-wrong", "127.0.0.1", { adminSurface: true }),
    /invalid API key/,
  );
});

// --- 明文留存与按需回显 --------------------------------------------------

test("新签发的 key 留存明文，可回显；明文与哈希都不进列表", () => {
  const { store, plaintext } = withOneKey();
  const id = store.keys[0].id;

  assert.equal(revealKey(id, store).secret, plaintext);

  // 但列表接口里既没有明文也没有哈希——它每几秒刷一次，明文跟着进网络面板、
  // 日志和前端缓存。只给一个「能不能回显」的布尔。
  const described = JSON.stringify(describeKeys(store));
  assert.ok(!described.includes(plaintext), "明文不该出现在列表响应里");
  assert.ok(!described.includes(hashKey(plaintext)));
  assert.match(described, /"revealable":true/);
});

test("旧版签发的 key 只有哈希：认证照常，回显如实降级", () => {
  const { store, plaintext } = withOneKey();
  // 模拟一份升级前写下的 keys.json —— 没有 secret 字段。
  const legacy: KeyStore = {
    ...store,
    keys: store.keys.map(({ secret: _drop, ...rest }) => rest),
  };

  // 认证不受影响（它一直只看哈希）。
  assert.equal(authenticate(legacy, `Bearer ${plaintext}`, "10.0.0.1")?.name, "预处理流水线");

  // 回显给出**原因**，而不是一个看起来像空 key 的空字符串。
  const revealed = revealKey(legacy.keys[0].id, legacy);
  assert.equal(revealed.secret, null);
  assert.match(revealed.reason ?? "", /旧版本签发/);
  assert.match(JSON.stringify(describeKeys(legacy)), /"revealable":false/);
});

test("明文能落盘再读回来", () => {
  const path = tempFile();
  const { store, plaintext } = withOneKey();
  writeKeyStore(store, path);
  assert.equal(revealKey(store.keys[0].id, readKeyStore(path)).secret, plaintext);
});

test("回显一把不存在的 key 是 404", () => {
  assert.throws(() => revealKey("key_nope", withOneKey().store), /unknown key/);
});
