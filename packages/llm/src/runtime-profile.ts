/**
 * Runtime profile resolution for the local LLM.
 *
 * Decides which local inference backend a machine should use:
 *   - `mac-apple-silicon-16gb`  → LM Studio + Qwen3.5-9B GGUF 4-bit
 *   - `legacy-local`            → managed Ollama + qwen3.5:4b
 *
 * Selection is conservative on purpose: any unknown / insufficient hardware
 * value lands on `legacy-local`, never on the high-end Mac profile. The
 * current Mac matches the first profile, so `BCP_LLM_PROVIDER=auto` will pick
 * LM Studio there — but preflight (managed by the shell lifecycle scripts) must
 * pass before any request is sent. See the spec:
 * docs/superpowers/specs/2026-09-04-adaptive-llm-provider-mac-lmstudio-design.md
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

export type LlmProvider = "ollama" | "lmstudio";
export type LlmProfile = "mac-apple-silicon-16gb" | "legacy-local";

export type RuntimeProbe = {
  os: string;
  arch: string;
  cpuBrand?: string;
  totalMemoryBytes?: number;
  providerOverride?: string;
};

export type EffectiveRuntime = {
  profile: LlmProfile;
  provider: LlmProvider;
  baseUrl: string;
  /** API exposed to project callers, not the runtime's internal upstream API. */
  apiStyle: "ollama" | "openai-compatible";
  model: string;
  modelKey?: string;
  contextLength: number;
};

/** Extra fields recorded by the lifecycle dispatcher after a successful start. */
export type RuntimeSnapshot = EffectiveRuntime & {
  schemaVersion: number;
  format?: string;
  vision?: boolean;
  serverStartedByProject?: boolean;
  resolvedAt: string;
};

/** Profile configuration pulled from environment / .env. */
export type RuntimeConfig = {
  baseUrl: string;
  modelKey: string;
  modelId: string;
  modelFormat: "gguf" | "mlx";
  contextLength: number;
  legacyModel: string;
};

/** The current Mac must land on LM Studio: Darwin + arm64 + Apple CPU + >= 16 GiB. */
export const MAC_MIN_MEMORY_BYTES = 16 * 1024 ** 3;

/** Defaults mirror the .env values; process env overrides them. */
export function runtimeConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const port = env.BCP_LLM_PORT ?? "11435";
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    modelKey: env.BCP_LLM_LMSTUDIO_MODEL_KEY ?? "lmstudio-community/Qwen3.5-9B-GGUF",
    modelId: env.BCP_LLM_LMSTUDIO_MODEL_ID ?? "qwen3.5-9b",
    modelFormat: env.BCP_LLM_LMSTUDIO_MODEL_FORMAT === "mlx" ? "mlx" : "gguf",
    contextLength: Number(env.BCP_LLM_LMSTUDIO_CONTEXT_LENGTH ?? "32768"),
    legacyModel: env.BCP_LLM_MODEL ?? "qwen3.5:4b",
  };
}

/**
 * Pure profile resolution — injected probe values make it deterministic and
 * unit-testable. `providerOverride` is `BCP_LLM_PROVIDER` ("auto" | "ollama" |
 * "lmstudio"); anything else is treated as auto.
 */
export function resolveProfile(
  probe: RuntimeProbe,
  cfg: RuntimeConfig,
): EffectiveRuntime {
  const override = (probe.providerOverride ?? "auto").trim().toLowerCase();
  const macHardware =
    probe.os === "darwin" &&
    probe.arch === "arm64" &&
    /Apple/i.test(probe.cpuBrand ?? "") &&
    (probe.totalMemoryBytes ?? 0) >= MAC_MIN_MEMORY_BYTES;
  const profile: LlmProfile = macHardware ? "mac-apple-silicon-16gb" : "legacy-local";

  let provider: LlmProvider;
  if (override === "lmstudio") {
    provider = "lmstudio";
  } else if (override === "ollama") {
    provider = "ollama";
  } else {
    provider = macHardware ? "lmstudio" : "ollama";
  }

  if (provider === "lmstudio") {
    return {
      profile,
      provider,
      baseUrl: cfg.baseUrl,
      // LM Studio stays behind the package-owned Ollama compatibility proxy.
      // All project callers retain their established /api/chat contract.
      apiStyle: "ollama",
      model: cfg.modelId,
      modelKey: cfg.modelKey,
      contextLength: cfg.contextLength,
    };
  }
  return {
    profile,
    provider,
    baseUrl: cfg.baseUrl,
    apiStyle: "ollama",
    model: cfg.legacyModel,
    contextLength: 0,
  };
}

/** Structured hardware probe — unknown values stay absent, never guessed. */
export function probeHardware(
  env: Record<string, string | undefined> = process.env,
): RuntimeProbe {
  return {
    os: os.platform(),
    arch: os.arch(),
    cpuBrand: os.cpus()[0]?.model,
    totalMemoryBytes: os.totalmem(),
    providerOverride: env.BCP_LLM_PROVIDER?.trim().toLowerCase() || "auto",
  };
}

const SNAPSHOT_URL = new URL("../scripts/.llm-runtime.json", import.meta.url);

function isProvider(v: unknown): v is LlmProvider {
  return v === "ollama" || v === "lmstudio";
}

/**
 * The effective runtime, in priority order:
 *   1. `.llm-runtime.json` — written by the lifecycle dispatcher on successful
 *      start; this is "what is actually running", so TypeScript, Python and the
 *      diagnostics agree on one provider.
 *   2. env + profile resolution — used when no snapshot exists yet.
 */
export function loadEffectiveRuntime(opts: {
  snapshotPath?: string;
  env?: Record<string, string | undefined>;
} = {}): EffectiveRuntime {
  const cfg = runtimeConfigFromEnv(opts.env);
  const snapshotPath = opts.snapshotPath ?? fileURLToPath(SNAPSHOT_URL);
  try {
    if (existsSync(snapshotPath)) {
      const raw = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (isProvider(raw.provider)) {
        return {
          profile: raw.profile === "mac-apple-silicon-16gb" ? raw.profile : "legacy-local",
          provider: raw.provider,
          baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : cfg.baseUrl,
          apiStyle:
            raw.apiStyle === "openai-compatible" || raw.apiStyle === "ollama"
              ? raw.apiStyle
              : "ollama",
          model:
            typeof raw.model === "string" && raw.model
              ? raw.model
              : raw.provider === "lmstudio"
                ? cfg.modelId
                : cfg.legacyModel,
          modelKey: typeof raw.modelKey === "string" ? raw.modelKey : undefined,
          contextLength:
            typeof raw.contextLength === "number" && raw.contextLength > 0
              ? raw.contextLength
              : cfg.contextLength,
        };
      }
    }
  } catch {
    // Corrupt/unreadable snapshot — fall through to env resolution.
  }
  // No snapshot → env + legacy defaults. An explicit BCP_LLM_PROVIDER (set in
  // process env or exported from .env by scripts/backend.sh) is honored. With
  // no provider configured anywhere we never guess a high-end profile: that
  // would silently point a running Ollama stack at a phantom LM Studio target.
  const env = opts.env ?? process.env;
  const override = (env.BCP_LLM_PROVIDER ?? "").trim().toLowerCase();
  if (override === "") {
    return {
      profile: "legacy-local",
      provider: "ollama",
      baseUrl: cfg.baseUrl,
      apiStyle: "ollama",
      model: cfg.legacyModel,
      contextLength: 0,
    };
  }
  return resolveProfile(probeHardware(env), cfg);
}
