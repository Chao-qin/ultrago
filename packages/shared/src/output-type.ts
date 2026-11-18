export type OutputType = "json" | "markdown" | "text" | "number" | "boolean" | "null" | "unknown";

export interface TypedOutput {
  data: string;
  type: OutputType;
  contentType: string;
}

export function classifyOutput(value: unknown): TypedOutput {
  if (value === null || value === undefined) return { data: "", type: "null", contentType: "application/json" };
  if (typeof value === "number") return { data: String(value), type: "number", contentType: "application/json" };
  if (typeof value === "boolean") return { data: String(value), type: "boolean", contentType: "application/json" };
  if (typeof value === "string") {
    // A book that serializes its result before returning it still produced a
    // JSON document, and labelling that document text/plain misleads every
    // consumer downstream. Only object/array payloads count: "123" and "true"
    // are parseable too, but calling those JSON would relabel ordinary text.
    if (isJsonDocument(value)) return { data: value, type: "json", contentType: "application/json" };
    const markdown = /(^|\n)#{1,6}\s|\|.+\|/.test(value);
    return { data: value, type: markdown ? "markdown" : "text", contentType: markdown ? "text/markdown" : "text/plain" };
  }
  try {
    return { data: JSON.stringify(value), type: "json", contentType: "application/json" };
  } catch {
    return { data: String(value), type: "unknown", contentType: "text/plain" };
  }
}

/** Does this string hold a JSON object or array?
 *
 *  The opening brace/bracket IS the rule, not just a fast path: anything that
 *  starts with one and parses can only be an object or an array, while "123"
 *  and "true" parse just as well and must stay text. Checking the first
 *  character also keeps ordinary prose out of a try/catch. */
function isJsonDocument(value: string): boolean {
  const head = value.trimStart()[0];
  if (head !== "{" && head !== "[") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
