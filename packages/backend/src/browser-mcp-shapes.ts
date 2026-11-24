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
    actionSucceeded: looseBool.optional().describe("The step's action returned successfully — for steps that leave nothing to check, such as close_tab"),
    urlIncludes: z.string().min(1).optional().describe("The tab's URL contains this"),
    textPresent: z.string().min(1).optional().describe("The top frame's visible text contains this — use it for status banners, which snapshot may not list"),
    textAbsent: z.string().min(1).optional().describe("The top frame's visible text does not contain this"),
    elementName: z.string().min(1).optional().describe("An interactable element whose accessible name contains this exists"),
    elementChecked: z.string().min(1).optional().describe("An element whose accessible name contains this is checked"),
    elementEnabled: z.string().min(1).optional().describe("An element whose accessible name contains this is enabled"),
    elementValue: z
      .object({
        name: z.string().min(1).describe("Text the element's accessible name contains"),
        equals: z.string().optional().describe("The exact value expected; takes precedence over includes"),
        includes: z.string().optional().describe("Text the value contains"),
      })
      .optional()
      .describe("An element named like `name` has a value that equals `equals`, else contains `includes`, else is set at all"),
    assert: z.string().min(1).optional().describe("A claim you judge yourself: once the other checks pass, advance asks you to confirm it"),
    visualAssert: z.string().min(1).optional().describe("A visual claim you judge from a screenshot the runner attaches — for canvas, images or layout"),
    networkOk: z
      .object({
        urlIncludes: z.string().min(1).describe("Text the request URL contains"),
        status: z.coerce.number().optional().describe("Required HTTP status; default any 2xx"),
        bodyIncludes: z.string().min(1).optional().describe("Text the response body contains; body capture is turned on for the step"),
      })
      .optional()
      .describe("A matching request completed since the step started"),
    evalCheck: z
      .object({
        code: z.string().min(1).describe("Page JavaScript that reads and returns a value synchronously"),
        equals: z.string().optional().describe("Expected result, compared as a string; omit to require a truthy result"),
      })
      .optional()
      .describe("The runner evaluates read-only page JavaScript and checks the result. The check fails if the code changes the DOM, focuses, scrolls, sets an input value, fires events, navigates, sends requests, writes storage, uses async/await, schedules work for later (timers, promise callbacks) or returns a Promise. Refused when the backend runs with BCP_EVAL=off"),
    evalUntil: z
      .object({
        code: z.string().min(1).describe("Page JavaScript that may act (click, scroll, await bcpWait) and returns whether the step is done"),
        equals: z.string().optional().describe("Expected result, compared as a string; omit to require a truthy result"),
      })
      .optional()
      .describe("Like evalCheck, but the code may act and is run again on every advance and retry until it holds, so a step can drive the page one round per attempt. Keep it safe to repeat; it is not behind the confirm gate. Runs after every other check. Refused when the backend runs with BCP_EVAL=off"),
    noErrors: looseBool.optional().describe("No visible field is marked invalid (aria-invalid). A message the page shows without marking its field is not counted — check that one with textAbsent"),
    settled: looseBool.optional().describe("The page has finished loading and rendering"),
    dialogOpen: looseBool.optional().describe("A dialog or modal is open"),
    formSubmittable: looseBool.optional().describe("The page has form controls and none is required-empty or invalid"),
  })
  .describe("Done-criteria the runner checks itself; every field given must hold. Boolean fields only count when true");
export const stepShape = z.object({
  goal: z.string().describe("What this step achieves"),
  verify: verifyShape,
  onFail: z.enum(["retry", "rescan", "escalate"]).optional().describe('On a failed verify: "retry" redoes the step, "rescan" re-reads the page and redoes it (both within maxRetries), "escalate" (default) stops and reports'),
  maxRetries: z.coerce.number().optional().describe("Retries or rescans before escalating (default 1)"),
  risk: z.enum(["confirm"]).optional().describe('"confirm" marks an irreversible step (submit, delete, pay, send, publish); in a recorded playbook, auto mode always pauses before it'),
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
