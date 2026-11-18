/**
 * The two expensive reads: the full page bundle and the screenshot.
 *
 * Split out of browser-mcp.ts. Both need the foreground lease — a screenshot
 * can only photograph a window's ACTIVE tab, so it switches, shoots and
 * restores — which is why they sit together, away from the cheap reads.
 */
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { resolve, dirname, relative, isAbsolute, sep, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_TOOL_INSTRUCTIONS, RpcMethod, type PageState, type RpcContracts, type SnapshotElement, type TabInfo } from "@bcp/shared";
import type { BrowserCall, ReadSnapshot } from "./browser-mcp-types.js";
import { fail, renderDelta, renderPageState, renderReadDump, renderTabsByWindow, text } from "./browser-mcp-render.js";
import { PageReadDumpStore } from "./browser-read-dump.js";
import { looseBool, tabId } from "./browser-mcp-shapes.js";

/** Screenshots are confined to these base dirs so a caller-supplied path can't
 * write a .png to arbitrary host locations (path traversal): the temp dir, plus
 * BCP_SCREENSHOT_DIR when set. The desktop client sets that one at runtime (a
 * folder the user picked), so it is read on every call. */
export function screenshotDirs(): string[] {
  const configured = process.env.BCP_SCREENSHOT_DIR;
  return configured ? [resolve(configured), resolve(tmpdir())] : [resolve(tmpdir())];
}

/** Resolve a caller-supplied screenshot path UNDER one of the screenshot dirs, rejecting
 * `..`/absolute escapes. Relative paths and the auto-named default resolve against the
 * first dir. */
export function resolveShotPath(p: string | undefined): string {
  const roots = screenshotDirs();
  const abs = resolve(roots[0], p ?? `ultrago-${Date.now()}.png`);
  if (!abs.toLowerCase().endsWith(".png")) throw new Error("screenshot path must end in .png");
  const inside = (root: string) => {
    const rel = relative(root, abs);
    return !(rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  };
  if (!roots.some(inside))
    throw new Error(`screenshot path must stay within ${roots.join(" or ")} (desktop client: choose a screenshot folder under 准备与连接; otherwise set BCP_SCREENSHOT_DIR)`);
  return abs;
}

/** Writes a screenshot that resolveShotPath already placed inside an allowed folder, without letting a link
 *  carry it out. The lexical check cannot see links: a directory link or junction inside an allowed folder, or a
 *  symlink / hard link at the file name. So the deepest folder that already exists must really be inside an
 *  allowed folder BEFORE anything is created, the created parent is checked again, and the bytes go to a NEW file
 *  (O_EXCL, never following a link) that is then renamed over the name. Renaming replaces the directory entry
 *  itself, so whatever link stood there is replaced rather than written through — no check-then-open window. */
export async function writeShot(abs: string, data: Buffer): Promise<void> {
  const roots = await Promise.all(screenshotDirs().map((root) => realpath(root).catch(() => root)));
  const confined = (path: string) => roots.some((root) => {
    const rel = relative(root, path);
    return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  });
  const refuse = () => new Error(`screenshot path resolves outside ${roots.join(" or ")} through a link — refusing`);
  let existing = dirname(abs);
  for (;;) {
    try { existing = await realpath(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(existing) === existing) throw error;
      existing = dirname(existing);
    }
  }
  if (!confined(existing)) throw refuse();
  await mkdir(dirname(abs), { recursive: true });
  const parent = await realpath(dirname(abs));
  if (!confined(parent)) throw refuse();
  const temporary = join(parent, `.${basename(abs)}.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    try { await file.writeFile(data); } finally { await file.close(); }
    await rename(temporary, join(parent, basename(abs)));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** What the capture did to the user's screen, when it had to bring a window forward. */
export function activationNote(shot: { activated?: boolean; keptInFront?: boolean }): string {
  if (!shot.activated) return "";
  return shot.keptInFront
    ? "NOTE: Chrome could not read this background window, so it was brought to the front for the capture. No window of this browser had focus before (the user was in another app, browser or profile), and focus cannot be handed back there — this window is now in front of the user."
    : "NOTE: Chrome could not read this background window, so it was brought to the front briefly for the capture and the previously focused window was restored.";
}

export interface CaptureToolDeps {
  server: McpServer;
  call: BrowserCall;
  deltaKey: string;
  drainEvents: (onTab?: number) => string;
  /** Screenshot behind the per-browser foreground lease (switch → shoot → restore). */
  captureWithLease: (tabIdParam: number | undefined) => Promise<RpcContracts[typeof RpcMethod.Screenshot]["result"]>;
  readDumps: PageReadDumpStore;
  readSnapshot: ReadSnapshot;
}

/** Registers analyze_page and screenshot. */
export function registerCaptureTools({ server, call, deltaKey, drainEvents, captureWithLease, readDumps, readSnapshot }: CaptureToolDeps): void {
  server.registerTool(
    "analyze_page",
    {
      description:
        "One-shot comprehensive page analysis = the full bundle: open tabs + page_state STATE digest (readiness/focus/forms/scroll/dialogs/changed) + accessibility snapshot (elements with [ref]s) + a temporary-file manifest for visible text + a PNG screenshot. Read the manifest/chunks with your local file reader; the page body is intentionally not copied into this MCP reply. Use on an unfamiliar or visual page when you want everything at once. For the cheap per-beat pulse use page_state (no screenshot); for just [ref]s use snapshot.",
      inputSchema: {
        tabId,
        saveScreenshot: looseBool.optional().describe("If true, write the screenshot to a file on the backend host instead of returning it inline (default false)"),
        screenshotPath: z.string().optional().describe("Path to save the PNG to when saveScreenshot is true; must end in .png"),
        maxChars: z.coerce.number().int().positive().optional().describe("Maximum characters per temporary dump file; omit for adaptive chunking"),
        offset: z.coerce.number().int().nonnegative().optional().describe("Zero-based character offset; use nextOffset from a previous read to continue"),
      },
    },
    async ({ tabId, saveScreenshot, screenshotPath, maxChars, offset }) => {
      try {
        // Screenshot is the one leg that can legitimately be refused (manual
        // mode won't re-foreground a background tab). Don't let that sink the
        // whole analysis — the snapshot + text are the point; degrade the shot.
        const [{ tabs }, snapshot, content, stateOrErr, shotOrErr] = await Promise.all([
          call(RpcMethod.ListTabs, {}),
          readSnapshot(tabId, {}, "analyze_page"),
          call(RpcMethod.ReadContent, { maxChars, offset, full: true, tabId }),
          // analyze_page composes page_state for its STATE layer (DRY) rather
          // than re-deriving readiness/focus/forms/scroll separately.
          call(RpcMethod.PageState, { tabId, verbosity: "detail", deltaKey }).then(
            (s) => ({ ok: true as const, state: s }),
            (e: unknown) => ({ ok: false as const, msg: e instanceof Error ? e.message : String(e) }),
          ),
          captureWithLease(tabId).then(
            (s) => ({ ok: true as const, shot: s }),
            (e: unknown) => ({ ok: false as const, msg: e instanceof Error ? e.message : String(e) }),
          ),
        ]);

        // Do the legs describe ONE page? They are five separate RPCs issued concurrently, and with no explicit
        // tabId each resolves "the active tab" on its own — so a navigation mid-call, or another session's
        // screenshot lease switching the visible tab, yields a bundle that DESCRIBES TWO PAGES while reading as
        // one. Nothing performed this comparison, and the tool's whole selling point is that it is coherent.
        // Compare origin+path only: a query/hash rewrite is the same document, and reporting it would be noise.
        const pageKey = (u: string): string => {
          try {
            const p = new URL(u);
            return p.origin + p.pathname.replace(/\/+$/, "");
          } catch {
            return u;
          }
        };
        const legs: Array<[string, string]> = [["snapshot", snapshot.url], ["visible text", content.url]];
        if (stateOrErr.ok) legs.push(["state", stateOrErr.state.url]);
        const incoherent =
          new Set(legs.map(([, u]) => pageKey(u))).size > 1
            ? `\n\n⚠ THIS BUNDLE IS NOT ONE PAGE — ${legs.map(([n, u]) => `${n} read ${u}`).join("; ")}. The legs run ` +
              `concurrently, so a navigation (or another session moving the visible tab) split them, and the ` +
              `screenshot may match either. Don't act on any section: call analyze_page again${tabId == null ? " with an explicit tabId — or claim_tab first — so the legs cannot land on different tabs" : ""}.`
            : "";
        const tabLines = renderTabsByWindow(tabs) + incoherent;
        const stateSection = stateOrErr.ok ? `\n\n## State\n${renderPageState(stateOrErr.state)}` : `\n\n## State\n(skipped: ${stateOrErr.msg})`;
        const more = snapshot.moreBelow ? "\n\n↓ more content below the fold — use scroll to load/see it" : "";
        const snapshotText = `# ${snapshot.title}\n${snapshot.url}\n\n${snapshot.text}${more}`;
        const dump = content.text.trim() || content.totalChars > 0
          ? await readDumps.create({
              url: content.url,
              title: content.title,
              text: content.text,
              totalChars: content.totalChars,
              overview: content.overview,
              maxChars,
              requestedOffset: offset,
            })
          : null;
        const visibleText = dump
          ? `# ${content.title}\n${content.url}\n\n${renderReadDump(dump)}`
          : `# ${content.title}\n${content.url}\n\n(no visible text after waiting for the DOM to settle — the page may still be loading slowly, be behind a login/consent wall, or render inside a canvas/iframe. Try wait_for a known element, or inspect the screenshot.)`;

        if (!shotOrErr.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `## Open tabs\n${tabLines}${stateSection}\n\n## Accessibility snapshot\n${snapshotText}\n\n## Visible text content\n${visibleText}\n\n## Screenshot\n(skipped: ${shotOrErr.msg})${drainEvents(tabId)}`,
              },
            ],
          };
        }
        const shot = shotOrErr.shot;
        const base64 = shot.dataUrl.replace(/^data:image\/png;base64,/, "");
        let screenshotContent:
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: "image/png" };

        if (saveScreenshot) {
          let abs: string;
          try {
            abs = resolveShotPath(screenshotPath);
            await writeShot(abs, Buffer.from(base64, "base64"));
          } catch (e) {
            return fail(e);
          }
          screenshotContent = { type: "text" as const, text: `Screenshot saved → ${abs}${shot.warning ? `\nWARNING: ${shot.warning}` : ""}${activationNote(shot) ? `\n${activationNote(shot)}` : ""}` };
        } else {
          screenshotContent = { type: "image" as const, data: base64, mimeType: "image/png" };
        }

        return {
          content: [
            { type: "text" as const, text: `## Open tabs\n${tabLines}${stateSection}\n\n## Accessibility snapshot\n${snapshotText}\n\n## Visible text content\n${visibleText}${shot.warning ? `\n\nWARNING: ${shot.warning}` : ""}${activationNote(shot) && !saveScreenshot ? `\n\n${activationNote(shot)}` : ""}${drainEvents(tabId)}` },
            screenshotContent,
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "screenshot",
    {
      description: MCP_TOOL_INSTRUCTIONS[RpcMethod.Screenshot].description,
      inputSchema: { tabId, savePath: z.string().optional().describe(MCP_TOOL_INSTRUCTIONS[RpcMethod.Screenshot].params["savePath"]) },
    },
    async ({ tabId, savePath }) => {
      try {
        const shot = await captureWithLease(tabId);
        const { dataUrl, warning } = shot;
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        const note = activationNote(shot);
        if (savePath) {
          // Confine writes under SCREENSHOT_DIR (path-traversal / clobber guard).
          let abs: string;
          try {
            abs = resolveShotPath(savePath);
            await writeShot(abs, Buffer.from(base64, "base64"));
          } catch (e) {
            return fail(e);
          }
          return text(`Saved screenshot → ${abs}${warning ? `\nWARNING: ${warning}` : ""}${note ? `\n${note}` : ""}`);
        }
        return {
          content: [
            ...(warning ? [{ type: "text" as const, text: `WARNING: ${warning}` }] : []),
            ...(note ? [{ type: "text" as const, text: note }] : []),
            { type: "image" as const, data: base64, mimeType: "image/png" },
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  );
}
