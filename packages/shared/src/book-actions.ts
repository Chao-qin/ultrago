import type { RpcContracts, RpcMethod, LocalMethod } from "./index.js";

/** A playbook step's action, discriminated by `method`. Writing
 * `method: "browser.click"` narrows `params` to Click's contract at compile
 * time — instead of the previous-inline `Record<string, unknown>`, which
 * accepted typos silently.
 *
 * Derived from RpcMethod/LocalMethod via mapped types, so a newly added RPC
 * method is covered automatically without hand-maintaining a union. The
 * LocalMethod branches cast their params to a concrete shape because
 * `RpcContracts` has no entries for local (backend-only) methods.
 *
 * Note: this is the AUTHORED-playbook shape. When codegen reads a playbook
 * JSON it keeps `params` as raw `{{name}}`-placeholder strings and only
 * validates placeholders against the book's declared `params[]` — it does
 * NOT type-check the runtime params against this union, because at authoring
 * time the values are placeholder literals, not concrete types.
 */
export type PlaybookAction =
  | {
      [K in RpcMethod]: {
        method: K;
        params: RpcContracts[K]["params"];
      };
    }[RpcMethod]
  | {
      [K in LocalMethod]: {
        method: K;
        params: K extends typeof LocalMethod.Eval
          ? { code: string }
          : K extends typeof LocalMethod.WriteFile
            ? { path: string }
            : never;
      };
    }[LocalMethod];