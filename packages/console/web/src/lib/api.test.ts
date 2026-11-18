import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "./api.js";

/**
 * These tests exist because a dropped query parameter is invisible from the
 * screen. `listSchemaRecords` took `sourcePrefix` in its signature and never
 * put it in the URL: the server answered with every SchemaRecord row instead
 * of the one run's, the page picked its row out with `.find()`, and the render
 * was correct. Only the transferred bytes were wrong — which no typecheck and
 * no click-through can see. So the assertions here are on the URL the client
 * builds, not on what the caller gets back.
 */

const realFetch = globalThis.fetch;
let seen: string[] = [];

beforeEach(() => {
  seen = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The URL the last call actually requested, parsed for inspection. */
function lastUrl(): URL {
  assert.equal(seen.length, 1, `expected exactly one request, got ${seen.length}`);
  // Relative paths need a base to parse; the origin is irrelevant to the assertions.
  return new URL(seen[0], "http://console.invalid");
}

function lastQuery(): URLSearchParams {
  return lastUrl().searchParams;
}

/** Assert where the request went, not just what it carried. Asserting only the
 *  query string leaves the endpoint itself untested — a typo in the path fails
 *  identically to a dropped filter (the server answers, wrongly or not at all),
 *  and every assertion here would still pass. */
function assertPath(expected: string): void {
  assert.equal(lastUrl().pathname, expected);
}

test("listSchemaRecords sends sourcePrefix as a query parameter", async () => {
  await api.listSchemaRecords({ sourcePrefix: "run:abc123" });
  assertPath("/api/schema-records");
  assert.equal(lastQuery().get("sourcePrefix"), "run:abc123");
});

test("listSchemaRecords sends every filter it was given", async () => {
  await api.listSchemaRecords({
    schemaName: "product",
    sourcePrefix: "flow:xyz789",
    includeDeleted: true,
  });
  assertPath("/api/schema-records");
  const q = lastQuery();
  assert.equal(q.get("schemaName"), "product");
  assert.equal(q.get("sourcePrefix"), "flow:xyz789");
  assert.equal(q.get("includeDeleted"), "true");
  // The detail-page flavour must NOT opt into the projection: it needs the
  // payload bodies it narrowed down to.
  assert.equal(q.get("preview"), null);
});

test("listSchemaRecordPreviews asks for the projection, on the same endpoint", async () => {
  await api.listSchemaRecordPreviews({ schemaName: "product", includeDeleted: true });
  // Same path as the full list — one endpoint, two projections. A separate URL
  // here would be a second route nobody registered.
  assertPath("/api/schema-records");
  const q = lastQuery();
  assert.equal(q.get("preview"), "true");
  assert.equal(q.get("schemaName"), "product");
  assert.equal(q.get("includeDeleted"), "true");
});

test("listSchemaRecordPreviews sends preview even with no other filter", async () => {
  // The browse page's default call. `preview` is not a filter the caller opts
  // into — it is the shape this function promises in its return type.
  await api.listSchemaRecordPreviews();
  assertPath("/api/schema-records");
  assert.equal(lastQuery().get("preview"), "true");
});

test("listSchemaRecords omits filters it was not given", async () => {
  await api.listSchemaRecords({ sourcePrefix: "run:only" });
  const q = lastQuery();
  assert.equal(q.get("sourcePrefix"), "run:only");
  // An unasked-for filter must not appear at all — sending `schemaName=` would
  // be a different query from sending nothing.
  assert.equal(q.get("schemaName"), null);
  assert.equal(q.get("includeDeleted"), null);
});

test("listBooks asks for deleted rows only when told to", async () => {
  // Default off: the switch changes what the page shows, so a default-on flag
  // would silently alter the list for everyone who never touched it.
  await api.listBooks();
  assertPath("/api/books");
  assert.equal(lastQuery().get("includeDeleted"), null);

  seen = [];
  await api.listBooks({ includeDeleted: true });
  assertPath("/api/books");
  assert.equal(lastQuery().get("includeDeleted"), "true");
});

test("listBooks({ includeDeleted: false }) is the same request as no argument", async () => {
  // Schedules and FlowEditor spell the default explicitly so their query key
  // can carry it; that only shares a cache entry with the Books page's default
  // view if the URL is identical too.
  await api.listBooks({ includeDeleted: false });
  const explicit = seen[0];
  seen = [];
  await api.listBooks();
  assert.equal(explicit, seen[0]);
});

test("listSchedules asks for deleted rows only when told to", async () => {
  await api.listSchedules();
  assertPath("/api/schedules");
  assert.equal(lastQuery().get("includeDeleted"), null);

  seen = [];
  await api.listSchedules({ includeDeleted: true });
  assertPath("/api/schedules");
  assert.equal(lastQuery().get("includeDeleted"), "true");
});
