import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";

/**
 * Gate for the endpoints that RUN something or WRITE something.
 *
 * The console binds 0.0.0.0 with no auth layer in front of it (see main.ts) —
 * a deliberate call for the existing read/write-a-row API. Running arbitrary
 * package.json scripts and rewriting `.env` is a different weight class: it is
 * shell execution and credential editing, and reachable over the LAN it would
 * be a straightforward remote-code-execution surface. So the listing endpoints
 * stay open like the rest of the console, and everything that acts is
 * restricted to a caller on this machine.
 */
@Injectable()
export class LoopbackGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ ip?: string; socket?: { remoteAddress?: string } }>();
    // The SOCKET's peer, not `req.ip`. Express derives `req.ip` from
    // X-Forwarded-For when `trust proxy` is on; this app does not turn that on
    // today, but a guard whose correctness depends on a setting somewhere else
    // staying off is one refactor away from being header-spoofable.
    const addr = req.socket?.remoteAddress ?? "";
    if (isLoopbackAddress(addr)) return true;
    throw new ForbiddenException(
      `这个操作只允许本机调用（当前来源 ${addr || "未知"}）。console 绑在 0.0.0.0 且没有鉴权层，所以「跑脚本」和「写 .env」不对局域网开放。`,
    );
  }
}

/** IPv4 loopback in any of its forms, plus `::1` and its IPv4-mapped spelling
 *  (which is what a dual-stack listener reports for a 127.0.0.1 client). */
export function isLoopbackAddress(addr: string): boolean {
  if (!addr) return false;
  const v = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  if (v === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255) && Number(m[1]) === 127;
}
