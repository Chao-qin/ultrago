/**
 * Agent-facing text of every MCP tool that maps 1:1 to an RpcMethod: its
 * registered tool name, description and per-parameter docs.
 *
 * This file is the single source of that text. The backend registers these
 * tools through `registerRpcTool` (packages/backend/src/browser-mcp-tool-spec.ts),
 * which takes the NAME and DESCRIPTION from here and attaches every `params`
 * entry to the matching schema field. It refuses to start when a schema field
 * has no doc or a doc names a field the schema does not have, so the text an
 * agent reads cannot drift from the arguments the tool accepts.
 *
 * Keyed by RpcMethod and typed `Record<RpcMethod, …>`, so a new RpcMethod
 * forces a decision here. Methods that deliberately have NO MCP tool (internal
 * to the plan runner or superseded by another tool) map to `null`, with the
 * reason next to them.
 *
 * Numbers an agent relies on (eval cap, wait defaults, buffer sizes) are read
 * from `limits.ts`, never typed into the prose.
 *
 * Tools with no 1:1 RpcMethod (composites, plan runner, lifecycle, events)
 * keep their text next to their registration in packages/backend.
 *
 * Writing rules for this text: the first sentence says what the tool does and
 * when to pick it over its neighbours; what follows is only what changes how
 * a caller uses it (defaults, limits, refusals, traps). Rules shared by many
 * tools (targeting, manual mode, the risk gate) live once in the server
 * instructions, not in every description.
 */
import { LocalMethod, RpcMethod } from "./methods.js";
import { EVAL_TIMEOUT_MS, NETWORK_LOG_PER_TAB, READ_DUMP_TTL_MS, WAIT_FOR_DEFAULT_MS, WAIT_FOR_MAX_MS } from "./limits.js";

/**
 * MCP tool annotations, declared for every tool next to its text so a client
 * can tell reads from actions without parsing prose. All four are always set:
 * - readOnlyHint: changes nothing the user can see or keep — pages, browser
 *   state, files, recordings. This session's own bookkeeping (which events it
 *   has been shown) is not part of that.
 * - destructiveHint: may replace or discard something (an input value, the
 *   current page, a file, a recording) rather than only add.
 * - idempotentHint: repeating the call with the same arguments changes nothing more.
 * - openWorldHint: may make the browser or backend contact external sites.
 */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** The common shapes; tools that fit none spell their own out. */
export const TOOL_HINTS = {
  /** Reads the page, the browser or this session's state. */
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  /** Acts on a page through its own handlers, which may submit, delete or navigate. */
  pageAction: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  /** Sets this session's or the browser's routing state; nothing is lost. */
  sessionSetting: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
} as const satisfies Record<string, ToolHints>;

export interface McpToolInstruction {
  /** The registered MCP tool name. */
  name: string;
  description: string;
  params: Record<string, string>;
  annotations: ToolHints;
}

const seconds = (ms: number): string => `${ms / 1000}s`;

/** How an omitted `tabId` resolves — the same rule for every tab-scoped tool. */
export const TAB_ID_DOC =
  "Tab id (from list_windows / new_tab / new_window). Omit to use this session's claimed tab, else the active tab of the last-focused window.";

/** Element locator docs, shared by every tool that targets an element. One
 *  definition so "same targeting as click" is true by construction. */
export const LOCATOR_DOCS = {
  ref: "[ref] from snapshot. Takes precedence over x,y and the description fields",
  text: "Visible text; matches the innermost element containing it",
  role: 'ARIA role, explicit or implied by the tag (a <button> is "button")',
  name: "Accessible name: aria-label, <label>, the text a link/button/tab/option shows, placeholder, alt or title",
  css: "CSS selector",
  near: "Keep candidates within ~200px of the element whose text matches this, closest first — picks a control in one row or card of a repeated list",
  exact: "Match text, name and near as whole strings (still case-insensitive) instead of substrings",
  nth: "0-based index among the matches, when a description matches several elements",
  x: "Viewport X in CSS px (e.g. read off a screenshot), for targets no ref or description can name. Use with y; resolves to the interactive element painted there",
  y: "Viewport Y in CSS px; use with x",
} as const;

/** One sentence every element-targeting description repeats. */
const LOCATOR_RULES =
  "Target by ref, by description (text / role / name / css, narrowed by near / exact / nth) or by x,y; a description is resolved when the action runs, in the top frame, and must match exactly one visible element.";

const CONFIRM_DOC =
  "Required when the target's label contains a risky word: 提交 删除 移除 清空 购买 下单 支付 付款 结算 发送 注销 退订 / confirm, delete, remove, submit, pay, buy, purchase, checkout, place order, send, sign out, log out, unsubscribe (case-insensitive; pay, buy and send as whole words). Set it only when the user asked for that action";

/** Field locators for tools whose `text` is the value, not a locator. */
const FIELD_EXACT_DOC = "Match name and near as whole strings (still case-insensitive) instead of substrings";

export const MCP_TOOL_INSTRUCTIONS = {
  [RpcMethod.Navigate]: {
    name: "navigate",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description:
      "Load a URL in an existing tab (new_tab opens a new one). The reply flags a redirect to a different host or path. javascript:, data:, file:, blob: and vbscript: URLs are refused, as are hosts excluded by the backend's domain allow/block lists.",
    params: {
      url: "Absolute URL including the scheme",
    },
  },
  [RpcMethod.NewTab]: {
    name: "new_tab",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Open a new tab, optionally at a URL (same URL rules as navigate), and return its tab id. It opens in the background by default (always, in manual mode); claim:true also makes it this session's default tab (see claim_tab).",
    params: {
      url: "URL to open; omit for a blank tab",
      active: "Whether the new tab should become active; defaults to false.",
      claim: "Also claim the tab as this session's default tab",
    },
  },
  [RpcMethod.CloseTab]: {
    name: "close_tab",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description:
      "Close a tab — with no tabId, this session's claimed tab, else the active tab of the last-focused window. The reply names the tab it closed.",
    params: {},
  },
  [RpcMethod.NewWindow]: {
    name: "new_window",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Open a new browser window and return its windowId and tabId — a separate workspace you drive by passing that tabId. It opens unfocused, but some platforms still raise it; restoreFocus:true puts the window the user was using back in front. A minimized window stops rendering, so prefer restoreFocus over minimized for a window you will drive.",
    params: {
      url: "URL to open (same rules as navigate); omit for a blank window",
      focused: "Bring the new window to the front with OS focus. Default false; ignored in manual mode",
      minimized: "Minimize the window after it opens. It then stops rendering: animations stall and screenshots need it brought back",
      left: "Left edge in screen px. Chrome keeps at least about half of a window on screen, so coordinates cannot hide it — use restoreFocus to keep it out of the way",
      top: "Top edge in screen px",
      width: "Width in px",
      height: "Height in px",
      restoreFocus: "Right after opening, re-focus the window that had focus before, so the new one keeps rendering behind it",
    },
  },
  [RpcMethod.CloseWindow]: {
    name: "close_window",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: "Close a window by id; with no windowId, the last-focused window (refused in manual mode — pass the id of a window you opened).",
    params: {
      windowId: "Window id from list_windows / new_window; omit for the last-focused window",
    },
  },
  // No MCP tool: the plan runner and playbooks use it to minimize a task window mid-run.
  [RpcMethod.SetWindowState]: null,
  // No MCP tool: list_windows returns the same tabs grouped by window, plus focus and window state.
  [RpcMethod.ListTabs]: null,
  [RpcMethod.ListWindows]: {
    name: "list_windows",
    annotations: TOOL_HINTS.read,
    description:
      "List the target browser's windows and their tabs (id, title, url): each window's visible tab is marked *, along with which window has OS focus (what the user is looking at) and each window's state. For every connected browser, modes and claims, use browser_state.",
    params: {},
  },
  [RpcMethod.Screenshot]: {
    name: "screenshot",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Capture a tab's visible viewport as a PNG. Use it when the DOM cannot answer: icon-only controls, canvas or charts, layout and overlap questions, or an action that seemed to do nothing. Snapshot boxes (x,y w×h) are in the same viewport coordinates, and click({x, y}) acts on a point. " +
      "A background tab is briefly made the visible tab of its window, captured and switched back, without focusing the window (refused in manual mode). If Chrome is not rendering the window (minimized or covered), it is brought forward for one retry; the reply says whether the previous window could be put back in front.",
    params: {
      savePath:
        "Save the PNG on the backend host and return only its path, keeping the image out of the conversation. Must end in .png. A relative path goes under the screenshot folder (BCP_SCREENSHOT_DIR or the folder chosen in the desktop client, else the system temp folder); an absolute path must stay inside one of those",
    },
  },
  [RpcMethod.Snapshot]: {
    name: "snapshot",
    annotations: TOOL_HINTS.read,
    description:
      "List the page's interactable elements with [ref] handles, each with its state ([disabled], [checked], [expanded], [invalid: …] …), viewport box (x,y w×h) and visual layer (@dialog:…, @fixed-…). Covers iframes (frame-prefixed refs; elements in cross-origin frames have no box) and open shadow roots. Hidden elements are named by [ref] instead of listed. A ref stays valid while its element exists, and the reply names the refs new to you or changed. Large pages are paged: narrow with query or viewportOnly, or continue with after. " +
      "It has no page text (read_content), pixels (screenshot) or readiness and form state (page_state); analyze_page returns all of them.",
    params: {
      query: "Only elements whose role, name, value or options contain this text (case and spacing ignored; several words match in any order; exact names first), e.g. \"登录\" or \"textbox\"",
      viewportOnly: "Only elements inside the visible viewport",
      limit: "Maximum number of elements in this reply, after query/viewportOnly",
      after: "Continue a paged reply after this [ref] (the reply names it)",
      within: "List this [ref] and what it holds or opens, hidden ones included",
      full: "List every element, hidden ones included",
    },
  },
  [RpcMethod.Click]: {
    name: "click",
    annotations: TOOL_HINTS.pageAction,
    description: `Click an element with a full pointer sequence. ${LOCATOR_RULES} A label with a risky word (submit, delete, pay, send, …) needs confirm:true.`,
    params: {
      ...LOCATOR_DOCS,
      humanize: "Add a human-like cursor approach and press delay (about 0.1–0.25s). Default false; only worth it when someone is watching",
      confirm: CONFIRM_DOC,
    },
  },
  [RpcMethod.Type]: {
    name: "type_text",
    annotations: TOOL_HINTS.pageAction,
    description:
      "Replace a field's value with `text` (input, textarea or contenteditable); to insert without clearing, use paste_text. " +
      "Target the field by ref or by description — describe it with `name` (its label, placeholder or aria-label), since `text` is the value; a <label> resolves to its control. " +
      "Date/time, color, range and number inputs are set whole and read back, and a value the field rejects is reported. submit:true then presses Enter and submits the enclosing form.",
    params: {
      ref: LOCATOR_DOCS.ref,
      text: "The value to type — not a locator. Replaces the current content",
      name: "The field's accessible name: <label>, placeholder, aria-label, alt or title",
      role: 'ARIA role, e.g. "textbox" or "combobox"',
      css: LOCATOR_DOCS.css,
      near: LOCATOR_DOCS.near,
      exact: FIELD_EXACT_DOC,
      nth: LOCATOR_DOCS.nth,
      submit: "After typing, press Enter and submit the enclosing form unless the page cancels the Enter; with no form only Enter is sent. The reply says whether it submitted",
      humanize: "Type with a human-like cadence (about 35–200ms per character). Default false",
      confirm: "Required with submit:true when the form's submit button has a risky label (word list under click). On refusal the text is already typed",
    },
  },
  [RpcMethod.ReadContent]: {
    name: "read_content",
    annotations: TOOL_HINTS.read,
    description:
      "Read the page's rendered text, top frame only — text inside iframes is missing here, so use snapshot or screenshot for it. " +
      "The text goes to temporary chunk files on the backend host; the reply gives a manifest path, chunk ranges and an outline. Read only the chunks you need, with your own file reader if it reaches the backend host, else with read_content_dump. " +
      `The dump is deleted before your next browser tool call (and after ${seconds(READ_DUMP_TTL_MS)}), so read it first and never run another browser tool in parallel.`,
    params: {
      maxChars: "Maximum characters per chunk file; omit to adapt (one file up to 16,000 characters, larger pages in 12,000–16,000-character chunks)",
    },
  },
  [RpcMethod.WaitFor]: {
    name: "wait_for",
    annotations: TOOL_HINTS.read,
    description:
      "Wait until `text` appears (top frame and its open shadow roots; case and spacing ignored; the text as one piece, not scattered words), until a CSS `selector`'s element is visible or hidden, or — with neither — for a fixed `ms`. Give text or selector, not both. " +
      `When waiting on a condition, \`ms\` is the timeout (default ${WAIT_FOR_DEFAULT_MS}ms, max ${WAIT_FOR_MAX_MS}ms) and the reply says whether it was met. ` +
      "For page loads and browser events use wait_for_event; for any other condition, bcpWait.until inside eval.",
    params: {
      text: "Text to wait for in the top frame's visible text (substring; case and spacing ignored)",
      selector: "CSS selector to wait on; pierces open shadow roots",
      state: 'With selector: "visible" (default) or "hidden"',
      ms: `Timeout for text/selector (default ${WAIT_FOR_DEFAULT_MS}, max ${WAIT_FOR_MAX_MS}); the delay itself when neither is given`,
    },
  },
  // No MCP tool: book signal gates use it inside the plan runner. Agents wait with wait_for, wait_for_event, or bcpWait inside eval.
  [RpcMethod.WaitSignal]: null,
  [RpcMethod.Eval]: {
    name: "eval",
    annotations: TOOL_HINTS.pageAction,
    description:
      "Run JavaScript in the page's own context and return its JSON-serializable result — for what no other tool covers. A single expression is returned as is; multi-statement code needs `return`; top-level declarations don't leak onto window. A strict page CSP can block it. " +
      `Runs stop at ${seconds(EVAL_TIMEOUT_MS)} and oversized results are truncated. Injected helpers: ` +
      "`bcpDeadline` (epoch ms, set safely before that cap) bounds your own loops. " +
      "`bcpWait` waits and reports instead of throwing, never past bcpDeadline: until(fn, maxMs) → the first truthy value or null; netIdle(quietMs, maxMs) and domQuiet(quietMs, maxMs) → true once quiet; grew(countFn) → the count once it stops growing; sleep(ms). " +
      "`bcpDom`: visible(el); innermost(root, text, {exact, selector}) → an array (more than one entry means the text is ambiguous); hover(el) and press(el) → false when something covers el; await click(el, {timeoutMs}) → {ok, attempts, reason}, retrying until el is visible, enabled and uncovered. " +
      "Refused when the backend runs with BCP_EVAL=off.",
    params: {
      code: "JavaScript to run in the page",
      frameId: 'Run in this frame instead of the top frame: the number before "_" in a frame-prefixed ref (42 for "42_e3")',
    },
  },
  [RpcMethod.Download]: {
    name: "download",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Download a URL to the browser's Downloads folder (exports, file links). The reply says whether it completed, failed or is still running, with the saved filename — Chrome renames on a name conflict. Same URL rules as navigate.",
    params: {
      url: "Absolute URL of the file",
      filename: "File name or relative path inside the Downloads folder; absolute paths are not allowed",
    },
  },
  [RpcMethod.SwitchTab]: {
    name: "switch_tab",
    annotations: TOOL_HINTS.sessionSetting,
    description:
      "Show a tab to the user: make it the active tab and focus its window (no reload). Refused in manual mode. To work in a tab without showing it, pass its tabId to other tools or claim it with claim_tab.",
    params: {
      tabId: "Tab id from list_windows / new_tab",
    },
  },
  [RpcMethod.SelectOption]: {
    name: "select_option",
    annotations: TOOL_HINTS.pageAction,
    description:
      "Set the selection of a native <select> by option value or visible label (exact, case-insensitive), replacing what was selected. For custom dropdowns use pick_option.",
    params: {
      ref: "[ref] of the <select> or its <label>",
      values: "Option values or visible labels to select",
    },
  },
  [RpcMethod.PressKey]: {
    name: "press_key",
    annotations: TOOL_HINTS.pageAction,
    description:
      'Send a key or chord (e.g. "Enter", "Escape", "ArrowDown", "Shift+Tab") to a [ref] element or the focused element. The page\'s key handlers run — Escape closes a modal, Enter submits a keydown-driven form — but browser defaults do not: Tab does not move focus, Control+a does not select, keys do not insert text (use type_text / paste_text). There is no confirm gate here.',
    params: {
      key: 'The key or chord, e.g. "Enter", "Escape", "ArrowDown", "Control+Enter"',
      ref: "[ref] of the element to send it to; omit for the focused element",
    },
  },
  [RpcMethod.GoBack]: {
    name: "go_back",
    annotations: TOOL_HINTS.pageAction,
    description: "Go back one step in the tab's history. The reply says whether a navigation actually committed.",
    params: {},
  },
  [RpcMethod.GoForward]: {
    name: "go_forward",
    annotations: TOOL_HINTS.pageAction,
    description: "Go forward one step in the tab's history. The reply says whether a navigation actually committed.",
    params: {},
  },
  [RpcMethod.Reload]: {
    name: "reload",
    annotations: TOOL_HINTS.pageAction,
    description: "Reload the tab. The reply says whether a new document actually committed.",
    params: {},
  },
  [RpcMethod.Scroll]: {
    name: "scroll",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Scroll the window or a scrollable container to reveal more content, including lazy-loaded lists. Returns the new position, what scrolled and whether more content remains. On a page with no DOM scroll container (canvas apps) it sends a wheel event instead and reports whether the page consumed it.",
    params: {
      ref: "[ref] of a (scrollable) container; omit for the window",
      deltaY: "Pixels to scroll; negative scrolls up. Default about 90% of the container's height",
      toBottom: "Scroll all the way to the bottom",
      humanize: "Scroll smoothly. Default true; false jumps at once. A background tab always jumps",
    },
  },
  [RpcMethod.Drag]: {
    name: "drag",
    annotations: TOOL_HINTS.pageAction,
    description:
      'Drag one element onto another — two different elements, both by [ref] in the same frame. method "html5" (default) fires native drag-and-drop events, for sortable lists and boards built on the HTML5 API; "pointer" presses, moves and releases, for pointer/mouse-based libraries and sliders — try it when html5 had no effect. Neither carries a file (use upload_file) or can complete a human-verification slider.',
    params: {
      ref: "[ref] of the element to drag",
      toRef: "[ref] of the drop target",
      method: '"html5" (default) or "pointer"',
      confirm: "Required when either end is labelled with a risky word (word list under click). Set it only when the user asked for that action",
    },
  },
  [RpcMethod.Upload]: {
    name: "upload_file",
    annotations: TOOL_HINTS.pageAction,
    description:
      "Attach files to an <input type=file> without the OS file dialog. Source: `url` (fetched by the backend, http(s) only, private and loopback hosts refused, sent with a same-origin Referer), `localPath` (a file on the backend host) or `attachments` (a list of either); 25MB per file. " +
      "Target the input by ref, or describe the visible upload slot — a slot inside a <label> resolves to its input; otherwise use the input's [ref] (snapshot names hidden inputs too). " +
      "Each attachment is a separate change event that replaces input.files: uploaders that add one file per change get them all, a plain <input multiple> keeps only the last, and galleries that re-render between files can drop some (give those one file per plan step). " +
      "Uploaders that require a real user gesture reject injected files — ask the user to attach those by hand.",
    params: {
      ref: "[ref] of the file input, or of a <label> around it. Prefer a description when the page re-renders between uploads",
      text: "Visible text of the upload slot",
      role: 'ARIA role, explicit or implied — e.g. "button" for a styled upload slot',
      name: "Accessible name of the upload slot: aria-label, <label>, the text it shows, placeholder, alt or title",
      css: LOCATOR_DOCS.css,
      near: LOCATOR_DOCS.near,
      nth: "0-based index among the matches. A filled slot often loses its label, so nth:0 usually names the next empty one",
      exact: LOCATOR_DOCS.exact,
      url: "http(s) URL of the file. Give one of url, localPath or attachments",
      localPath: "Path of a file on the backend host. Give one of url, localPath or attachments",
      filename: "Name for the uploaded file (default: the source's name)",
      attachments: "Files to attach in order, each {url or localPath, filename?, mimeType?}",
      batchSize: "How many attachments to load into memory at a time; does not change the order or pacing of the uploads",
    },
  },
  [RpcMethod.Hover]: {
    name: "hover",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      `Move the pointer onto an element to reveal hover-only UI (tooltips, hover menus). ${LOCATOR_RULES} Read the page right away — hover UI closes on your next action. A menu that opens only through a CSS :hover rule cannot be triggered.`,
    params: { ...LOCATOR_DOCS },
  },
  // No MCP tool: click({text}) resolves the same innermost-text match, strictly. Kept as an RPC for existing playbooks.
  [RpcMethod.ClickText]: null,
  [RpcMethod.ContextMenu]: {
    name: "right_click",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Open a page's custom context menu (file trees, table rows, editors) by firing its contextmenu event; the browser's own menu cannot be opened. `defaultPrevented` in the reply means the page handled it — read the menu right away, it closes on your next action. " +
      LOCATOR_RULES,
    params: { ...LOCATOR_DOCS },
  },
  [RpcMethod.DblClick]: {
    name: "double_click",
    annotations: TOOL_HINTS.pageAction,
    description:
      "Double-click an element — open a row, start inline editing, expand a tree node. Two click calls do not trigger dblclick handlers; this does. " +
      `${LOCATOR_RULES} Same confirm gate as click.`,
    params: {
      ...LOCATOR_DOCS,
      confirm: CONFIRM_DOC,
    },
  },
  [RpcMethod.Paste]: {
    name: "paste_text",
    annotations: TOOL_HINTS.pageAction,
    description:
      "Paste text into a field as a clipboard paste, keeping its existing content: at the caret (replacing a selection) if the field had focus, else at the end. Use it for rich-text editors that build content from paste events, and for long text. `defaultPrevented` in the reply means the editor handled the paste itself. To replace a field's value, use type_text. " +
      "Target the field by ref or by description (name / role / css / near / nth); `text` is the content, not a locator.",
    params: {
      ref: LOCATOR_DOCS.ref,
      text: "Text to paste — not a locator",
      role: 'ARIA role, e.g. "textbox"',
      name: LOCATOR_DOCS.name,
      css: LOCATOR_DOCS.css,
      near: LOCATOR_DOCS.near,
      exact: FIELD_EXACT_DOC,
      nth: LOCATOR_DOCS.nth,
    },
  },
  [RpcMethod.ReadNetwork]: {
    name: "read_network",
    annotations: TOOL_HINTS.read,
    description:
      `List the tab's recent XHR/fetch requests (method, URL, status; failures marked ✗), up to the last ${NETWORK_LOG_PER_TAB} since the extension's background worker started. Use it to confirm a save or submit reached the server with a 2xx instead of trusting the UI. ` +
      "Response bodies (JSON/text, truncated) appear only for requests made while set_network_capture was on — that is how you catch a 200 carrying a business error.",
    params: {
      limit: "Maximum requests to return, newest last (default 20)",
    },
  },
  [RpcMethod.SetNetworkCapture]: {
    name: "set_network_capture",
    annotations: TOOL_HINTS.sessionSetting,
    description:
      "Turn response-body capture on or off for a tab (default off). While on, the JSON/text bodies of new XHR/fetch responses are kept for read_network, across navigations of that tab. It patches the page's fetch and XHR, so turn it off when done.",
    params: {
      enabled: "true to start capturing on this tab, false to stop",
    },
  },
  [RpcMethod.PageState]: {
    name: "page_state",
    annotations: TOOL_HINTS.read,
    description:
      "One consistent read of a tab's state: url and title, loading, element count, scroll position, the focused control, a form summary (filled / required-empty / invalid / dirty), open dialogs, overlay or scroll lock, busy regions, invalid fields (marked aria-invalid, with the message they point to), and `changed` since your last page_state on this tab. Cheap enough to call after every action to confirm it landed. No elements, text or pixels (snapshot, read_content, screenshot).",
    params: {
      verbosity: '"detail" adds dialog names, error texts and the fields blocking submit; default "summary"',
      resetDelta: "Reset the `changed` baseline without reporting changes",
    },
  },
} satisfies Record<RpcMethod, McpToolInstruction | null>;

/** Tools for the backend-executed step methods. */
const LOCAL_METHOD_TOOLS: Record<LocalMethod, string> = {
  [LocalMethod.Eval]: "local_eval",
  [LocalMethod.WriteFile]: "write_file",
  [LocalMethod.PickOption]: "pick_option",
};

/** RPCs with no tool of their own, and the tool that does the same job. */
const SUPERSEDED_BY: Partial<Record<RpcMethod, string>> = {
  [RpcMethod.ClickText]: "click",
  [RpcMethod.ListTabs]: "list_windows",
  [RpcMethod.WaitSignal]: "wait_for",
};

/** The tool an agent calls to perform a recorded step action with this method,
 *  or null when no tool can (only the runner performs it). Replies that hand a
 *  playbook step to an agent name tools, never RPC method strings. */
export function toolNameOf(method: string): string | null {
  const local = (LOCAL_METHOD_TOOLS as Record<string, string>)[method];
  if (local) return local;
  const spec = (MCP_TOOL_INSTRUCTIONS as Record<string, McpToolInstruction | null>)[method];
  if (spec) return spec.name;
  return (SUPERSEDED_BY as Record<string, string>)[method] ?? null;
}
