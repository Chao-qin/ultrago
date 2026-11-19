/**
 * Argument shapes shared by more than one tool.
 *
 * `verifyShape` and `stepShape` are referenced by both the plan family and
 * batch, and `looseBool` by most tools that take a flag — keeping them in one
 * place is what lets the tool registrations be split up without each group
 * growing its own copy of the contract.
 */
import { z } from "zod";
import { LOCATOR_DOCS, TAB_ID_DOC } from "@bcp/shared";

/** Tolerant boolean for MCP args: some clients (or a stringifying transport) send
 * booleans as JSON strings. Map "true"/"false" (and "1"/"0") to real booleans,
 * but reject anything else. Deliberately NOT z.coerce.boolean() — its Boolean()
 * coercion turns "false" into true, which would silently OPEN a confirm gate. */
export const looseBool = z.preprocess(
(v) => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v),
z.boolean(),
);

export const verifyShape = z
  .object({
    actionSucceeded: looseBool.optional().describe("The current step has an action that returned successfully; use for terminal actions such as close_tab"),
    urlIncludes: z.string().min(1).optional(),
    textPresent: z.string().min(1).optional(),
    textAbsent: z.string().min(1).optional(),
    elementName: z.string().min(1).optional(),
    elementChecked: z.string().min(1).optional(),
    elementEnabled: z.string().min(1).optional(),
    elementValue: z.object({ name: z.string().min(1), equals: z.string().optional(), includes: z.string().optional() }).optional(),
    assert: z.string().min(1).optional().describe("Agent-judged TEXT claim — after mechanical checks pass, you confirm it via advance's confirm; forces a look, weaker than structured checks"),
    visualAssert: z.string().min(1).optional().describe("Agent-judged VISUAL claim — the runner screenshots and hands you the image to confirm (for canvas / image correctness / pixels the structured checks & text can't see)"),
    networkOk: z
      .object({ urlIncludes: z.string().min(1), status: z.coerce.number().optional(), bodyIncludes: z.string().min(1).optional() })
      .optional(),
    evalCheck: z
      .object({ code: z.string().min(1), equals: z.string().optional() })
      .optional()
      .describe("Runner runs this page JS and gates on its value (equals, or truthy). Arbitrary expressiveness; read-only; refused only when the backend runs with BCP_EVAL=off"),
    noErrors: looseBool.optional(),
    settled: looseBool.optional(),
    dialogOpen: looseBool.optional(),
    formSubmittable: looseBool.optional(),
  })
  .describe("Structured done-criteria the runner checks itself; all present fields must hold (ANDed).");
export const stepShape = z.object({
  goal: z.string().describe("What this step accomplishes"),
  verify: verifyShape,
  onFail: z.enum(["retry", "rescan", "escalate"]).optional().describe('Recovery on a failed verify (default "escalate")'),
  maxRetries: z.coerce.number().optional().describe("Retry/rescan budget before a forced escalate (default 1)"),
  risk: z.enum(["confirm"]).optional().describe('Mark this step irreversible (submit/delete/pay/send/publish). If this plan is being recorded, the marker carries into the saved playbook, where auto playback will always pause before executing it.'),
});

export const tabId = z.coerce.number().optional().describe(TAB_ID_DOC);

/** Every element locator field, described once. Tools that target an element
 *  spread the subset they support, so "same targeting as click" holds by
 *  construction rather than by each registration copying the list. */
export const locatorShape = {
  ref: z.string().optional().describe(LOCATOR_DOCS.ref),
  text: z.string().optional().describe(LOCATOR_DOCS.text),
  role: z.string().optional().describe(LOCATOR_DOCS.role),
  name: z.string().optional().describe(LOCATOR_DOCS.name),
  css: z.string().optional().describe(LOCATOR_DOCS.css),
  near: z.string().optional().describe(LOCATOR_DOCS.near),
  exact: looseBool.optional().describe(LOCATOR_DOCS.exact),
  nth: z.coerce.number().int().nonnegative().optional().describe(LOCATOR_DOCS.nth),
  x: z.coerce.number().optional().describe(LOCATOR_DOCS.x),
  y: z.coerce.number().optional().describe(LOCATOR_DOCS.y),
};
