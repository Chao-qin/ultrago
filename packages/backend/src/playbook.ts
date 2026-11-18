import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeBookCode, normalizeParams as normalizeSharedParams, splitBookCode, validateParams as validateSharedParams, resolveParamDefaults as resolveSharedDefaults } from "@bcp/shared";
import type { DefaultContext, ParamMap, ParamSpec, PlanStep, Playbook } from "@bcp/shared";

const PLAYBOOKS_DIR = join(process.cwd(), "resource", "playbooks");

const WHOLE_SLOT = /^\{\{([\w.]+)\}\}$/;
const INLINE_SLOT = /\{\{([\w.]+)\}\}/g;

function slotValue(path: string, values: ParamMap): unknown {
  const [root, ...parts] = path.split(".");
  let value: unknown = values[root];
  for (const part of parts) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** A {{slot}} this run's params don't carry. Its own class so `instantiateSteps`
 * can tell "this step's data is absent" apart from every other throw — dropping
 * an `optional` step on an unrelated error would silently shorten a plan, which
 * is exactly the failure mode (a step that never ran, reported as fine) the
 * whole verify machinery exists to prevent. */
export class UnresolvedSlotError extends Error {
  constructor(readonly slot: string) {
    super(`unresolved playbook slot: ${slot}`);
    this.name = "UnresolvedSlotError";
  }
}

/** {{slot}} → concrete value, for filling a playbook's action params before
 * replay. A whole-value placeholder keeps its runtime type so structured book
 * params can reach an action intact; embedded placeholders are string-only for
 * URLs and other scalar text fields. */
export function fillSlots<T extends Record<string, unknown>>(params: T, values: ParamMap): T {
  return fillValue(params, values) as T;
}

/**
 * Substitution at any depth, because a slot's usefulness should not depend on
 * how deeply the field it names happens to be nested.
 *
 * Every slot in this repository's books sits at the top level of
 * `action.params`, so recursing changes none of them — it was verified rather
 * than assumed. What it unblocks is `verify`, where the interesting field
 * (`elementValue.equals`) is two levels down: a book that types a parameterised
 * string could not, until now, assert that the string arrived.
 */
function fillValue(value: unknown, values: ParamMap): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_SLOT.exec(value);
    if (whole) {
      const replacement = slotValue(whole[1], values);
      if (replacement === undefined || replacement === null) {
        throw new UnresolvedSlotError(whole[1]);
      }
      // The runtime type survives, so an array or object parameter arrives as
      // itself rather than as `[object Object]`.
      return replacement;
    }
    return value.replace(INLINE_SLOT, (_match, name: string) => {
      const replacement = slotValue(name, values);
      if (replacement === undefined || replacement === null) {
        throw new UnresolvedSlotError(name);
      }
      // Inline slots are commonly JavaScript source in browser.eval. Structured
      // values must become JSON literals instead of the useless "[object Object]".
      return typeof replacement === "object" ? JSON.stringify(replacement) : String(replacement);
    });
  }
  if (Array.isArray(value)) return value.map((item) => fillValue(item, values));
  // Plain objects only. Anything else (numbers, booleans, null) is returned as
  // it stands, which is what the shallow version did for them too.
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fillValue(v, values)]));
  }
  return value;
}

/** Concrete value → {{slot}}, for recording: replaces action params that
 * exactly equal one of this run's known param values with its placeholder.
 * Exact string match only (no substring replace), so a value that happens to
 * appear inside a longer unrelated string isn't corrupted. */
export function extractSlots<T extends Record<string, unknown>>(params: T, values: Record<string, string>): T {
  const bySlotValue = new Map(Object.entries(values).map(([k, v]) => [v, k]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = typeof v === "string" && bySlotValue.has(v) ? `{{${bySlotValue.get(v)}}}` : v;
  }
  return out as T;
}

export async function loadPlaybook(name: string): Promise<Playbook> {
  const raw = await readFile(join(PLAYBOOKS_DIR, `${name}.json`), "utf8");
  const pb = JSON.parse(raw) as Playbook;
  // 内联 JS 允许写成行数组（见 book-code.ts）——在这里合回字符串，此后全链路
  // 只见 string。放在最前面：下面的每一步、以及所有调用方，都假定 code 是字符串。
  normalizeBookCode(pb);
  // Normalize legacy `paramNames: string[]` → rich `params: ParamSpec[]` so
  // validation/defaults work uniformly.  Rich `params` takes precedence.
  if (!Array.isArray(pb.params) && Array.isArray(pb.paramNames)) {
    pb.params = pb.paramNames.map((n) => ({ name: n, required: true, schema: { type: "string" } }));
  }
  return pb;
}

/** Enough to pick one and call it, without loading every step. */
export interface PlaybookSummary {
  /** The name run_playbook takes — the FILE's basename, which is what
   * loadPlaybook resolves, even if the JSON's own `name` field drifted. */
  name: string;
  goal: string;
  paramNames: string[];
  steps: number;
}

/** Summarize every saved playbook. run_playbook needs an exact name and a
 * matching param set, and a fresh session knows neither — without this, a saved
 * playbook is only reachable by guessing. A file that doesn't parse is reported
 * rather than dropped silently, so a corrupt playbook can't look like an absent
 * one. Missing directory = nothing recorded yet (not an error); any OTHER
 * readdir failure propagates instead of masquerading as "no playbooks". */
export async function listPlaybooks(): Promise<{ playbooks: PlaybookSummary[]; unreadable: string[] }> {
  let files: string[];
  try {
    files = await readdir(PLAYBOOKS_DIR);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { playbooks: [], unreadable: [] };
    throw e;
  }
  const playbooks: PlaybookSummary[] = [];
  const unreadable: string[] = [];
  for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
    try {
      const pb = JSON.parse(await readFile(join(PLAYBOOKS_DIR, f), "utf8")) as Playbook;
      playbooks.push({
        name: f.slice(0, -".json".length),
        goal: pb.goal ?? "(no goal recorded)",
        // Current books declare rich parameter metadata in `params`; older
        // recordings may still carry the flattened `paramNames` field.
        paramNames: pb.params?.map((param) => param.name) ?? pb.paramNames ?? [],
        steps: pb.steps?.length ?? 0,
      });
    } catch {
      unreadable.push(f);
    }
  }
  return { playbooks, unreadable };
}

export async function savePlaybook(pb: Playbook): Promise<string> {
  await mkdir(PLAYBOOKS_DIR, { recursive: true });
  const path = join(PLAYBOOKS_DIR, `${pb.name}.json`);
  // 落盘成行数组，否则 record_stop 录出来的书是一整行，人工排好的版一录就打回原形。
  // 深拷贝后再切：splitBookCode 是就地改的，直接切会把调用方手上的 playbook 对象
  // 的 code 变成数组，而它后面还要按 string 用（browser-mcp 的 record_stop 就把同一个
  // 对象 JSON.stringify 出来回显给用户）。
  const onDisk = JSON.parse(JSON.stringify(pb)) as Playbook;
  splitBookCode(onDisk);
  await writeFile(path, JSON.stringify(onDisk, null, 2) + "\n", "utf8");
  return path;
}

/** Playbook steps with every action.params {{slot}} filled from `values` —
 * returns new step objects, doesn't mutate the playbook. */
/**
 * A plan with its slots filled — in `verify` as well as in `action.params`.
 *
 * Leaving `verify` out made a parameterised assertion silently unsatisfiable:
 * a step that types `{{title}}` and then asserts the field equals one specific
 * recorded sentence fails for every title but that one. The alternative on
 * offer was to drop the assertion, which trades a broken check for no check —
 * and a replay that verifies nothing reports success whatever the page did.
 */
export function instantiateSteps(steps: PlanStep[], values: ParamMap): PlanStep[] {
  const out: PlanStep[] = [];
  for (const s of steps) {
    try {
      const next = { ...s };
      if (s.action) next.action = { method: s.action.method, params: fillSlots(s.action.params, values) };
      if (s.verify) next.verify = fillSlots(s.verify as unknown as Record<string, unknown>, values) as typeof s.verify;
      out.push(next);
    } catch (e) {
      // `optional` + 槽位缺失 = 这一步没有数据可做，整步不进 plan。
      //
      // 丢弃而不是「跑到那一步再跳过」是刻意的：不进 plan 的步骤不需要 gate /
      // verify / 重试预算里多一种状态，也就不可能出现「什么都没做却记成通过」——
      // 而那正是 verify 这套机器存在的理由。代价是 plan 的步数随入参变化，所以
      // 只有书里显式标了 optional 的步骤才享受它。
      //
      // 其他任何错误照旧上抛：少做一步必须是数据缺失的直接后果，不能是别的 bug
      // 被顺手吃掉的结果。
      if (s.optional && e instanceof UnresolvedSlotError) continue;
      throw e;
    }
  }
  return out;
}

/** Fill omitted/empty optional params from the book's declared defaults, so an
 * MCP caller that never passed a value (or a console form left blank) still
 * gets the book's intended default. Top-level `default` wins over
 * `schema.default`; dynamic defaults are resolved with the supplied execution
 * context and are frozen in the returned map. */
export function applyParamDefaults(
  declared: ParamSpec[] | undefined,
  actual: ParamMap,
  context: DefaultContext,
): ParamMap {
  const resolved = resolveSharedDefaults(declared, actual, context);
  return normalizeSharedParams(declared, resolved);
}

/** Validate a run_playbook param set against the playbook's declared `params`.
 * Mirrors the console form's rule set (rulesFor) so the MCP path and the
 * console path reject the same bad values: required, type (number/integer/
 * boolean), enum membership, min/max, minLength/maxLength, pattern. */
export function validatePlaybookParams(
  declared: ParamSpec[] | undefined,
  actual: ParamMap,
): string[] {
  return validateSharedParams(declared, actual);
}
