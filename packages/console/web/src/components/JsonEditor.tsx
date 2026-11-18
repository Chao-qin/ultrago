import { useEffect, useMemo, useRef } from "react";
import { Button, Tooltip } from "antd";
import { FormatPainterOutlined } from "@ant-design/icons";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { bracketMatching, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { EditorView, keymap, lineNumbers, placeholder as editorPlaceholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export interface JsonEditorProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  height?: number;
  readOnly?: boolean;
  expected?: "any" | "object";
  ariaLabel?: string;
}

type JsonState =
  | { valid: true; empty: boolean; value?: unknown }
  | { valid: false; message: string };

const jsonTheme = EditorView.theme({
  "&": { color: "var(--c-ink-1)", backgroundColor: "var(--c-subtle)", fontSize: "12px" },
  ".cm-content": { caretColor: "var(--c-accent)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--c-accent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--c-accent) 20%, transparent)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--c-accent) 6%, transparent)" },
  ".cm-gutters": { color: "var(--c-ink-3)", backgroundColor: "color-mix(in srgb, var(--c-subtle) 76%, var(--c-bg))", borderRight: "1px solid var(--c-line)" },
  ".cm-activeLineGutter": { color: "var(--c-ink-2)", backgroundColor: "color-mix(in srgb, var(--c-accent) 7%, transparent)" },
});

const jsonHighlight = HighlightStyle.define([
  { tag: t.propertyName, color: "var(--c-info)" },
  { tag: t.string, color: "var(--c-ok)" },
  { tag: [t.number, t.bool, t.null], color: "var(--c-warn)" },
  { tag: [t.punctuation, t.separator], color: "var(--c-ink-3)" },
  { tag: t.invalid, color: "var(--c-bad)" },
]);

function inspectJson(text: string, expected: JsonEditorProps["expected"]): JsonState {
  if (!text.trim()) return { valid: true, empty: true };
  try {
    const value: unknown = JSON.parse(text);
    if (expected === "object" && (!value || typeof value !== "object" || Array.isArray(value))) {
      return { valid: false, message: "请输入 JSON 对象" };
    }
    return { valid: true, empty: false, value };
  } catch (error) {
    return { valid: false, message: error instanceof Error ? error.message : "JSON 格式无效" };
  }
}

/** A compact CodeMirror surface for JSON input and inspection. */
export function JsonEditor({
  value = "",
  onChange,
  placeholder = '{"key": "value"}',
  height = 176,
  readOnly = false,
  expected = "any",
  ariaLabel = "JSON 编辑器",
}: JsonEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const emit = useRef(onChange);
  emit.current = onChange;
  const state = useMemo(() => inspectJson(value, expected), [expected, value]);

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
          javascript(),
          syntaxHighlighting(jsonHighlight, { fallback: true }),
          jsonTheme,
          editorPlaceholder(placeholder),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
          keymap.of([...closeBracketsKeymap, ...historyKeymap, ...defaultKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) emit.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [ariaLabel, placeholder, readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  const format = () => {
    if (!state.valid || state.empty) return;
    onChange?.(JSON.stringify(state.value, null, 2));
  };

  return (
    <div className={`console-json-editor${state.valid ? "" : " console-json-editor--invalid"}`}>
      <div className="console-json-editor__toolbar">
        <span>JSON</span>
        <span className={state.valid ? "console-json-editor__status" : "console-json-editor__status console-json-editor__status--invalid"}>
          {state.valid ? (state.empty ? "等待输入" : "格式有效") : state.message}
        </span>
        {!readOnly && (
          <Tooltip title="格式化 JSON">
            <Button
              type="text"
              size="small"
              icon={<FormatPainterOutlined />}
              disabled={!state.valid || state.empty}
              onClick={format}
              aria-label="格式化 JSON"
            />
          </Tooltip>
        )}
      </div>
      <div ref={host} className="console-json-editor__body" style={{ height }} />
    </div>
  );
}
