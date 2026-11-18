import type { Query, SqlLintResult } from "@prisma/studio-core/data";
import type { SerializedError } from "@prisma/studio-core/data/bff";

/** Wire contract between `createStudioBFFClient()` (browser) and our
 *  `POST /api/studio` route. Mirrors the shipped client in
 *  `@prisma/studio-core/data/bff` — every field below is one the client
 *  actually sends or unpacks, so changing a name here silently breaks Studio.
 *
 *  `query-insights` is intentionally absent: the client only issues it when
 *  constructed with `queryInsights: true`, which we don't do (it's a Prisma
 *  Postgres feature and would just render an empty Queries tab).
 */
export type StudioRequest =
  | { procedure: "query"; query: Query<unknown>; schema?: string }
  | { procedure: "sequence"; sequence: readonly [Query<unknown>, Query<unknown>] }
  | { procedure: "transaction"; queries: readonly Query<unknown>[] }
  | { procedure: "sql-lint"; sql: string; schema?: string; schemaVersion?: string };

const PROCEDURES: ReadonlySet<string> = new Set<StudioRequest["procedure"]>([
  "query",
  "sequence",
  "transaction",
  "sql-lint",
]);

export function isStudioRequest(body: unknown): body is StudioRequest {
  return typeof body === "object" && body !== null && PROCEDURES.has((body as { procedure?: unknown }).procedure as string);
}

/** `[error]` on failure, `[null, result]` on success. Note the error travels
 *  in a 200 response — the client only reads `res.text()` on a non-2xx, which
 *  would lose the structured message. */
export type StudioResult<T> = [SerializedError] | [null, T];

export type StudioResponse =
  /** query */
  | StudioResult<unknown[]>
  /** transaction */
  | StudioResult<unknown[][]>
  /** sql-lint */
  | StudioResult<SqlLintResult>
  /** sequence — one tuple per query, truncated at the first failure */
  | [[SerializedError]]
  | [[null, unknown[]], StudioResult<unknown[]>];
