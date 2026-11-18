import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ArgumentsHost, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaExceptionFilter, PRISMA_ERROR_MAP } from "./prisma-exception.filter.js";

/** A real Prisma error, not a shape that looks like one. The filter selects on
 *  the CLASS via `@Catch`, so a plain object would test nothing about whether
 *  the right things reach it. */
function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(
    `\nInvalid \`prisma.schedule.create()\` invocation:\n\nUnique constraint failed on the fields: (\`targetKey\`,\`cronExpr\`)`,
    { code, clientVersion: "5.22.0", meta },
  );
}

/** Records what the filter wrote, standing in for the Express response. */
function capture(headersSent = false) {
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({
        headersSent,
        status(code: number) {
          sent.status = code;
          return {
            json(body: Record<string, unknown>) {
              sent.body = body;
            },
          };
        },
      }),
    }),
  } as unknown as ArgumentsHost;
  return { sent, host };
}

function run(code: string, meta?: Record<string, unknown>) {
  const { sent, host } = capture();
  new PrismaExceptionFilter().catch(prismaError(code, meta), host);
  return sent;
}

test("the codes a caller can act on get the status that says so", () => {
  assert.equal(run("P2002").status, 409, "unique violation is a conflict, not a server fault");
  assert.equal(run("P2025").status, 404);
  assert.equal(run("P2003").status, 400);
  assert.equal(run("P1008").status, 503, "a timeout is retryable — 503 says so, 500 does not");
});

test("an unmapped code still produces exactly the 500 Nest would have", () => {
  // The allowlist is what stops a real bug arriving as a tidy 4xx. Behaviour
  // outside it must be unchanged, byte for byte.
  for (const code of ["P2011", "P2021", "P2034", "P5000"]) {
    const sent = run(code);
    assert.equal(sent.status, 500, `${code} is not understood, so it must not be dressed up`);
    assert.deepEqual(sent.body, { statusCode: 500, message: "Internal server error" });
  }
});

test("no response repeats Prisma's text or names a column", () => {
  // Prisma messages carry constraint and column names; the log keeps them, the
  // caller does not get them.
  const leaky = run("P2002", { target: ["targetKey", "cronExpr"] });
  const body = JSON.stringify(leaky.body);
  assert.ok(!body.includes("targetKey"), "meta.target must not reach the caller");
  assert.ok(!body.includes("cronExpr"));
  assert.ok(!body.includes("prisma.schedule.create"), "nor the invocation text");
  assert.ok(!body.includes("Unique constraint failed"));
});

test("every mapped entry is internally consistent", () => {
  // Cheap, but it catches the copy-paste where a new row gets the status of the
  // one above it and a message that says something else.
  const errorForStatus: Record<number, string> = {
    400: "Bad Request",
    404: "Not Found",
    409: "Conflict",
    503: "Service Unavailable",
  };
  for (const [code, entry] of Object.entries(PRISMA_ERROR_MAP)) {
    assert.equal(entry.error, errorForStatus[entry.status], `${code}: error text must match its status`);
    assert.ok(entry.message.length > 0, `${code}: needs a message`);
    assert.ok(!/^P\d+/.test(entry.message), `${code}: the message is for a human, not a code`);
  }
});

test("a response that already started streaming is left alone", () => {
  // Nest's BaseExceptionFilter checks this before replying; taking over its job
  // means taking over its guard. Writing a second time to a response whose
  // headers are already out replaces the original failure with an
  // ERR_HTTP_HEADERS_SENT that says nothing about what actually went wrong.
  const { sent, host } = capture(true);
  new PrismaExceptionFilter().catch(prismaError("P2002"), host);
  assert.equal(sent.status, undefined, "must not set a status on a sent response");
  assert.equal(sent.body, undefined, "and must not write a body");
});

test("a fresh response is still written — the guard is not a blanket skip", () => {
  const { sent, host } = capture(false);
  new PrismaExceptionFilter().catch(prismaError("P2002"), host);
  assert.equal(sent.status, 409);
});

/** Captures what the filter logged, without giving production code a seam it
 *  would not otherwise have. `Logger` is constructed inside the filter, so the
 *  only honest way to observe it is to intercept the prototype for the duration
 *  of one call. */
function withLoggerSpy<T>(fn: () => T): { result: T; errors: unknown[][]; warns: unknown[][] } {
  const errors: unknown[][] = [];
  const warns: unknown[][] = [];
  const errorSpy = mock.method(Logger.prototype, "error", (...args: unknown[]) => { errors.push(args); });
  const warnSpy = mock.method(Logger.prototype, "warn", (...args: unknown[]) => { warns.push(args); });
  try {
    return { result: fn(), errors, warns };
  } finally {
    errorSpy.mock.restore();
    warnSpy.mock.restore();
  }
}

test("an unmapped code is logged WITH its stack", () => {
  // Nest's BaseExceptionFilter.handleUnknownError logs `(message, stack)` for
  // every error it does not recognise. This filter takes those errors off it,
  // so logging only the message would make the filter a downgrade for exactly
  // the cases it declines to interpret — the ones where the stack is the only
  // thing that identifies the bug.
  const { host } = capture();
  const err = prismaError("P2011");
  const { errors } = withLoggerSpy(() => new PrismaExceptionFilter().catch(err, host));
  assert.equal(errors.length, 1, "an unmapped code must be logged at error level");
  assert.equal(errors[0].length, 2, "message AND stack, matching what Nest did before");
  assert.equal(errors[0][1], err.stack);
});

test("a mapped code is a warning, and does not pretend to be a crash", () => {
  // The counterpart. An expected conflict logged at error level with a stack is
  // noise that trains people to ignore the error log.
  const { host } = capture();
  const { errors, warns } = withLoggerSpy(() => new PrismaExceptionFilter().catch(prismaError("P2002"), host));
  assert.deepEqual(errors, [], "a understood outcome is not an error");
  assert.equal(warns.length, 1);
  assert.equal(warns[0].length, 1, "no stack — the shape of this failure is already known");
});
