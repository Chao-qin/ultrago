/**
 * Every browser MCP tool's name / description / params, keyed by its RpcMethod.
 *
 * The keys are the RpcMethod string literals (e.g. "browser.navigate"), so the
 * object typechecks against `Record<RpcMethod, McpToolInstruction>` — meaning
 * any new RpcMethod in index.ts forces its tool entry here (and vice-versa —
 * if index.ts drops one, this file stops compiling).
 *
 * `description` and `params` mirror the `server.registerTool(...)` call in
 * packages/backend/src/browser-mcp.ts (tool description + each zod field's
 * `.describe("...")`). Params without a `.describe()` get a short description
 * derived from the RpcContracts JSDoc in index.ts.
 *
 * NOTE: this file only covers the tools that map 1:1 to an RpcMethod. The pure
 * orchestration / composite / LocalMethod tools are intentionally SKIPPED here
 * (they have no RpcMethod constant) — they are listed at the bottom comment.
 */
import { RpcMethod } from "./methods.js";

export interface McpToolInstruction {
  name: `browser_${string}`;
  description: string;
  params: Record<string, string>;
}

export const MCP_TOOL_INSTRUCTIONS = {
  [RpcMethod.Navigate]: {
    name: "browser_navigate",
    description: "Navigate a tab to a URL.",
    params: {
      url: "Absolute URL incl. scheme",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.NewTab]: {
    name: "browser_new_tab",
    description:
      "Open a new browser tab (optionally at a URL). The tab opens in the background by default; set active:true to make it active. In manual mode it always opens in the background. claim:true also claims it as this session's default workspace (see claim_tab).",
    params: {
      url: "URL to open in the new tab; omit for a blank tab.",
      active: "Whether the new tab should become active; defaults to false.",
      claim: "Also claim the new tab as this session's default target",
    },
  },
  [RpcMethod.CloseTab]: {
    name: "browser_close_tab",
    description: "Close a tab by id, or the active tab if no id is given.",
    params: {
      tabId: "Id of the tab to close; omit to close the active (or claimed) tab.",
    },
  },
  [RpcMethod.NewWindow]: {
    name: "browser_new_window",
    description:
      "Open a NEW browser window (unfocused by default so it doesn't steal your foreground) and return its windowId + tabId. Pin a task's actions to this tab via the tabId param — it runs in the background window without disturbing your active window. Set minimized=true to minimize the new window after creation; leave it unset to keep the default non-minimized window. focused:false alone is not reliably enough to keep it from grabbing OS foreground — add restoreFocus:true to actually re-raise whatever window the user was looking at right after this one opens.",
    params: {
      url: "URL to open in the new window; omit for a blank one.",
      focused: "Make the new window the OS-focused foreground window (default false so it doesn't steal foreground).",
      minimized: "Minimize the new window after creation (note a minimized window stops rendering).",
      left: 'Window X. Chrome refuses bounds leaving less than ~50% of the window off the visible display (anti-abuse guard, not a config gap) — off-screen coordinates narrow the window\'s footprint but never make it fully invisible. For that, use restoreFocus instead: the window stays normal/rendering, just behind.',
      top: "Window Y",
      width: "Window width (optional).",
      height: "Window height (optional).",
      restoreFocus: "Re-raise whichever window had OS focus right before this create, immediately after — the new window opens normal/rendering but ends up behind it instead of in front, without the input-breaking cost of minimized",
    },
  },
  [RpcMethod.CloseWindow]: {
    name: "browser_close_window",
    description: "Close a window by id, or the active window if omitted.",
    params: {
      windowId: "Id of the window to close; omit to close the active window.",
    },
  },
  [RpcMethod.SetWindowState]: {
    name: "browser_setWindowState",
    description:
      "Toggle a task window's state mid-run, e.g. minimize it once its interactive part (typing/submit) is done and only a rendering-independent wait/poll is left — normal while you need input to land, minimized once you don't, without recreating the window.",
    params: {
      tabId: "Target tab whose window to toggle; defaults to the claimed tab, same as other TAB_SCOPED methods.",
      minimized: "true = minimize the window; false = restore it.",
    },
  },
  [RpcMethod.ListTabs]: {
    name: "browser_list_tabs",
    description:
      "List open tabs grouped by window (id, url, title; * = the tab visible in its window). Each window has its own visible tab, so with multiple windows expect several *.\n" +
      "This is the flat view. For window TOPOLOGY — which window the user is actually looking at (OS focus), each window's state (normal/minimized/…), and how to reason about a multi-window layout — use list_windows. Across several browsers or agent sessions, use browser_state.",
    params: {},
  },
  [RpcMethod.ListWindows]: {
    name: "browser_list_windows",
    description:
      "List the target browser's WINDOWS and their tabs — the topology list_tabs (flat) can't give: which windows exist, which one is OS-focused (what the user is actually looking at), each window's state (normal/minimized/…) and its visible tab. Use it to reason about multi-window layout before acting.",
    params: {},
  },
  [RpcMethod.Screenshot]: {
    name: "browser_screenshot",
    description:
      "PNG screenshot of a tab's visible viewport. Works on a background window's active tab; if Chrome cannot read that window back (minimized, or not being composited), the window is brought forward for one retry — then the previously focused Chrome window is restored, or, when another app was in front, Chrome stays in front because focus cannot be handed back to it; the reply says which. With savePath, the PNG is written to that file on the backend host and only the path is returned (keeps the image out of the conversation); otherwise the image is returned inline.\n" +
      "Reach for pixels when the DOM cannot describe what you need: icon-only buttons with no accessible name, canvas or chart hot-spots, custom-drawn widgets, a layout question (\"is this covered / off-screen / mis-aligned\"), or any point where a snapshot read fine but the action did not do what you expected. Seeing it is often faster than a third blind re-read.\n" +
      "It is a two-way bridge, not a dead end: snapshot elements carry their box as (x,y w×h), so you can map what you SEE to a [ref] — and when nothing in the snapshot lines up, click({x, y}) acts on whatever is painted at those viewport coordinates. Prefer a [ref] or a description when one exists.",
    params: {
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
      savePath: "Where to write the PNG on the backend host: a relative path, or an absolute one inside the allowed folders (the system temp folder, plus the folder chosen in the desktop client or BCP_SCREENSHOT_DIR). The error names the allowed folders",
    },
  },
  [RpcMethod.Snapshot]: {
    name: "browser_snapshot",
    description:
      "Compact accessibility snapshot of the page: interactable elements with [ref] ids, each with its state ([disabled]/[hidden]/[checked]/[expanded]/[invalid]…) and its viewport box (x,y w×h). Pierces iframes and open shadow roots. A [ref] survives re-snapshots as long as its element does, so handles you already hold stay valid; the reply also names which refs are NEW since your last snapshot — start there rather than re-reading the whole page. A ref dies only when the element is genuinely removed (a virtual list recycling rows or a portal re-mounting makes NEW elements with new refs) — for content that moves like that, prefer a description on click/type. Call before click/type. A large page is paged (the reply says how to continue): pass query or viewportOnly to get just the controls you need; every [ref] stays valid whether or not this reply showed it.\n" +
      "Gives you HANDLES, not the page: no rendered text (use read_content), no pixels (use screenshot), no readiness/focus/form state (use page_state). If you want all of it at once on an unfamiliar page, use analyze_page. Escalate rather than re-snapshotting a page that already surprised you twice — a second identical snapshot answers the same question the same way.",
    params: {
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
      query: "Only elements whose role, name, value or options contain this text (case-insensitive), e.g. \"登录\" or \"textbox\". The cheapest way to find one control on a large page",
      viewportOnly: "Only elements inside the viewport the user sees — elements inside frames are measured against it too",
      limit: "Show at most this many elements (after query/viewportOnly); a large reply is paged either way",
      after: "Continue after this [ref] — the one a paged reply names. A ref, not a position, so elements added or removed between calls are not skipped",
    },
  },
  [RpcMethod.Click]: {
    name: "browser_click",
    description:
      "Click an element. THREE ways to name the target, in order of preference: (1) ref — a handle from the latest snapshot, the normal case; (2) a description — text, or role+name, or css, optionally narrowed by near/exact/nth; (3) x,y — viewport coordinates read off a screenshot, for what the DOM cannot describe at all. Everything else is a modifier on one of those three; you never need more than one path. " +
      "A description is re-resolved at click time, so it survives the re-renders, portals and virtual-list recycling that make a ref stale — prefer it when the page is moving. " +
      "Matching is STRICT: several matches is an error that lists the candidates; pass nth (0-based) to choose deliberately. " +
      "Risky/irreversible clicks (submit/delete/pay/send) require confirm:true — only set it when the user explicitly asked for that action.",
    params: {
      ref: "Ref from the latest snapshot. Wins over every description field below",
      text: "Visible text; resolves to the innermost element containing it",
      role: 'ARIA role, explicit or implicit — a <button> is "button" even with no ARIA markup',
      name: "Accessible name: aria-label, associated <label>, placeholder, alt or title",
      css: "CSS selector, for markup that carries no usable semantics",
      near: "Keep only candidates within ~200px of the nearest element whose text matches this, closest first — the way to disambiguate a repeated button across rows/cards",
      exact: "Match text/name exactly instead of as a substring",
      nth: "0-based pick among matches; the explicit way out of a strict-match error",
      x: "Viewport X, normally read off a screenshot. Use when the snapshot cannot name the target — icon-only toolbars, canvas hot-spots, custom-drawn widgets. Resolves to what is painted there, then climbs to the nearest interactive ancestor. Must be paired with y",
      y: "Viewport Y — must be paired with x; giving only one is rejected",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
      humanize: "Human-like cursor approach + press timing. Default FALSE (fast); pass true only when a human is watching the run — it adds 150-350ms per click",
      confirm: "Allow a risky/irreversible action — required when the target's label contains one of: 提交 删除 移除 清空 购买 下单 支付 付款 结算 发送 注销 退订 / confirm, delete, remove, submit, pay, buy, purchase, checkout, place order, send, sign out, log out, unsubscribe. Pass it only when the user asked for that action",
    },
  },
  [RpcMethod.Type]: {
    name: "browser_type",
    description:
      "Type text into an input/textarea/contenteditable, named EITHER by [ref] OR by description (name / role / css / near). " +
      "Note `text` is the VALUE to type, so unlike click it can't also locate — describe the field by `name`, which covers its <label>, placeholder, aria-label, alt or title. " +
      "Structured inputs (date, time, datetime-local, month, week, color, range, number) are set whole and verified by read-back; a value the field rejects is reported, not silently swallowed. " +
      "Targeting a <label> or a styled wrapper resolves to the control it belongs to — select_option and upload_file do the same, so a hidden file input behind a styled button is reachable by the button. Optionally submit (Enter).",
    params: {
      ref: "Ref from the latest snapshot. Wins over the description fields",
      text: "The value to type — NOT a locator",
      name: "Accessible name of the field: its <label>, placeholder, aria-label, alt or title",
      role: 'ARIA role, e.g. "textbox" / "combobox"',
      css: "CSS selector, for fields with no usable semantics",
      near: "Keep only candidates within ~200px of the nearest element with this text, closest first",
      exact: "Match `name` exactly instead of as a substring",
      nth: "0-based pick among matches; the explicit way out of a strict-match error",
      submit: "Also submit the form (Enter) after typing.",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
      humanize: "Randomized keystroke cadence. Default FALSE (fast); pass true only when a human is watching — it adds 35-110ms per character",
      confirm: "Required when submit:true would trigger a risky/irreversible form (pay/place order/delete)",
    },
  },
  [RpcMethod.ReadContent]: {
    name: "browser_read",
    description:
      "Rendered text is normalized and dumped into backend-owned temporary files instead of being inserted into this reply. The dump is deleted before the next browser operation, so read the chunks you need before calling any other browser tool, and never in parallel with one. The reply contains a manifest path, adaptive chunk ranges, and a compact structural overview; use your local file reader to open the manifest and only the chunk(s) needed. The dump is deleted before the next browser operation.\n" +
      "TOP FRAME ONLY — unlike snapshot, this does NOT pierce iframes. If text you can see is missing here, the page put it in an iframe: take a snapshot (its refs are frame-prefixed) or screenshot instead of concluding the text is not there.\n" +
      "Use it to READ (prose, tables, error copy, whether a value was saved). To ACT you need refs from snapshot; to judge readiness use page_state.",
    params: {
      maxChars: "Maximum characters per temporary dump file; omit for adaptive chunking (short pages one file, larger pages 12000–16000 characters)",
      offset: "Optional legacy starting offset recorded in the manifest; normally read the manifest and choose chunk files instead",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.WaitFor]: {
    name: "browser_wait_for",
    description:
      "Wait until: `text` appears, OR a CSS `selector`'s element becomes visible/hidden (`state`), OR a fixed delay. Use selector+state to sync with SPAs (e.g. wait for a spinner to disappear before reading).",
    params: {
      text: "Visible text to wait to appear.",
      selector: "CSS selector whose element to wait on.",
      state: "Target state for the selector element: \"visible\" or \"hidden\".",
      ms: "Fixed delay to wait, in ms.",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.WaitSignal]: {
    name: "browser_wait_signal",
    description:
      "Wait until a declarative condition holds in a tab — and the only wait that can outlast browser_eval's 15s cap (its own timeoutMs governs, up to 180s). Evaluates immediately, then re-checks on observed DOM/page changes AND on a 500ms tick, so it also sees conditions that move no DOM (a `script` leaf reading page state); a navigation re-evaluates it in the new document with the remaining deadline. Book v2 gates are built on this — do NOT hand-roll a polling loop inside browser_eval to wait for something, it gets cut off mid-wait.",
    params: {
      condition: "Declarative signal condition tree (urlIncludes/settled/selector/textPresent/script/all/any/not).",
      timeoutMs: "Absolute wait ceiling in ms.",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.Eval]: {
    name: "browser_eval",
    description:
      "Evaluate JavaScript in the page's own JS context (MAIN world) and return its JSON-serializable result. Top-level declarations are wrapped so they don't leak onto window; a single expression is returned implicitly, while multi-statement code needs an explicit `return`. Pure chrome.scripting (no CDP); a strict page CSP may block it — there is no isolated fallback, since an MV3 extension can't eval in its own isolated world. Async runs cap at 15s — a hard cap you cannot raise from here, so to WAIT for something use browser_wait_signal instead of polling in this code; oversized results come back truncated.",
    params: {
      code: "JavaScript to evaluate in the page's MAIN world context.",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
      frameId: 'Run inside a specific same-origin frame (the frameId prefix of a snapshot ref, e.g. 42 in "42_e3"); omit for the top frame',
    },
  },
  [RpcMethod.Download]: {
    name: "browser_download",
    description:
      "Download a file (e.g. a page's export/PDF link) to the browser's Downloads folder via chrome.downloads. filename is optional and relative to the Downloads directory (chrome cannot write arbitrary absolute paths).",
    params: {
      url: "Absolute URL of the file",
      filename: "Filename for the download, relative to the browser's Downloads directory (optional).",
    },
  },
  [RpcMethod.SwitchTab]: {
    name: "browser_switch_tab",
    description:
      "Bring an existing tab to the foreground: make it active and focus its window (does NOT reload it).",
    params: {
      tabId: "Tab id from list_tabs/new_tab",
    },
  },
  [RpcMethod.SelectOption]: {
    name: "browser_select_option",
    description:
      "Choose option(s) in a native <select> by value or visible label (snapshot lists a select's options).",
    params: {
      ref: "Ref of the <select> element from the latest snapshot.",
      values: "Option value(s) or label(s) to select",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.PressKey]: {
    name: "browser_press_key",
    description:
      'Press a key or chord (e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+a") on a [ref] element or the focused element. Use for closing modals (Escape), committing autocompletes (ArrowDown then Enter), etc.',
    params: {
      key: "The key or chord to press (e.g. \"Enter\", \"Escape\", \"ArrowDown\", \"Control+a\").",
      ref: "Ref of the element to send the key to; omit to send to the focused element.",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.GoBack]: {
    name: "browser_go_back",
    description: "Navigate the tab back in history.",
    params: {
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.GoForward]: {
    name: "browser_go_forward",
    description: "Navigate the tab forward in history.",
    params: {
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.Reload]: {
    name: "browser_reload",
    description: "Reload the tab.",
    params: {
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.Scroll]: {
    name: "browser_scroll",
    description:
      "Scroll the page (or a [ref]'s scrollable container) down by a delta or to the bottom, to reveal below-the-fold / lazy-loaded content. Returns whether more content remains.",
    params: {
      ref: "Ref of the scrollable container to scroll; omit to scroll the window.",
      deltaY: "Pixels to scroll (default ~one viewport)",
      toBottom: "Scroll all the way to the bottom.",
      humanize: "Scroll gradually like a human. Default true; pass false for an instant jump",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.Drag]: {
    name: "browser_drag",
    description:
      "Drag one page element onto another by their [ref] ids. Default method \"html5\": synthetic HTML5 drag-and-drop events (dragstart/dragover/drop) — for reordering / kanban / sortable zones built on the native DnD API. Its dataTransfer is EMPTY (no file payload), so it CANNOT deliver a file to a drop-to-upload zone — use upload_file for file inputs. Method \"pointer\": press on the source, move in steps, release over the target — for libraries built on pointer/mouse events (sortable lists in fallback mode, range sliders, canvas editors); if an html5 drop had no effect, try pointer. The two ends must be separate elements (a press and release on one control is a click). Neither is OS-level input: events are isTrusted=false, so a widget that requires a real hand — typically a page asking the user to prove they are human by dragging a slider or completing a picture — will not move; ask the user to do that step. Both refs must be in the same frame.",
    params: {
      ref: "[ref] to drag",
      toRef: "[ref] to drop onto",
      method: "\"html5\" (default, native drag-and-drop events) or \"pointer\" (press, move, release — for pointer/mouse-based libraries)",
      confirm: "Required when the dragged control or the drop target is labelled with a risky word (the same list as click's confirm), e.g. dropping onto a 删除 bin. Pass it only when the user asked for that action",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.Upload]: {
    name: "browser_upload_file",
    description:
      "Attach one or more files to a <input type=file> with no native OS file dialog (pure extension). SOURCES — either a single `url` (fetched server-side: http(s) only, SSRF-guarded, sent with a same-origin Referer so image-host hotlink checks pass) or `localPath` (a file on the machine running this server), or an `attachments` LIST of those to fill a multi-image uploader in one call. Max 25MB each. The list is dispatched back-to-back with NO wait between files, so it only suits an uploader that swallows a burst; one that re-renders its slots between files (most React/Vue galleries) drops all but the first few — give those ONE file per playbook step and let the step's verify block until it landed. TARGET — a [ref], or a description (name/role/css/near/nth) exactly like click: prefer the description, because an upload re-renders the uploader and kills the refs around it, so a ref taken before the call is often dead by the next one. The <input type=file> is usually hidden behind a styled slot; name the VISIBLE slot and this resolves inward to the input. Works for uploaders that read input.files on a change event (most React/Vue widgets); a few that demand a trusted user gesture reject any injected file — there is NO drag fallback for those (drag carries no file payload), so report back and have the user attach it by hand.",
    params: {
      ref: "[ref] of the file input or its visible wrapper. Wins over the description fields; prefer a description when the page re-renders between uploads",
      role: 'ARIA role, explicit or implicit — e.g. "button" for a styled upload slot',
      name: "Accessible name of the file input or its visible slot: aria-label, associated <label>, placeholder, alt or title",
      css: "CSS selector, for markup that carries no usable semantics",
      near: "Keep only candidates within ~200px of the nearest element whose text matches this, closest first",
      nth: "0-based pick among matches; the explicit way out of a strict-match error. A filled slot usually drops its label, so nth:0 keeps naming the next EMPTY one",
      exact: "Match `name` exactly instead of as a substring",
      url: "Absolute http(s) URL of the file (mutually exclusive with localPath and attachments)",
      localPath: "Path to a file on the server machine (mutually exclusive with url and attachments)",
      filename: "Override the filename (defaults to the source's basename)",
      attachments: "List of {url|localPath, filename?, mimeType?} to attach in order — for a gallery/multi-image uploader. Mutually exclusive with the single url/localPath",
      batchSize: "How many of `attachments` to READ into memory at a time (fetch/disk), so a long list is not all held at once. It does NOT pace the dispatches — every file is still sent back-to-back. An uploader that re-renders between files (most React/Vue galleries do) needs one file per PLAYBOOK STEP, where the step's own verify blocks until the previous one landed; sequencing is the book's job, not this parameter's",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.Hover]: {
    name: "browser_hover",
    description:
      "Hover the pointer over an element by [ref] to reveal hover-only UI — tooltips, menus that open on mouseover. Read the page in the same beat (analyze_page/snapshot); hover UI vanishes on your next action. Snapshot first to get the [ref].",
    params: {
      ref: "[ref] of the element to hover",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.ClickText]: {
    name: "browser_click_text",
    description:
      "Fallback click when no [ref] fits: clicks the innermost visible element whose text matches — reaches bespoke UI the snapshot didn't surface. Prefer a real [ref] when you have one. Irreversible/external actions (submit/pay/delete/send) still need confirm:true.",
    params: {
      text: "Visible text to match",
      exact: "Exact (normalized) match instead of contains (default false)",
      nth: "0-based pick when several elements match (default 0)",
      confirm: "Required for irreversible/external actions",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.ContextMenu]: {
    name: "browser_right_click",
    description:
      "Right-click an element to open its CUSTOM context menu (file trees, table rows, canvas editors). " +
      "Chrome's own menu cannot be opened by any extension and is not what this does — this fires the `contextmenu` event the page listens for. " +
      "The reply says `defaultPrevented` when the page handled it, which is your signal a custom menu opened: read the page in the same beat, it closes on your next action. " +
      "Same targeting as click (ref, or a description).",
    params: {
      ref: "[ref] from the latest snapshot",
      text: "Visible text; resolves to the innermost element containing it",
      role: 'ARIA role, explicit or implicit — a <button> is "button" even with no ARIA markup',
      name: "Accessible name: aria-label, associated <label>, placeholder, alt or title",
      css: "CSS selector, for markup that carries no usable semantics",
      near: "Keep only candidates within ~200px of the nearest element whose text matches this, closest first",
      exact: "Match text/name exactly instead of as a substring",
      nth: "0-based pick among matches; the explicit way out of a strict-match error",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.DblClick]: {
    name: "browser_double_click",
    description:
      "Double-click an element — the gesture that opens a row, enters inline edit, or expands a tree node. " +
      "Not the same as calling click twice: the browser only fires a dblclick handler when the second click carries detail:2, which two separate click calls never do. " +
      "Same targeting and risk gate as click.",
    params: {
      ref: "[ref] from the latest snapshot",
      text: "Visible text; resolves to the innermost element containing it",
      role: 'ARIA role, explicit or implicit — a <button> is "button" even with no ARIA markup',
      name: "Accessible name: aria-label, associated <label>, placeholder, alt or title",
      css: "CSS selector, for markup that carries no usable semantics",
      near: "Keep only candidates within ~200px of the nearest element whose text matches this, closest first",
      exact: "Match text/name exactly instead of as a substring",
      nth: "0-based pick among matches; the explicit way out of a strict-match error",
      confirm: "Allow a risky/irreversible action — required when the target's label contains one of: 提交 删除 移除 清空 购买 下单 支付 付款 结算 发送 注销 退订 / confirm, delete, remove, submit, pay, buy, purchase, checkout, place order, send, sign out, log out, unsubscribe. Pass it only when the user asked for that action",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.Paste]: {
    name: "browser_paste_text",
    description:
      "Paste text into a field as a clipboard drop rather than as keystrokes. Use it for rich editors (Notion/Quill/ProseMirror-style) that listen for `paste` and build their own content model — type_text sends keys those editors may reformat or reject, and it is slow for long text. " +
      "The reply says `defaultPrevented` when the editor consumed the paste itself; otherwise the text was inserted here. Appends at the caret, it does not clear the field.",
    params: {
      ref: "[ref] from the latest snapshot",
      text: "Text to paste",
      role: 'ARIA role, explicit or implicit — a <button> is "button" even with no ARIA markup',
      name: "Accessible name: aria-label, associated <label>, placeholder, alt or title",
      css: "CSS selector, for fields with no usable semantics",
      near: "Keep only candidates within ~200px of the nearest element with this text, closest first",
      exact: "Match text/name exactly instead of as a substring",
      nth: "0-based pick among matches; the explicit way out of a strict-match error",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.ReadNetwork]: {
    name: "browser_read_network",
    description:
      "List recent XHR/fetch requests for the tab (method, URL, HTTP status) captured since the extension woke. Use to confirm a save/submit actually reached the server and returned 2xx, instead of guessing from the UI. Metadata only — no response bodies (that needs CDP, which this extension avoids).",
    params: {
      limit: "Max requests to return (default 20)",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.SetNetworkCapture]: {
    name: "browser_set_network_capture",
    description:
      "Turn fetch/XHR RESPONSE-BODY capture on or off for a tab (default OFF). When ON, JSON/text API responses on that tab surface as `network_body` events (read via read_events or the piggyback line) — the only way to see actual response bodies without CDP, so you can verify a save/submit's real result instead of trusting the UI or a bare HTTP status. Captures requests made AFTER you enable it; turn OFF when done to keep the page un-patched (lower detectability).",
    params: {
      enabled: "true = start capturing bodies on this tab; false = stop",
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
    },
  },
  [RpcMethod.PageState]: {
    name: "browser_page_state",
    description:
      "Coherent one-shot STATE of a tab from a SINGLE atomic read (nothing drifts between fields): url/title, whether it's still loading, interactable-element count, scroll position (+ more above/below), the focused control (which [ref], is it a text field, caret/selection), a form submittability summary (filled / empty-required / invalid / dirty counts), open dialogs, overlay/scroll-lock, a busy-region count, the visible-error count, and `changed` = what moved since YOUR last page_state on this tab. This is the cheap perceive→verify instrument — call it each beat to orient and to confirm the last action landed. It returns NO element tree/[ref]s (use snapshot), NO text (use read_content), NO pixels (use screenshot); analyze_page bundles all of those. verbosity:\"detail\" adds dialog names, the error texts, and the blocking form fields.",
    params: {
      tabId: "Target tab id (from new_window/new_tab/list_tabs); omit for the active tab",
      verbosity: '"detail" adds dialog names, error texts, and blocking form fields; default "summary"',
      resetDelta: "Refresh the change baseline without reporting `changed` — use on the first beat after you know the page changed",
    },
  },
} satisfies Record<RpcMethod, McpToolInstruction>;

/**
 * ── SKIPPED (no RpcMethod constant, or a LocalMethod/composite) ──────────────
 *
 * These `server.registerTool(...)` calls in browser-mcp.ts have NO 1:1
 * RpcMethod key (they are pure backend orchestration, composites of several
 * RPCs, or use LocalMethod instead of RpcMethod), so they are intentionally
 * absent from MCP_TOOL_INSTRUCTIONS. Keeping them out (rather than reusing a
 * nearby RpcMethod key as a placeholder) stops a fake "browser_*" name from
 * entering lookup tables that must address each RpcMethod exactly once.
 *
 * Orchestration / registry / session (backend-only state, no browser RPC):
 *   - list_browsers
 *   - use_browser
 *   - claim_tab
 *   - set_browser_mode
 *   - browser_state
 *
 * Event store (backend buffered events, no browser RPC):
 *   - read_events
 *   - wait_for_event
 *
 * Composite tools (compose several RPCs; no single RpcMethod):
 *   - analyze_page   (ListTabs + PageState + Snapshot + ReadContent + Screenshot)
 *   - batch          (Click / Type / SelectOption / PressKey / Hover / Scroll)
 *   - pick_option    (Click + WaitFor + Snapshot + Click)
 *
 * Plan runner (P0 orchestration):
 *   - plan
 *   - advance
 *   - plan_status
 *   - plan_abort
 *   - record_stop
 *   - run_playbook
 *   - list_playbooks
 *
 * Local-method tools (LocalMethod, not RpcMethod):
 *   - local_eval     -> LocalMethod.Eval
 *   - write_file     -> LocalMethod.WriteFile
 *
 * NOTE: RpcMethod.SetWindowState has NO MCP tool registered today (it only
 * appears in browser-mcp.ts's TAB_SCOPED / MANUAL_READ_FALLBACK sets), yet it
 * is present above because `Record<RpcMethod, McpToolInstruction>` demands an
 * entry for every RpcMethod. Its description/params come from the RpcContracts
 * JSDoc in index.ts.
 */
