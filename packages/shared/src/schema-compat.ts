/**
 * Can a value produced against schema A be fed to something expecting schema B?
 *
 * This is the question a flow canvas asks every time a wire is drawn, and it is
 * NOT the same question `validateSchemaValue` answers — that one compares a
 * VALUE to a schema, this one compares two SCHEMAS. They must nevertheless
 * agree, because a wire the canvas calls legal is a wire whose values will hit
 * the runtime validator later. The relationship is pinned by two laws, both
 * enforced in schema-compat.test.ts:
 *
 *   Law A (ok doesn't lie)     isAssignable(A,B) === "ok"
 *                              ⟹ ∀v: valid(v,A) ⟹ valid(v,B)
 *   Law B (error doesn't frame) isAssignable(A,B) === "error"
 *                              ⟹ ∃v: valid(v,A) ∧ ¬valid(v,B)   (a named witness)
 *
 * Hence the guiding rule: only claim `error` when failure is PROVABLE, only
 * claim `ok` when success is provable, and say so plainly the rest of the time.
 * An incomplete decision procedure is the normal case, not a defect — what
 * would be a defect is dressing "I don't know" up as either verdict.
 *
 *   Law C (unsupported doesn't bluff) a schema using keywords outside the
 *   supported subset must come back `unsupported`, never `ok`.
 *
 * Law C exists because of a real failure: `validateSchemaValue` silently
 * ignores `$ref`, so handing it a document whose constraints all live behind
 * `$ref` yields "no problems" — a checker that checked nothing. Anything
 * reading THIS module must be told it cannot judge such a schema, so the
 * decision moves to a full draft 2020-12 validator at runtime instead.
 */
import { isUnconstrainedSchema, unsupportedSchemaKeywords } from "./schema-keywords.js";
import type { ParamSchemaFragment } from "./param-runtime.js";

export type CompatLevel = "ok" | "warn" | "unsupported" | "error";

export interface Compat {
  level: CompatLevel;
  /** Human-readable, shown on the wire's tooltip. */
  reason: string;
  /** Where inside the shape the verdict came from, e.g. "items[].url". */
  at?: string;
  /**
   * The evidence behind `reason`, when spelling it out inline would drown the
   * verdict — an unsupported schema names every keyword it tripped on, and a
   * dozen of them is longer than the sentence explaining what they mean. Kept
   * separate so a list can show the verdict and a tooltip the evidence.
   */
  detail?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asSchema(value: unknown): ParamSchemaFragment {
  return isPlainObject(value) ? (value as ParamSchemaFragment) : {};
}

const SEVERITY: Record<CompatLevel, number> = { ok: 0, warn: 1, unsupported: 2, error: 3 };

function worst(a: Compat, b: Compat): Compat {
  return SEVERITY[b.level] > SEVERITY[a.level] ? b : a;
}

const OK: Compat = { level: "ok", reason: "契约兼容" };

/**
 * Judge whether a producer's shape can feed a consumer's.
 *
 * @param src what the upstream promises to produce; null/absent = undeclared
 * @param dst what the downstream requires; null/absent = no constraint
 */
export function isAssignable(src: ParamSchemaFragment | null | undefined, dst: ParamSchemaFragment | null | undefined): Compat {
  // A target that constrains nothing accepts anything — including a source we
  // could not otherwise judge. Checked first so an unjudgeable source doesn't
  // block a wire whose destination never cared.
  if (isUnconstrainedSchema(dst)) return OK;

  const dstUnsupported = unsupportedSchemaKeywords(dst);
  if (dstUnsupported.length > 0) {
    return {
      level: "unsupported",
      reason: `目标契约含 ${dstUnsupported.length} 个画布无法静态判定的关键字，将在运行时用完整校验器检查`,
      detail: dstUnsupported.join(", "),
    };
  }
  if (isUnconstrainedSchema(src)) {
    return { level: "warn", reason: "上游未声明出参契约，运行时才能校验" };
  }
  const srcUnsupported = unsupportedSchemaKeywords(src);
  if (srcUnsupported.length > 0) {
    return {
      level: "unsupported",
      reason: `上游契约含 ${srcUnsupported.length} 个画布无法静态判定的关键字，将在运行时用完整校验器检查`,
      detail: srcUnsupported.join(", "),
    };
  }
  return compare(src as ParamSchemaFragment, dst as ParamSchemaFragment, "");
}

function at(path: string, segment: string): string {
  return path ? `${path}${segment}` : segment.replace(/^\./, "");
}

function compare(src: ParamSchemaFragment, dst: ParamSchemaFragment, path: string): Compat {
  let verdict = OK;
  const where = path || undefined;

  verdict = worst(verdict, compareType(src, dst, where));
  if (verdict.level === "error") return verdict;

  verdict = worst(verdict, compareEnum(src, dst, where));
  if (verdict.level === "error") return verdict;

  verdict = worst(verdict, compareRange(src.minimum, src.maximum, dst.minimum, dst.maximum, "取值范围", where));
  verdict = worst(verdict, compareRange(src.minLength, src.maxLength, dst.minLength, dst.maxLength, "长度", where));
  if (verdict.level === "error") return verdict;

  if (typeof dst.pattern === "string" && src.pattern !== dst.pattern) {
    verdict = worst(verdict, { level: "warn", reason: `目标要求匹配 ${dst.pattern}，上游未声明同一约束`, at: where });
  }

  // A branch on either side puts the shape beyond what this procedure decides.
  if (Array.isArray(src.oneOf) || Array.isArray(dst.oneOf) || src.not !== undefined || dst.not !== undefined) {
    verdict = worst(verdict, { level: "warn", reason: "含 oneOf/not 分支，兼容性不做完备判定", at: where });
  }

  if (dst.type === "array" || src.type === "array" || dst.items || src.items) {
    verdict = worst(verdict, compare(asSchema(src.items), asSchema(dst.items), at(path, "[]")));
    if (verdict.level === "error") return verdict;
  }

  verdict = worst(verdict, compareObject(src, dst, path));
  return verdict;
}

function compareType(src: ParamSchemaFragment, dst: ParamSchemaFragment, where?: string): Compat {
  const s = src.type;
  const d = dst.type;
  if (d === undefined) return OK;
  if (s === undefined) return { level: "warn", reason: "上游未声明类型", at: where };
  if (s === d) return OK;
  // integer ⊂ number: every integer is a number, so widening is safe and
  // narrowing is not.
  if (s === "integer" && d === "number") return OK;
  if (s === "number" && d === "integer") return { level: "warn", reason: "上游可能产生小数，目标只接受整数", at: where };
  return { level: "error", reason: `类型不兼容：上游 ${s}，目标要求 ${d}`, at: where };
}

function compareEnum(src: ParamSchemaFragment, dst: ParamSchemaFragment, where?: string): Compat {
  if (!Array.isArray(dst.enum)) return OK;
  if (!Array.isArray(src.enum)) {
    return { level: "warn", reason: `目标限定取值为 ${dst.enum.join(" / ")}，上游取值不受限`, at: where };
  }
  const allowed = new Set(dst.enum);
  const outside = src.enum.filter((v) => !allowed.has(v));
  if (outside.length === 0) return OK;
  if (outside.length === src.enum.length) {
    return { level: "error", reason: `取值集合无交集：上游 ${src.enum.join(" / ")}，目标只接受 ${dst.enum.join(" / ")}`, at: where };
  }
  return { level: "warn", reason: `上游可能产生目标不接受的值：${outside.join(" / ")}`, at: where };
}

/** Interval containment for the two range pairs (numeric and length). */
function compareRange(
  srcMin: number | undefined,
  srcMax: number | undefined,
  dstMin: number | undefined,
  dstMax: number | undefined,
  label: string,
  where?: string,
): Compat {
  if (dstMin === undefined && dstMax === undefined) return OK;
  const sLo = srcMin ?? -Infinity;
  const sHi = srcMax ?? Infinity;
  const dLo = dstMin ?? -Infinity;
  const dHi = dstMax ?? Infinity;
  if (sLo > dHi || sHi < dLo) {
    return { level: "error", reason: `${label}无交集：上游 [${fmt(sLo)}, ${fmt(sHi)}]，目标 [${fmt(dLo)}, ${fmt(dHi)}]`, at: where };
  }
  if (sLo >= dLo && sHi <= dHi) return OK;
  return { level: "warn", reason: `${label}可能越界：上游 [${fmt(sLo)}, ${fmt(sHi)}]，目标 [${fmt(dLo)}, ${fmt(dHi)}]`, at: where };
}

function fmt(n: number): string {
  return Number.isFinite(n) ? String(n) : n > 0 ? "∞" : "-∞";
}

function compareObject(src: ParamSchemaFragment, dst: ParamSchemaFragment, path: string): Compat {
  const dstProps = isPlainObject(dst.properties) ? dst.properties : {};
  const srcProps = isPlainObject(src.properties) ? src.properties : {};
  const dstRequired = Array.isArray(dst.required) ? dst.required.filter((k): k is string => typeof k === "string") : [];
  const srcRequired = new Set(Array.isArray(src.required) ? src.required.filter((k): k is string => typeof k === "string") : []);
  const srcClosed = src.additionalProperties === false;

  let verdict = OK;
  for (const key of dstRequired) {
    const where = at(path, `.${key}`);
    if (!(key in srcProps)) {
      // A closed source PROVES the key never appears; an open one merely fails
      // to promise it. Only the first is a demonstrable failure.
      verdict = worst(
        verdict,
        srcClosed
          ? { level: "error", reason: `目标必填 ${key}，而上游声明不会产生该字段`, at: where }
          : { level: "warn", reason: `目标必填 ${key}，上游未保证一定产生它`, at: where },
      );
      if (verdict.level === "error") return verdict;
      continue;
    }
    if (!srcRequired.has(key)) {
      verdict = worst(verdict, { level: "warn", reason: `目标必填 ${key}，上游只是可选产生`, at: where });
    }
  }

  for (const [key, dstChild] of Object.entries(dstProps)) {
    if (!(key in srcProps)) continue; // absence already judged by the required pass
    verdict = worst(verdict, compare(asSchema(srcProps[key]), asSchema(dstChild), at(path, `.${key}`)));
    if (verdict.level === "error") return verdict;
  }
  return verdict;
}
