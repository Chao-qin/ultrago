/**
 * Is a step's verify strong enough to be evidence?
 *
 * `settled` says the DOM stopped moving. `noErrors` says nothing threw.
 * `actionSucceeded` says the call returned. A step can pass all three having
 * clicked entirely the wrong element — `baidu-hot-search` step 1 verifies
 * exactly `{noErrors, settled}`.
 *
 * This used to be the gate on locator enrichment (learned dimensions were only
 * written back into a book from steps whose verify could have caught a wrong
 * match). That machinery is gone — relaxing a locator to recover from a miss
 * makes it match MORE things, so a "recovery" could drive a step into a
 * different element than the author named, and the write-back edited books
 * silently, leaving no trace of who changed what.
 *
 * The predicate outlives it because the question it answers is the useful part:
 * a step verified only by these three has proven nothing about WHAT it acted
 * on. Keep it as an authoring/lint judgement, not as a runtime gate.
 */
import type { StepVerify } from "@bcp/shared";

const WEAK_VERIFY_KEYS = new Set<keyof StepVerify>(["actionSucceeded", "noErrors", "settled"]);

export function verifyIsSubstantive(verify: StepVerify | undefined): boolean {
  if (!verify) return false;
  return Object.entries(verify).some(
    ([key, value]) =>
      value !== undefined &&
      value !== false &&
      !WEAK_VERIFY_KEYS.has(key as keyof StepVerify),
  );
}
