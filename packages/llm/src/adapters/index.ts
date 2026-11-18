/**
 * Adapter registry.
 *
 * Bundled adapters are registered here; developer-written ones are picked up
 * from the sibling `custom/` directory, one module per adapter, default-
 * exporting an Adapter. Dropping a file in is the whole ritual — no core file
 * to edit, and no privilege the bundled three have that a custom one does not.
 */
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { lmStudioAdapter, openAiAdapter } from "./openai.js";
import { ollamaAdapter } from "./ollama.js";
import { openCodeAdapter } from "./opencode.js";
import type { Adapter } from "./types.js";

const BUILT_IN: Adapter[] = [openAiAdapter, lmStudioAdapter, ollamaAdapter, openCodeAdapter];

const CUSTOM_DIR = new URL("./custom/", import.meta.url);

function isAdapter(value: unknown): value is Adapter {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  if (typeof c.name !== "string") return false;
  // Either shape is valid; which one it is decides what must be present.
  if (c.kind === "direct") return typeof c.invoke === "function";
  return (
    typeof c.buildRequest === "function" &&
    typeof c.parseResponse === "function" &&
    typeof c.parseStreamFrame === "function"
  );
}

/**
 * Load `custom/*.js`.
 *
 * A module that is present but unusable throws instead of being skipped: an
 * adapter silently absent shows up later as "unknown adapter" on a channel that
 * looks correctly configured, which is a miserable thing to debug.
 */
async function loadCustom(dir: string): Promise<Adapter[]> {
  if (!existsSync(dir)) return [];
  const found: Adapter[] = [];
  for (const file of readdirSync(dir).sort()) {
    // .ts is accepted so custom adapters also load under tsx (dev + tests);
    // production runs the compiled .js out of dist/.
    const loadable = file.endsWith(".js") || (file.endsWith(".ts") && !file.endsWith(".d.ts"));
    if (!loadable || file.includes(".test.")) continue;
    const specifier = new URL(file, CUSTOM_DIR).href;
    const module = (await import(specifier)) as { default?: unknown };
    if (!isAdapter(module.default)) {
      throw new Error(`custom/${file} must default-export an Adapter (name + the three methods)`);
    }
    found.push(module.default);
  }
  return found;
}

export type Registry = Map<string, Adapter>;

export async function loadRegistry(customDir?: string): Promise<Registry> {
  const registry: Registry = new Map();
  for (const adapter of BUILT_IN) registry.set(adapter.name, adapter);
  for (const adapter of await loadCustom(customDir ?? fileURLToPath(CUSTOM_DIR))) {
    // Custom wins: overriding a bundled adapter is a legitimate reason to write
    // one, and a name clash that resolved the other way would look like the
    // file had been ignored.
    registry.set(adapter.name, adapter);
  }
  return registry;
}

export { openAiAdapter, lmStudioAdapter, ollamaAdapter, openCodeAdapter };
export type { Adapter };
