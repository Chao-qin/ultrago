import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { EMPTY_GRAPH, FLOW_NODE_TYPE_LABELS, bookOutputPorts, branchPorts, collectPorts, deriveInputSchema, flowInputParams, flowInputPortId, flowOutputKey, mapPorts, mergePorts, normalizeParams, paramsToInputPorts, parseFlowGraph, parseParamSpecs, propagateRouterSchemas, resolveEmbeddedSchemaRefs, resolveParamDefaults, resolveParamSchema, scriptInputPorts, subflowPorts, transformOutputKey, type BranchNodeConfig, type FlowGraph, type FlowNode, type FlowPort, type FlowProblem, type MergeNodeConfig, type ParamMap, type ParamSchemaFragment, type ParamSchemaResolver, type ParamSpec, type PortMap, type SchemaRefResolver, type ScriptNodeConfig, validateGraphShape, validateParams, validatePorts } from "@bcp/shared";
import type { SubflowNodeConfig } from "@bcp/shared";
import { getResumeBlockReason } from '@bcp/shared';
import type { ResumeRunRow } from '@bcp/shared';
import { mapOwners, mapScope } from "./flow-exec.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { SchemasService } from "../schemas/schemas.service.js";
import { isUniqueViolation, scheduleExecutionId } from '../schedules/schedule-execution.js';
import type { ScheduleExecution } from '../schedules/schedule-execution.js';


export interface UpsertFlowInput {
  name?: string;
  description?: string | null;
  graphJson?: string;
  enabled?: boolean;
  tags?: string | null;
  expectedUpdatedAt?: string;
}

const PREPROCESS_CONFIG_SCHEMA = { name: "product-preprocess-config", version: 2 } as const;

/** Fill the product preprocessing policy only when the caller omitted it.
 * Explicit trigger values always win; the record is merely the flow's stable
 * default so a run cannot silently fall back to Python's legacy policy. */
export function applyPreprocessConfigDefault(
  specs: ParamSpec[],
  params: ParamMap,
  record: { data: string | null } | null,
): ParamMap {
  const spec = specs.find((candidate) =>
    candidate.name === "preprocessConfig"
    && candidate.schemaRef?.name === PREPROCESS_CONFIG_SCHEMA.name
    && candidate.schemaRef.version === PREPROCESS_CONFIG_SCHEMA.version,
  );
  if (!spec || params.preprocessConfig !== undefined || !record) return params;
  if (typeof record.data !== "string" || !record.data.trim()) {
    throw new BadRequestException("product-preprocess-config SchemaRecord 没有 JSON payload");
  }
  let data: unknown;
  try {
    data = JSON.parse(record.data);
  } catch (error) {
    throw new BadRequestException(`product-preprocess-config SchemaRecord 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...params, preprocessConfig: data };
}

const MAX_FLOW_NAME = 60;
/** Control characters only. A flow's name is a LABEL, not an identifier:
 *  nothing ever cites a flow by name (references go through the id), so there
 *  is no reason to restrict the alphabet.
 *
 *  This started life as a copy of Schema.name's kebab-case rule, where the
 *  restriction IS load-bearing because consumers cite "canonical-product@1" as
 *  a string. Copying it here just meant 中文 names were rejected — which is the
 *  most natural way to name a flow in this console. */
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001F\u007F]/;

export function normalizeFlowName(raw: string | undefined): string {
  const name = (raw ?? "").trim();
  if (!name) throw new BadRequestException("流程名称不能为空");
  if (name.length > MAX_FLOW_NAME) throw new BadRequestException(`流程名称最多 ${MAX_FLOW_NAME} 个字符，当前 ${name.length} 个`);
  if (FORBIDDEN_NAME_CHARS.test(name)) throw new BadRequestException("流程名称不能包含控制字符");
  return name;
}

/** Prisma's unique-constraint error, turned into something a person can act on.
 *  The raw P2002 says "Unique constraint failed on the fields: (`name`)", which
 *  tells the operator nothing about what to do next. */
function isDuplicateName(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

@Injectable()
export class FlowsService {
  private readonly logger = new Logger(FlowsService.name);
  private cancellationHandler?: (id: string) => Promise<void>;
  private readonly resumes = new Map<string, Promise<Awaited<ReturnType<FlowsService['resumeRunLocked']>>>>();

  registerCancellationHandler(handler: (id: string) => Promise<void>): void {
    this.cancellationHandler = handler;
  }

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SchemasService) private readonly schemas: SchemasService,
  ) {}

  list(opts: { includeDeleted?: boolean } = {}) {
    return this.prisma.flow.findMany({
      where: opts.includeDeleted ? {} : { deletedAt: null },
      orderBy: { updatedAt: "desc" },
      include: { runs: { where: { deletedAt: null }, orderBy: { queuedAt: "desc" }, take: 1, select: { id: true, status: true, queuedAt: true, finishedAt: true, durationMs: true } } },
    });
  }

  async findById(id: string) {
    const flow = await this.prisma.flow.findFirst({ where: { id, deletedAt: null } });
    if (!flow) throw new NotFoundException(`flow ${id} not found`);
    return flow;
  }

  async create(input: UpsertFlowInput) {
    const name = normalizeFlowName(input.name);
    const graph = parseFlowGraph(input.graphJson ?? JSON.stringify(EMPTY_GRAPH));
    const schemaCache = new Map<string, ParamSchemaFragment | null>();
    await this.validateFieldSchemaRefs(graph, schemaCache);
    // Derived here as well as in `update`, which it was not before. A flow
    // created with a graph in one POST kept `inputSchema: "[]"` and
    // `outputSchema: null` until someone happened to save it a second time —
    // invisible while nothing read those columns, and load-bearing the moment
    // a subflow node did: embedding a freshly-created flow gave a node with no
    // ports and nothing saying why.
    //
    // `resolveOutputSchemaRef` is passed an empty id: it exists to stop a flow
    // citing its own contract, and a flow that does not exist yet cannot be
    // cited by anything, including itself.
    const inputSchema = JSON.stringify(deriveInputSchema(graph, await this.flowInputRefs(graph, schemaCache)));
    const out = await deriveOutputSchema(graph, (ref) => this.resolveOutputSchemaRef("", ref));
    try {
      return await this.prisma.flow.create({
        data: {
          name,
          description: input.description ?? null,
          graphJson: JSON.stringify(graph),
          tags: input.tags ?? null,
          inputSchema,
          outputSchema: out ? JSON.stringify(out) : null,
        },
      });
    } catch (e) {
      if (isDuplicateName(e)) throw new BadRequestException(`已经有一条流程叫「${name}」了，换个名字`);
      throw e;
    }
  }

  /** Save the canvas. The derived input/output contracts are recomputed here
   *  rather than trusted from the client: they are what makes this flow usable
   *  as a node elsewhere, so they must follow the graph, not the caller. */
  async update(id: string, patch: UpsertFlowInput) {
    const current = await this.findById(id);
    if (patch.expectedUpdatedAt !== undefined && current.updatedAt.toISOString() !== patch.expectedUpdatedAt) {
      throw new ConflictException("流程已被其它窗口修改，请重新加载服务器版本后再保存");
    }
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = normalizeFlowName(patch.name);
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.tags !== undefined) data.tags = patch.tags;
    if (patch.graphJson !== undefined) {
      const graph = parseFlowGraph(patch.graphJson);
      const schemaCache = new Map<string, ParamSchemaFragment | null>();
      await this.validateFieldSchemaRefs(graph, schemaCache);
      data.graphJson = JSON.stringify(graph);
      data.inputSchema = JSON.stringify(deriveInputSchema(graph, await this.flowInputRefs(graph, schemaCache)));
      const out = await deriveOutputSchema(graph, (ref) => this.resolveOutputSchemaRef(id, ref));
      data.outputSchema = out ? JSON.stringify(out) : null;
    }
    try {
      return await this.prisma.flow.update({ where: { id }, data });
    } catch (e) {
      if (isDuplicateName(e)) throw new BadRequestException(`已经有一条流程叫「${String(data.name)}」了，换个名字`);
      throw e;
    }
  }

  /** Soft delete, cascading to this flow's runs and their node rows in one
   *  transaction. See BooksService.delete for why the FK `onDelete: Cascade`
   *  does not do this for us. */
  async remove(id: string) {
    await this.findById(id);
    const deletedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.flowNodeRun.updateMany({ where: { flowRun: { flowId: id }, deletedAt: null }, data: { deletedAt } });
      await tx.flowRun.updateMany({ where: { flowId: id, deletedAt: null }, data: { deletedAt } });
      // Flow-targeted schedules hang off this flow the same way book-targeted
      // ones hang off a book (`onDelete: Cascade` on Schedule.flowId).
      await tx.schedule.updateMany({ where: { flowId: id, deletedAt: null }, data: { deletedAt } });
      await tx.flow.update({ where: { id }, data: { deletedAt } });
    });
    return { ok: true };
  }

  /** Real delete; the database's `onDelete: Cascade` takes the descendants.
   *  Deliberately not routed — see BooksService.purge. */
  async purge(id: string) {
    await this.prisma.flow.delete({ where: { id } });
    return { ok: true };
  }

  /** Resolve every node's ports, which needs the database: a book's ports come
   *  from its stored paramSchema, a script's from the schema registry. */
  async resolvePorts(graph: FlowGraph): Promise<PortMap> {
    const map: PortMap = new Map();
    const bookIds = graph.nodes.filter((n) => n.type === "book").map((n) => (n.config as { bookId?: string }).bookId).filter((v): v is string => !!v);
    // A deleted book resolves to no ports, which surfaces as a validation
    // error on the node that still cites it — the right outcome, since
    // triggering that flow would enqueue against a book the user removed.
    const books = bookIds.length
      ? await this.prisma.book.findMany({ where: { id: { in: bookIds }, deletedAt: null }, select: { id: true, name: true, paramSchema: true, outputSchema: true } })
      : [];
    const bookById = new Map(books.map((b) => [b.id, b]));

    for (const node of graph.nodes) {
      map.set(node.id, await this.portsFor(node, bookById));
    }
    // Routers inherit from upstream, so they can only be filled in once every
    // other node's ports exist.
    propagateRouterSchemas(graph, map);
    return map;
  }

  private async portsFor(
    node: FlowNode,
    bookById: Map<string, { id: string; name: string; paramSchema: string; outputSchema: string | null }>,
  ): Promise<FlowPort[]> {
    switch (node.type) {
      case "book": {
        const book = bookById.get((node.config as { bookId?: string }).bookId ?? "");
        if (!book) return [];
         const params = parseParamSpecs(book.paramSchema);
         return [...paramsToInputPorts(params, await this.paramResolver(params)), ...bookOutputPorts(parseJsonSchema(book.outputSchema))];
      }
      case "script": {
        const config = node.config as ScriptNodeConfig;
        // Inline contract wins over the registry citation, mirroring `FlowOutputNodeConfig`
        // below and keeping the canvas + server in lockstep — both call the same
        // shared rule and only differ in where they resolve a citation from.
        const input = config.inputSchema ? await resolveEmbeddedSchemaRefs(config.inputSchema, (ref) => this.schemaFor(ref)) : await this.schemaFor(config.inputSchemaRef);
        const output = config.outputSchema ? await resolveEmbeddedSchemaRefs(config.outputSchema, (ref) => this.schemaFor(ref)) : await this.schemaFor(config.outputSchemaRef);
         const scriptParams = input ? parseJsonSchemaParams(input) : [];
         return [
           ...scriptInputPorts(input, await this.paramResolver(scriptParams)).map((p) =>
            config.inputSchema ? p : config.inputSchemaRef ? { ...p, schemaRef: config.inputSchemaRef } : p,
          ),
          {
            id: "output",
            label: "输出",
            direction: "out",
            required: false,
            schema: output,
            schemaRef: config.outputSchema ? undefined : config.outputSchemaRef,
          },
        ];
      }
      case "transform": {
        const outputs = (node.config as { outputs?: Array<{ id: string; label?: string; schema?: ParamSchemaFragment; schemaRef?: { name: string; version?: number } }> }).outputs ?? [];
        const ports: FlowPort[] = [{ id: "input", label: "输入", direction: "in", required: true, schema: null }];
        for (const out of outputs) {
          ports.push({ id: out.id, label: transformOutputKey(out), direction: "out", required: false, schema: out.schema ?? await this.schemaFor(out.schemaRef), ...(out.schema ? {} : out.schemaRef ? { schemaRef: out.schemaRef } : {}) });
        }
        return ports;
      }
      case "branch": {
        // Schemas arrive later, in `propagateRouterSchemas` — a branch has no
        // contract of its own, only whatever its upstream turned out to be.
        return branchPorts(node.config as BranchNodeConfig, null);
      }
      case "merge": {
        return mergePorts(node.config as MergeNodeConfig, null);
      }
      case "map":
      case "collect": {
        // Both take their shape from upstream, filled in by
        // `propagateRouterSchemas` — a map goes one level DOWN (array → its
        // element) and a collect one level back UP.
        return node.type === "map" ? mapPorts(null) : collectPorts(null);
      }
      case "flow": {
        // The child's own contract, read off the child. Nothing is declared
        // twice, so a child that gains a parameter grows a handle here.
        const childId = (node.config as SubflowNodeConfig).flowId;
        if (!childId) return [];
        const child = await this.prisma.flow.findFirst({
          where: { id: childId, deletedAt: null },
          select: { inputSchema: true, outputSchema: true },
        });
        // No ports rather than guessed ones: a node pointing at a flow that is
        // gone should be unwireable, and `validateSubflows` says why.
        if (!child) return [];
         const childParams = parseParamSpecs(child.inputSchema);
         const childOutput = parseJsonSchema(child.outputSchema);
         return subflowPorts(childParams, childOutput, await this.paramResolver(childParams));
      }
      case "flowInput": {
        // The flow's own inputs are OUTPUTS as far as the graph is concerned:
        // they are where values enter and flow onward. Read through the shared
        // helper, not straight off `config.params`, because the node may cite
        // the registry instead — and this must agree with the canvas, which
        // resolves it the same way.
        const config = node.config as { schemaRef?: { name: string; version?: number } };
         const cited = config.schemaRef ? await this.schemaFor(config.schemaRef) : null;
         const params = flowInputParams(node.config, () => cited);
         const resolver = await this.paramResolver(params);
         return params.map((p) => ({
          // The canvas resolves this identically (`flow-ports-client.ts`); the
          // handle is the parameter's stable id, the label is its editable name.
          id: flowInputPortId(p),
          label: p.name,
          direction: "out" as const,
          required: false,
           schema: resolveParamSchema(p, resolver).schema,
           ...(p.schemaRef ? { schemaRef: p.schemaRef } : config.schemaRef ? { schemaRef: config.schemaRef } : {}),
        }));
      }
      case "flowOutput": {
        const config = node.config as { schemaRef?: { name: string; version?: number }; schema?: ParamSchemaFragment | null };
        return [{ id: "value", label: "流程产出", direction: "in", required: true, schema: config.schema ? await resolveEmbeddedSchemaRefs(config.schema, (ref) => this.schemaFor(ref)) : await this.schemaFor(config.schemaRef), schemaRef: config.schemaRef }];
      }
      default:
        return [];
    }
  }

  /** A registry citation resolved to its document, or null when it names
   *  nothing — an unresolvable ref degrades the port to "undeclared" rather
   *  than failing the whole graph, since the author is probably mid-edit. */
  /** Pre-resolve every `schemaRef` the graph's flowInput nodes cite, so the
   *  shared `deriveInputSchema` can stay synchronous.
   *
   *  It is synchronous because its other caller is a `useMemo` in FlowEditor
   *  with the registry already in hand; making it async to suit this side would
   *  have pushed that into state-and-effect for nothing. The asynchrony belongs
   *  here, where the database is. */
  private async flowInputRefs(graph: FlowGraph, schemaCache = new Map<string, ParamSchemaFragment | null>()): Promise<SchemaRefResolver> {
    const key = (ref: { name: string; version?: number }) => `${ref.name}@${ref.version ?? "active"}`;
    for (const node of graph.nodes) {
      if (node.type !== "flowInput") continue;
      const ref = (node.config as { schemaRef?: { name: string; version?: number } }).schemaRef;
      if (!ref?.name || schemaCache.has(key(ref))) continue;
      schemaCache.set(key(ref), await this.schemaFor(ref, schemaCache));
    }
    return (ref) => schemaCache.get(key(ref)) ?? null;
  }

   private async schemaFor(ref: { name: string; version?: number } | undefined, schemaCache?: Map<string, ParamSchemaFragment | null>): Promise<ParamSchemaFragment | null> {
     if (!ref?.name) return null;
     const key = `${ref.name}@${ref.version ?? "active"}`;
     if (schemaCache?.has(key)) return schemaCache.get(key) ?? null;
     const resolved = await resolveSchemaCitation(this.schemas, ref);
     schemaCache?.set(key, resolved);
     return resolved;
   }

   private async paramResolver(specs: ParamSpec[], schemaCache = new Map<string, ParamSchemaFragment | null>()): Promise<ParamSchemaResolver> {
    const resolved = new Map<string, ParamSchemaFragment | null>();
    for (const spec of specs) {
      if (!spec.schemaRef) continue;
      const ref = spec.schemaRef;
       resolved.set(`${ref.name}@${ref.version}`, await this.schemaFor(ref, schemaCache));
    }
    return (ref) => resolved.get(`${ref.name}@${ref.version}`) ?? null;
  }

  private async validateFieldSchemaRefs(graph: FlowGraph, schemaCache = new Map<string, ParamSchemaFragment | null>()): Promise<void> {
    const problems = await this.fieldSchemaRefProblems(graph, schemaCache);
    if (problems.length > 0) {
      throw new BadRequestException(`无法保存流程：${problems.slice(0, 5).map((p) => p.message).join("; ")}`);
    }
  }

  /** The same reference checks are exposed by the Validate action so a broken
   * field points to the node and inspector tab instead of only producing a
   * save-time toast. */
  private async fieldSchemaRefProblems(graph: FlowGraph, schemaCache = new Map<string, ParamSchemaFragment | null>()): Promise<FlowProblem[]> {
    const problems: FlowProblem[] = [];
    const check = async (node: FlowNode, path: string, specs: ParamSpec[]) => {
      const resolver = await this.paramResolver(specs, schemaCache);
      for (const spec of specs) {
        const result = resolveParamSchema(spec, resolver);
        if (result.status === "missing" || result.status === "invalid" || result.status === "conflict") {
          problems.push({ level: "error", at: node.id, path: `${path}.${spec.name}`, tab: "io", message: `${node.label ?? node.id} / ${path} / ${spec.name}：${result.message ?? "schemaRef 无法解析"}` });
        }
      }
    };
    const checkRef = async (node: FlowNode, path: string, ref: { name: string; version?: number } | undefined) => {
      if (!ref) return;
      const schema = await this.schemaFor(ref, schemaCache);
      if (!schema || typeof ref.name !== "string" || !ref.name.trim() || (ref.version !== undefined && (!Number.isInteger(ref.version) || ref.version < 1))) {
        problems.push({ level: "error", at: node.id, path, tab: "io", message: `${node.label ?? node.id} / ${path}：Schema 引用 ${ref.name}@${ref.version ?? "?"} 不存在或版本无效` });
      }
    };
    for (const node of graph.nodes) {
      const config = node.config as {
        params?: ParamSpec[];
        schema?: ParamSchemaFragment | null;
        schemaRef?: { name: string; version?: number };
        inputSchema?: ParamSchemaFragment | null;
        inputSchemaRef?: { name: string; version?: number };
        outputSchema?: ParamSchemaFragment | null;
        outputSchemaRef?: { name: string; version?: number };
      };
      if (node.type === "flowInput") {
        if ((config.params ?? []).length > 0) await check(node, "入参", config.params ?? []);
        else await checkRef(node, "入参契约", config.schemaRef);
      }
      if (node.type === "flowOutput") await checkRef(node, "产出契约", config.schemaRef);
      if (node.type === "script") {
        if (config.inputSchema) await check(node, "input", parseJsonSchemaParams(config.inputSchema));
        else await checkRef(node, "input 契约", config.inputSchemaRef);
        if (config.outputSchema) await check(node, "output", parseJsonSchemaParams(config.outputSchema));
        else await checkRef(node, "output 契约", config.outputSchemaRef);
      }
      if (node.type === "transform") {
        for (const output of (node.config as { outputs?: Array<{ id: string; schema?: ParamSchemaFragment; schemaRef?: { name: string; version?: number } }> }).outputs ?? []) {
          if (output.schema && output.schemaRef) {
            problems.push({ level: "error", at: node.id, path: `output.${output.id}`, tab: "io", message: `${node.label ?? node.id} / output ${output.id}：schema 与 schemaRef 不能同时存在` });
          } else await checkRef(node, `output.${output.id}`, output.schemaRef);
        }
      }
    }
    return problems;
  }

  /** The resolver `deriveOutputSchema` calls for a flowOutput's `schemaRef`.
   *  Delegates to `schemaFor` — same degrade-to-null behavior as port
   *  resolution — but additionally warns: unlike a port (which just shows
   *  "undeclared" in the inspector), a null here silently narrows what
   *  `Flow.outputSchema` records for a SAVED flow, which is worth telling an
   *  operator about. Saving must not be held hostage to the registry being
   *  reachable, so this never throws (mirrors filesync's resolveRef). */
  private async resolveOutputSchemaRef(
    flowId: string,
    ref: { name: string; version?: number } | undefined,
  ): Promise<ParamSchemaFragment | null> {
    if (!ref?.name) return null;
    const schema = await this.schemaFor(ref);
    if (!schema) {
      this.logger.warn(
        `flow ${flowId}: flowOutput schemaRef "${ref.name}${ref.version ? `@${ref.version}` : ""}" did not resolve — the declared output falls back to an empty contract`,
      );
    }
    return schema;
  }

  /** Everything wrong with the graph, structural and port-level. */
  async validate(id: string): Promise<{ problems: FlowProblem[]; ok: boolean }> {
    const flow = await this.findById(id);
    const graph = parseFlowGraph(flow.graphJson);
    const problems = [
      ...validateGraphShape(graph),
      ...validateMaps(graph),
      ...(await this.validateSubflows(id, graph)),
      ...(await this.fieldSchemaRefProblems(graph)),
      ...validatePorts(graph, await this.resolvePorts(graph)),
    ];
    return { problems, ok: !problems.some((p) => p.level === "error") };
  }

  /**
   * The checks a subflow node needs, all of which are about the OTHER flow.
   *
   * `validateGraphShape` finds cycles inside one graph and cannot see these:
   * A embedding B embedding A is a cycle drawn across two documents, each of
   * which is a perfectly good DAG on its own. Left unchecked it is not a wrong
   * answer, it is infinite recursion — runs spawning runs until something
   * gives, which on this scheduler means a browser budget held forever by a
   * chain of parents each waiting for a child.
   *
   * Walked at SAVE time rather than at run time on purpose. A recursion that
   * only announces itself once it is running has already made a mess by then,
   * and the person who drew the wire is no longer looking.
   */
  private async validateSubflows(selfId: string, graph: FlowGraph): Promise<FlowProblem[]> {
    const nodes = graph.nodes.filter((n) => n.type === "flow");
    if (nodes.length === 0) return [];

    const problems: FlowProblem[] = [];
    const nameOf = (n: FlowNode): string => n.label ?? FLOW_NODE_TYPE_LABELS[n.type];

    for (const node of nodes) {
      const childId = (node.config as SubflowNodeConfig).flowId;
      if (!childId) {
        problems.push({ level: "error", at: node.id, message: `${nameOf(node)}：还没选要运行哪条流程` });
        continue;
      }
      if (childId === selfId) {
        problems.push({ level: "error", at: node.id, message: `${nameOf(node)}：一条流程不能把自己当子流程 —— 那是无限递归` });
        continue;
      }
      const child = await this.prisma.flow.findFirst({ where: { id: childId, deletedAt: null } });
      if (!child) {
        problems.push({ level: "error", at: node.id, message: `${nameOf(node)}：指向的流程不存在或已删除` });
        continue;
      }
      if (!child.enabled) {
        // An error, not a warning: triggering this flow would fail at the
        // subflow node, and a graph that cannot run is not a graph that saves
        // clean.
        problems.push({ level: "error", at: node.id, message: `${nameOf(node)}：流程「${child.name}」已停用，跑不起来` });
        continue;
      }
      const loop = await this.subflowPathTo(childId, selfId);
      if (loop) {
        problems.push({
          level: "error",
          at: node.id,
          message: `${nameOf(node)}：会绕回本流程 —— ${loop.join(" → ")} —— 无限递归`,
        });
      }
    }
    return problems;
  }

  /**
   * A path of subflow edges from `fromId` back to `targetId`, or null.
   *
   * Breadth-first over `Flow.graphJson`, which means one query per flow
   * VISITED, not per edge — a diamond where two nodes embed the same child
   * reads it once. `seen` is what makes it terminate on a graph that already
   * contains a cycle, which is exactly the state this runs in when someone is
   * about to add the closing edge.
   */
  private async subflowPathTo(fromId: string, targetId: string): Promise<string[] | null> {
    const seen = new Set<string>([fromId]);
    let frontier: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [] }];

    while (frontier.length > 0) {
      const next: Array<{ id: string; path: string[] }> = [];
      for (const { id, path } of frontier) {
        const flow = await this.prisma.flow.findFirst({ where: { id, deletedAt: null }, select: { name: true, graphJson: true } });
        if (!flow) continue;
        const here = [...path, flow.name];
        for (const child of parseFlowGraph(flow.graphJson).nodes.filter((n) => n.type === "flow")) {
          const childId = (child.config as SubflowNodeConfig).flowId;
          if (!childId) continue;
          if (childId === targetId) return here;
          if (seen.has(childId)) continue;
          seen.add(childId);
          next.push({ id: childId, path: here });
        }
      }
      frontier = next;
    }
    return null;
  }

  /**
   * Start a flow. Creates the FlowRun and its per-node rows; the dispatcher
   * picks them up on its next tick.
   *
   * The graph is snapshotted here so that editing the flow afterwards cannot
   * change what a past run meant — the same reason a Run stores its params
   * instead of re-reading the book.
   */
  async trigger(id: string, params: ParamMap = {}, trigger = "manual", mode?: string, parentFlowRunId?: string, execution?: ScheduleExecution) {
    const runId = execution ? scheduleExecutionId('flow', execution) : randomUUID();
    if (execution) {
      const existing = await this.prisma.flowRun.findUnique({ where: { id: runId }, include: { nodes: true } });
      if (existing) return existing;
    }
    const flow = await this.findById(id);
    if (!flow.enabled) throw new BadRequestException(`flow "${flow.name}" is disabled`);

    const check = await this.validate(id);
    if (!check.ok) {
      const first = check.problems.filter((p) => p.level === "error").slice(0, 3).map((p) => p.message);
      throw new BadRequestException(`flow has unresolved errors: ${first.join("; ")}`);
    }

    const graph = parseFlowGraph(flow.graphJson);
    const bodyNodes = new Set(mapOwners(graph).keys());
    const specs = deriveInputSchema(graph, await this.flowInputRefs(graph));
    const preprocessSpec = specs.find((candidate) =>
      candidate.name === "preprocessConfig"
      && candidate.schemaRef?.name === PREPROCESS_CONFIG_SCHEMA.name
      && candidate.schemaRef.version === PREPROCESS_CONFIG_SCHEMA.version,
    );
    let effectiveParams = params;
    if (preprocessSpec && params.preprocessConfig === undefined) {
      const records = await this.prisma.schemaRecord.findMany({
        where: {
          schemaName: PREPROCESS_CONFIG_SCHEMA.name,
          schemaVersion: PREPROCESS_CONFIG_SCHEMA.version,
          deletedAt: null,
        },
        orderBy: { createdAt: "desc" },
        take: 2,
        select: { data: true },
      });
      if (records.length > 1) {
        throw new BadRequestException("存在多条 product-preprocess-config SchemaRecord，请在流程参数中明确选择一条");
      }
      effectiveParams = applyPreprocessConfigDefault(specs, params, records[0] ?? null);
    }
    const resolver = await this.paramResolver(specs);
    const resolved = normalizeParams(specs, resolveParamDefaults(specs, effectiveParams, {
      bookName: flow.name,
      runId,
      planId: `flow_${runId}`,
      uuid: randomUUID(),
     }, resolver), resolver);
     const problems = validateParams(specs, resolved, resolver);
    if (problems.length > 0) throw new BadRequestException(problems.join("; "));

    try {
      return await this.prisma.flowRun.create({
        data: {
          id: runId,
          scheduleId: execution?.scheduleId,
          flowId: flow.id,
          graphSnapshot: flow.graphJson,
          trigger,
          mode: mode ?? 'auto',
          status: 'pending',
          paramsJson: JSON.stringify(resolved),
          // 子流程和恢复链复用父级列，由 trigger 区分父级关系的含义。
          ...(parentFlowRunId ? { parentFlowRunId } : {}),
          dedupeKey: execution?.dedupeKey ?? `${trigger}:${flow.id}:${Date.now()}`,
          nodes: {
            // map 体内的节点按迭代创建，此处创建会留下永远 pending 的无迭代记录。
            create: graph.nodes
              .filter((n) => !bodyNodes.has(n.id))
              .map((n) => ({ nodeId: n.id, nodeType: n.type, status: 'pending' })),
          },
        },
        include: { nodes: true },
      });
    } catch (error) {
      if (execution && isUniqueViolation(error)) {
        const existing = await this.prisma.flowRun.findUnique({ where: { id: runId }, include: { nodes: true } });
        if (existing) return existing;
      }
      throw error;
    }
  }

  listRuns(flowId?: string, limit = 50, opts: { includeDeleted?: boolean } = {}) {
    return this.prisma.flowRun.findMany({
      where: {
        ...(flowId ? { flowId } : {}),
        ...(opts.includeDeleted ? {} : { deletedAt: null }),
      },
      orderBy: { queuedAt: "desc" },
      take: limit,
      include: { flow: { select: { name: true } } },
    });
  }

  async getRun(id: string) {
    const run = await this.prisma.flowRun.findFirst({
      where: { id, deletedAt: null },
      // createdAt 给 SQL 层一个稳定的插入顺序基线；真实执行顺序由
      // compareFlowNodesByExecution 在拿到结果后再排一次。
      include: { nodes: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } }, flow: { select: { name: true } } },
    });
    if (!run) throw new NotFoundException(`flow run ${id} not found`);
    const resumeBlockReason = run.status === 'failed'
      ? selectResumeRows(parseFlowGraph(run.graphSnapshot), run.nodes).resumeBlockReason
      : null;
    // 已发生的节点按真实开始时间正序排，未启动的节点排到末尾。SQLite + Prisma 5
    // 不能在 orderBy 里表达 NULLS LAST（且 Prisma 把 NULL 默认排在 ASC 的最前，
    // 那样会让所有 pending 节点霸占时间线顶端），所以走应用层稳定排序。
    const nodes = [...run.nodes].sort(compareFlowNodesByExecution);
    return { ...run, nodes, resumeBlockReason };
  }

  async cancelRun(id: string) {
    const run = await this.getRun(id);
    if (['success', 'failed'].includes(run.status)) return run;
    if (!this.cancellationHandler) throw new Error('Flow cancellation handler is unavailable');
    await this.cancellationHandler(id);
    return this.getRun(id);
  }

  /**
   * Pick a failed run up where it stopped: a new run that inherits the finished
   * work and re-does only what did not finish.
   *
   * The alternative was re-triggering, which is what everyone did instead, and
   * it is expensive in the way that matters here — the nodes it repeats are the
   * ones that drive a browser, so a flow that scraped four products and then
   * broke on the fifth scraped all four again. Copying a `success` row is not a
   * shortcut around running it; the node DID run, in the parent, and its
   * product is right there.
   *
   * THE SNAPSHOT IS THE PARENT'S, not the flow's current graph. A flow edited
   * between the two runs would otherwise have its new node ids checked against
   * rows minted under the old ones, and the mismatch would show up as nodes
   * mysteriously starting from scratch — or not at all.
   */
  resumeRun(id: string) {
    const active = this.resumes.get(id);
    if (active) return active;
    // 仅协调本进程内的并发请求；跨进程仍需持久化约束才能保证唯一性。
    const operation = this.resumeRunLocked(id).finally(() => {
      if (this.resumes.get(id) === operation) this.resumes.delete(id);
    });
    this.resumes.set(id, operation);
    return operation;
  }

  private async resumeRunLocked(id: string) {
    const old = await this.getRun(id);
    if (old.status !== "failed") {
      // `cancelled` is deliberately not resumable: someone stopped this on
      // purpose, and the half-finished state was not what they were after.
      throw new BadRequestException(`flow run ${id} is ${old.status} — 只有失败的运行可以续跑`);
    }

    // The same gate `trigger` puts on starting a run, because this starts one
    // too — same `pending` row, same dispatcher, same browser. Skipping it
    // would mean the switch someone flipped BECAUSE the flow was misbehaving
    // stops a fresh start and not a resume, which is the one people reach for
    // when a flow is misbehaving.
    const flow = await this.findById(old.flowId);
    if (!flow.enabled) throw new BadRequestException(`flow "${flow.name}" is disabled`);

    // 终态与软删除都不能证明外部操作未提交，旧父运行不能另开恢复链。
    const child = await this.prisma.flowRun.findFirst({
      where: { parentFlowRunId: old.id, trigger: 'manual' },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      include: { nodes: true },
    });
    if (child) {
      if (!child.deletedAt && ['pending', 'running'].includes(child.status)) return child;
      throw new BadRequestException(`该运行已续跑，请查看最新子运行 ${child.id} 并核验结果，不能从旧父运行再次续跑。`);
    }

    const graph = parseFlowGraph(old.graphSnapshot);
    const { seeded, before, carriedIterations, resumeBlockReason } = selectResumeRows(graph, old.nodes);
    if (resumeBlockReason) throw new BadRequestException(resumeBlockReason);

    return this.prisma.flowRun.create({
      data: {
        flowId: old.flowId,
        graphSnapshot: old.graphSnapshot,
        trigger: "manual",
        mode: old.mode,
        status: "pending",
        paramsJson: old.paramsJson,
        parentFlowRunId: old.id,
        dedupeKey: `resume:${old.id}:${Date.now()}`,
        nodes: {
          create: [
            ...carriedIterations.map((r) => ({
              nodeId: r.nodeId,
              nodeType: r.nodeType,
              iteration: r.iteration,
              status: r.status,
              inputJson: r.inputJson,
              outputJson: r.outputJson,
              runId: r.runId,
              childFlowRunId: r.childFlowRunId,
              errorMessage: r.errorMessage,
              startedAt: r.startedAt,
              finishedAt: r.finishedAt,
              durationMs: r.durationMs,
            })),
            ...seeded.map((n) => {
            const prior = before.get(n.id);
            if (prior?.status !== "success") return { nodeId: n.id, nodeType: n.type, status: "pending" };
            // Carried whole, including how long it took and which book run
            // produced it, so the resumed run reads as one history rather than
            // as a run whose first half has no timings.
            return {
              nodeId: n.id,
              nodeType: n.type,
              status: "success",
              inputJson: prior.inputJson,
              outputJson: prior.outputJson,
              runId: prior.runId,
              childFlowRunId: prior.childFlowRunId,
              startedAt: prior.startedAt,
              finishedAt: prior.finishedAt,
              durationMs: prior.durationMs,
            };
            }),
          ],
        },
      },
      include: { nodes: true },
    });
  }
}

function selectResumeRows<Row extends ResumeRunRow>(graph: FlowGraph, rows: Row[]) {
  const owners = mapOwners(graph);
  const seeded = graph.nodes.filter((node) => !owners.has(node.id));
  const before = new Map(rows.filter((row) => row.iteration == null).map((row) => [row.nodeId, row]));
  const carriedIterations = rows.filter((row) => {
    if (row.iteration == null) return false;
    const mapId = owners.get(row.nodeId);
    return mapId !== undefined && before.get(mapId)?.status === 'success';
  });
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const rerunRows = rows.filter((row) => {
    if (!nodeIds.has(row.nodeId)) return false;
    const mapId = owners.get(row.nodeId);
    // 未完成的 map 从首项重放，体内成功行也会再次执行。
    if (mapId !== undefined) return before.get(mapId)?.status !== 'success';
    return before.get(row.nodeId)?.status !== 'success';
  });
  return { seeded, before, carriedIterations, resumeBlockReason: getResumeBlockReason(graph, rerunRows) };
}

/**
 * A `name@version` citation resolved to its registry document, or null when it
 * names nothing.
 *
 * A free function rather than a method because the RUNNER needs the same answer
 * — a script node's product is checked against the contract it cites, and a
 * second copy of "how do I resolve a ref" is exactly how the canvas and the run
 * end up disagreeing about what a node promised.
 *
 * Degrading to null instead of throwing is deliberate and shared by both
 * callers: an unresolvable ref means the port shows as undeclared and the value
 * goes unchecked, which is what an author mid-edit needs. It must never take a
 * save or a run down with it.
 */
export async function resolveSchemaCitation(
  schemas: SchemasService,
  ref: { name: string; version?: number } | undefined,
): Promise<ParamSchemaFragment | null> {
  if (!ref?.name) return null;
  try {
    const row = await schemas.resolve(ref.name, ref.version);
    return parseJsonSchema(row.jsonSchema);
  } catch {
    return null;
  }
}

/**
 * What only a map can get wrong.
 *
 * Kept out of `validateGraphShape` because that function is shared with the
 * canvas and deliberately needs no knowledge of any node type's semantics —
 * these three are semantic, and all three are the kind of mistake that would
 * otherwise surface as a run that quietly did the wrong thing rather than a
 * save that said no.
 */
export function validateMaps(graph: FlowGraph): FlowProblem[] {
  const problems: FlowProblem[] = [];
  const scopes = new Map(graph.nodes.filter((n) => n.type === "map").map((n) => [n.id, mapScope(graph, n.id)]));
  const nameOf = (id: string): string => graph.nodes.find((n) => n.id === id)?.label ?? id;

  for (const [mapId, scope] of scopes) {
    const name = nameOf(mapId);
    if (!scope.collectId) {
      problems.push({ level: "error", at: mapId, message: `${name}：下游没有「收集结果」节点，每一项的结果无处可去` });
      continue;
    }
    // More than one reachable collect means the pairing is ambiguous, and the
    // runtime resolves it by taking the first — silently. Refusing here is what
    // stops the OTHER collect from being reported as unreachable, which it is
    // not: there is a path, it just was not the one chosen.
    if (scope.collects.length > 1) {
      problems.push({
        level: "error",
        at: mapId,
        message: `${name}：下游有 ${scope.collects.length} 个「收集结果」（${scope.collects.map(nameOf).join("、")}），一个「逐项处理」只能配一个`,
      });
      continue;
    }
    // An empty body is a map that can never advance: `seedIteration` creates no
    // rows, so the controller finds nothing to wait on and returns on every
    // tick forever. The identity shape — `item` wired straight into `result` —
    // is the first thing anyone tries, and it used to pass validation and then
    // wedge the run with no diagnostic anywhere.
    if (scope.body.size === 0) {
      problems.push({
        level: "error",
        at: mapId,
        message: `${name}：与「${nameOf(scope.collectId)}」之间没有任何节点，每一项没有要做的事`,
      });
      continue;
    }
    const nested = [...scope.body].filter((id) => graph.nodes.find((n) => n.id === id)?.type === "map");
    if (nested.length > 0) {
      problems.push({ level: "error", at: mapId, message: `${name}：暂不支持嵌套的「逐项处理」` });
    }
    for (const id of scope.dangling) {
      problems.push({
        level: "warn",
        at: id,
        message: `${nameOf(id)}：接在「${name}」下面却到不了「收集结果」，会每一项跑一遍但结果被丢掉`,
      });
    }
  }

  // A node in two maps' bodies belongs to whichever map `mapOwners` wrote last,
  // and the loser then waits forever on rows nobody seeds — while its own row
  // stays `success`, so the RUN reports success with half its work never done.
  // Silently wrong beats loudly broken only in the other direction.
  const claimed = new Map<string, string[]>();
  for (const [mapId, scope] of scopes) {
    for (const id of scope.body) claimed.set(id, [...(claimed.get(id) ?? []), mapId]);
  }
  for (const [nodeId, mapIds] of claimed) {
    if (mapIds.length < 2) continue;
    problems.push({
      level: "error",
      at: nodeId,
      message: `${nameOf(nodeId)}：同时属于 ${mapIds.length} 个「逐项处理」（${mapIds.map(nameOf).join("、")}），一个节点只能归一个`,
    });
  }

  // A collect nobody iterates into never settles, so the run would hang on it.
  // Judged against every REACHABLE collect, not only the chosen one — otherwise
  // the unchosen half of an ambiguous pairing gets accused of being unwired.
  const reachableCollects = new Set([...scopes.values()].flatMap((s) => s.collects));
  for (const node of graph.nodes) {
    if (node.type !== "collect" || reachableCollects.has(node.id)) continue;
    problems.push({ level: "error", at: node.id, message: `${nameOf(node.id)}：没有任何「逐项处理」通向它，它永远不会产出` });
  }
  return problems;
}

function parseJsonSchema(json: string | null | undefined): ParamSchemaFragment | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ParamSchemaFragment) : null;
  } catch {
    return null;
  }
}

function parseJsonSchemaParams(schema: ParamSchemaFragment): ParamSpec[] {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return parseParamSpecs(JSON.stringify(schema));
}

/**
 * The flow's output contract: an object keyed by flowOutput node, at any node
 * count.
 *
 * A single output used to yield its schema BARE, which contradicted the only
 * thing that produces the value — `finishRun` keys every product by node name
 * unconditionally. So a one-output flow declared `{reply: string}` and produced
 * `{产出: {reply: string}}`, and the disagreement was not cosmetic: this
 * declaration is what `describeOutputs` validates the product against, so a
 * correct run landed with a contract violation recorded on it.
 *
 * It also made the SHAPE depend on the node count — adding a second flowOutput
 * silently rewrote the first one's contract. The input side has never done
 * that (`deriveInputSchema` always returns a ParamSpec[], and a new node only
 * appends), and neither does any comparable orchestrator: GitHub Actions,
 * Argo and n8n all name both sides.
 *
 * A flowOutput declares its contract one of two ways — inline (`config.schema`)
 * or by citing the registry (`config.schemaRef`) — and `resolveSchemaRef` is
 * how the caller resolves the latter. This must stay the same priority as
 * `portsFor`'s `flowOutput` case (`config.schema ?? schemaFor(ref)`): those
 * two are what the canvas shows and what gets recorded on the Flow, and a
 * flow whose port says one contract and whose `outputSchema` says another is
 * exactly the FLOW-1 bug class this function exists to prevent.
 */
export async function deriveOutputSchema(
  graph: FlowGraph,
  resolveSchemaRef: (ref: { name: string; version?: number } | undefined) => Promise<ParamSchemaFragment | null>,
): Promise<ParamSchemaFragment | null> {
  const outputs = graph.nodes.filter((n) => n.type === "flowOutput");
  if (outputs.length === 0) return null;
  const properties: Record<string, ParamSchemaFragment> = {};
  for (const node of outputs) {
    const config = node.config as { schema?: ParamSchemaFragment | null; schemaRef?: { name: string; version?: number } };
    properties[flowOutputKey(node)] = config.schema
      ? await resolveEmbeddedSchemaRefs(config.schema, resolveSchemaRef)
      : (await resolveSchemaRef(config.schemaRef)) ?? {};
  }
  return { type: "object", properties };
}

/** FlowNodeRun 行里参与排序的字段。抽成局部类型，便于单元测试不依赖 Prisma。
 *  `createdAt` 在生产路径上总是有值（schema 默认 `now()`），但旧测试夹具里
 *  没填——comparator 在缺失时跳过 createdAt 兜底即可，不应该崩。 */
export type FlowNodeExecutionOrderRow = {
  nodeId: string;
  iteration: number | null;
  startedAt: Date | null;
  createdAt?: Date;
};

/** 把 FlowNodeRun 按"实际发生时间"排序，供执行时间线使用。
 *
 *  不在 SQL 层做是有原因的：SQLite + Prisma 5 的 `orderBy: { startedAt: "asc" }`
 *  会把 NULL 排在最前——这恰好与时间线想要的相反（pending 节点还没发生）。
 *  Prisma 5.20 也没把 `NULLS LAST` 带到 SQLite，必须用 raw query 才能表达，
 *  而 raw query 在这里会把整条链路的类型推断拖成 `unknown`。改成 JS 稳定
 *  排序的好处：
 *
 *    - 行为可单测（纯函数）。
 *    - 不依赖数据库方言细节。
 *    - 单次流程的节点数最多几十条，开销可忽略。
 *
 *  排序规则：
 *    1. `startedAt` ASC。已发生的节点（带时间戳）构成"过去"，排在前。
 *    2. NULL `startedAt` 排到末尾。pending/ready 是"未来"，跟在过去之后。
 *    3. 双 NULL 时回退 `createdAt` ASC——避免 cuid 随机性让新建的 pending
 *       行抖得到处乱跑。
 *    4. 最终平局裁决：先 `nodeId` ASC（不同节点之间没有拓扑语义，给一个
 *       跨进程的稳定顺序即可），同 `nodeId` 时再 `iteration` ASC（map 展
 *       开在同一帧内会拿到相同时间戳，iteration 是 schema 的唯一键）。
 *
 *  第 4 步的顺序是关键：把 `nodeId` 放在 `iteration` 之前，意味着不同节
 *  点之间的平局不会被「null iteration 兜成 0」这一逻辑污染——这正是第一
 *  版的回归点（不同 nodeId 的两条同毫秒行会因为 iteration=null??0=0 vs 2
 *  互相错位）。
 */
export function compareFlowNodesByExecution(
  a: FlowNodeExecutionOrderRow,
  b: FlowNodeExecutionOrderRow,
): number {
  const aStart = a.startedAt;
  const bStart = b.startedAt;
  if (aStart && bStart) {
    const diff = aStart.getTime() - bStart.getTime();
    if (diff !== 0) return diff;
  } else if (aStart && !bStart) {
    return -1;
  } else if (!aStart && bStart) {
    return 1;
  } else {
    // 双 NULL：回退 createdAt。生产路径上 createdAt 永远存在；测试夹具
    // 没填时直接跳过这层平局裁决，让后面的 nodeId/iteration 兜底——避免
    // 真实数据没问题、单元测试却崩在 undefined.getTime() 上。
    if (a.createdAt && b.createdAt) {
      const diff = a.createdAt.getTime() - b.createdAt.getTime();
      if (diff !== 0) return diff;
    }
  }
  // 平局裁决——只在 startedAt 相同（同毫秒的 map 展开）或双方都 NULL 且
  // createdAt 也相同时才会走到。
  const aIter = a.iteration;
  const bIter = b.iteration;
  // 平局裁决顺序：先 nodeId，再 iteration。把 nodeId 放在 iteration 之前
  // 是有意的——不同节点之间没有拓扑语义，iteration=null??0=0 这一逻辑
  // 不能跨 nodeId 污染，否则同毫秒的两条不同节点会因为一方的 null iteration
  // 被错误地排到 iteration=2 的前面（第一版的回归点）。
  if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
  if (aIter == null && bIter == null) return 0;
  if (aIter == null) return 1;
  if (bIter == null) return -1;
  return aIter - bIter;
}
