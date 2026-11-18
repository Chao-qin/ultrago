const BUDGET_PREFIX = 'BCP_BUDGET_V1 ';
const MAX_MESSAGE_LENGTH = 1_024;

export class ScriptBudget {
  private pending = '';
  private discarding = false;
  private deadline: number;
  private readonly maximumDeadline: number;
  stage: string | null = null;

  constructor(startedAt: number, initialMs: number, maximumMs: number) {
    this.maximumDeadline = startedAt + maximumMs;
    this.deadline = Math.min(startedAt + initialMs, this.maximumDeadline);
  }

  get deadlineAt(): number {
    return this.deadline;
  }

  consume(chunk: string, now: number): boolean {
    if (now >= this.deadline) return false;
    let changed = false;
    const parts = chunk.split('\n');
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!this.discarding) {
        if (this.pending.length + part.length > MAX_MESSAGE_LENGTH) {
          this.pending = '';
          this.discarding = true;
        } else {
          this.pending += part;
        }
      }
      if (index === parts.length - 1) break;
      if (!this.discarding) changed = this.apply(this.pending, now) || changed;
      this.pending = '';
      this.discarding = false;
    }
    return changed;
  }

  private apply(line: string, now: number): boolean {
    if (!line.startsWith(BUDGET_PREFIX)) return false;
    let packet: unknown;
    try {
      packet = JSON.parse(line.slice(BUDGET_PREFIX.length));
    } catch {
      return false;
    }
    if (!packet || typeof packet !== 'object') return false;
    const { stage, remainingMs } = packet as Record<string, unknown>;
    if (typeof stage !== 'string' || !stage.trim() || stage.length > 80
      || typeof remainingMs !== 'number' || !Number.isSafeInteger(remainingMs) || remainingMs <= 0) return false;
    const next = Math.min(now + remainingMs, this.maximumDeadline);
    if (next <= this.deadline) return false;
    this.stage = stage;
    this.deadline = next;
    return true;
  }
}
