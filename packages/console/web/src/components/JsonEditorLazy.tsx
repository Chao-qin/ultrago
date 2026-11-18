import { lazy, Suspense } from "react";
import type { JSX } from "react";
import type { JsonEditorProps } from "./JsonEditor";

const JsonEditorImpl = lazy(async () => {
  const module = await import("./JsonEditor");
  return { default: module.JsonEditor };
});

/** Loads CodeMirror only when a JSON field is opened. */
export function JsonEditor(props: JsonEditorProps): JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="console-json-editor console-json-editor__loading" style={{ height: (props.height ?? 176) + 31 }} aria-busy="true">
          正在加载 JSON 编辑器…
        </div>
      }
    >
      <JsonEditorImpl {...props} />
    </Suspense>
  );
}
