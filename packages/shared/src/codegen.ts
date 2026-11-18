/**
 * Book-param type codegen.
 *
 * SOURCE OF TRUTH: `resource/playbooks/*.json`. Each book's
 * top-level `params` array is a list of `{ name, required, description?,
 * schema }` — a JSON Schema fragment per input. The steps' `action.method`
 * and `{{slot}}` references are cross-validated against the declared params.
 *
 * OUTPUT (into packages/shared/src/generated/, committed):
 *   - books.ts   — one TS `Params` interface per book + a `BookParams` map +
 *                  `BookName` union, so any caller can `import type { Book }`
 *                  and get a typed param object.
 *   - schema.ts  — the raw JSON Schema registry per book, for runtime
 *                  validation (no runtime deps; shared stays a types-only +
 *                  constants module).
 *
 * Invoked via `pnpm playbooks:generate` (exits 1 on any validation error so pre-commit /
 * CI can gate on it).
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcMethod, LocalMethod } from "./methods.js";
import type { ParamSchemaFragment, ParamSpec } from "./param-runtime.js";
import { validateBookV2 } from "./book-signals.js";
import { normalizeBookCode } from "./book-code.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// packages/shared/src/ → monorepo root
const SHARED_SRC = __dirname;
const MONOREPO_ROOT = resolve(__dirname, "../../..");
const PLAYBOOKS_DIR = resolve(MONOREPO_ROOT, "resource/playbooks");
const GENERATED_DIR = resolve(SHARED_SRC, "generated");

/** A declared book input param (the JSON is the SSOT). */
type BookParam = ParamSpec;

interface BookMeta {
  file: string;
  name: string;
  goal: string;
  params: BookParam[];
  /** The book's declared output contract, or null when it promises nothing. */
  outputSchema: ParamSchemaFragment | null;
}

// ── validation ─────────────────────────────────────────────────────────────

const VALID_METHODS = new Set<string>([
  ...Object.values(RpcMethod),
  ...Object.values(LocalMethod),
]);

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function err(file: string, msg: string): never {
  throw new Error(`${file}: ${msg}`);
}

/** Cross-validate one book JSON against the SSOT rules. Returns the params. */
function validateBook(file: string, data: unknown): BookMeta {
  // 内联 JS 的行数组合回字符串，必须在 validateBookV2 之前 —— 那个校验器要求
  // `code` 是 string，正是靠这一点把「谁忘了归一化」当场报出来。
  normalizeBookCode(data);
  // Book v2 gate: schemaVersion, pages, per-step page/gate references, no
  // physical tabId on page-scoped actions, no waitSignal actions. Runs FIRST
  // so a structurally-broken book never reaches the param rules below.
  try {
    validateBookV2(data);
  } catch (e) {
    err(file, e instanceof Error ? e.message : String(e));
  }
  const obj = data as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : err(file, "missing string `name`");
  const goal = typeof obj.goal === "string" ? obj.goal : "";
  const rawParams = obj.params;
  const rawSteps = obj.steps;

  let params: BookParam[];
  if (Array.isArray(rawParams)) {
    params = rawParams as BookParam[];
  } else if (Array.isArray(obj.paramNames)) {
    // Back-compat: legacy `paramNames: string[]` → every param is a required
    // string slot (same as the old console default). codegen normalizes it.
    params = (obj.paramNames as string[]).map((n) => ({
      name: n,
      required: false,
      schema: { type: "string" },
    }));
  } else {
    params = [];
  }

  // Rule 1 + 5: identifier + no duplicates.
  const seen = new Set<string>();
  for (const p of params) {
    if (typeof p.name !== "string" || !IDENTIFIER_RE.test(p.name)) {
      err(file, `param.name "${String(p.name)}" is not a valid JS identifier`);
    }
    if (seen.has(p.name)) err(file, `duplicate param.name "${p.name}"`);
    seen.add(p.name);
  }

  if (Array.isArray(rawSteps)) {
    for (const step of rawSteps as Array<Record<string, unknown>>) {
      const action = step.action as Record<string, unknown> | undefined;
      if (!action) continue;
      const method = action.method;
      // Rule 2: method must be a known RpcMethod / LocalMethod.
      if (typeof method !== "string" || !VALID_METHODS.has(method)) {
        err(file, `steps[].action.method "${String(method)}" is not a known RpcMethod/LocalMethod`);
      }
      // Rule 3: every {{slot}} must be declared.
      const rawActionParams = action.params;
      if (rawActionParams && typeof rawActionParams === "object") {
        for (const [key, value] of Object.entries(rawActionParams as Record<string, unknown>)) {
          if (typeof value !== "string") continue;
          const m = /{{(.*?)}}/g;
          let match: RegExpExecArray | null;
          while ((match = m.exec(value)) !== null) {
            const slot = match[1].trim();
            // A slot may be a dotted PATH into a declared param — the runtime
            // resolves `{{product.title.text}}` against the `product` value, and
            // books rely on it heavily (doudian-publish-canonical alone has a
            // dozen). Only the ROOT segment is an input; the rest is navigation
            // inside that input, and demanding it be declared would mean listing
            // every field of every object param as a separate param — which is
            // not what a param is.
            //
            // 2026-09-03: before this, the rule compared the whole slot against
            // param names, so every dotted slot failed. That made this generator
            // fail outright on doudian-publish-canonical — and since the
            // pre-commit hook that runs it was never installed (.git/hooks/
            // pre-commit is absent), nobody hit it and generated/ silently
            // stopped being regenerated.
            const root = slot.split(".")[0]!.trim();
            if (!seen.has(root)) {
              err(
                file,
                `step "…${key}" references undelcared "{{${slot}}}"` +
                  (root === slot ? "" : ` (its root "${root}")`) +
                  " (declare it in `params`)",
              );
            }
          }
        }
      }
    }
  }

  // Rule 6: the OUT side of the contract. Optional, but a declaration that is
  // present must be usable — an unusable one would generate a TS type nobody
  // can satisfy and a runtime check nobody can pass, which is worse than
  // declaring nothing at all.
  const rawOutput = obj.outputSchema;
  let outputSchema: ParamSchemaFragment | null = null;
  if (rawOutput !== undefined && rawOutput !== null) {
    if (!isParamMap(rawOutput)) err(file, "`outputSchema` must be a JSON Schema object");
    if (Object.keys(rawOutput).length === 0) err(file, "`outputSchema` is empty — omit it instead of declaring an empty contract");
    if (typeof rawOutput.type !== "string") err(file, "`outputSchema` must declare a top-level `type`");
    outputSchema = rawOutput as ParamSchemaFragment;
  }

  return { file, name, goal, params, outputSchema };
}

// ── emitters ───────────────────────────────────────────────────────────────

/** JSON Schema type → TS type string. */
function schemaToTsType(p: BookParam): string {
  return schemaValueToTsType(p.schema ?? {});
}

function schemaValueToTsType(s: ParamSchemaFragment): string {
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    return s.enum.map((v) => JSON.stringify(v)).join(" | ") || "string";
  }
  switch (s.type) {
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `${schemaValueToTsType(asSchema(s.items))}[]`;
    case "object":
      if (isParamMap(s.properties)) {
        const required = new Set(Array.isArray(s.required) ? s.required.filter((v): v is string => typeof v === "string") : []);
        const fields = Object.entries(s.properties).map(([name, raw]) => {
          const key = IDENTIFIER_RE.test(name) ? name : JSON.stringify(name);
          return `${key}${required.has(name) ? "" : "?"}: ${schemaValueToTsType(asSchema(raw))}`;
        });
        return fields.length ? `{ ${fields.join("; ")} }` : "Record<string, unknown>";
      }
      return "Record<string, unknown>";
    default:
      return "string";
  }
}

function isParamMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asSchema(value: unknown): ParamSchemaFragment {
  return isParamMap(value) ? value as ParamSchemaFragment : {};
}

function toPascal(name: string): string {
  const pascal = name
    .split(/[^A-Za-z0-9]/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join("");
  // A TS interface name cannot start with a digit (e.g. "1688OfferSnatch").
  return /^[0-9]/.test(pascal) ? `Book${pascal}` : pascal;
}

/** Emit `generated/books.ts`. Returns the per-book TS interface names. */
function emitBooks(books: BookMeta[]): Map<string, string> {
  const interfaceName = new Map<string, string>();
  const lines: string[] = [
    "// AUTO-GENERATED by pnpm playbooks:generate — do not edit.",
    "// Source of truth: resource/playbooks/*.json (top-level `params`).",
    "",
  ];
  for (const b of books) {
    const t = toPascal(b.name);
    interfaceName.set(b.name, `${t}Params`);
    lines.push(`export interface ${t}Params {`);
    for (const p of b.params) {
      const doc = p.description ? ` // ${p.description}` : "";
      const opt = p.required ? "" : "?";
      const ts = schemaToTsType(p);
      lines.push(`  ${p.name}${opt}: ${ts}${doc}`);
    }
    lines.push("}", "");
  }
  lines.push("export type BookParams = {");
  for (const b of books) {
    lines.push(`  "${b.name}": ${interfaceName.get(b.name)!};`);
  }
  lines.push("};");
  lines.push("");
  lines.push("export type BookName = keyof BookParams;");
  lines.push("");
  // The OUT side of the contract. A book with no `outputSchema` maps to
  // `unknown` rather than being omitted, so BookOutputs stays total over
  // BookName and a consumer must narrow before trusting a shape.
  for (const b of books) {
    lines.push(`export type ${toPascal(b.name)}Outputs = ${b.outputSchema ? schemaValueToTsType(b.outputSchema) : "unknown"};`);
  }
  lines.push("");
  lines.push("export type BookOutputs = {");
  for (const b of books) {
    lines.push(`  "${b.name}": ${toPascal(b.name)}Outputs;`);
  }
  lines.push("};");
  lines.push("");
  writeFileSync(resolve(GENERATED_DIR, "books.ts"), lines.join("\n"));
  return interfaceName;
}

/** Emit `generated/schema.ts` — the runtime JSON Schema registry. */
function emitSchema(books: BookMeta[]): void {
  const lines: string[] = [
    "// AUTO-GENERATED by pnpm playbooks:generate — do not edit.",
    "// Source of truth: resource/playbooks/*.json (top-level `params`).",
    'import type { BookName } from "./books.js";',
    'import type { ParamSchemaFragment, ParamSpec } from "../param-runtime.js";',
    "",
    "export type BookParamSchema = ParamSpec;",
    "",
    "export const BOOK_PARAM_SCHEMAS = {",
  ];
  for (const b of books) {
    lines.push(`  "${b.name}": ${JSON.stringify(b.params, null, 2).replace(/\n/g, "\n  ")} as BookParamSchema[],`);
  }
  lines.push("} satisfies Record<BookName, BookParamSchema[]>;");
  lines.push("");
  // Runtime counterpart of BookOutputs: null means "declares no contract",
  // which validateOutput() treats as "nothing to check" — distinct from {}.
  lines.push("export const BOOK_OUTPUT_SCHEMAS = {");
  for (const b of books) {
    const literal = b.outputSchema ? JSON.stringify(b.outputSchema, null, 2).replace(/\n/g, "\n  ") : "null";
    lines.push(`  "${b.name}": ${literal} as ParamSchemaFragment | null,`);
  }
  lines.push("} satisfies Record<BookName, ParamSchemaFragment | null>;");
  lines.push("");
  writeFileSync(resolve(GENERATED_DIR, "schema.ts"), lines.join("\n"));
}

// ── main ───────────────────────────────────────────────────────────────────

function main(): void {
  if (!readdirSync(PLAYBOOKS_DIR).some((f) => f.endsWith(".json"))) {
    throw new Error(`no resource/playbooks/*.json found in ${PLAYBOOKS_DIR}`);
  }
  mkdirSync(GENERATED_DIR, { recursive: true });

  const books: BookMeta[] = [];
  for (const f of readdirSync(PLAYBOOKS_DIR).filter((x) => x.endsWith(".json")).sort()) {
    const raw = readFileSync(resolve(PLAYBOOKS_DIR, f), "utf8");
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      err(f, `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    books.push(validateBook(f, data));
  }

  // Rule 6: no two books with the same name.
  const names = new Set<string>();
  for (const b of books) {
    if (names.has(b.name)) err(b.file, `duplicate book name "${b.name}"`);
    names.add(b.name);
  }

  emitBooks(books);
  emitSchema(books);

  // Warn (not error) for declared-but-unused params.
  for (const b of books) {
    const used = new Set<string>();
    // Walk the whole params value, not just its top-level strings. Inline JS is
    // stored as a LINE ARRAY, so every slot inside `code` sits one level down —
    // scanning only string values reported all four of doudian-publish's params
    // as unused, and a warning that is always wrong is a warning nobody reads.
    const collect = (v: unknown): void => {
      if (typeof v === "string") {
        const m = /{{(.*?)}}/g;
        let match: RegExpExecArray | null;
        // `{{product.title.text}}` spends the param named `product`; the root
        // identifier is what has to match a declared param name.
        while ((match = m.exec(v)) !== null) used.add(match[1].trim().split(".")[0]);
      } else if (Array.isArray(v)) {
        for (const item of v) collect(item);
      } else if (v && typeof v === "object") {
        for (const item of Object.values(v as Record<string, unknown>)) collect(item);
      }
    };
    for (const raw of readSteps(b)) {
      const step = raw as Record<string, unknown>;
      const action = step.action as Record<string, unknown> | undefined;
      if (action && action.params && typeof action.params === "object") collect(action.params);
    }
    for (const p of b.params) {
      if (!used.has(p.name)) {
        console.warn(`${b.file}: param "${p.name}" is declared but never used in steps`);
      }
    }
  }

  console.log(`playbooks:generate: ${books.length} book(s) → generated/{books,schema}.ts`);
}

// Re-read steps for the unused-param scan (keeps validateBook pure/focused).
function readSteps(b: BookMeta): unknown[] {
  const obj = JSON.parse(readFileSync(resolve(PLAYBOOKS_DIR, b.file), "utf8")) as Record<string, unknown>;
  return Array.isArray(obj.steps) ? (obj.steps as unknown[]) : [];
}

main();
