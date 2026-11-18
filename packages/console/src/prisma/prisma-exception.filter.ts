import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * Turns the Prisma errors that mean something to a CALLER into the status code
 * that says so, and leaves every other one alone.
 *
 * Why this exists: services throw Nest's HttpExceptions where they have thought
 * about it, but a Prisma error escaping any unguarded write reaches Nest with no
 * `statusCode`, so it becomes a 500. The console had ~68 such call sites and no
 * filter, which meant "you just created a duplicate schedule" and "the query
 * engine has a bug" produced the identical response. schema-records.service.ts
 * had already written three separate comments explaining that it pre-empts the
 * error itself — with a `BadRequestException` thrown before the write, not by
 * mapping a code afterwards — precisely because nothing downstream would. Those
 * pre-checks stay: they name the specific conflict, which no status table can.
 *
 * What this is NOT: it does not reformat anything. HttpExceptions the
 * controllers already throw never reach here, because `@Catch` is narrowed to
 * `PrismaClientKnownRequestError` rather than left open. That narrowing is
 * deliberate — a `@Catch()` with no argument would take over the response shape
 * of every error in the app, a far wider change than the one being made.
 *
 * The allowlist is the other half of staying honest. An UNMAPPED code falls
 * through to exactly the 500 Nest would have produced, because the failure mode
 * to avoid here is not "an ugly error" but "a real bug wearing a tidy 4xx".
 * A mapped code is a statement that we understand this outcome; anything else
 * gets logged with its code so the next person can decide whether it belongs.
 *
 * Messages are fixed strings, never `e.message` or `e.meta`. Prisma's text
 * names columns and constraints; the caller does not need them and the log
 * keeps them.
 *
 * Not caught here, deliberately: `PrismaClientValidationError` (a malformed
 * query is our bug, not the caller's) and anything from
 * packages/console/src/studio — Studio talks to its own `node:sqlite` handle,
 * never through Prisma, so it cannot raise this class at all.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const mapped = MAPPED[exception.code];
    const res = host.switchToHttp().getResponse<{
      headersSent: boolean;
      status(code: number): { json(body: unknown): void };
    }>();

    // Nest's own BaseExceptionFilter checks this before replying, and taking
    // over its job means taking over its guard: a handler that has already
    // streamed (the `@Res()` download routes) would otherwise get a second
    // write and an ERR_HTTP_HEADERS_SENT on top of the original failure.
    if (res.headersSent) {
      this.logger.error(`Prisma ${exception.code} after response was sent: ${exception.message}`, exception.stack);
      return;
    }

    if (!mapped) {
      // Same body Nest produces for an unrecognised error, so behaviour for
      // everything outside the allowlist is unchanged — and `exception.stack`
      // is passed for the same reason. BaseExceptionFilter.handleUnknownError
      // already logged `(message, stack)` for these; dropping the second
      // argument would have made this filter a downgrade for exactly the
      // errors it declines to interpret.
      this.logger.error(`unmapped Prisma error ${exception.code}: ${exception.message}`, exception.stack);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: "Internal server error",
      });
      return;
    }

    // A mapped code is an outcome we understand, so it is a warning with the
    // engine's text and no stack — the stack of an expected conflict is noise.
    this.logger.warn(`${exception.code} → ${mapped.status}: ${exception.message}`);
    res.status(mapped.status).json({
      statusCode: mapped.status,
      message: mapped.message,
      error: mapped.error,
    });
  }
}

/** The codes this application has decided it understands. Adding one is a
 *  claim that the caller can act on it — if they cannot, a 500 is the honest
 *  answer and it belongs here only after someone has thought about it. */
const MAPPED: Record<string, { status: number; message: string; error: string }> = {
  // Unique constraint. The reachable ones today: POST/PATCH /api/schedules
  // against @@unique([targetKey, cronExpr, paramsJson]), and two concurrent
  // POST /api/schemas for the same name+version.
  P2002: {
    status: HttpStatus.CONFLICT,
    message: "already exists — the request conflicts with a record that is already there",
    error: "Conflict",
  },
  // "An operation failed because it depends on one or more records that were
  // required but not found" — i.e. an update/delete whose target is gone.
  //
  // Known imprecision, stated rather than hidden: the same code also fires when
  // a nested `connect` on a CREATE names a parent that does not exist, where
  // 400 would be truer than 404. 404 is chosen because the update/delete case
  // is the one this console actually reaches; revisit if a POST ever starts
  // reporting a missing parent as "not found".
  P2025: {
    status: HttpStatus.NOT_FOUND,
    message: "not found — the record this operation depends on does not exist",
    error: "Not Found",
  },
  // Foreign key constraint: the caller named a parent row that is not there.
  P2003: {
    status: HttpStatus.BAD_REQUEST,
    message: "referenced record does not exist",
    error: "Bad Request",
  },
  // The engine could not get an answer in time. Retryable, and squarely a
  // server-side condition — 503 rather than 500 says "try again", which for a
  // SQLite writer-lock queue is true.
  P1008: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: "the database did not respond in time — retry shortly",
    error: "Service Unavailable",
  },
};

/** Exported for the test: the mapping is the part worth pinning, and asserting
 *  it through a live Nest app would test Nest rather than this decision. */
export const PRISMA_ERROR_MAP = MAPPED;
