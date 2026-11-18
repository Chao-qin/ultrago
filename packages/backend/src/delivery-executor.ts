/**
 * delivery-executor.ts — delivery RESOLUTION (backend side).
 *
 * The backend resolves a book's declared deliveries for a specific run — fills
 * {{slot}} params (like step params) and applies framework defaults — and
 * extracts the produced data. Both are surfaced in the internal-runner snapshot
 * for the CONSOLE layer to execute against its SQLite-backed delivery queue.
 *
 * The backend NEVER delivers: sending webhooks/messages, verifying files, and
 * rendering print output all live in the console layer, where SQLite gives them
 * durability + a redelivery queue.
 */
import { LocalMethod, normalizeDelivery, resolveDeliveries } from "@bcp/shared";
import type { Delivery, ParamMap, ResolvedDelivery } from "@bcp/shared";
import { fillSlots } from "./playbook.js";
import type { PlaybackStepResult } from "./playback.js";
import { relative, resolve, sep, isAbsolute } from "node:path";

/** The book's produced data = the LAST local.eval step's value (the "assemble +
 * fail-closed validate" step). undefined if the run had none. */
export function extractOutputs(results: PlaybackStepResult[]): unknown {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].method === LocalMethod.Eval) return results[i].value;
  }
  return undefined;
}

/** Instantiate a book's declared deliveries for THIS run: fill {{slot}} params
 * (like step params) and apply framework defaults (resolveDeliveries). */
export function instantiateDeliveries(
  deliveries: Delivery[] | undefined,
  values: ParamMap,
): ResolvedDelivery[] {
  const canonical = (deliveries ?? []).map(normalizeDelivery);
  return resolveDeliveries(
    canonical.map((d) => {
      if (d.kind === "file") return { ...d, artifact: fillSlots({ artifact: d.artifact }, values).artifact };
      if (d.kind === "webhook") return { ...d, url: fillSlots({ url: d.url }, values).url };
      if (d.kind === "message") {
        return { ...d, template: fillSlots({ template: d.template }, values).template };
      }
      return d;
    }),
  );
}

/** Extract files written by this run so console can enforce artifact ownership. */
export function extractArtifacts(results: PlaybackStepResult[]): Array<{ path: string; kind: "report"; size: number }> {
  const reportsDir = resolve(process.cwd(), "reports");
  const out: Array<{ path: string; kind: "report"; size: number }> = [];
  for (const result of results) {
    if (result.method !== LocalMethod.WriteFile || !result.value || typeof result.value !== "object") continue;
    const p = (result.value as { path?: unknown }).path;
    if (typeof p !== "string") continue;
    const rel = relative(reportsDir, resolve(p));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    out.push({ path: rel.split(sep).join("/"), kind: "report", size: 0 });
  }
  return out;
}
