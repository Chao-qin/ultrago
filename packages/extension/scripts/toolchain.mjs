/**
 * The toolchain the DOM-runtime scripts share: an esbuild and a playwright-core
 * that are already on the machine (neither is a dependency of this repo), and
 * the real `bcpDomRuntime` bundled from source. A caller that gets null from a
 * loader must exit 2 — a missing harness must never read as "passed".
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_TS = pathResolve(HERE, "../src/content/dom-runtime.ts");
const require_ = createRequire(import.meta.url);

const firstExisting = (paths) => paths.find((p) => existsSync(p));

export async function loadEsbuild() {
  try {
    return await import("esbuild");
  } catch {
    /* not a direct dependency — fall through to a scan */
  }
  const { globSync } = await import("node:fs");
  const roots = [
    pathResolve(HERE, "../../../node_modules/.pnpm"),
    "/usr/local/lib/node_modules",
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let hits = [];
    try {
      hits = globSync("esbuild@*/node_modules/esbuild/lib/main.js", { cwd: root }).map((h) => pathResolve(root, h));
    } catch {
      /* older node without globSync */
    }
    const hit = firstExisting(hits);
    if (hit) return require_(hit);
  }
  return null;
}

export async function loadPlaywright() {
  try {
    return await import("playwright-core");
  } catch {
    /* not a direct dependency — fall through to known machine locations */
  }
  const candidates = [
    pathResolve(HERE, "../../../node_modules/playwright-core/index.mjs"),
    "/root/.bun/install/cache/playwright-core@1.58.2@@@1/index.mjs",
    "/usr/local/lib/python3.11/dist-packages/playwright/driver/package/index.mjs",
  ];
  const hit = firstExisting(candidates);
  return hit ? await import(hit) : null;
}

/** The runtime module's exports, bundled from source exactly as the extension ships them. */
export async function bundleRuntime(esbuild) {
  return bundle(esbuild, RUNTIME_TS);
}

/** The dispatcher's frame merge (src/snapshot-merge.ts), bundled from source. */
export async function bundleFrameMerge(esbuild) {
  return bundle(esbuild, pathResolve(HERE, "../src/snapshot-merge.ts"));
}

async function bundle(esbuild, entry) {
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true, format: "esm", target: "es2022", write: false, logLevel: "silent",
  });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}
