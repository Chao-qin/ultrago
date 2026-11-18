/**
 * deliveries.ts — delivery-contract SSOT: the Delivery type, its FIXED
 * framework defaults, and the resolver that normalises a book's declared
 * deliveries.
 *
 * Unlike input params (per-book JSON Schema `default`), a Delivery's optional
 * fields have framework-wide defaults that are NOT per-book configurable.
 *
 * resolveDeliveries() is the single place these fallbacks live, so every
 * consumer (console badge, run_finished event assembly, the delivery executor)
 * reads the same effective values instead of each re-inventing the default.
 */

/** Which run outcomes trigger a delivery. Default "success". */
export type RunConclusion = "success" | "failure" | "cancelled" | "any";

export const RUN_CONCLUSION_VALUES = ["success", "failure", "cancelled", "any"] as const;

export type DeliveryRunStatus = "pending" | "running" | "ok" | "skipped" | "error";

export const DELIVERY_RUN_STATUS_VALUES = ["pending", "running", "ok", "skipped", "error"] as const;

/** One post-run delivery: how the book's produced data leaves the system.
 * The `kind`-specific fields may contain `{{slot}}` placeholders, instantiated
 * with this run's params like any step param. */
export type Delivery =
  | { kind: "file";    artifact: string; on?: RunConclusion }
  | { kind: "message"; channel?: "wechat"; template?: string; on?: RunConclusion }
  | { kind: "print";   format?: "text" | "markdown"; on?: RunConclusion }
  | { kind: "webhook"; url: string; method?: "POST" | "PUT"; on?: RunConclusion };

export const DELIVERY_DEFAULTS = {
  on: "success" as RunConclusion,
  print: { format: "markdown" as const },
  webhook: { method: "POST" as const },
  message: {
    channel: "wechat" as const,
    template: "{{bookName}} 运行{{status}}（{{ranSteps}}/{{totalSteps}} 步，{{durationMs}}ms）",
  },
} as const;

/** A Delivery after resolveDeliveries(): every effective field is present. */
export type ResolvedDelivery =
  | { kind: "file";    artifact: string; on: RunConclusion }
  | { kind: "message"; channel: "wechat"; template: string; on: RunConclusion }
  | { kind: "print";   format: "text" | "markdown"; on: RunConclusion }
  | { kind: "webhook"; url: string; method: "POST" | "PUT"; on: RunConclusion };

/** Convert the persisted legacy file.path shape to the canonical artifact key.
 * This is intentionally the only legacy conversion used by executors. */
export function normalizeDelivery(value: unknown): ResolvedDelivery {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid delivery payload");
  }
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (kind !== "file" && kind !== "message" && kind !== "print" && kind !== "webhook") {
    throw new Error(`invalid delivery kind: ${String(kind)}`);
  }
  const on = raw.on as RunConclusion | undefined;
  switch (kind) {
    case "file": {
      const artifact = raw.artifact === undefined ? raw.path : raw.artifact;
      return resolveDeliveries([{ kind, artifact: artifact as string, on }])[0];
    }
    case "message":
      return resolveDeliveries([{ kind, channel: raw.channel as "wechat" | undefined, template: raw.template as string | undefined, on }])[0];
    case "print":
      return resolveDeliveries([{ kind, on, format: raw.format as "text" | "markdown" | undefined }])[0];
    case "webhook":
      return resolveDeliveries([{ kind, url: raw.url as string, method: raw.method as "POST" | "PUT" | undefined, on }])[0];
  }
}

/** Normalize a persisted delivery array in one place. Unknown keys and the
 * legacy file.path/overwrite shape are removed from the returned snapshot. */
export function normalizeDeliveries(value: unknown): ResolvedDelivery[] {
  if (!Array.isArray(value)) throw new Error("deliveries must be an array");
  return value.map(normalizeDelivery);
}

/** Normalise a book's declared deliveries so every effective field carries its
 * value. Pure — does not mutate the input. */
export function resolveDeliveries(deliveries?: Delivery[]): ResolvedDelivery[] {
  const out: ResolvedDelivery[] = [];
  for (const d of deliveries ?? []) {
    validateDeclaredDelivery(d);
    const on: RunConclusion = d.on ?? DELIVERY_DEFAULTS.on;
    if (d.kind === "file") {
      out.push({ ...d, on });
    } else if (d.kind === "message") {
      out.push({
        ...d,
        channel: d.channel ?? DELIVERY_DEFAULTS.message.channel,
        template: d.template ?? DELIVERY_DEFAULTS.message.template,
        on,
      });
    } else if (d.kind === "print") {
      out.push({ ...d, on, format: d.format ?? DELIVERY_DEFAULTS.print.format });
    } else if (d.kind === "webhook") {
      out.push({ ...d, on, method: d.method ?? DELIVERY_DEFAULTS.webhook.method });
    }
  }
  return out;
}

function validateDeclaredDelivery(d: Delivery): void {
  if (!d || typeof d !== "object") throw new Error("invalid delivery payload");
  if (d.on !== undefined && !(RUN_CONCLUSION_VALUES as readonly string[]).includes(d.on)) throw new Error("delivery on is invalid");
  if (d.kind === "file" && (typeof d.artifact !== "string" || !d.artifact.trim())) throw new Error("file delivery requires artifact");
  if (d.kind === "webhook" && (typeof d.url !== "string" || !d.url.trim())) throw new Error("webhook delivery requires url");
  if (d.kind === "print" && d.format !== undefined && d.format !== "text" && d.format !== "markdown") throw new Error("print delivery format is invalid");
  if (d.kind === "message" && d.channel !== undefined && d.channel !== "wechat") throw new Error("message delivery channel is invalid");
  if (d.kind === "message" && d.template !== undefined && typeof d.template !== "string") throw new Error("message delivery template is invalid");
  if (d.kind === "webhook" && d.method !== undefined && d.method !== "POST" && d.method !== "PUT") throw new Error("webhook delivery method is invalid");
}
