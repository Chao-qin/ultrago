/**
 * The code editor for an inline script node.
 *
 * Three bands: the derived signature above, the author's body in the middle,
 * and the derived stdin/stdout plumbing below. Only the middle one is editable,
 * and only the middle one is stored — the other two are recomputed from the
 * node's contracts every render, so changing a contract updates the signature
 * without touching what the author wrote.
 *
 * The read-only bands are shown rather than hidden because they are the answer
 * to "what is `params`?". Hiding them would put the question right back where
 * it was: answerable only by reading the runner's source.
 */
import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { bracketMatching, indentRange, indentUnit, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { autocompletion, closeBrackets, closeBracketsKeymap, completeFromList, completionKeymap, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { javascript, localCompletionSource, typescriptSnippets } from "@codemirror/lang-javascript";
import { Button, Space, theme as antdTheme } from "antd";
import { scriptSkeleton, type ScriptLanguage } from "@bcp/shared";
import type { ParamSchemaFragment } from "@bcp/shared";
import { useTheme } from '../theme';

interface Props {
  language: ScriptLanguage;
  /** The BODY only — never the whole program. */
  value?: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  inputSchema: ParamSchemaFragment | null;
  outputSchema: ParamSchemaFragment | null;
  /** How tall the editable band may grow. The inspector's preview wants a
   *  small ceiling; the workbench wants the whole window, because a code editor
   *  that shows eight lines is a code editor nobody writes code in. */
  height?: number | string;
  fill?: boolean;
  revealLine?: number;
  revealKey?: number;
}

/** Inline bodies are TypeScript only (see `SCRIPT_LANGUAGES`), so there is one
 *  grammar. Kept as a function taking the language so the compartment below
 *  stays the seam it would need to be if that ever changes. */
function languageExtension(_language: ScriptLanguage) {
  return javascript({ typescript: true });
}

const EDITOR_CHROME = EditorView.theme(
  {
    '&': { color: 'var(--c-ink-1)', backgroundColor: 'transparent' },
    '.cm-content': { caretColor: 'var(--c-accent)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--c-accent)' },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: 'color-mix(in srgb, var(--c-accent) 20%, transparent)',
    },
    '.cm-activeLine': { backgroundColor: 'var(--c-subtle)' },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: 'var(--c-ink-3)',
      border: "none",
    },
    '.cm-activeLineGutter': { backgroundColor: 'var(--c-subtle)', color: 'var(--c-ink-2)' },
    '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--c-accent) 15%, transparent)' },
    '.cm-tooltip-autocomplete': { border: '1px solid var(--c-line)', backgroundColor: 'var(--c-surface)' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--c-subtle)', color: 'var(--c-ink-1)' },
  },
);

const EDITOR_HIGHLIGHT = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: 'var(--c-info)' },
  { tag: [t.name, t.variableName, t.definition(t.variableName)], color: 'var(--c-ink-1)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.propertyName], color: 'var(--c-info)' },
  { tag: [t.string, t.special(t.string), t.typeName, t.className], color: 'var(--c-ok)' },
  { tag: [t.number, t.bool, t.null, t.self], color: 'var(--c-warn)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--c-ink-3)', fontStyle: 'italic' },
  { tag: [t.operator, t.operatorKeyword, t.punctuation, t.separator], color: 'var(--c-ink-2)' },
  { tag: t.invalid, color: 'var(--c-bad)' },
]);

/**
 * Completions for `params.` — the fields this node actually declares.
 *
 * The one thing an editor library cannot supply. `localCompletionSource` sees
 * variables in the body and TypeScript's own service is not running in this
 * browser, so without this, typing `params.` offers nothing at all — while the
 * answer is sitting in the node's input contract, which the panel above the
 * editor is already displaying.
 *
 * It is also the question this whole editor was built to answer, the one that
 * started the flow work: "我完全不知道脚本节点的入参怎么消费".
 */
function paramsCompletions(inputSchema: ParamSchemaFragment | null) {
  const props = inputSchema && typeof inputSchema === "object" ? inputSchema.properties : null;
  const required = new Set(
    Array.isArray(inputSchema?.required) ? inputSchema.required.filter((v): v is string => typeof v === "string") : [],
  );
  const fields =
    props && typeof props === "object"
      ? Object.entries(props).map(([name, schema]) => {
          const type = (schema as ParamSchemaFragment | null)?.type;
          return {
            label: name,
            type: "property",
            // The declared type and whether it is optional, which is what you
            // actually need to know before writing the next character.
            detail: `${typeof type === "string" ? type : "unknown"}${required.has(name) ? "" : "?"}`,
          };
        })
      : [];

  return (context: CompletionContext): CompletionResult | null => {
    if (fields.length === 0) return null;
    // Only right after `params.` — offering these field names anywhere else
    // would put a product's field list in front of someone writing a loop
    // variable, which is noise pretending to be help.
    const after = context.matchBefore(/params\.\w*/);
    if (!after) return null;
    return { from: after.from + "params.".length, options: fields, validFor: /^\w*$/ };
  };
}

export function ScriptEditor({ language, value = '', onChange, inputSchema, outputSchema, height = 320, fill = false, readOnly = false, revealLine, revealKey }: Props): JSX.Element {
  const { mode } = useTheme();
  const { token } = antdTheme.useToken();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const languageSlot = useRef(new Compartment());
  const editabilitySlot = useRef(new Compartment());
  const themeSlot = useRef(new Compartment());
  const [showWrapper, setShowWrapper] = useState(false);
  // The params source is read through a ref for the same reason `onChange` is:
  // the contract changes when someone picks a different schema, and the editor
  // must not be rebuilt for it — rebuilding drops the cursor and the history.
  const completionSourceRef = useRef(paramsCompletions(inputSchema));
  completionSourceRef.current = paramsCompletions(inputSchema);
  // The callback the editor calls is read through a ref, so a new `onChange`
  // identity on every parent render does not force the editor to be rebuilt —
  // rebuilding it would drop the cursor and the undo history mid-typing.
  const emit = useRef(onChange);
  emit.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          // Tabs and other invisibles show as a dot rather than as nothing —
          // a stray tab in indented code is otherwise a difference you cannot
          // see and the runtime can.
          highlightSpecialChars(),
          syntaxHighlighting(EDITOR_HIGHLIGHT, { fallback: true }),
          EDITOR_CHROME,
          editabilitySlot.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          themeSlot.current.of(EditorView.theme({}, { dark: mode === 'dark' })),
          EditorView.contentAttributes.of({ 'aria-label': '脚本代码编辑器', role: 'textbox', 'aria-multiline': 'true' }),
          // `override` rather than registering on a language's data facet.
          // `javascript({ typescript: true })` installs `typescriptLanguage`,
          // which is NOT `javascriptLanguage` — sources registered on the
          // latter simply never fire, silently, which is how the first version
          // of this shipped. An explicit list cannot miss the language it was
          // meant for.
          autocompletion({
            defaultKeymap: false,
            override: [
              (context: CompletionContext) => completionSourceRef.current(context),
              localCompletionSource,
              completeFromList(typescriptSnippets),
            ],
          }),
          // Tab inserts an indent rather than moving focus out of the editor,
          // which is what `indentWithTab` below needs a width for.
          indentUnit.of("  "),
          // Order matters: the completion and bracket bindings go FIRST, so
          // Enter accepts a completion when the popup is open and Escape closes
          // it, and only fall through to the default behaviour when it is not.
          // `indentWithTab` sits last for the same reason — Tab should cycle
          // completions before it indents.
          keymap.of([
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...historyKeymap,
            { key: "Mod-/", run: toggleComment },
            ...defaultKeymap,
            indentWithTab,
          ]),
          languageSlot.current.of(languageExtension(language)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) emit.current?.(update.state.doc.toString());
          }),
          EditorView.theme({ "&": { fontSize: "12px" }, ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" } }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Built once for the lifetime of this node's panel. `value` and `language`
    // are pushed in by the effects below instead of listed here, because
    // rebuilding on either would discard the cursor on every keystroke.
  }, []);

  // A language switch reconfigures the compartment rather than rebuilding the
  // editor, so the document survives. There is one language today; this is the
  // seam that keeps adding another from being a rewrite.
  useEffect(() => {
    view.current?.dispatch({ effects: [languageSlot.current.reconfigure(languageExtension(language))] });
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({ effects: editabilitySlot.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);
  useEffect(() => {
    view.current?.dispatch({ effects: themeSlot.current.reconfigure(EditorView.theme({}, { dark: mode === 'dark' })) });
  }, [mode]);


  // Only when the two genuinely disagree: echoing back the value the editor
  // just produced would reset the selection on every keystroke.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !revealLine || revealLine > editor.state.doc.lines) return;
    const line = editor.state.doc.line(revealLine);
    editor.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    editor.focus();
  }, [revealKey, revealLine]);

  const skeleton = scriptSkeleton(language, inputSchema, outputSchema);
  const fixed: React.CSSProperties = {
    margin: 0,
    padding: "6px 8px",
    fontSize: 11,
    lineHeight: 1.5,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: token.colorTextTertiary,
    background: token.colorFillQuaternary,
    whiteSpace: "pre",
    overflowX: "auto",
  };

  return (
    <div
      style={{
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 4,
        overflow: "hidden",
        ...(fill ? { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } : {}),
      }}
      >
      <div className='script-editor__toolbar'>
        <Space size={4}>
          <Button size='small' type='text' onClick={() => setShowWrapper((visible) => !visible)}>
            {showWrapper ? '隐藏运行包装' : '查看运行包装'}
          </Button>
          <Button
            size='small'
            type='text'
            disabled={readOnly}
            onClick={() => {
              const editor = view.current;
              if (!editor) return;
              editor.dispatch({ changes: indentRange(editor.state, 0, editor.state.doc.length) });
              editor.focus();
            }}
          >
            格式化代码
          </Button>
        </Space>
      </div>
      {showWrapper && <pre style={{ ...fixed, borderBottom: `1px solid ${token.colorBorderSecondary}`, flex: "none" }}>{skeleton.header}</pre>}
      <div ref={host} style={fill ? { flex: 1, minHeight: 0, overflowY: "auto" } : { maxHeight: height, overflowY: "auto" }} />
      {showWrapper && <pre style={{ ...fixed, borderTop: `1px solid ${token.colorBorderSecondary}`, flex: "none" }}>{skeleton.footer.replace(/^\n+/, "")}</pre>}
    </div>
  );
}
