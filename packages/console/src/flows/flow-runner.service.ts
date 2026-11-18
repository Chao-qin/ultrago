/**
 * 软删立场（本文件通篇适用）：FlowNodeRun 的查询不按 deletedAt 过滤。
 *
 * 节点行的可见性由父级决定。拉取待推进的 FlowRun 时已经滤过
 * `{ deletedAt: null, flow: { deletedAt: null } }`，所以走到节点这一层的每一行都
 * 属于一个确认存活的 run，再滤一次是冗余。节点行自身还要过一层 `visibleRows`，
 * 那筛的是 map 的当前迭代归属，与软删无关，两者不要混起来读。
 *
 * 对 Run / FlowRun 的读同样不过滤，理由与 dispatcher.service.ts 相同：正在跑的
 * 东西必须被驱动到终态，否则它会卡住后续所有运行。
 */
import { BadRequestException, Inject, Injectable, Logger, forwardRef, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ScriptBudget } from './script-budget.js';
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COLLECT_RESULT_PORT,
  FLOW_NODE_TYPES,
  MAP_ITEM_PORT,
  SCRIPT_EXTENSION,
  SCRIPT_LANGUAGES,
  buildScriptSource,
  flowOutputKey,
  flowProductSource,
  isInstantNode,
  isWaitingNode,
  parseFlowGraph,
  runProductSource,
  splitOutputProblems,
  transformOutputKey,
  type BranchNodeConfig,
  type FlowGraph,
  type FlowNode,
  type MergeNodeConfig,
  type ParamSchemaFragment,
  type ScriptLanguage,
  type ScriptNodeConfig,
  validateOutput,
  resolveEmbeddedSchemaRefs,
  scriptSkeleton,
} from "@bcp/shared";
import type { SubflowNodeConfig } from "@bcp/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { SchemasService } from "../schemas/schemas.service.js";
import { resolveSchemaCitation } from "./flows.service.js";
import { FlowsService } from "./flows.service.js";
import { RecordsService } from "../records/records.service.js";
import { EnqueueService } from "../runs/enqueue.service.js";
import { RunsService } from '../runs/runs.service.js';
import type { FlowNodeType } from '@bcp/shared';
import { DispatcherService } from "../runs/dispatcher.service.js";
import { OutputLandingService } from "../runs/output-landing.service.js";
import { describeOutputs, INLINE_OUTPUT_LIMIT } from "../runs/output-type.js";
import { readNodeOutput, storeNodeOutput } from './flow-output-storage.js';
import {
  MAP_STATE_KEY,
  afterMapIteration,
  branchChoicesOf,
  currentMapItem,
  evalExpr,
  initialMapState,
  mapIsDone,
  mapOwners,
  mapScope,
  readMapState,
  planDispatch,
  readyNodeIds,
  resolveInputs,
  runVerdict,
  mergeValue,
  selectBranch,
  skippedNodeIds,
  toleratedFailures,
  type MapState,
  type NodeStatus,
} from "./flow-exec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** packages/console/src/flows → repo root */
const MONOREPO_ROOT = path.resolve(__dirname, "../../../..");
const TERMINAL_RUN_STATUSES = new Set(["success", "failed", "escalated", "cancelled"]);
const PAUSED_RUN_STATUSES = new Set(["needsConfirm", "needsJudge", "noAction"]);
/** Where a node product too big for its row goes. Repo-relative, and gitignored
 *  with a LEADING SLASH so it anchors to the root — learn.md 2026-08-25: an
 *  unanchored pattern also swallowed an unrelated directory of the same name. */
/**
 * The node types that DO something — drive a browser, spawn a process — as
 * opposed to computing over values already in hand.
 *
 * Derived rather than listed again, so adding a node type cannot silently
 * leave it outside the budget below: a new type is acting until someone
 * declares otherwise, which is the safe default.
 *
 * `WAITING_NODE_TYPES` is the second exclusion and the one where "acting" is
 * NOT the safe default. A subflow sits `running` for as long as its child runs
 * while occupying no browser of its own — the child's book and script nodes
 * are counted here in their own right, because this query spans every live
 * flow run. Count the parent as well and it deadlocks on the first tick: the
 * parent holds the only slot, waiting for a child that can never get one.
 */
const ACTING_NODE_TYPES: readonly string[] = FLOW_NODE_TYPES.filter((t) => !isInstantNode(t) && !isWaitingNode(t));
const DEFAULT_SCRIPT_TIMEOUT_MS = 300_000;
/** A ceiling the node's own `timeoutMs` cannot raise. Without one the field is
 *  not a timeout but a suggestion: type enough nines and the node never ends,
 *  and since a run holds the single acting slot, neither does the flow. */
const MAX_SCRIPT_TIMEOUT_MS = 1_800_000;
/** A dry-run holds an HTTP request open while someone watches a panel, so it
 *  caps its own wait well below a real node's. A script that needs longer than
 *  this is one to try out by running the flow, not from the inspector. */
const DRY_RUN_TIMEOUT_MS = 60_000;
/** How much of each stream is retained. Generous enough that a real product
 *  line survives, small enough that a script looping on print() cannot take the
 *  console's heap with it. */
const STDOUT_TAIL_LIMIT = 4_000_000;
const STDERR_TAIL_LIMIT = 256_000;
/**
 * The only environment variables a flow script inherits.
 *
 * Everything else is dropped, `.env` included: this process loads the repo's
 * secrets into `process.env`, and passing that through made every script a
 * credential reader whether or not it wanted to be. These are the ones a
 * program needs to locate its interpreter and agree about text and time.
 */
const SCRIPT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "SHELL", "USER", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE"] as const;

interface NodeRunRow {
  id: string;
  nodeId: string;
  nodeType: string;
  status: string;
  runId: string | null;
  /** The FlowRun a subflow node started; null everywhere else. */
  childFlowRunId: string | null;
  outputJson: string | null;
  /** Which pass over a map's body this row belongs to; null everywhere else. */
  iteration: number | null;
}

/**
 * Advances flow runs one tick at a time, driven by the existing dispatcher
 * loop rather than a timer of its own.
 *
 * The state machine lives in the database, not in this object: which nodes
 * finished, what they produced, which slot each holds. A restart therefore
 * resumes rather than restarts — the same reason the rest of this console
 * keeps its continuity in SQLite instead of memory.
 *
 * The one exception is a running script's child process, which cannot outlive
 * the process that spawned it. That gap is handled explicitly in `reconcile`
 * rather than papered over.
 */
@Injectable()
export class FlowRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FlowRunnerService.name);
  /** flowNodeRun.id → live child process. Memory-only by nature. */
  private readonly scriptProcs = new Map<string, ChildProcess>();
  private readonly scriptShutdown = new AbortController();
  private readonly scriptTasks = new Set<Promise<ScriptOutcome>>();
  @Inject(RunsService) private readonly runs!: RunsService;
  private readonly cancelling = new Set<string>();
  private readonly cancellations = new Map<string, Promise<void>>();
  private readonly advancing = new Map<string, Promise<number>>();
  private readonly starting = new Set<string>();
  private readonly nodeCancellations = new Map<string, Promise<void>>();
  private reconciled = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EnqueueService) private readonly enqueue: EnqueueService,
    @Inject(DispatcherService) private readonly dispatcher: DispatcherService,
    @Inject(RecordsService) private readonly records: RecordsService,
    @Inject(OutputLandingService) private readonly outputLanding: OutputLandingService,
    // A subflow node starts its child through the same door a manual trigger
    // uses, so it inherits that path's validation, parameter defaults and
    // body-node exclusion instead of a second copy that drifts. Safe from a
    // cycle: FlowsService depends on Prisma and the registry, nothing else.
    @Inject(forwardRef(() => FlowsService)) private readonly flows: FlowsService,
    // A script node's product is checked against the contract it cites, so the
    // runner resolves refs the same way the canvas does — through the registry,
    // via the one shared resolver.
    @Inject(SchemasService) private readonly schemas: SchemasService,
  ) {}

  /** Ride the dispatcher's existing 200ms loop rather than starting a second
   *  timer: one clock is easier to reason about, and the flow state machine has
   *  no reason to tick on a different beat than the runs it enqueues. */
  onModuleInit(): void {
    this.flows.registerCancellationHandler((id) => this.cancelRun(id));
    this.dispatcher.registerTickStep("flow-runner", () => this.advance());
  }

  async onModuleDestroy(): Promise<void> {
    this.scriptShutdown.abort();
    await boundedCancellation(Promise.all(this.scriptTasks).then(() => {}));
  }

  private runScript(
    config: ScriptNodeConfig,
    inputs: Record<string, unknown>,
    contracts: { input: ParamSchemaFragment | null; output: ParamSchemaFragment | null },
    onSpawn?: (proc: ChildProcess) => void,
    signal?: AbortSignal,
  ): Promise<ScriptOutcome> {
    const task = runScriptProcess(config, inputs, contracts, onSpawn, signal ? AbortSignal.any([signal, this.scriptShutdown.signal]) : this.scriptShutdown.signal)
      .finally(() => { this.scriptTasks.delete(task); });
    this.scriptTasks.add(task);
    return task;
  }

  cancelRun(id: string): Promise<void> {
    const existing = this.cancellations.get(id);
    if (existing) return existing;
    this.cancelling.add(id);
    const pending = this.cancelOne(id).finally(() => {
      this.cancellations.delete(id);
      if (!this.advancing.has(id)) this.cancelling.delete(id);
    });
    this.cancellations.set(id, pending);
    return pending;
  }

  private async cancelOne(id: string): Promise<void> {
    const run = await this.prisma.flowRun.findUnique({ where: { id } });
    if (!run || ['success', 'failed'].includes(run.status)) return;
    await this.prisma.flowRun.updateMany({
      where: { id, status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    const rows = await this.prisma.flowNodeRun.findMany({ where: { flowRunId: id } });
    const failures: string[] = [];
    const passive = async (_row: NodeRunRow): Promise<void> => {};
    const handlers: Record<FlowNodeType, (row: NodeRunRow) => Promise<void>> = {
      book: async (row) => {
        if (!row.runId) return;
        const result = await this.runs.cancel(row.runId);
        const error = 'error' in result ? result.error : undefined;
        if (!result.ok && !error?.includes('already finished')) throw new Error(error ?? 'Book cancellation failed');
      },
      script: async (row) => {
        const proc = this.scriptProcs.get(row.id);
        if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
        let closed: () => void;
        const stopped = new Promise<void>((done) => { closed = done; proc.once('close', closed); });
        try { terminateScriptTree(proc); await stopped; }
        finally { proc.removeListener('close', closed!); }
      },
      flow: async (row) => { if (row.childFlowRunId) await this.cancelRun(row.childFlowRunId); },
      flowInput: passive,
      flowOutput: passive,
      transform: passive,
      branch: passive,
      merge: passive,
      map: passive,
      collect: passive,
    };
    await Promise.all(rows.map(async (row) => {
      const activeMap = row.nodeType === 'map' && row.status === 'success' && !mapIsDone(readMapState(safeJson(row.outputJson)) ?? initialMapState([]));
      if (!['pending', 'running'].includes(row.status) && !activeMap) return;
      try {
        if (this.starting.has(row.id) && ((row.nodeType === 'book' && !row.runId) || (row.nodeType === 'flow' && !row.childFlowRunId))) {
          throw new Error('startup cleanup pending; cancellation will retry after attachment');
        }
        const handler = handlers[row.nodeType as FlowNodeType];
        if (!handler) throw new Error(`Unsupported node type: ${row.nodeType}`);
        let cleanup = this.nodeCancellations.get(row.id);
        if (!cleanup) {
          cleanup = (async () => {
            await handler(row);
            await this.prisma.flowNodeRun.updateMany({
              where: { id: row.id, status: { in: activeMap ? ['success'] : ['pending', 'running'] } },
              data: { status: 'cancelled', finishedAt: new Date(), errorMessage: null },
            });
          })().finally(() => { this.nodeCancellations.delete(row.id); });
          this.nodeCancellations.set(row.id, cleanup);
        }
        await boundedCancellation(cleanup);
      } catch (error) {
        const message = `${row.id}: ${error instanceof Error ? error.message : String(error)}`;
        failures.push(message);
        await this.prisma.flowNodeRun.updateMany({
          where: { id: row.id, status: { in: ['pending', 'running'] } },
          data: { errorMessage: `取消未完成：${message}` },
        });
      }
    }));
    await this.prisma.flowRun.updateMany({
      where: { id, status: 'cancelled' },
      data: { errorMessage: failures.length ? `取消未完成：${failures.join('; ')}` : null },
    });
    if (failures.length) throw new Error(`Flow cancellation incomplete: ${failures.join('; ')}`);
  }

  /** Called from the dispatcher's tick. Never throws into the caller: a broken
   *  flow must not stop books from being started. */
  async advance(): Promise<void> {
    if (!this.reconciled) {
      await this.reconcile();
      this.reconciled = true;
    }
    // The flow side's "find work to do". Same rule as the dispatcher's
    // startPending: a withdrawn flow run, or one whose flow was deleted, must
    // not be advanced another step.
    const runs = await this.prisma.flowRun.findMany({
      where: { status: { in: ["pending", "running"] }, deletedAt: null, flow: { deletedAt: null } },
      include: { nodes: true },
      orderBy: { queuedAt: "asc" },
    });
    // The acting budget is GLOBAL, and it has to be: `planDispatch` enforces
    // "at most one node that does something at a time", but it was asked that
    // question once per flow run, so N concurrent runs meant N browsers. Chrome
    // stops rendering an occluded window, which is precisely how a repeatable
    // run becomes an intermittent one — the constraint this budget encodes is
    // about the machine, not about a run.
    //
    // Counted across every run, including ones this tick will not touch, and
    // carried forward as each run starts something so two runs in the same tick
    // cannot both claim the last slot.
    // A cancelled parent can still own a browser while termination is pending
    // or failed. Its node retains the slot until cleanup confirms termination.
    //
    // A PAUSED book (needsConfirm) does keep its slot, deliberately: its run is
    // alive, its browser window is open mid-task, and starting another book
    // into that window is the interference this budget exists to prevent.
    let acting = await this.prisma.flowNodeRun.count({
      where: {
        status: "running",
        nodeType: { in: [...ACTING_NODE_TYPES] },
        deletedAt: null,
        flowRun: { status: { in: ["pending", "running"] }, deletedAt: null, flow: { deletedAt: null } },
      },
    });
    acting += await this.prisma.flowNodeRun.count({
      where: {
        status: 'running',
        nodeType: { in: [...ACTING_NODE_TYPES] },
        flowRun: { status: { in: ['cancelled'] } },
      },
    });
    for (const run of runs) {
      if (this.cancelling.has(run.id) || this.advancing.has(run.id)) continue;
      try {
        const pending = this.advanceOne(run, acting > 0);
        this.advancing.set(run.id, pending);
        acting += await pending;
      } catch (e) {
        this.logger.error(`flow run ${run.id} failed to advance: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.advancing.delete(run.id);
        if (this.cancelling.has(run.id)) await this.cleanupAfterStartup(run.id);
      }
    }
  }

  /**
   * A script node marked `running` with no live process behind it is a node
   * whose process died with the last console. Say so and fail it, rather than
   * leaving a row that claims to be working forever.
   */
  private async reconcile(): Promise<void> {
    // NOT filtered on `deletedAt`, for the same reason as the dispatcher's
    // reconcileStaleState: an orphaned row has to be resolved whether or not
    // it was withdrawn. Leaving a soft-deleted node claiming `running` forever
    // is strictly worse than recording that its process is gone.
    const orphans = await this.prisma.flowNodeRun.findMany({ where: { status: "running", nodeType: "script" } });
    for (const row of orphans) {
      if (this.scriptProcs.has(row.id)) continue;
      const cancelled = await this.prisma.flowNodeRun.updateMany({
        where: { id: row.id, status: 'running', flowRun: { status: 'cancelled' } },
        data: {
          status: 'cancelled',
          finishedAt: new Date(),
          errorMessage: 'console 重启后脚本进程句柄丢失，无法确认终止结果，请检查残留进程',
        },
      });
      if (cancelled.count) continue;
      await this.finishNode(row.id, "failed", { error: "脚本进程随 console 重启丢失，未能确认结果" });
    }
    if (orphans.length > 0) this.logger.warn(`reclaimed ${orphans.length} script node(s) orphaned by a restart`);
  }

  private async advanceOne(run: {
    id: string;
    status: string;
    graphSnapshot: string;
    paramsJson: string;
    mode: string;
    nodes: NodeRunRow[];
  }, actingBusy: boolean): Promise<number> {
    if (this.cancelling.has(run.id)) return 0;
    const current = await this.prisma.flowRun.findUnique({ where: { id: run.id } });
    if (!current || ['success', 'failed', 'cancelled'].includes(current.status) || this.cancelling.has(run.id)) return 0;
    const graph = parseFlowGraph(run.graphSnapshot);
    if (run.status === "pending") {
      await this.prisma.flowRun.updateMany({ where: { id: run.id, status: 'pending' }, data: { status: 'running', startedAt: new Date() } });
    }

    // 1. Bring book nodes up to date with the Runs they are waiting on.
    for (const row of run.nodes) {
      if (row.status === "running" && row.nodeType === "book" && row.runId) await this.syncBookNode(row);
      if (row.status === "running" && row.nodeType === "flow" && row.childFlowRunId) await this.syncSubflowNode(row);
    }

    // 2. Drive any map's loop. It runs BEFORE the generic machinery because it
    //    both creates the rows that machinery will dispatch and settles the
    //    ones it must not touch — a map and its collect are controlled here,
    //    never by `readyNodeIds`.
    const owners = mapOwners(graph);
    await this.advanceMaps(run, graph, owners);
    if (this.cancelling.has(run.id)) return 0;

    // Only the CURRENT iteration's body rows are visible. That one filter is
    // what lets everything below stay keyed by `nodeId` — statuses, outputs,
    // readiness and dispatch are all written as "one row per node", and
    // rewriting them for a feature only maps use would put iteration awareness
    // into every path instead of one.
    const stored = await this.prisma.flowNodeRun.findMany({ where: { flowRunId: run.id } });
    const fresh = visibleRows(stored, owners, mapIndexes(stored, graph));
    const statuses = new Map<string, NodeStatus>(fresh.map((n: { nodeId: string; status: string }) => [n.nodeId, n.status as NodeStatus]));
    const outputs = new Map<string, Record<string, unknown>>();
    for (const row of fresh) {
      if (row.status === "success") outputs.set(row.nodeId, await this.readOutput(row.outputJson));
    }

    // 3. Settle what can never run. NOT "everything downstream of a failure":
    //    that closure also killed the join node where two paths rejoin, which
    //    made a branch unusable the first time anyone drew one. See
    //    `skippedNodeIds` for the per-edge rule that replaced it.
    const choices = branchChoicesOf(graph, outputs);
    for (const id of skippedNodeIds(graph, statuses, choices)) {
      if (this.cancelling.has(run.id)) return 0;
      const row = fresh.find((candidate) => candidate.nodeId === id);
      if (!row) continue;
      const skipped = await this.prisma.flowNodeRun.updateMany({
        where: { id: row.id, status: 'pending', flowRun: { status: { in: ['pending', 'running'] } } },
        data: { status: 'skipped', finishedAt: new Date() },
      });
      if (skipped.count) statuses.set(id, 'skipped');
    }

    // 4. Start what may start. A map and its collect are excluded: their state
    //    machine is `advanceMaps` above, and letting the generic dispatcher
    //    also finish them would collapse the loop to its first item.
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const candidates = readyNodeIds(graph, statuses)
      .map((id) => byId.get(id))
      .filter((n): n is FlowNode => !!n && n.type !== "map" && n.type !== "collect");
    // `actingBusy` comes from the caller, which counted across ALL runs. A
    // per-run count was the bug: it could only ever see this run's own nodes.
    let started = 0;
    for (const nodeId of planDispatch(candidates, actingBusy)) {
      if (this.cancelling.has(run.id)) break;
      const node = byId.get(nodeId)!;
      const row = fresh.find((n) => n.nodeId === nodeId)!;
      // Same predicate as the budget above — a waiting node started, but it
      // did not take the slot, so reporting it as one would starve its child.
      if (!isInstantNode(node.type) && !isWaitingNode(node.type)) started++;
      await this.startNode(run, node, row, resolveInputs(node, graph, outputs));
    }

    // 5. Settle the run. Read through the same visibility filter: a finished
    //    earlier iteration's rows are history, and judging the run by them
    //    would call it done while the current item is still going.
    const settled = await this.prisma.flowNodeRun.findMany({ where: { flowRunId: run.id } });
    const after = visibleRows(settled, owners, mapIndexes(settled, graph));
    const verdict = runVerdict(new Map(after.map((n: { nodeId: string; status: string }) => [n.nodeId, n.status as NodeStatus])), toleratedFailures(graph));
    if (verdict !== "running") await this.finishRun(run.id, verdict, graph);
    return started;
  }

  /**
   * Drive every map's loop one step.
   *
   * Runs before the generic machinery and owns two things it must not touch:
   * the map row (which carries the loop state) and the collect row (which must
   * not settle until the LAST item). Everything in between is an ordinary node
   * that the generic dispatcher runs — once per iteration, against rows this
   * method creates.
   *
   * Sequential by construction. A flow already allows one acting node at a
   * time, so twenty items are twenty rounds regardless; iterating them one at a
   * time buys a state machine small enough to reason about and a per-item row
   * that says which of the twenty failed.
   */
  private async advanceMaps(
    run: { id: string; paramsJson: string; mode: string },
    graph: FlowGraph,
    owners: Map<string, string>,
  ): Promise<void> {
    const maps = graph.nodes.filter((n) => n.type === "map");
    if (maps.length === 0) return;

    for (const mapNode of maps) {
      if (this.cancelling.has(run.id)) return;
      const rows = await this.prisma.flowNodeRun.findMany({ where: { flowRunId: run.id } });
      const mapRow = rows.find((r) => r.nodeId === mapNode.id && r.iteration === null);
      if (!mapRow || mapRow.status === "failed" || mapRow.status === "skipped") continue;

      const scope = mapScope(graph, mapNode.id);
      if (!scope.collectId) {
        await this.finishNode(mapRow.id, "failed", { error: "「逐项处理」下游没有「收集结果」节点，每一项的结果无处可去" });
        continue;
      }

      const state = readMapState(safeJson(mapRow.outputJson));
      if (state === null) {
        await this.beginMap(run, graph, owners, mapNode, mapRow, scope.collectId, rows);
        continue;
      }
      if (mapIsDone(state)) continue;
      await this.stepMap(run, graph, owners, mapNode, mapRow, scope.collectId, state, rows);
    }
  }

  /** Start iterating, once the array to iterate has arrived. */
  private async beginMap(
    run: { id: string; paramsJson: string; mode: string },
    graph: FlowGraph,
    owners: Map<string, string>,
    mapNode: FlowNode,
    mapRow: { id: string; status: string },
    collectId: string,
    rows: NodeRunRow[],
  ): Promise<void> {
    if (mapRow.status !== "pending") return;
    const statuses = new Map<string, NodeStatus>(
      visibleRows(rows, owners, mapIndexes(rows, graph)).map((r): [string, NodeStatus] => [r.nodeId, r.status as NodeStatus]),
    );
    if (!readyNodeIds(graph, statuses).includes(mapNode.id)) return;

    const outputs = await this.outputsFor(visibleRows(rows, owners, mapIndexes(rows, graph)));
    const items = resolveInputs(mapNode, graph, outputs).items;
    if (!Array.isArray(items)) {
      await this.failMap(run.id, mapRow.id, collectId, `「逐项处理」的入参必须是数组，收到 ${items === undefined ? "空" : typeof items}`);
      return;
    }

    const state = initialMapState(items);
    if (mapIsDone(state)) {
      // Nothing to iterate is not an error: the body simply never runs and the
      // collect produces an empty array, which is what every downstream node
      // that reduces over the results already knows how to handle.
      await this.finishNode(mapRow.id, "success", { output: { [MAP_ITEM_PORT]: undefined, [MAP_STATE_KEY]: state } });
      await this.settleCollect(run.id, collectId, []);
      return;
    }
    await this.publishMapItem(mapRow.id, state);
    await this.seedIteration(run.id, graph, owners, mapNode.id, 0);
  }

  /** One iteration settled — record it and either move on or finish. */
  private async stepMap(
    run: { id: string; paramsJson: string; mode: string },
    graph: FlowGraph,
    owners: Map<string, string>,
    mapNode: FlowNode,
    mapRow: { id: string },
    collectId: string,
    state: MapState,
    rows: NodeRunRow[],
  ): Promise<void> {
    const current = rows.filter((r) => owners.get(r.nodeId) === mapNode.id && r.iteration === state.index);
    if (current.length === 0) {
      // `seedIteration` creates one row per body node, so an empty set here
      // means the body is empty — nothing will ever arrive and every future
      // tick would return at this same line, leaving the run at `running`
      // forever. Save-time validation refuses these graphs now; this is for the
      // ones already stored, where silence is the worst possible answer.
      await this.failMap(run.id, mapRow.id, collectId, "「逐项处理」与「收集结果」之间没有任何节点，每一项没有要做的事", state);
      return;
    }
    if (current.some((r) => r.status === "pending" || r.status === "ready" || r.status === "running")) return;

    const failed = current.some((r) => r.status === "failed");
    const outputs = await this.outputsFor(current);
    const collectNode = graph.nodes.find((n) => n.id === collectId)!;
    const value = resolveInputs(collectNode, graph, outputs)[COLLECT_RESULT_PORT];

    if (failed && mapNode.onFail !== "continue") {
      // The default. The state goes in WITH the error, and that is load-bearing
      // rather than tidy: `mapIndexes` reads the index back out of this row, so
      // a failure that wiped it would drop the index to 0, make the FIRST
      // iteration's rows visible again — the successful ones — and leave the
      // collect looking ready forever while nothing could ever dispatch it. The
      // run hung instead of failing.
      await this.failMap(run.id, mapRow.id, collectId, `第 ${state.index + 1} 项处理失败（共 ${state.items.length} 项）`, state);
      return;
    }

    const next = afterMapIteration(state, { failed, value });
    if (mapIsDone(next)) {
      await this.finishNode(mapRow.id, "success", { output: { [MAP_ITEM_PORT]: undefined, [MAP_STATE_KEY]: next } });
      if (next.failed.length > 0) {
        this.logger.warn(`flow run ${run.id}: map ${mapNode.id} finished with ${next.failed.length}/${next.items.length} item(s) failed`);
      }
      await this.settleCollect(run.id, collectId, next.results);
      return;
    }
    await this.publishMapItem(mapRow.id, next);
    await this.seedIteration(run.id, graph, owners, mapNode.id, next.index);
  }

  /** Hand the body the element it should work on, and the loop state with it.
   *  `success` because the body reads this row as an ordinary finished
   *  upstream — the map is "done producing THIS item", not done iterating. */
  private async publishMapItem(mapRowId: string, state: MapState): Promise<void> {
    await this.prisma.flowNodeRun.updateMany({
      where: { id: mapRowId, status: { in: ['pending', 'success'] }, flowRun: { status: { in: ['pending', 'running'] } } },
      data: {
        status: "success",
        startedAt: new Date(),
        errorMessage: null,
        outputJson: JSON.stringify({ [MAP_ITEM_PORT]: currentMapItem(state), [MAP_STATE_KEY]: state }),
      },
    });
  }

  /** Fresh pending rows for one pass over the body. Earlier iterations' rows
   *  are LEFT IN PLACE: they are the per-item history that makes "3 succeeded,
   *  17 failed" answerable, and the unique key was already `[flowRunId, nodeId,
   *  iteration]` for exactly this. */
  private async seedIteration(
    flowRunId: string,
    graph: FlowGraph,
    owners: Map<string, string>,
    mapId: string,
    iteration: number,
  ): Promise<void> {
    if (this.cancelling.has(flowRunId)) return;
    const body = [...owners.entries()].filter(([, id]) => id === mapId).map(([nodeId]) => nodeId);
    for (const nodeId of body) {
      if (this.cancelling.has(flowRunId)) return;
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      await this.prisma.flowNodeRun.upsert({
        where: { flowRunId_nodeId_iteration: { flowRunId, nodeId, iteration } },
        create: { flowRunId, nodeId, nodeType: node.type, iteration, status: "pending" },
        update: {},
      });
    }
  }

  /**
   * End a map, and end its collect with it.
   *
   * The collect has to be settled HERE because nothing else can: it is excluded
   * from the generic dispatcher (the controller owns it), and the skip rule
   * cannot reach it either when the map died before any body row existed — its
   * upstream would simply have no status at all. Left alone it sits `pending`
   * forever and the run never reaches a verdict, which is worse than the
   * failure it is reporting.
   */
  private async failMap(
    flowRunId: string,
    mapRowId: string,
    collectId: string,
    error: string,
    state?: MapState,
  ): Promise<void> {
    await this.finishNode(mapRowId, "failed", {
      error,
      output: state ? { [MAP_ITEM_PORT]: currentMapItem(state), [MAP_STATE_KEY]: state } : undefined,
    });
    const row = await this.prisma.flowNodeRun.findFirst({ where: { flowRunId, nodeId: collectId, iteration: null } });
    if (row && !this.cancelling.has(flowRunId)) {
      await this.prisma.flowNodeRun.updateMany({
        where: { id: row.id, status: 'pending', flowRun: { status: { in: ['pending', 'running'] } } },
        data: { status: "skipped", finishedAt: new Date() },
      });
    }
  }

  private async settleCollect(flowRunId: string, collectId: string, results: unknown[]): Promise<void> {
    const row = await this.prisma.flowNodeRun.findFirst({ where: { flowRunId, nodeId: collectId, iteration: null } });
    if (row) await this.finishNode(row.id, "success", { output: { results } });
  }

  /** The products of a set of rows, keyed by node — the shape `resolveInputs`
   *  reads. Shared by the controller's two callers so neither grows its own. */
  private async outputsFor(rows: Array<{ nodeId: string; status: string; outputJson: string | null }>): Promise<Map<string, Record<string, unknown>>> {
    const outputs = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      if (row.status === "success") outputs.set(row.nodeId, await this.readOutput(row.outputJson));
    }
    return outputs;
  }

  private async startNode(
    run: { id: string; paramsJson: string; mode: string },
    node: FlowNode,
    row: NodeRunRow,
    inputs: Record<string, unknown>,
  ): Promise<void> {
    if (this.cancelling.has(run.id)) return;
    const base = { status: "running", startedAt: new Date(), errorMessage: null, inputJson: JSON.stringify(inputs) };
    const claimed = await this.prisma.flowNodeRun.updateMany({
      where: { id: row.id, status: 'pending', flowRun: { status: { in: ['pending', 'running'] } } },
      data: base,
    });
    if (!claimed.count) return;

    // A throw from here on is the node's failure, not the dispatcher's.
    //
    // Without this it was neither: the row had just been marked `running`, the
    // exception unwound to the tick's catch, and the run sat at `running`
    // forever — every 200ms logging the same line to a file nobody was
    // watching, while the console showed a node that had simply never
    // finished. A branch comparing against a number instead of a string did
    // exactly that (`text.trim is not a function`), and the graph gave no hint
    // which of its nodes was at fault.
    //
    // The point is not that branch had a bug. It is that ANY bug, in any node
    // type, became an unkillable run with no diagnosis attached to it.
    try {
      if (this.cancelling.has(run.id)) return;
      this.starting.add(row.id);
      await this.dispatchNode(run, node, row, inputs);
    } catch (e) {
      await this.finishNode(row.id, "failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.starting.delete(row.id);
      if (this.cancelling.has(run.id)) await this.cleanupAfterStartup(run.id);
    }
  }

  private async cleanupAfterStartup(id: string): Promise<void> {
    const current = this.cancellations.get(id);
    if (current) {
      try { await current; }
      catch (error) { this.logger.warn(`flow ${id} cancellation needs another pass: ${String(error)}`); }
    }
    try { await this.cancelRun(id); }
    catch (error) { this.logger.warn(`flow ${id} cancellation remains incomplete: ${String(error)}`); }
  }

  private async dispatchNode(
    run: { id: string; paramsJson: string; mode: string },
    node: FlowNode,
    row: NodeRunRow,
    inputs: Record<string, unknown>,
  ): Promise<void> {
    switch (node.type) {
      case "flowInput": {
        // The flow's own parameters enter here, one port per declared param.
        await this.finishNode(row.id, "success", { output: safeJson(run.paramsJson) });
        return;
      }
      case "flowOutput": {
        await this.finishNode(row.id, "success", { output: { value: inputs.value } });
        return;
      }
      case "transform": {
        // Keyed by the author's NAME for each field, not by its stable handle:
        // this object is what the run inspector shows, and `resolveInputs`
        // translates a wire's handle into the same key on the way out.
        const outs = (node.config as { outputs?: Array<{ id: string; label?: string; expr: string; schema?: ParamSchemaFragment; schemaRef?: { name: string; version?: number } }> }).outputs ?? [];
        const produced: Record<string, unknown> = {};
        for (const out of outs) {
          const key = transformOutputKey(out);
          const value = evalExpr(out.expr, inputs.input ?? inputs);
          produced[key] = value;
          const schema = out.schema ? await resolveEmbeddedSchemaRefs(out.schema, (ref) => resolveSchemaCitation(this.schemas, ref)) : await resolveSchemaCitation(this.schemas, out.schemaRef);
          const { violations } = splitOutputProblems(validateOutput(schema, value));
          if (violations.length > 0) {
            await this.finishNode(row.id, "failed", { error: `Transform 输出「${key}」不满足 Schema：${violations.slice(0, 3).join("; ")}` });
            return;
          }
        }
        await this.finishNode(row.id, "success", { output: produced });
        return;
      }
      case "branch": {
        // The product is keyed by the port that WON, which is what lets
        // `branchChoicesOf` recover the decision after a restart without a
        // column of its own — and what makes every other port's edge dead.
        const chosen = selectBranch(node.config as BranchNodeConfig, inputs.input ?? inputs);
        await this.finishNode(row.id, "success", { output: chosen ? { [chosen]: inputs.input ?? inputs } : {} });
        return;
      }
      case "merge": {
        await this.finishNode(row.id, "success", {
          output: { output: mergeValue(node.config as MergeNodeConfig, inputs) },
        });
        return;
      }
      case "book": {
        await this.startBookNode(run, node, row, inputs);
        return;
      }
      case "script": {
        // Resolved HERE rather than inside the spawn callback: this method is
        // already async, and neither materialising the source nor judging the
        // product should have to await a database round-trip from inside a
        // process event handler.
        const script = node.config as ScriptNodeConfig;
        // Inline contract wins over the registry citation, matching the rule
        // `portsFor` uses to size the node's input ports. Falling back to the
        // ref when no inline shape exists keeps every old graphJson valid.
        const contracts = {
          input: script.inputSchema ? await resolveEmbeddedSchemaRefs(script.inputSchema, (ref) => resolveSchemaCitation(this.schemas, ref)) : await resolveSchemaCitation(this.schemas, script.inputSchemaRef),
          output: script.outputSchema ? await resolveEmbeddedSchemaRefs(script.outputSchema, (ref) => resolveSchemaCitation(this.schemas, ref)) : await resolveSchemaCitation(this.schemas, script.outputSchemaRef),
        };
        if (!this.cancelling.has(run.id)) this.startScriptNode(node, row, inputs, contracts);
        return;
      }
      case "flow": {
        await this.startSubflowNode(run, node, row, inputs);
        return;
      }
      default:
        await this.finishNode(row.id, "failed", { error: `不支持的节点类型：${node.type}` });
    }
  }

  /**
   * A book node does NOT execute a book. It enqueues one and waits.
   *
   * Everything the run pipeline already provides — the start lease, dedupe,
   * per-step history, delivery retries, the run detail page — is inherited by
   * going through the same door. A second execution path would be a second set
   * of side effects to keep aligned, and the last time this codebase had two,
   * the same book succeeded over MCP and failed every time from the console.
   */
  private async startBookNode(
    run: { id: string; mode: string },
    node: FlowNode,
    row: NodeRunRow,
    inputs: Record<string, unknown>,
  ): Promise<void> {
    const bookId = (node.config as { bookId?: string }).bookId;
    if (!bookId) {
      await this.finishNode(row.id, "failed", { error: "book 节点未绑定 book" });
      return;
    }
    try {
      await this.enqueue.enqueue({
        bookId,
        params: inputs,
        mode: run.mode === "assisted" ? "assisted" : "auto",
        trigger: "flow",
        flowNodeRunId: row.id,
        // Same node, same key: a repeated dispatch after a crash coalesces onto
        // the run already in flight instead of starting a second one.
        dedupeKey: `flow:${run.id}:${row.nodeId}:${row.iteration ?? 0}`,
      });
    } catch (e) {
      await this.finishNode(row.id, "failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Start the child flow this node points at, and remember which run it is.
   *
   * Through `FlowsService.trigger`, not a hand-rolled `flowRun.create`: that
   * path validates the child, resolves its parameter defaults and knows not to
   * mint rows for map bodies. A second copy here would be a second thing to
   * keep in step, and the copy is always the one that falls behind.
   *
   * `trigger: "flow"` is what tells the run list these were not started by a
   * person, and `parentFlowRunId` is set by trigger from the same argument.
   */
  private async startSubflowNode(
    run: { id: string; mode: string },
    node: FlowNode,
    row: NodeRunRow,
    inputs: Record<string, unknown>,
  ): Promise<void> {
    const childId = (node.config as SubflowNodeConfig).flowId;
    if (!childId) {
      await this.finishNode(row.id, "failed", { error: "子流程节点没有选择要运行的流程" });
      return;
    }
    try {
      const child = await this.flows.trigger(childId, inputs, "flow", run.mode, run.id);
      await this.prisma.flowNodeRun.update({ where: { id: row.id }, data: { childFlowRunId: child.id } });
    } catch (e) {
      // A child that refuses to start (disabled, unresolved errors, bad
      // parameters) fails THIS node with the child's own message — the reason
      // is about the child, and repeating it here is what makes it findable
      // from the parent's run detail.
      await this.finishNode(row.id, "failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Mirror the child flow run's terminal state onto the node.
   *
   * The same shape as `syncBookNode`, and deliberately so: a flow's product
   * lands as a `SchemaRecord` keyed by `flowProductSource`, exactly as a book
   * run's does. That is the closure the design is named for — a flow is an
   * endpoint like any other, so consuming one needs no new machinery.
   */
  private async syncSubflowNode(row: NodeRunRow): Promise<void> {
    const child = await this.prisma.flowRun.findUnique({
      where: { id: row.childFlowRunId! },
      select: { status: true, failedNodeId: true },
    });
    if (!child) {
      await this.finishNode(row.id, "failed", { error: "子流程运行记录不见了" });
      return;
    }
    if (!["success", "failed", "cancelled"].includes(child.status)) return;

    if (child.status !== "success") {
      await this.finishNode(row.id, "failed", {
        error: `子流程${child.status === "cancelled" ? "被取消" : "失败"}${child.failedNodeId ? `（节点 ${child.failedNodeId}）` : ""}`,
      });
      return;
    }

    const record = await this.prisma.schemaRecord.findFirst({
      where: { source: flowProductSource(row.childFlowRunId!), deletedAt: null },
      select: { data: true, fileName: true, url: true, contentType: true, bytes: true, schemaErrors: true },
    });
    // A child that declared no outputs produced none, and `{}` is the honest
    // reading — the same one the book path gives a run with no product.
    let outputs: Record<string, unknown>;
    try {
      outputs = this.recordOutputs(record);
    } catch (e) {
      await this.finishNode(row.id, "failed", { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    // Keyed by the child's OWN output names, not wrapped in an `output` key.
    // `resolveInputs` looks a wire's `sourceHandle` up in this object, and the
    // handles are now one per declared output — so `{结果: …, 汇总: …}` is what
    // makes wiring just 汇总 downstream work. It is also exactly what the child
    // run produced; wrapping it was the thing that needed explaining.
    await this.finishNode(row.id, "success", { output: outputs });
  }

  /** Mirror the enqueued Run's terminal state onto the node. */
  private async syncBookNode(row: NodeRunRow): Promise<void> {
    const run = await this.prisma.run.findUnique({
      where: { id: row.runId! },
      select: { status: true, errorMessage: true },
    });
    if (!run) return;
    if (PAUSED_RUN_STATUSES.has(run.status)) {
      // A resumable pause is not a failure (a confirm prompt, a judgement
      // call). Touching the node here would destroy the state a resume needs.
      await this.prisma.flowNodeRun.updateMany({
        where: { id: row.id, status: 'running', flowRun: { status: { in: ['pending', 'running'] } } },
        data: { errorMessage: `等待人工处理：${run.status}` },
      });
      return;
    }
    if (!TERMINAL_RUN_STATUSES.has(run.status)) return;

    if (run.status !== "success") {
      await this.finishNode(row.id, "failed", { error: run.errorMessage ?? `run ${run.status}` });
      return;
    }

    const stored = await this.prisma.flowNodeRun.findUnique({ where: { id: row.id }, select: { outputJson: true } });
    let checkpoint: Record<string, unknown>;
    try {
      checkpoint = readNodeOutput(stored?.outputJson);
    } catch (error) {
      await this.finishNode(row.id, 'failed', { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const direct = Object.hasOwn(checkpoint, 'outputSchemaErrors');
    const record = direct ? null : await this.prisma.schemaRecord.findFirst({
      where: { source: runProductSource(row.runId!), deletedAt: null },
      select: { data: true, fileName: true, url: true, contentType: true, bytes: true, schemaErrors: true },
    });

    // Inside a flow, a contract violation is fatal even though a standalone run
    // only records it: this value is about to be fed to another endpoint, and
    // passing on data already known to be wrong is how a downstream node fails
    // somewhere unrelated — or worse, quietly succeeds on garbage.
    //
    // `schemaErrors` holds BOTH kinds of entry, so the split is not cosmetic:
    // "nobody could check this" is not "this is wrong", and failing the node on
    // it would stop a flow over data that conforms. It is not a pass either, so
    // it is logged rather than dropped — this branch is the only place a flow
    // ever looks at the verdict.
    const schemaErrors = direct ? checkpoint.outputSchemaErrors : record?.schemaErrors;
    const { violations, notices } = splitOutputProblems(parseArray(typeof schemaErrors === 'string' ? schemaErrors : null));
    if (notices.length > 0) {
      this.logger.warn(`flow node ${row.id}: product not fully checked against the book's outputSchema — ${notices.join("; ")}`);
    }
    if (violations.length > 0) {
      await this.finishNode(row.id, "failed", { error: `产出不满足 outputSchema：${violations.slice(0, 3).join("; ")}`, ...(direct ? { output: checkpoint } : {}) });
      return;
    }

    let outputs: Record<string, unknown>;
    try {
      outputs = direct ? safeJson(JSON.stringify(checkpoint.outputs)) : this.recordOutputs(record);
    } catch (e) {
      // A row pointing at bytes that are no longer there is not a node that
      // succeeded. Failing here is the same judgement as the violation above:
      // better a stopped flow than a downstream node fed a pointer where its
      // input used to be.
      await this.finishNode(row.id, "failed", { error: `产出读取失败：${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    await this.finishNode(row.id, "success", { output: {
      outputs, status: run.status,
      ...(direct ? { outputSchemaErrors: schemaErrors } : {}),
      ...(checkpoint.outputValueIsWrapped === true ? { outputValueIsWrapped: true } : {}),
    } });
  }

  /**
   * What a book node hands downstream, from the row its run landed.
   *
   * The payload branch keeps the bytes in `data` and passes them on. The file
   * branch has no `data`, and the honest answer there depends on size: at or
   * under INLINE_OUTPUT_LIMIT the bytes are read back so a downstream node
   * receives the VALUE it has always received — handing it `{url: …}` where its
   * input used to be is exactly the "quietly succeeds on garbage" failure the
   * violation check exists to prevent. Above the limit the pointer is all a
   * node gets, which is the bargain `FlowNodeRun.outputJson` already documents:
   * a multi-megabyte blob re-read on every 200ms tick is how a dispatcher stops
   * dispatching. The pointer's keys are `url` / `fileName` / `bytes`, so a
   * downstream node reading `$.<field>` gets nothing rather than a
   * plausible-looking wrong value.
   *
   * THE FIRST TEST IS `data`, NOT `schemaName` — and since `planOutputRecord`
   * grew the same size ceiling, that is no longer a distinction without a
   * difference. A book with a resolvable `outputSchemaRef` whose product
   * outgrows the limit now lands on the FILE branch with its contract name
   * intact, and arrives here as `data === null, bytes > LIMIT` — a pointer,
   * exactly like the no-contract case of the same size. `doudian-category-tree`
   * is that book: it carries `book-output-nonempty-string@1` and its landed
   * product measures 1,171,535 bytes.
   *
   * The size check still guards only the file branch, and sharing
   * `INLINE_OUTPUT_LIMIT` with `planOutputRecord` is what keeps that safe: a
   * row this method reads was LANDED by `OutputLandingService`, and everything
   * that path puts in `data` is either empty or within the limit. A separate,
   * larger storage ceiling would silently reopen the hole. It is a guarantee
   * about the landing path, not about the column — `SchemaRecordsService.update`
   * PATCHes `data` with no ceiling of its own, so a hand-edited product row can
   * still be read back whole. That is a person choosing to, not a run doing it
   * unattended, and it is left alone rather than guarded twice.
   */
  private recordOutputs(record: {
    data: string | null;
    fileName: string | null;
    url: string | null;
    contentType: string;
    bytes: number;
  } | null): Record<string, unknown> {
    if (!record) return {};
    if (record.data !== null) return decodePayload(record.data, record.contentType);
    if (record.fileName && record.bytes <= INLINE_OUTPUT_LIMIT) {
      return decodePayload(readFileSync(this.records.resolveStored(record.fileName), "utf8"), record.contentType);
    }
    return { url: record.url, fileName: record.fileName, contentType: record.contentType, bytes: record.bytes };
  }

  /**
   * Run a local script. Input arrives on stdin as JSON and the result is the
   * LAST line of stdout — chosen so nothing has to be quoted onto a command
   * line, and so a script may log freely without corrupting its own result.
   *
   * NOTE ON SCOPE: whether a registered script writes to a database is beyond
   * anything this code can tell. That judgement belongs to whoever registers
   * the node, and the repo's standing rule is that database writes are run by
   * a person, not by automation on their behalf.
   */
  /**
   * Run a script node's code once, against values typed by hand, outside any
   * flow run.
   *
   * The point is to make "what does `params` hold, and what comes back?"
   * answerable by pressing a button instead of by wiring a whole graph and
   * triggering it. It goes through `runScriptProcess`, the same function a real
   * node goes through, so what it reports is what a real run will do — a
   * dry-run with its own execution path would be worse than no dry-run at all.
   *
   * The one deliberate difference is the timeout: a node may legitimately take
   * half an hour, but nobody holds an HTTP request open watching a panel for
   * that long, so this caps its own wait and says so when it trips.
   */
  async dryRunScript(rawConfig: unknown, params: Record<string, unknown>, signal?: AbortSignal): Promise<ScriptOutcome> {
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      throw new BadRequestException("试运行需要一份 script 节点配置");
    }
    const config = rawConfig as ScriptNodeConfig;
    // INLINE ONLY. A `command` here would make this endpoint an arbitrary-exec
    // API: it takes its argv from a request body, the console listens on
    // loopback with no authentication, and command nodes run outside the
    // sandbox by design (they point at reviewed files in the repo). Since a
    // sandboxed body CAN still open sockets — Node 22 has no network
    // permission — that combination let inline code escalate to the console
    // user's full rights with one local fetch. Trying out a command node is
    // not what this button is for; running the flow is.
    if (config.command?.length) {
      throw new BadRequestException("试运行只跑内联代码。命令模式请直接运行流程 —— 它不在沙箱内，不能由一个 HTTP 请求指定");
    }
    const contracts = {
      input: config.inputSchema ? await resolveEmbeddedSchemaRefs(config.inputSchema, (ref) => resolveSchemaCitation(this.schemas, ref)) : await resolveSchemaCitation(this.schemas, config.inputSchemaRef),
      output: config.outputSchema ? await resolveEmbeddedSchemaRefs(config.outputSchema, (ref) => resolveSchemaCitation(this.schemas, ref)) : await resolveSchemaCitation(this.schemas, config.outputSchemaRef),
    };
    const inputCheck = splitOutputProblems(validateOutput(contracts.input, params));
    if (inputCheck.violations.length > 0) {
      return {
        ok: false,
        errorCategory: 'input',
        error: `入参不满足 inputSchema：${inputCheck.violations.slice(0, 3).join('; ')}`,
        stdout: '',
        stderr: '',
        durationMs: 0,
        notices: inputCheck.notices,
      };
    }
    return this.runScript(
      { ...config, timeoutMs: Math.min(config.timeoutMs ?? DRY_RUN_TIMEOUT_MS, DRY_RUN_TIMEOUT_MS) },
      params,
      contracts,
      undefined,
      signal,
    );
  }

  private startScriptNode(
    node: FlowNode,
    row: NodeRunRow,
    inputs: Record<string, unknown>,
    contracts: { input: ParamSchemaFragment | null; output: ParamSchemaFragment | null },
  ): void {
    void this.runScript(node.config as ScriptNodeConfig, inputs, contracts, (proc) => this.scriptProcs.set(row.id, proc))
      .then((outcome) => {
        this.scriptProcs.delete(row.id);
        for (const notice of outcome.notices) {
          this.logger.warn(`flow node ${row.id}: script product not fully checked against its outputSchema — ${notice}`);
        }
        if (outcome.warning) this.logger.warn(`flow node ${row.id}: ${outcome.warning}`);
        return outcome.ok
          ? this.finishNode(row.id, "success", { output: { output: outcome.output } })
          : this.finishNode(row.id, "failed", { error: outcome.error });
      })
      .catch(async (error: unknown) => {
        this.scriptProcs.delete(row.id);
        try { await this.finishNode(row.id, 'failed', { error: error instanceof Error ? error.message : String(error) }); }
        catch (failure) { this.logger.error(`script node ${row.id} failed to settle: ${String(failure)}`); }
      });
  }

  private async finishNode(
    id: string,
    status: "success" | "failed",
    result: { output?: unknown; error?: string },
  ): Promise<void> {
    const row = await this.prisma.flowNodeRun.findUnique({
      where: { id },
      select: { startedAt: true, flowRunId: true, nodeId: true, iteration: true, status: true, nodeType: true, outputJson: true },
    });
    const activeMap = row?.nodeType === 'map' && row.status === 'success' && !mapIsDone(readMapState(safeJson(row.outputJson)) ?? initialMapState([]));
    if (row && (this.cancelling.has(row.flowRunId) || (!activeMap && ['success', 'failed', 'cancelled', 'skipped'].includes(row.status)))) return;
    const finishedAt = new Date();
    await this.prisma.flowNodeRun.updateMany({
      where: { id, status: { in: activeMap ? ['success'] : ['pending', 'running'] }, flowRun: { status: { in: ['pending', 'running'] } } },
      data: {
        status,
        finishedAt,
        durationMs: row?.startedAt ? finishedAt.getTime() - row.startedAt.getTime() : null,
        errorMessage: result.error ?? null,
        ...(Object.hasOwn(result, 'output') ? { outputJson: this.storeOutput(result.output, row?.flowRunId, row?.nodeId, row?.iteration) } : {}),
      },
    });
  }

  /**
   * A node's product, either inline or as a pointer to a file holding it.
   *
   * `FlowNodeRun.outputJson` has claimed to do this since the column was
   * written — its comment describes the `$ref` form exactly — while the code
   * stored the whole payload unconditionally. That was not merely untidy: every
   * dispatcher tick re-reads each finished node's output to resolve the wires
   * leaving it, so a multi-megabyte product was re-parsed five times a second
   * for the rest of the run. This repo already carries a 1.9MB product JSON.
   *
   * Sharing `INLINE_OUTPUT_LIMIT` with the book-product path is deliberate —
   * two thresholds for "how big is too big" would eventually disagree, and the
   * one that disagreed downward would be the one silently truncating.
   *
   * Falls back to inline when the row does not name its run: a pointer with
   * nowhere to point is worse than a large row.
   *
   * The ITERATION is part of the name, and leaving it out was a real defect for
   * as long as map existed: a body node produces one product per pass, so three
   * passes wrote three times to one path and the last one won. The live run was
   * unaffected — each pass's value is read back and accumulated the moment it
   * finishes, before the next write — but the STORED history was wrong, which
   * is worse than it sounds, because per-item history is the entire reason you
   * can ask which of twenty items failed. Opening iteration 0 showed you
   * iteration 19's product, with nothing anywhere saying so.
   */
  private storeOutput(output: unknown, flowRunId?: string, nodeId?: string, iteration?: number | null): string | null {
    return storeNodeOutput(output, { flowRunId, nodeId, iteration }, (message) => this.logger.warn(message));
  }

  private async finishRun(id: string, verdict: "success" | "failed", graph: FlowGraph): Promise<void> {
    if (this.cancelling.has(id)) return;
    const run = await this.prisma.flowRun.findUnique({ where: { id }, select: { startedAt: true, queuedAt: true, flow: { select: { outputSchema: true } } } });
    const nodes = await this.prisma.flowNodeRun.findMany({ where: { flowRunId: id } });
    const failed = nodes.find((n) => n.status === "failed");
    const outputs: Record<string, unknown> = {};
    for (const node of graph.nodes) {
      if (node.type !== "flowOutput") continue;
      const row = nodes.find((n) => n.nodeId === node.id);
      if (row?.outputJson) outputs[flowOutputKey(node)] = (await this.readOutput(row.outputJson)).value;
    }
    const finishedAt = new Date();
    const startedAt = run?.startedAt ?? run?.queuedAt ?? finishedAt;
    if (this.cancelling.has(id)) return;
    const settled = await this.prisma.flowRun.updateMany({
      where: { id, status: { in: ['pending', 'running'] } },
      data: {
        status: verdict,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        failedNodeId: failed?.nodeId ?? null,
        errorMessage: failed?.errorMessage ?? null,
      },
    });
    // A flow's product is a payload like a book's, so it lands the same way
    // instead of in a column of its own. `outputSchemaRef` is null because a
    // Flow declares its output contract inline and has no ref column at all —
    // the position four of the six live books are still in, and the same file
    // branch follows from it.
    if (settled.count && !this.cancelling.has(id) && Object.keys(outputs).length > 0) {
      await this.outputLanding.land(flowProductSource(id), describeOutputs(outputs, run?.flow.outputSchema), null);
    }
  }

  /** Node outputs are stored inline until they get big; see INLINE_OUTPUT_LIMIT. */
  private async readOutput(json: string | null): Promise<Record<string, unknown>> {
    return readNodeOutput(json);
  }
}

function safeJson(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return {};
  }
}

/** A landed payload back into the value a node passes on.
 *
 *  `SchemaRecord.data` holds the payload AS PRODUCED (classifyOutput's `data`),
 *  not the JSON-encoded form the deleted `Run.outputsJson` column held — a markdown
 *  product is the markdown itself, and running that through `safeJson` would
 *  parse-fail and silently yield {}. Only a JSON payload is parsed; anything
 *  else keeps the `{value: …}` shape a non-object output has always had here. */
function decodePayload(payload: string, contentType: string): Record<string, unknown> {
  if (contentType === "application/json") return safeJson(payload);
  return { value: payload };
}

function parseArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * The grammar for a `$name` placeholder in a script command argv slot.
 *
 * Full identifier only — `^\$[A-Za-z_][A-Za-z0-9_]*$`. Anything else
 * (a bare `$`, `$1`, `$x.y`, a partial match) is left alone so that:
 *   - shell-like commands with literal `$1` survive intact
 *   - a stray `$` mid-string cannot become a typo that silently swallows
 *     characters
 *   - `$x.y` is reserved for "future nested bindings" without committing to
 *     them now
 *
 * Same identifier rule as the JSON Schema / ParamSpec field names, so what an
 * author types in `inputSchema.properties.x` is what `$x` looks up.
 */
const COMMAND_TOKEN_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Replace `$name` argv slots with values from `inputs`. `null` / `undefined`
 * become the literal string `"null"` / `"undefined"` so a script that wanted
 * to see the field's emptiness can do so — `--capture ""` would have masked
 * the difference.
 *
 * Pure function. Returns `{ ok: false, missing }` on a token whose name is not
 * a key of `inputs`; the runner turns that into a clear spawn-time error.
 */
export function substituteCommandTokens(
  command: string[],
  inputs: Record<string, unknown>,
): { ok: true; command: string[] } | { ok: false; missing: string } {
  const out: string[] = [];
  for (const slot of command) {
    const m = COMMAND_TOKEN_RE.exec(slot);
    if (!m) {
      out.push(slot);
      continue;
    }
    const name = m[1];
    if (!Object.prototype.hasOwnProperty.call(inputs, name)) {
      return { ok: false, missing: name };
    }
    out.push(stringifyTokenValue(inputs[name]));
  }
  return { ok: true, command: out };
}

function stringifyTokenValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Arrays / objects — round-trip through JSON so the script gets a string it
  // can `JSON.parse` back. Same shape JSON.stringify already promises to the
  // script on stdin, so nothing surprises downstream.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** What running a script produced, with no opinion about where it gets
 *  recorded. `notices` is the "nobody could fully check this" half of the
 *  contract verdict — separate from `error`, because it is not a breach. */
export interface ScriptOutcome {
  ok: boolean;
  output?: unknown;
  error?: string;
  errorCategory?: ScriptErrorCategory;
  errorLocation?: { line: number; column?: number };
  /** Tails, already bounded — see `keepTail`. */
  stdout: string;
  stderr: string;
  durationMs: number;
  notices: string[];
  /** Something worth telling an operator that did not fail the run. */
  warning?: string;
}

export type ScriptErrorCategory =
  | 'input'
  | 'syntax'
  | 'runtime'
  | 'timeout'
  | 'output'
  | 'permission'
  | 'network'
  | 'module'
  | 'cancelled';

function classifyScriptFailure(stderr: string, timedOut: boolean): ScriptErrorCategory {
  if (timedOut) return 'timeout';
  if (/SyntaxError|ERR_INVALID_TYPESCRIPT_SYNTAX|Unexpected token/i.test(stderr)) return 'syntax';
  if (/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|Module not found/i.test(stderr)) return 'module';
  if (/ERR_ACCESS_DENIED|permission denied|not permitted|access denied/i.test(stderr)) return 'permission';
  if (/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|UND_ERR/i.test(stderr)) return 'network';
  return 'runtime';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function userScriptDiagnostic(
  stderr: string,
  workDir: string | null,
  config: ScriptNodeConfig,
  contracts: { input: ParamSchemaFragment | null; output: ParamSchemaFragment | null },
): { stderr: string; location?: { line: number; column?: number }; locationText?: string } {
  if (!workDir || config.source === undefined) return { stderr };
  const headerLines = scriptSkeleton(config.language ?? 'ts', contracts.input, contracts.output).header.split('\n').length;
  const bodyLines = config.source.replace(/\r\n/g, '\n').split('\n').length;
  let location: { line: number; column?: number } | undefined;
  const filePattern = new RegExp(`(?:file://)?${escapeRegExp(path.join(workDir, 'main.ts'))}:(\\d+)(?::(\\d+))?`, 'g');
  let safe = stderr.replace(filePattern, (_match, rawLine: string, rawColumn?: string) => {
    const generatedLine = Number(rawLine);
    const line = generatedLine - headerLines;
    if (line < 1 || line > bodyLines) return '脚本运行包装';
    const column = rawColumn ? Math.max(1, Number(rawColumn) - 2) : undefined;
    location ??= { line, ...(column ? { column } : {}) };
    return `脚本第 ${line} 行${column ? `，第 ${column} 列` : ''}`;
  });
  safe = safe
    .replace(new RegExp(`file://${escapeRegExp(workDir)}(?:/[^\\s():]+)?`, 'g'), '脚本运行包装')
    .replace(new RegExp(`${escapeRegExp(workDir)}(?:/[^\\s():]+)?`, 'g'), '脚本运行包装');
  return {
    stderr: safe,
    location,
    locationText: location ? `脚本第 ${location.line} 行${location.column ? `，第 ${location.column} 列` : ''}` : undefined,
  };
}

/**
 * Run one script and say what happened. THE only place a flow script is
 * spawned.
 *
 * Single on purpose. This repo has already paid for two execution paths once:
 * internal-runner's `call()` was missing `noteAction`, and the same book
 * succeeded over MCP and failed every time from the console. A dry-run that
 * spawned its own way would be that bug again in a worse form — the button
 * whose entire job is "tell me what the real run will do" would be the one
 * thing that does not do what the real run does.
 *
 * So this function knows nothing about the database, and both callers — the
 * node runner and the dry-run endpoint — get identical behaviour by
 * construction rather than by two lists that have to be kept aligned.
 *
 * `onSpawn` hands the live child back, which the node runner needs so a
 * restart can notice an orphan and a cancel can kill one. The dry-run does not
 * pass it, because nothing outlives the request.
 */
export async function runScriptProcess(
  config: ScriptNodeConfig,
  inputs: Record<string, unknown>,
  contracts: { input: ParamSchemaFragment | null; output: ParamSchemaFragment | null },
  onSpawn?: (proc: ChildProcess) => void,
  signal?: AbortSignal,
): Promise<ScriptOutcome> {
  const startedAt = Date.now();
  const budgetStartedAt = performance.now();
  const fail = (
    error: string,
    stdout = '',
    stderr = '',
    errorCategory: ScriptErrorCategory = 'runtime',
    errorLocation?: { line: number; column?: number },
  ): ScriptOutcome => ({
    ok: false,
    error,
    errorCategory,
    errorLocation,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    notices: [],
  });

  let cwd: string;
  let command: string[];
  // Where an inline body was materialised, so it can be removed once the
  // process is done with it. Null for a `command` node, which owns its file.
  let workDir: string | null = null;
  try {
    cwd = resolveInsideRepo(config.cwd);
    if (config.source !== undefined) {
      const materialised = materialiseScript(config, contracts.input);
      workDir = materialised.dir;
      command = materialised.command;
    } else if (config.command && config.command.length > 0) {
      // `$name` slots resolve against the script's own inputs — the same object
      // that just landed on stdin. Anything else (literal `$`, `$1`, `$x.y`)
      // passes through, so commands that already embed a shell-like token
      // survive untouched.
      const substituted = substituteCommandTokens(config.command, inputs);
      if (!substituted.ok) {
        throw new Error(`command 中引用了入参字段「${substituted.missing}」，但本节点没有这个入参（可能上游没接对，或 inline 契约忘了声明）`);
      }
      command = substituted.command;
      if (command[0] === 'python' || command[0] === 'python3') {
        if (process.env.BCP_DESKTOP === '1') {
          const python = process.env.BCP_PYTHON_EXECUTABLE;
          if (!python || !path.isAbsolute(python)) throw new Error('随包 Python 未准备，请重新安装客户端');
          command = [python, '-E', '-s', ...command.slice(1)];
        } else command = ['bash', path.join(MONOREPO_ROOT, 'scripts/python.sh'), ...command.slice(1)];
      } else if (process.env.BCP_DESKTOP === '1' && ['node', 'nodejs'].includes(command[0])) {
        command = [process.execPath, ...command.slice(1)];
      }
    } else {
      throw new Error("script 节点既没有内联代码也没有命令");
    }
  } catch (e) {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    return fail(e instanceof Error ? e.message : String(e));
  }

  const timeoutMs = Math.min(config.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS, MAX_SCRIPT_TIMEOUT_MS);
  const acceptsWorkBudgets = config.source === undefined;
  if (signal?.aborted) {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    return fail('试跑已停止', '', '', 'cancelled');
  }
  return await new Promise<ScriptOutcome>((resolve) => {
    const proc = spawn(command[0], command.slice(1), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // The console's own environment is NOT the script's. This process has the
      // repo's `.env` loaded into it — tokens included — and handing all of it
      // to a subprocess makes every script a credential reader by default.
      env: { ...scriptEnv(command[0]), ...(acceptsWorkBudgets ? { BCP_FLOW_BUDGET_PROTOCOL: '1' } : {}) },
      // Its own process group, so the timeout below can kill the whole tree.
      // `proc.kill()` signals only the direct child, which for `python3 x.py`
      // that spawned helpers leaves those helpers running after the node has
      // already been recorded as timed out. The cost is that the child no
      // longer receives a Ctrl-C aimed at the console's group — but a child was
      // never reaped by the parent exiting anyway, which is precisely what
      // `reconcile()` exists to notice.
      detached: true,
    });
    onSpawn?.(proc);

    // TAIL-bounded, not head-bounded: the result is the LAST line of stdout, so
    // dropping the oldest bytes keeps the one part that has to survive while a
    // script that logs without limit can no longer grow this process's heap
    // until it dies.
    let stdout = "";
    let stderr = "";
    let warning: string | undefined;
    const budget = new ScriptBudget(budgetStartedAt, timeoutMs, MAX_SCRIPT_TIMEOUT_MS);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let terminationError: string | undefined;
    const cancel = (): void => {
      cancelled = true;
      const error = killTree(proc);
      terminationError ??= error;
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const expire = () => {
      timedOut = true;
      const error = killTree(proc);
      terminationError ??= error;
      const stage = budget.stage ? `（${budget.stage}）` : '';
      stderr += `\n[flow] 超时 ${Math.ceil(budget.deadlineAt - budgetStartedAt)}ms${stage}，${terminationError ? `进程树终止失败：${terminationError}` : '已请求终止进程树'}`;
    };
    let timer = setTimeout(expire, Math.max(0, budget.deadlineAt - performance.now()));
    proc.stdout.on("data", (chunk) => { stdout = keepTail(stdout + String(chunk), STDOUT_TAIL_LIMIT); });
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr = keepTail(stderr + text, STDERR_TAIL_LIMIT);
      if (acceptsWorkBudgets && !settled && !timedOut && budget.consume(text, performance.now())) {
        clearTimeout(timer);
        timer = setTimeout(expire, Math.max(0, budget.deadlineAt - performance.now()));
      }
    });

    const done = (outcome: ScriptOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (workDir) rmSync(workDir, { recursive: true, force: true });
      resolve(outcome);
    };

    proc.on("error", (e) => done(fail(`无法启动脚本：${e.message}`, stdout, stderr, 'runtime')));

    proc.on("close", (code) => {
      if (terminationError) {
        done(fail(`脚本进程树终止未确认，可能仍有子进程运行：${terminationError}`, stdout, stderr, 'runtime'));
        return;
      }
      if (cancelled) {
        const diagnostic = userScriptDiagnostic(stderr, workDir, config, contracts);
        done(fail('试跑已停止', stdout, diagnostic.stderr, 'cancelled', diagnostic.location));
        return;
      }
      if (timedOut || code !== 0) {
        const reason = timedOut ? '脚本超时' : `脚本退出码 ${code}`;
        const diagnostic = userScriptDiagnostic(stderr, workDir, config, contracts);
        const category = classifyScriptFailure(diagnostic.stderr, timedOut);
        const summary = diagnostic.locationText ? `${reason}（${diagnostic.locationText}）` : reason;
        done(fail(`${summary}：${diagnostic.stderr.slice(-2000)}`, stdout, diagnostic.stderr, category, diagnostic.location));
        return;
      }
      const lastLine = stdout.trimEnd().split("\n").pop() ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        done(fail(`脚本最后一行不是合法 JSON：${lastLine.slice(0, 200)}`, stdout, stderr, 'output'));
        return;
      }
      // The same fail-closed rule a book node already gets (see `syncBookNode`):
      // inside a flow this value is about to be fed to another endpoint, so
      // passing on a product already known to violate its own declared contract
      // is how a downstream node fails somewhere unrelated — or quietly
      // succeeds on garbage. A script had no such check at all until now, which
      // made "the contract is enforced" true of one endpoint kind and false of
      // the other.
      const { violations, notices } = splitOutputProblems(validateOutput(contracts.output, parsed));
      const base = { stdout, stderr, durationMs: Date.now() - startedAt, notices, warning };
      done(
        violations.length > 0
          ? { ...base, ok: false, errorCategory: 'output' as const, error: `产出不满足 outputSchema：${violations.slice(0, 3).join("; ")}`, output: parsed }
          : { ...base, ok: true, output: parsed },
      );
    });

    // A script that exits before reading stdin makes this write fail with
    // EPIPE, and an unhandled 'error' on a stream is a process-level crash —
    // the console would go down because a script closed early.
    proc.stdin.on("error", (e) => {
      warning = `脚本没读 stdin 就退出了（${e.message}）`;
    });
    proc.stdin.write(JSON.stringify(inputs));
    proc.stdin.end();
  });
}

/**
 * How to run an inline body: Node itself, with the sandbox on.
 *
 * `--experimental-strip-types` means no tsx, which removes a real hazard rather
 * than a dependency — tsx is a devDependency, its bare name is not on this
 * process's PATH (so spawning it fails with ENOENT, which reads as a broken
 * script rather than a missing toolchain), and it needs to write an IPC pipe
 * that the sandbox below would have to be opened up for.
 *
 * WHAT `--permission` ACTUALLY COVERS, measured on the Node this repo runs
 * (22.x) rather than assumed: the filesystem, child processes, worker threads,
 * native addons, WASI and FFI. Reading /etc/passwd from a body comes back
 * ERR_ACCESS_DENIED, and so does `execSync`.
 *
 * WHAT IT DOES NOT COVER: **the network**. There is no network permission in
 * this line of Node — `--allow-net` is rejected as a bad option, the flag
 * arrives in v25 — so a body can open outbound sockets and listen on loopback.
 * That is not a footnote: a body can post the params it was handed to an
 * external host, and it can reach this console's own unauthenticated HTTP API.
 * The second half is why `dryRunScript` refuses a `command` config (see there);
 * the first half is a limit the UI states plainly rather than papering over.
 *
 * It is NOT `node:vm`, which Node's own documentation says is not a security
 * mechanism, nor `vm2`, which was discontinued in 2023 after a run of
 * sandbox-escape CVEs its maintainer judged unfixable. Those are the two things
 * a reader reaches for first, so they are named here.
 */
function interpreterFor(language: ScriptLanguage, scriptDir: string): string[] {
  if (language !== "ts") throw new Error(`不支持的脚本语言：${language}`);
  return [
    process.execPath,
    "--experimental-strip-types",
    "--permission",
    `--allow-fs-read=${scriptDir}`,
    // Silences the type-stripping experimental-feature banner, which would
    // otherwise be the first thing on stderr of every successful run.
    "--disable-warning=ExperimentalWarning",
  ];
}

/**
 * Write an inline body out as a whole program and say how to run it.
 *
 * A fresh directory per run under the OS temp dir, not under `resource/`: the
 * source of truth is `config.source` inside the graph — and inside the run's
 * immutable `graphSnapshot` — so this file is a derivation, and keeping
 * derivations around only invites someone to edit the copy.
 */
function materialiseScript(
  config: ScriptNodeConfig,
  inputSchema: ParamSchemaFragment | null,
): { dir: string; command: string[] } {
  // Read as a plain string first: the TYPE says only "ts" is possible, but this
  // config came out of a stored graph, and a graph written while inline Python
  // existed still carries `language: "python"`. Refusing it by name beats
  // running it as TypeScript and reporting a syntax error.
  const declared = (config.language ?? "ts") as string;
  if (!(SCRIPT_LANGUAGES as readonly string[]).includes(declared)) throw new Error(`不支持的脚本语言：${declared}`);
  const language = declared as ScriptLanguage;
  // realpath, not the raw mkdtemp result. `--allow-fs-read` is matched against
  // RESOLVED paths, and macOS's os.tmpdir() lives under /var, which is a
  // symlink to private/var — so on macOS the un-resolved form grants a path
  // Node never sees, and the run dies in `resolveMainPath` before reaching the
  // body. Verified by reproducing the same topology here: symlinked TMPDIR
  // fails with ERR_ACCESS_DENIED, realpath'd succeeds.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "bcp-flow-script-")));
  try {
    const file = path.join(dir, `main.${SCRIPT_EXTENSION[language]}`);
    writeFileSync(file, buildScriptSource(language, config.source ?? "", inputSchema, null), "utf8");
    return { dir, command: [...interpreterFor(language, dir), file] };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** The minimum a row has to expose for the visibility filter below. Narrower
 *  than the Prisma row on purpose, so the same filter serves the two call sites
 *  that select different columns. */
interface IterableRow {
  nodeId: string;
  iteration: number | null;
  status: string;
  outputJson: string | null;
}

/** Which item each map is currently on, read back out of its own product. A map
 *  that has not started yet counts as 0, which is what makes the very first
 *  iteration's rows visible the moment they are seeded. */
export function mapIndexes(rows: Array<{ nodeId: string; iteration: number | null; outputJson: string | null }>, graph: FlowGraph): Map<string, number> {
  const indexes = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.type !== "map") continue;
    const row = rows.find((r) => r.nodeId === node.id && r.iteration === null);
    indexes.set(node.id, readMapState(safeJson(row?.outputJson ?? null))?.index ?? 0);
  }
  return indexes;
}

/**
 * The rows the rest of the engine is allowed to see: everything outside a map,
 * plus the CURRENT iteration of everything inside one.
 *
 * This single filter is what keeps iteration out of the rest of the code. The
 * scheduler, the skip rule, the readiness check and the dispatcher are all
 * written as "one row per node", and they stay that way — earlier iterations
 * are history that the run detail can show, not state that the scheduler has to
 * reason about.
 *
 * A body row whose map has no index yet is dropped rather than shown: it means
 * the map has not started, and letting the body look READY before it has an
 * item to work on is how it would run once against nothing.
 */
export function visibleRows<T extends IterableRow>(rows: T[], owners: Map<string, string>, indexes: Map<string, number>): T[] {
  return rows.filter((row) => {
    const mapId = owners.get(row.nodeId);
    if (mapId === undefined) return row.iteration === null;
    return row.iteration === indexes.get(mapId);
  });
}

/** The allowlisted slice of this process's environment — see
 *  `SCRIPT_ENV_ALLOWLIST` for why it is a list and not a subtraction. */
export function scriptEnv(executable?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SCRIPT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (process.env.BCP_DESKTOP === '1' && executable === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

/** Keep the last `limit` characters. Exported so the size rule is testable
 *  without spawning anything. */
export function keepTail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

/** SIGKILL the child AND anything it started.
 *
 *  The negative pid addresses the process GROUP, which the `detached: true` at
 *  the spawn site made this child the leader of. `proc.kill()` alone reaches
 *  only the direct child, so an interpreter that had spawned helpers left them
 *  running past the timeout that was supposed to have ended them. Falls back to
 *  the plain kill when the group is already gone — a race with normal exit,
 *  not a failure. */
function killTree(proc: ChildProcess): string | undefined {
  try {
    terminateScriptTree(proc);
  } catch (error) {
    proc.kill("SIGKILL");
    return error instanceof Error ? error.message : String(error);
  }
}

export function terminateScriptTree(proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  if (process.platform === 'win32') {
    if (proc.exitCode != null || proc.signalCode != null) return;
    const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 4000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`脚本进程树终止失败：${result.stderr || result.status}`);
    return;
  }
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function boundedCancellation(cleanup: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('termination confirmation pending; retry cancellation')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Keep a script's working directory inside the repo. An absolute path or a
 *  `..` escape is refused rather than normalised, because a node that can pick
 *  any directory on the machine is a different feature than the one asked for. */
export function resolveInsideRepo(relative: string | undefined): string {
  const base = process.env.BCP_DESKTOP === '1' ? process.env.BCP_DATA_ROOT : MONOREPO_ROOT;
  if (!base || !path.isAbsolute(base)) throw new Error('桌面脚本缺少有效的用户数据目录');
  if (!relative) return base;
  if (path.isAbsolute(relative)) throw new Error(`script cwd 必须是仓库内相对路径，收到绝对路径：${relative}`);
  const resolved = path.resolve(base, relative);
  const root = base.endsWith(path.sep) ? base : base + path.sep;
  if (!resolved.startsWith(root)) throw new Error(`script cwd 逃出了仓库目录：${relative}`);
  return resolved;
}

export { INLINE_OUTPUT_LIMIT };
