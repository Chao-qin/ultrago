/**
 * Deterministic profile resolution tests — injected probe values, no real host.
 *
 * Guarded by a mutation rule (spec §14.1): changing the arm64 predicate or the
 * 16 GiB threshold must turn one of these assertions red.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  loadEffectiveRuntime,
  resolveProfile,
  runtimeConfigFromEnv,
  type RuntimeConfig,
  type RuntimeProbe,
} from "./runtime-profile.js";

const cfg: RuntimeConfig = {
  baseUrl: "http://127.0.0.1:11435",
  modelKey: "lmstudio-community/Qwen3.5-9B-GGUF",
  modelId: "bcp-qwen35-9b",
  modelFormat: "gguf",
  contextLength: 32768,
  legacyModel: "qwen3.5:4b",
};

function probe(over: Partial<RuntimeProbe>): RuntimeProbe {
  return {
    os: "darwin",
    arch: "arm64",
    cpuBrand: "Apple M4",
    totalMemoryBytes: 16 * 1024 ** 3,
    providerOverride: "auto",
    ...over,
  };
}

test("Darwin + arm64 + Apple M4 + 16 GiB → LM Studio 9B GGUF", () => {
  const r = resolveProfile(probe({}), cfg);
  assert.equal(r.profile, "mac-apple-silicon-16gb");
  assert.equal(r.provider, "lmstudio");
  assert.equal(r.apiStyle, "ollama");
  assert.equal(r.model, "bcp-qwen35-9b");
  assert.equal(r.modelKey, "lmstudio-community/Qwen3.5-9B-GGUF");
  assert.equal(r.contextLength, 32768);
  assert.equal(cfg.modelFormat, "gguf");
});

test("Darwin + arm64 + 8 GiB → Ollama + 4B (insufficient memory)", () => {
  const r = resolveProfile(probe({ totalMemoryBytes: 8 * 1024 ** 3 }), cfg);
  assert.equal(r.profile, "legacy-local");
  assert.equal(r.provider, "ollama");
  assert.equal(r.apiStyle, "ollama");
  assert.equal(r.model, "qwen3.5:4b");
});

test("Linux + x86_64 + 64 GiB → Ollama + 4B (non-Mac)", () => {
  const r = resolveProfile(
    probe({ os: "linux", arch: "x64", cpuBrand: "Intel(R) Xeon", totalMemoryBytes: 64 * 1024 ** 3 }),
    cfg,
  );
  assert.equal(r.profile, "legacy-local");
  assert.equal(r.provider, "ollama");
});

test("unknown hardware (probe error) → Ollama + 4B, never a high-end Mac", () => {
  const r = resolveProfile(
    probe({ cpuBrand: undefined, totalMemoryBytes: undefined }),
    cfg,
  );
  assert.equal(r.profile, "legacy-local");
  assert.equal(r.provider, "ollama");
});

test("Darwin + arm64 + Apple CPU but NO memory value → Ollama + 4B", () => {
  const r = resolveProfile(probe({ totalMemoryBytes: undefined }), cfg);
  assert.equal(r.profile, "legacy-local");
  assert.equal(r.provider, "ollama");
});

test("Darwin + Intel (non-Apple CPU) → Ollama + 4B", () => {
  const r = resolveProfile(
    probe({ cpuBrand: "Intel(R) Core(TM) i7", totalMemoryBytes: 32 * 1024 ** 3 }),
    cfg,
  );
  assert.equal(r.profile, "legacy-local");
  assert.equal(r.provider, "ollama");
});

test("explicit BCP_LLM_PROVIDER=ollama → Ollama even on a Mac", () => {
  const r = resolveProfile(probe({ providerOverride: "ollama" }), cfg);
  assert.equal(r.provider, "ollama");
  assert.equal(r.model, "qwen3.5:4b");
});

test("explicit BCP_LLM_PROVIDER=lmstudio → LM Studio, never silently Ollama", () => {
  // Even on a non-Mac, an explicit lmstudio override must stay lmstudio.
  const r = resolveProfile(
    probe({ providerOverride: "lmstudio", os: "linux", arch: "x64", cpuBrand: "Intel" }),
    cfg,
  );
  assert.equal(r.provider, "lmstudio");
  assert.equal(r.apiStyle, "ollama");
});

test("runtimeConfigFromEnv honours BCP_LLM_LMSTUDIO_* overrides", () => {
  const c = runtimeConfigFromEnv({
    BCP_LLM_PORT: "11436",
    BCP_LLM_LMSTUDIO_MODEL_KEY: "mlx-community/Other-1B-MLX",
    BCP_LLM_LMSTUDIO_MODEL_ID: "my-id",
    BCP_LLM_LMSTUDIO_MODEL_FORMAT: "mlx",
    BCP_LLM_LMSTUDIO_CONTEXT_LENGTH: "8192",
    BCP_LLM_MODEL: "legacy:latest",
  });
  assert.equal(c.baseUrl, "http://127.0.0.1:11436");
  assert.equal(c.modelKey, "mlx-community/Other-1B-MLX");
  assert.equal(c.modelId, "my-id");
  assert.equal(c.modelFormat, "mlx");
  assert.equal(c.contextLength, 8192);
  assert.equal(c.legacyModel, "legacy:latest");
});

test("loadEffectiveRuntime prefers a valid snapshot file", () => {
  const dir = mkdtempSync(join(tmpdir(), "bcp-llm-runtime-"));
  const snapshot = join(dir, ".llm-runtime.json");
  writeFileSync(
    snapshot,
    JSON.stringify({
      schemaVersion: 1,
      profile: "mac-apple-silicon-16gb",
      provider: "lmstudio",
      baseUrl: "http://127.0.0.1:11435",
      apiStyle: "ollama",
      model: "bcp-qwen35-9b",
      modelKey: "lmstudio-community/Qwen3.5-9B-GGUF",
      contextLength: 32768,
      format: "gguf",
      vision: true,
    }),
  );
  try {
    const r = loadEffectiveRuntime({ snapshotPath: snapshot });
    assert.equal(r.provider, "lmstudio");
    assert.equal(r.model, "bcp-qwen35-9b");
    assert.equal(r.apiStyle, "ollama");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEffectiveRuntime falls back to env resolution when snapshot is missing", () => {
  const r = loadEffectiveRuntime({
    snapshotPath: join(tmpdir(), "does-not-exist-.llm-runtime.json"),
    env: { BCP_LLM_PROVIDER: "ollama" },
  });
  assert.equal(r.provider, "ollama");
  assert.equal(r.model, "qwen3.5:4b");
});

test("loadEffectiveRuntime with no snapshot and no provider var → legacy defaults, never a phantom LM Studio", () => {
  const r = loadEffectiveRuntime({
    snapshotPath: join(tmpdir(), "does-not-exist-.llm-runtime.json"),
    env: {},
  });
  assert.equal(r.provider, "ollama");
  assert.equal(r.model, "qwen3.5:4b");
  assert.equal(r.profile, "legacy-local");
});

test("loadEffectiveRuntime ignores a corrupt snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "bcp-llm-runtime-"));
  const snapshot = join(dir, ".llm-runtime.json");
  writeFileSync(snapshot, "{ not json !!");
  try {
    const r = loadEffectiveRuntime({
      snapshotPath: snapshot,
      env: { BCP_LLM_PROVIDER: "ollama" },
    });
    assert.equal(r.provider, "ollama");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
