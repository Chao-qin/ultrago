import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { normalizeScriptLanguage, normalizeScriptSchema } from './script-definition.js';
import { PrismaService } from "../prisma/prisma.service.js";
import { runScriptProcess } from "../flows/flow-runner.service.js";
import { resolveEmbeddedSchemaRefs, splitOutputProblems, validateOutput } from '@bcp/shared';
import type { ParamMap, ParamSchemaFragment, SchemaCitationInput } from "@bcp/shared";
import type { Run, Script } from '@prisma/client';
import { isUniqueViolation, scheduleExecutionId } from '../schedules/schedule-execution.js';
import type { ScheduleExecution } from '../schedules/schedule-execution.js';
import { SchemasService } from '../schemas/schemas.service.js';

/** The Script fields the runner and scheduler actually read. Defined as a
 *  structural type so the scheduler can pass a `select`-shaped row without
 *  carrying the full row, and the runner can accept either. */
type ScriptLike = {
  id: string;
  language: string;
  source: string;
  inputSchema: string;
  outputSchema: string;
};

/**
 * 定时脚本：一个独立、内联的可调度脚本（无 Book，无 Flow 图）。
 *
 * 与 spec 的一个务实偏差（用户确认）：脚本执行**复用 flow script-node 的
 * `runScriptProcess`**（spawn Node 子进程 + `--permission` 沙箱），而不是 spec
 * 设想的新造一套 `node:vm`。原因：仓库既定脚本安全模型就是那个子进程沙箱；再造
 * 一个 vm 既是重复轮子，又引入一套——与现有一致性不同的——安全边界。这里所有能被
 * 脚本执行的内容，都是 `runScriptProcess` 能执行的内容。
 *
 * 本服务只管三件事：把 Script + Schedule 铺成一个即时 Run 记录（targetType=script）、
 * 同步执行脚本、把结果写回 Run 与 Schedule 统计。脚本本身不碰数据库——执行是
 * sandbox 的，判断写库与否属于登记脚本的人，与仓库对 flow script-node 的立场一致。
 */
@Injectable()
export class ScriptsService {
  private readonly logger = new Logger(ScriptsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SchemasService) private readonly schemas: SchemasService,
  ) {}

  async list(opts: { includeDeleted?: boolean } = {}): Promise<(Script & { lastRunAt: Date | null; lastRunStatus: string | null })[]> {
    const scripts = await this.prisma.script.findMany({
      where: { ...(opts.includeDeleted ? {} : { deletedAt: null }) },
      orderBy: { updatedAt: "desc" },
    });
    return Promise.all(
      scripts.map(async (s) => {
        const last = await this.prisma.run.findFirst({
          where: { scriptId: s.id, deletedAt: null },
          orderBy: { queuedAt: "desc" },
          select: { queuedAt: true, status: true },
        });
        return { ...s, lastRunAt: last?.queuedAt ?? null, lastRunStatus: last?.status ?? null };
      }),
    );
  }

  async findById(id: string): Promise<Script> {
    const s = await this.prisma.script.findFirst({ where: { id, deletedAt: null } });
    if (!s) throw new NotFoundException(`script ${id} not found`);
    return s;
  }

  async create(input: { name?: string; description?: string; language?: string; source?: string; inputSchema?: string; outputSchema?: string }) {
    const name = (input.name ?? "").trim() || "未命名脚本";
    const language = normalizeScriptLanguage(input.language);
    return this.prisma.script.create({ data: { name, description: input.description ?? null, language, source: input.source ?? "", inputSchema: normalizeScriptSchema(input.inputSchema), outputSchema: normalizeScriptSchema(input.outputSchema) } });
  }

  async update(id: string, input: { name?: string; description?: string; language?: string; source?: string; inputSchema?: string; outputSchema?: string }) {
    const existing = await this.findById(id);
    return this.prisma.script.update({
      where: { id },
      data: {
        name: input.name ?? existing.name,
        description: input.description ?? existing.description,
        language: input.language !== undefined ? normalizeScriptLanguage(input.language) : existing.language,
        source: input.source ?? existing.source,
        inputSchema: input.inputSchema !== undefined ? normalizeScriptSchema(input.inputSchema) : existing.inputSchema,
        outputSchema: input.outputSchema !== undefined ? normalizeScriptSchema(input.outputSchema) : existing.outputSchema,
      },
    });
  }

  /** Soft delete — schedules on this script are disabled (their own delete
   *  semantics, not cascaded here). History Runs survive. */
  async remove(id: string) {
    await this.findById(id);
    await this.prisma.script.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.prisma.schedule.updateMany({ where: { scriptId: id, deletedAt: null }, data: { enabled: false } });
    return { ok: true };
  }

  /** 试跑：不入 Run。返回脚本执行的直接结果，供 /scripts 页「测试运行」按钮。 */
  async test(id: string, params?: ParamMap, timeoutMs = 30_000) {
    const s = await this.findById(id);
    const outcome = await this.execute(s, params ?? {}, timeoutMs);
    return outcome;
  }

  /** Manual execution of the saved revision. Unlike `test`, this is an
   * operational run and therefore belongs in the shared run history. */
  async runManual(id: string, params: ParamMap = {}, timeoutMs = 60_000): Promise<{ runId: string; status: string }> {
    const script = await this.findById(id);
    const run = await this.prisma.run.create({
      data: {
        scriptId: script.id,
        targetType: 'script',
        targetKey: `script:${script.id}`,
        trigger: 'manual',
        mode: 'auto',
        status: 'starting',
        paramsJson: JSON.stringify(params),
        queuedAt: new Date(),
      },
    });
    const startedAt = Date.now();
    let outcome: { ok: boolean; durationMs: number; error?: string };
    try {
      outcome = await this.execute(script, params, timeoutMs);
    } catch (error) {
      outcome = { ok: false, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
    }
    const status = outcome.ok ? 'success' : 'failed';
    await this.prisma.run.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: new Date(),
        durationMs: outcome.durationMs,
        errorMessage: outcome.ok ? null : outcome.error ?? undefined,
      },
    });
    return { runId: run.id, status };
  }

  /** 调度触发（由 SchedulerService 调）：铺 Run 记录并同步执行。 */
  async runForSchedule(script: ScriptLike, params: ParamMap, firedAt: Date, timeoutMs = 60_000, execution?: ScheduleExecution): Promise<{ runId: string; status: string }> {
    const paramsJson = JSON.stringify(params);
    const id = execution ? scheduleExecutionId('script', execution) : undefined;
    let run: Run;
    try {
      run = await this.prisma.run.create({
        data: {
          id,
          scheduleId: execution?.scheduleId,
          dedupeKey: execution?.dedupeKey,
          scriptId: script.id,
          targetType: 'script',
          targetKey: `script:${script.id}`,
          trigger: 'schedule',
          mode: 'auto',
          status: 'starting',
          paramsJson,
          queuedAt: firedAt,
        },
      });
    } catch (error) {
      if (id && isUniqueViolation(error)) {
        const existing = await this.prisma.run.findUnique({ where: { id } });
        if (existing) return { runId: existing.id, status: existing.status };
      }
      throw error;
    }
    const startedAt = Date.now();
    let outcome: { ok: boolean; durationMs: number; error?: string };
    try {
      outcome = await this.execute(script, params, timeoutMs);
    } catch (error) {
      outcome = { ok: false, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
    }
    const status = outcome.ok ? "success" : "failed";
    await this.prisma.run.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: new Date(),
        durationMs: outcome.durationMs,
        errorMessage: outcome.ok ? null : outcome.error ?? undefined,
      },
    });
    return { runId: run.id, status };
  }

  /** 把 Script 资源铺成 ScriptNodeConfig 并走 runScriptProcess。 */
  private async execute(s: ScriptLike, params: ParamMap, timeoutMs: number) {
    const inputSchema = await this.resolveContract(parseFragment(s.inputSchema));
    const outputSchema = await this.resolveContract(parseFragment(s.outputSchema));
    const inputCheck = splitOutputProblems(validateOutput(inputSchema, params));
    if (inputCheck.violations.length > 0) {
      return {
        ok: false,
        errorCategory: 'input' as const,
        error: `入参不满足 inputSchema：${inputCheck.violations.slice(0, 3).join('; ')}`,
        stdout: '',
        stderr: '',
        durationMs: 0,
        notices: inputCheck.notices,
      };
    }
    return runScriptProcess(
      {
        source: s.source,
        language: normalizeScriptLanguage(s.language),
        timeoutMs,
        inputSchema: inputSchema ?? null,
        outputSchema: outputSchema ?? null,
      },
      params,
      { input: inputSchema ?? null, output: outputSchema ?? null },
    );
  }

  private async resolveContract(schema: ParamSchemaFragment | null): Promise<ParamSchemaFragment | null> {
    if (!schema) return null;
    return resolveEmbeddedSchemaRefs(schema, async (ref: SchemaCitationInput) => {
      const row = await this.schemas.resolve(ref.name, ref.version);
      return parseFragment(row.jsonSchema);
    });
  }
}

function parseFragment(json: string): Record<string, unknown> | null {
  if (!json || json === "null" || json === "{}") return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
