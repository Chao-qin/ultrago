import { access, mkdir, writeFile } from "node:fs/promises";
import pathApi, { basename, dirname, extname, resolve } from "node:path";
import vm from "node:vm";
import type { PlaybackStepResult } from "./orchestrator.js";

const REPORTS_DIR = resolve(process.cwd(), "reports");

export function resolveReportFile(directory: string, file: string, paths = pathApi): string {
  if (!file.trim() || /^\{\{[^}]+\}\}$/.test(file.trim())) {
    throw new Error(`local.writeFile path "${file}" contains an unresolved template reference`);
  }
  const absolute = paths.resolve(directory, file);
  const relative = paths.relative(directory, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) {
    throw new Error(`local.writeFile path "${file}" escapes the reports/ directory — refusing`);
  }
  return absolute;
}

/** Run a `local.eval` step's code against this run's collected read results.
 * Sandboxed with node:vm, and nothing from this realm crosses in: any host object — even the plain `results`
 * array — leads back to the host Function through its constructor, and
 * `results.constructor.constructor("return process")()` reached the backend process. So the context's global
 * has no prototype, `results` arrives as JSON text parsed INSIDE the context, and the value leaves as JSON text
 * parsed here: the code only ever touches the context's own builtins. vm is still not a hard boundary against a
 * determined escape, which is why this stays gated behind BCP_LOCAL_EVAL (see config.localEvalEnabled). */
export function runLocalEval(code: string, results: PlaybackStepResult[]): unknown {
  const context = vm.createContext(Object.create(null));
  context.__input = JSON.stringify(results);
  // Same two compile forms as page eval (extension background.ts), in the same
  // order: a bare expression is returned implicitly, otherwise the code is a
  // function body that needs an explicit `return`. Without the expression form
  // `results.length` evaluated to undefined here while the identical code
  // returned a value from eval.
  const compile = (body: string): vm.Script =>
    new vm.Script(
      // A returned Promise is settled inside the context first: left alone, its rejection surfaces in the backend as
      // an unhandledRejection and takes the whole process down. local.eval is synchronous by contract.
      `(() => { const value = (function (results) {\n${body}\n})(JSON.parse(__input));` +
        ` if (value && typeof value.then === "function") { value.then(undefined, () => {}); throw new Error("local.eval must return its value synchronously, not a Promise"); }` +
        ` return value === undefined ? undefined : JSON.stringify(value); })()`,
    );
  let script: vm.Script;
  try {
    script = compile(`return (${code}\n);`);
  } catch {
    script = compile(code);
  }
  const out = script.runInContext(context, { timeout: 2000 }) as string | undefined;
  return out === undefined ? undefined : JSON.parse(out);
}

/** Write a `local.writeFile` step's content to `reports/<path>`. Path is
 * resolved against REPORTS_DIR and refused if it escapes that directory
 * (traversal guard) — this has no BCP_LOCAL_EVAL-style gate since it can only
 * ever land inside reports/, not run code.
 *
 * `overwrite` guards an existing file at the same path (default "overwrite"
 * keeps today's behaviour — a scheduled run rewriting today's report must
 * keep working):
 * - "overwrite": silently replace (default; any unrecognised value too, e.g. an
 *   unfilled {{slot}} placeholder);
 * - "error": throw instead of clobbering an existing file;
 * - "rename": keep the old file and write to `<name>-<timestamp><ext>`
 *   (ISO-ish stamp, filesystem-safe).
 */
/** A `local.writeFile` step writes the value of the step RIGHT BEFORE it —
 * the previous plan step, matched by index. `results` only keeps steps that
 * advanced with exactly one action, so "the last entry" could be an older
 * step's value whenever the previous step produced none; that is refused here
 * instead of silently writing the wrong data. Shared by the write_file tool and
 * both playback channels. */
export async function writePreviousStepValue(
  path: string,
  results: PlaybackStepResult[],
  stepIndex: number,
  opts?: { overwrite?: "overwrite" | "error" | "rename" },
): Promise<string> {
  const prev = results.find((r) => r.index === stepIndex - 1);
  if (!prev)
    throw new Error(
      `local.writeFile writes the value of the step right before it (step ${stepIndex}), but that step produced no single value — ` +
        `put the step that computes the content (one action, e.g. local_eval) immediately before write_file`,
    );
  return writeLocalFile(path, typeof prev.value === "string" ? prev.value : JSON.stringify(prev.value), opts);
}

export async function writeLocalFile(
  path: string,
  content: string,
  opts?: { overwrite?: "overwrite" | "error" | "rename" },
): Promise<string> {
  let abs = resolveReportFile(REPORTS_DIR, path);
  const mode = opts?.overwrite;
  if (mode === "error" || mode === "rename") {
    let exists = false;
    try {
      await access(abs);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exists) {
      if (mode === "error") {
        throw new Error(`local.writeFile path "${path}" already exists — refusing to overwrite (overwrite:"error")`);
      }
      const ext = extname(abs);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      abs = resolve(dirname(abs), `${basename(abs, ext)}-${stamp}${ext}`);
    }
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return abs;
}
