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
 */
import { LocalMethod, RpcMethod } from "./methods.js";
import { EVAL_TIMEOUT_MS, NETWORK_LOG_PER_TAB, READ_DUMP_TTL_MS, WAIT_FOR_DEFAULT_MS, WAIT_FOR_MAX_MS } from "./limits.js";

export interface McpToolInstruction {
  /** The registered MCP tool name. */
  name: string;
  description: string;
  params: Record<string, string>;
}

const seconds = (ms: number): string => `${ms / 1000}s`;

/** How an omitted `tabId` resolves — the same rule for every tab-scoped tool. */
export const TAB_ID_DOC =
  "Tab to act on (ids come from new_tab / new_window / list_windows). Omit it to use this session's claimed tab (claim_tab), " +
  "or, with no claim, the active tab of the browser's last-focused window. In manual mode an omitted tabId is refused, except " +
  "that page_state, snapshot, read_content and read_network still read that tab.";

/** Element locator docs, shared by every tool that targets an element. One
 *  definition so "same targeting as click" is true by construction. */
export const LOCATOR_DOCS = {
  ref: "[ref] from a snapshot. A ref keeps naming its element across re-snapshots until that element is removed. Wins over every description field",
  text: "Visible text; resolves to the innermost element containing it",
  role: 'ARIA role, explicit or implicit — a <button> is "button" even with no ARIA markup',
  name: "Accessible name: aria-label, associated <label>, placeholder, alt or title",
  css: "CSS selector, for markup that carries no usable semantics",
  near: "Keep only candidates within ~200px of the nearest element whose text matches this, closest first — the way to disambiguate a repeated control across rows/cards",
  exact: "Match text/name exactly instead of as a substring",
  nth: "0-based pick among matches; the explicit way out of a strict-match error",
  x: "Viewport X, normally read off a screenshot. Use when the snapshot cannot name the target — icon-only toolbars, canvas hot-spots, custom-drawn widgets. Resolves to what is painted there, then climbs to the nearest interactive ancestor. Must be paired with y",
  y: "Viewport Y — must be paired with x; giving only one is rejected",
} as const;

/** One sentence every element-targeting description repeats. */
const LOCATOR_RULES =
  "Name the target by ref, by description (text / role / name / css, optionally narrowed by near / exact / nth), or by x,y. " +
  "A description is re-resolved at action time, so it survives re-renders, portals and virtual-list recycling. Matching is STRICT: " +
  "several matches is an error listing the candidates — pass nth (0-based) to choose. A description or x,y resolves in the TOP frame " +
  "only; for a control inside an iframe use its frame-prefixed [ref] from snapshot.";

const CONFIRM_DOC =
  "Allow a risky/irreversible action — required when the target's label contains one of: 提交 删除 移除 清空 购买 下单 支付 付款 结算 发送 注销 退订 / confirm, delete, remove, submit, pay, buy, purchase, checkout, place order, send, sign out, log out, unsubscribe. Pass it only when the user asked for that action";

export const MCP_TOOL_INSTRUCTIONS = {
  [RpcMethod.Navigate]: {
    name: "navigate",
    description: "Navigate a tab to a URL. The reply flags it when the site redirected you somewhere else.",
    params: {
      url: "Absolute URL incl. scheme",
    },
  },
  [RpcMethod.NewTab]: {
    name: "new_tab",
    description:
      "Open a new browser tab (optionally at a URL). The tab opens in the background by default; set active:true to make it active. In manual mode it always opens in the background. claim:true also claims it as this session's default workspace (see claim_tab).",
    params: {
      url: "URL to open in the new tab; omit for a blank tab.",
      active: "Whether the new tab should become active; defaults to false.",
      claim: "Also claim the new tab as this session's default target",
    },
  },
  [RpcMethod.CloseTab]: {
    name: "close_tab",
    description: "Close a tab. With no tabId it closes this session's claimed tab, or with no claim the active tab of the last-focused window; the reply names the tab it closed.",
    params: {},
  },
  [RpcMethod.NewWindow]: {
    name: "new_window",
    description:
      "Open a NEW browser window (unfocused by default so it doesn't steal your foreground) and return its windowId + tabId. Pin a task's actions to this tab via the tabId param — it runs in the background window without disturbing your active window. Set minimized=true to minimize the new window after creation; leave it unset to keep the default non-minimized window. focused:false alone is not reliably enough to keep it from grabbing OS foreground — add restoreFocus:true to actually re-raise whatever window the user was looking at right after this one opens.",
    params: {
      url: "URL to open in the new window; omit for a blank one.",
      focused: "Make the new window the OS-focused foreground window (default false so it doesn't steal foreground).",
      minimized: "Minimize the new window after creation (note a minimized window stops rendering).",
      left: 'Window X. Chrome refuses bounds leaving less than ~50% of the window off the visible display (anti-abuse guard, not a config gap) — off-screen coordinates narrow the window\'s footprint but never make it fully invisible. For that, use restoreFocus instead: the window stays normal/rendering, just behind.',
      top: "Window Y",
      width: "Window width in pixels.",
      height: "Window height in pixels.",
      restoreFocus: "Re-raise whichever window had OS focus right before this create, immediately after — the new window opens normal/rendering but ends up behind it instead of in front, without the input-breaking cost of minimized",
    },
  },
  [RpcMethod.CloseWindow]: {
    name: "close_window",
    description: "Close a window by id, or the last-focused window if omitted.",
    params: {
      windowId: "Id of the window to close (from list_windows / new_window); omit to close the last-focused window.",
    },
  },
  // No MCP tool: the plan runner and playbooks use it to minimize a task window mid-run.
  [RpcMethod.SetWindowState]: null,
  // No MCP tool: list_windows returns the same tabs grouped by window, plus focus and window state.
  [RpcMethod.ListTabs]: null,
  [RpcMethod.ListWindows]: {
    name: "list_windows",
    description:
      "List the target browser's windows and their tabs (id, title, url). Marks each window's visible tab with *, which window has OS focus (what the user is actually looking at) and each window's state (normal/minimized/…). Tab ids from here are what tabId takes. For every connected browser at once, plus mode and claims, use browser_state.",
    params: {},
  },
  [RpcMethod.Screenshot]: {
    name: "screenshot",
    description:
      "PNG screenshot of a tab's visible viewport. Works on a background window's active tab; if Chrome cannot read that window back (minimized, or not being composited), the window is brought forward for one retry — then the previously focused Chrome window is restored, or, when another app was in front, Chrome stays in front because focus cannot be handed back to it; the reply says which. With savePath, the PNG is written to that file on the backend host and only the path is returned (keeps the image out of the conversation); otherwise the image is returned inline.\n" +
      "Reach for pixels when the DOM cannot describe what you need: icon-only buttons with no accessible name, canvas or chart hot-spots, custom-drawn widgets, a layout question (\"is this covered / off-screen / mis-aligned\"), or any point where a snapshot read fine but the action did not do what you expected. Seeing it is often faster than a third blind re-read.\n" +
      "It is a two-way bridge, not a dead end: snapshot elements carry their box as (x,y w×h), so you can map what you SEE to a [ref] — and when nothing in the snapshot lines up, click({x, y}) acts on whatever is painted at those viewport coordinates. Prefer a [ref] or a description when one exists.",
    params: {
      savePath: "Where to write the PNG on the backend host: a relative path, or an absolute one inside the allowed folders (the system temp folder, plus the folder chosen in the desktop client or BCP_SCREENSHOT_DIR). The error names the allowed folders",
    },
  },
  [RpcMethod.Snapshot]: {
    name: "snapshot",
    description:
      "Compact accessibility snapshot of the page: interactable elements with [ref] ids, each with its state ([disabled]/[hidden]/[checked]/[expanded]/[invalid]…) and its viewport box (x,y w×h). Pierces iframes and open shadow roots. A [ref] survives re-snapshots as long as its element does, so handles you already hold stay valid; the reply also names which refs are NEW since your last snapshot — start there rather than re-reading the whole page. A ref dies only when the element is genuinely removed (a virtual list recycling rows or a portal re-mounting makes NEW elements with new refs) — for content that moves like that, target by description instead. A large page is paged (the reply says how to continue): pass query or viewportOnly to get just the controls you need; every [ref] stays valid whether or not this reply showed it.\n" +
      "Gives you HANDLES, not the page: no rendered text (use read_content), no pixels (use screenshot), no readiness/focus/form state (use page_state). If you want all of it at once on an unfamiliar page, use analyze_page. Escalate rather than re-snapshotting a page that already surprised you twice — a second identical snapshot answers the same question the same way.",
    params: {
      query: "Only elements whose role, name, value or options contain this text (case-insensitive), e.g. \"登录\" or \"textbox\". The cheapest way to find one control on a large page",
      viewportOnly: "Only elements inside the viewport the user sees — elements inside frames are measured against it too",
      limit: "Show at most this many elements (after query/viewportOnly); a large reply is paged either way",
      after: "Continue after this [ref] — the one a paged reply names. A ref, not a position, so elements added or removed between calls are not skipped",
    },
  },
  [RpcMethod.Click]: {
    name: "click",
    description: `Click an element. ${LOCATOR_RULES} Risky/irreversible clicks (submit/delete/pay/send) require confirm:true — only set it when the user explicitly asked for that action.`,
    params: {
      ...LOCATOR_DOCS,
      humanize: "Human-like cursor approach + press timing. Default FALSE (fast); pass true only when a human is watching the run — it adds 150-350ms per click",
      confirm: CONFIRM_DOC,
    },
  },
  [RpcMethod.Type]: {
    name: "type_text",
    description:
      "Type a value into an input/textarea/contenteditable, REPLACING what the field held (to insert at the caret instead, use paste_text). " +
      "Name the field by [ref] or by description (name / role / css / near / nth) — `text` is the VALUE, so describe the field by `name`, which covers its <label>, placeholder, aria-label, alt or title. A description resolves in the top frame only. " +
      "Structured inputs (date, time, datetime-local, month, week, color, range, number) are set whole and verified by read-back; a value the field rejects is reported, not silently swallowed. " +
      "Targeting a <label> or a styled wrapper resolves to the control it belongs to. Optionally submit (Enter).",
    params: {
      ref: LOCATOR_DOCS.ref,
      text: "The value to type — NOT a locator. Replaces the field's current content",
      name: "Accessible name of the field: its <label>, placeholder, aria-label, alt or title",
      role: 'ARIA role, e.g. "textbox" / "combobox"',
      css: LOCATOR_DOCS.css,
      near: LOCATOR_DOCS.near,
      exact: "Match `name` exactly instead of as a substring",
      nth: LOCATOR_DOCS.nth,
      submit: "Also submit the form (Enter) after typing.",
      humanize: "Randomized keystroke cadence. Default FALSE (fast); pass true only when a human is watching — it adds 35-110ms per character",
      confirm: "Required when submit:true would trigger a risky/irreversible form (pay/place order/delete)",
    },
  },
  [RpcMethod.ReadContent]: {
    name: "read_content",
    description:
      "Read the page's rendered text. The text is normalized and written to temporary files on the BACKEND host instead of being inserted into this reply; the reply gives a manifest path, chunk ranges and a short structural overview. Open the manifest and only the chunk(s) you need — with your own file reader when it runs on the backend host, otherwise with read_content_dump. " +
      `The dump is deleted before your next browser operation (and after ${seconds(READ_DUMP_TTL_MS)} at most), so read what you need first and never in parallel with another browser tool.\n` +
      "TOP FRAME ONLY — unlike snapshot, this does NOT pierce iframes. If text you can see is missing here, the page put it in an iframe: take a snapshot (its refs are frame-prefixed) or screenshot instead of concluding the text is not there.\n" +
      "Use it to READ (prose, tables, error copy, whether a value was saved). To ACT you need refs from snapshot; to judge readiness use page_state.",
    params: {
      maxChars: "Maximum characters per dump chunk file; omit for adaptive chunking (short pages one file, larger pages 12000–16000 characters)",
    },
  },
  [RpcMethod.WaitFor]: {
    name: "wait_for",
    description:
      "Wait for the page: until `text` appears (top frame), or until a CSS `selector`'s element becomes visible/hidden (`state`), or — with neither — for a fixed delay of `ms`. Give text OR selector, not both. " +
      `When waiting on a condition, \`ms\` is the timeout (default ${WAIT_FOR_DEFAULT_MS}ms, max ${WAIT_FOR_MAX_MS}ms); the reply says whether it was met or timed out. ` +
      "Use selector+state to sync with SPAs (e.g. wait for a spinner to disappear before reading). For a condition these can't express, compute it in eval with bcpWait.until.",
    params: {
      text: "Visible text to wait for (top frame).",
      selector: "CSS selector whose element to wait on.",
      state: "For `selector`: \"visible\" (default) or \"hidden\".",
      ms: `Timeout in ms when waiting on text/selector (default ${WAIT_FOR_DEFAULT_MS}, max ${WAIT_FOR_MAX_MS}); the fixed delay when neither is given.`,
    },
  },
  // No MCP tool: book signal gates use it inside the plan runner. Agents wait with wait_for, wait_for_event, or bcpWait inside eval.
  [RpcMethod.WaitSignal]: null,
  [RpcMethod.Eval]: {
    name: "eval",
    description:
      "Evaluate JavaScript in the page's own JS context (MAIN world) and return its JSON-serializable result. Top-level declarations are wrapped so they don't leak onto window; a single expression is returned implicitly, while multi-statement code needs an explicit `return`. Pure chrome.scripting (no CDP); a strict page CSP may block it — there is no isolated fallback, since an MV3 extension can't eval in its own isolated world. " +
      `Async runs are capped at ${seconds(EVAL_TIMEOUT_MS)}; inside, \`bcpDeadline\` is the deadline to loop against and \`bcpWait\` (until / netIdle / domQuiet / grew / sleep) does bounded waiting — see the server instructions. Oversized results come back truncated. On by default; a backend started with BCP_EVAL=off refuses it.`,
    params: {
      code: "JavaScript to evaluate in the page's MAIN world context.",
      frameId: 'Run inside a specific same-origin frame (the frameId prefix of a snapshot ref, e.g. 42 in "42_e3"); omit for the top frame',
    },
  },
  [RpcMethod.Download]: {
    name: "download",
    description:
      "Download a file (e.g. a page's export/PDF link) to the browser's Downloads folder via chrome.downloads. filename is optional and relative to the Downloads directory (chrome cannot write arbitrary absolute paths). The reply says whether it completed, failed or is still in progress.",
    params: {
      url: "Absolute URL of the file",
      filename: "Filename for the download, relative to the browser's Downloads directory (optional).",
    },
  },
  [RpcMethod.SwitchTab]: {
    name: "switch_tab",
    description:
      "Bring an existing tab to the foreground: make it active and focus its window (does NOT reload it). This changes what the user sees; to work in a tab without showing it, pass its tabId to other tools or claim_tab it instead.",
    params: {
      tabId: "Tab id from list_windows / new_tab",
    },
  },
  [RpcMethod.SelectOption]: {
    name: "select_option",
    description:
      "Choose option(s) in a NATIVE <select> by value or visible label (snapshot lists a select's options). For a custom dropdown (Ant Design / Element / Arco …) use pick_option.",
    params: {
      ref: "[ref] of the <select> element (or its <label>)",
      values: "Option value(s) or label(s) to select",
    },
  },
  [RpcMethod.PressKey]: {
    name: "press_key",
    description:
      'Dispatch a key or chord (e.g. "Enter", "Escape", "ArrowDown", "Shift+Tab") to a [ref] element or to the focused element. The page\'s own key handlers run — Escape closes a modal, ArrowDown then Enter commits an autocomplete, Enter submits a keydown-driven form. The browser\'s built-in default actions do NOT happen (synthetic keys): Tab does not move focus, Control+a does not select, and keys do not insert text — use type_text / paste_text to enter text.',
    params: {
      key: 'The key or chord to press (e.g. "Enter", "Escape", "ArrowDown", "Control+Enter").',
      ref: "[ref] of the element to send the key to; omit to send to the focused element.",
    },
  },
  [RpcMethod.GoBack]: {
    name: "go_back",
    description: "Navigate the tab back in history. The reply says whether a navigation actually committed.",
    params: {},
  },
  [RpcMethod.GoForward]: {
    name: "go_forward",
    description: "Navigate the tab forward in history. The reply says whether a navigation actually committed.",
    params: {},
  },
  [RpcMethod.Reload]: {
    name: "reload",
    description: "Reload the tab. The reply says whether a new document actually committed.",
    params: {},
  },
  [RpcMethod.Scroll]: {
    name: "scroll",
    description:
      "Scroll the page (or a [ref]'s scrollable container) down by a delta or to the bottom, to reveal below-the-fold / lazy-loaded content. Returns the new position, what it scrolled and whether more content remains.",
    params: {
      ref: "[ref] of the scrollable container (snapshot marks them (scrollable)); omit to scroll the window.",
      deltaY: "Pixels to scroll (default ~one viewport)",
      toBottom: "Scroll all the way to the bottom.",
      humanize: "Scroll gradually like a human. Default true; pass false for an instant jump",
    },
  },
  [RpcMethod.Drag]: {
    name: "drag",
    description:
      "Drag one page element onto another by their [ref] ids. Default method \"html5\": synthetic HTML5 drag-and-drop events (dragstart/dragover/drop) — for reordering / kanban / sortable zones built on the native DnD API. Its dataTransfer is EMPTY (no file payload), so it CANNOT deliver a file to a drop-to-upload zone — use upload_file for file inputs. Method \"pointer\": press on the source, move in steps, release over the target — for libraries built on pointer/mouse events (sortable lists in fallback mode, range sliders, canvas editors); if an html5 drop had no effect, try pointer. The two ends must be separate elements (a press and release on one control is a click). Neither is OS-level input: events are isTrusted=false, so a widget that requires a real hand — typically a page asking the user to prove they are human by dragging a slider or completing a picture — will not move; ask the user to do that step. Both refs must be in the same frame.",
    params: {
      ref: "[ref] to drag",
      toRef: "[ref] to drop onto",
      method: "\"html5\" (default, native drag-and-drop events) or \"pointer\" (press, move, release — for pointer/mouse-based libraries)",
      confirm: "Required when the dragged control or the drop target is labelled with a risky word (the same list as click's confirm), e.g. dropping onto a 删除 bin. Pass it only when the user asked for that action",
    },
  },
  [RpcMethod.Upload]: {
    name: "upload_file",
    description:
      "Attach one or more files to a <input type=file> with no native OS file dialog (pure extension). SOURCES — either a single `url` (fetched server-side: http(s) only, SSRF-guarded, sent with a same-origin Referer so image-host hotlink checks pass) or `localPath` (a file on the machine running this server), or an `attachments` LIST of those to fill a multi-image uploader in one call. Max 25MB each. The list is dispatched back-to-back with NO wait between files, so it only suits an uploader that swallows a burst; one that re-renders its slots between files (most React/Vue galleries) drops all but the first few — give those ONE file per playbook step and let the step's verify block until it landed. " +
      "TARGET — a [ref], or a description (text / name / role / css / near / nth): prefer the description, because an upload re-renders the uploader and kills the refs around it. The <input type=file> is usually hidden behind a styled slot; name the VISIBLE slot and this resolves inward to the input. A description resolves in the top frame only. Works for uploaders that read input.files on a change event (most React/Vue widgets); a few that demand a trusted user gesture reject any injected file — there is NO drag fallback for those (drag carries no file payload), so report back and have the user attach it by hand.",
    params: {
      ref: "[ref] of the file input or its visible wrapper. Wins over the description fields; prefer a description when the page re-renders between uploads",
      text: "Visible text of the upload slot; resolves inward to its file input",
      role: 'ARIA role, explicit or implicit — e.g. "button" for a styled upload slot',
      name: "Accessible name of the file input or its visible slot: aria-label, associated <label>, placeholder, alt or title",
      css: LOCATOR_DOCS.css,
      near: LOCATOR_DOCS.near,
      nth: "0-based pick among matches; the explicit way out of a strict-match error. A filled slot usually drops its label, so nth:0 keeps naming the next EMPTY one",
      exact: LOCATOR_DOCS.exact,
      url: "Absolute http(s) URL of the file (mutually exclusive with localPath and attachments)",
      localPath: "Path to a file on the server machine (mutually exclusive with url and attachments)",
      filename: "Override the filename (defaults to the source's basename)",
      attachments: "List of {url|localPath, filename?, mimeType?} to attach in order — for a gallery/multi-image uploader. Mutually exclusive with the single url/localPath",
      batchSize: "How many of `attachments` to READ into memory at a time (fetch/disk), so a long list is not all held at once. It does NOT pace the dispatches — every file is still sent back-to-back. An uploader that re-renders between files (most React/Vue galleries do) needs one file per PLAYBOOK STEP, where the step's own verify blocks until the previous one landed; sequencing is the book's job, not this parameter's",
    },
  },
  [RpcMethod.Hover]: {
    name: "hover",
    description:
      `Hover the pointer over an element to reveal hover-only UI — tooltips, menus that open on mouseover. ${LOCATOR_RULES} Read the page in the same beat (analyze_page/snapshot); hover UI vanishes on your next action. Synthetic pointer events run the page's mouseover/mouseenter handlers but never put the element into CSS :hover, so a menu that opens purely through a :hover stylesheet rule will not open.`,
    params: { ...LOCATOR_DOCS },
  },
  // No MCP tool: click({text}) resolves the same innermost-text match, strictly. Kept as an RPC for existing playbooks.
  [RpcMethod.ClickText]: null,
  [RpcMethod.ContextMenu]: {
    name: "right_click",
    description:
      "Right-click an element to open its CUSTOM context menu (file trees, table rows, canvas editors). " +
      "Chrome's own menu cannot be opened by any extension and is not what this does — this fires the `contextmenu` event the page listens for. " +
      "The reply says `defaultPrevented` when the page handled it, which is your signal a custom menu opened: read the page in the same beat, it closes on your next action. " +
      LOCATOR_RULES,
    params: { ...LOCATOR_DOCS },
  },
  [RpcMethod.DblClick]: {
    name: "double_click",
    description:
      "Double-click an element — the gesture that opens a row, enters inline edit, or expands a tree node. " +
      "Not the same as calling click twice: the browser only fires a dblclick handler when the second click carries detail:2, which two separate click calls never do. " +
      `${LOCATOR_RULES} Same risk gate as click.`,
    params: {
      ...LOCATOR_DOCS,
      confirm: CONFIRM_DOC,
    },
  },
  [RpcMethod.Paste]: {
    name: "paste_text",
    description:
      "Paste text into a field as a clipboard drop rather than as keystrokes. Use it for rich editors (Notion/Quill/ProseMirror-style) that listen for `paste` and build their own content model — type_text sends keys those editors may reformat or reject, and it is slow for long text. " +
      "The reply says `defaultPrevented` when the editor consumed the paste itself; otherwise the text is inserted — at the caret (replacing any selection) when the field already had focus, else at the end — keeping the field's existing content and markup. To replace a field's whole value use type_text. " +
      "Name the field by [ref] or by description (name / role / css / near / nth) — `text` is the pasted VALUE, not a locator. A description resolves in the top frame only.",
    params: {
      ref: LOCATOR_DOCS.ref,
      text: "Text to paste — NOT a locator",
      role: LOCATOR_DOCS.role,
      name: LOCATOR_DOCS.name,
      css: LOCATOR_DOCS.css,
      near: LOCATOR_DOCS.near,
      exact: "Match `name` exactly instead of as a substring",
      nth: LOCATOR_DOCS.nth,
    },
  },
  [RpcMethod.ReadNetwork]: {
    name: "read_network",
    description:
      `List recent XHR/fetch requests for the tab (method, URL, HTTP status; the last ${NETWORK_LOG_PER_TAB} per tab, captured since the extension woke). Use to confirm a save/submit actually reached the server and returned 2xx, instead of guessing from the UI. ` +
      "Response BODIES appear under their request only for requests made while set_network_capture is ON for that tab (JSON/text, truncated) — that is how you check a 200 that carries a business error.",
    params: {
      limit: "Max requests to return, newest last (default 20)",
    },
  },
  [RpcMethod.SetNetworkCapture]: {
    name: "set_network_capture",
    description:
      "Turn fetch/XHR RESPONSE-BODY capture on or off for a tab (default OFF). While ON, JSON/text response bodies of requests made from then on are kept and shown by read_network under their request. Turn it OFF when done to keep the page un-patched (lower detectability).",
    params: {
      enabled: "true = start capturing bodies on this tab; false = stop",
    },
  },
  [RpcMethod.PageState]: {
    name: "page_state",
    description:
      "Coherent one-shot STATE of a tab from a SINGLE atomic read (nothing drifts between fields): url/title, whether it's still loading, interactable-element count, scroll position (+ more above/below), the focused control (which [ref], is it a text field, caret/selection), a form submittability summary (filled / empty-required / invalid / dirty counts), open dialogs, overlay/scroll-lock, a busy-region count, the visible-error count, and `changed` = what moved since YOUR last page_state on this tab. This is the cheap perceive→verify instrument — call it each beat to orient and to confirm the last action landed. It returns NO element tree/[ref]s (use snapshot), NO text (use read_content), NO pixels (use screenshot); analyze_page bundles all of those. verbosity:\"detail\" adds dialog names, the error texts, and the blocking form fields.",
    params: {
      verbosity: '"detail" adds dialog names, error texts, and blocking form fields; default "summary"',
      resetDelta: "Refresh the change baseline without reporting `changed` — use on the first beat after you know the page changed",
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
