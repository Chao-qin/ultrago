import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  Tag,
  Typography,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Switch,
  Space,
  message,
  Tooltip,
} from "antd";
import {
  CalendarOutlined,
  PlusOutlined,
  ClockCircleOutlined,
} from "@ant-design/icons";
import { api } from "../lib/api";
import { CronSelector } from "../components/CronSelector";
import { TextClamp } from "../components/TextClamp";
import { ParamFields, paramInitialValues } from "../components/ParamForm";
import { useSchemaResolver } from "../lib/use-schema-resolver";
import { DeliveryFields, collectDeliveries, deliveryInitialValues } from "../components/DeliveryForm";
import { PageTable } from "../components/PageTable";
import { DeletedToggle } from "../components/DeletedToggle";
import { SearchInput } from "../components/SearchInput";
import { BcpSelect } from "../components/BcpSelect";
import dayjs from "dayjs";
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { parseConsoleDeliveries, parseConsoleParams, parseConsoleParamSchema } from "../lib/types";
import type { Book, Delivery, ParamSchema, Schedule, Script } from "../lib/types";
import { BOOKS_QUERY_ROOT, bookLinkIsLive, booksQueryKey } from "../lib/books";
import type { FlowSummary } from "../lib/types";
import { ConsoleFormSection } from '../components/console-form-section';
import { RowActions, ROW_ACTIONS_COLUMN } from "../components/RowActions";
import { PageShell } from "../components/PageShell";
import { SchemaParamEditor } from '../components/schema-param-editor';
import { paramsOfSchema } from '../lib/flow-editor-model';
import { parseScriptContract, resolveScriptContract } from '../lib/script-contract';
import { validateParams } from '@bcp/shared';

dayjs.extend(utc);
dayjs.extend(timezone);

/** Target-type chip: blue book / cyan flow / purple script. */
const TYPE_TAG: Record<string, { color: string; label: string }> = {
  book: { color: "blue", label: "Book" },
  flow: { color: "cyan", label: "Flow" },
  script: { color: "purple", label: "Script" },
};

export function Schedules() {
  const qc = useQueryClient();
  const [queryParams, setQueryParams] = useSearchParams();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [search, setSearch] = useState("");
  const schedules = useQuery({
    queryKey: ["schedules", includeDeleted],
    queryFn: () => api.listSchedules({ includeDeleted }),
    refetchInterval: 5_000,
  });
  // The book list here feeds the create/edit form's target picker, so it stays
  // live-only regardless of the switch — you cannot point a new schedule at a
  // deleted book. That "live-only" is spelled out in the key as well as the
  // request, so this and the Books page's default view share one cache entry
  // instead of polling one URL twice.
  // No refetchInterval, for the same reason as the Books page: this feeds a
  // picker, and the set of books changes only on a playbook edit + 重新扫描.
  const books = useQuery({ queryKey: booksQueryKey(false), queryFn: () => api.listBooks({ includeDeleted: false }) });
  // Flows and scripts feed the create/edit form's target picker for their own
  // kinds, live-only for the same reason as books: you can't point a schedule
  // at a deleted resource.
  const flows = useQuery({ queryKey: ["flows", false], queryFn: () => api.listFlows({ includeDeleted: false }) });
  const scripts = useQuery({ queryKey: ["scripts", false], queryFn: () => api.listScripts({ includeDeleted: false }) });
  const scheduleSchemaResolver = useSchemaResolver();

  const [editing, setEditing] = useState<Schedule | null>(null);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();
  const openCreator = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ targetType: 'book', timezone: 'Asia/Shanghai', mode: 'auto', enabled: true, params: {} });
    setCreating(true);
  };

  const requestedScriptId = queryParams.get('scriptId');
  useEffect(() => {
    if (!requestedScriptId || !scripts.data) return;
    const requestedScript = scripts.data.find((item) => item.id === requestedScriptId);
    const next = new URLSearchParams(queryParams);
    next.delete('scriptId');
    setQueryParams(next, { replace: true });
    if (!requestedScript) {
      message.error('未找到要创建定时任务的脚本');
      return;
    }
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      targetType: 'script',
      scriptId: requestedScript.id,
      name: `${requestedScript.name} 定时任务`,
      timezone: 'Asia/Shanghai',
      mode: 'auto',
      enabled: true,
      timeoutMs: 60_000,
      params: {},
    });
    setCreating(true);
  }, [form, queryParams, requestedScriptId, scripts.data, setQueryParams]);

  const createMut = useMutation({
    mutationFn: api.createSchedule,
    onSuccess: () => {
      message.success("定时任务已创建");
      qc.invalidateQueries({ queryKey: ["schedules"] });
      qc.invalidateQueries({ queryKey: BOOKS_QUERY_ROOT });
      setCreating(false);
      form.resetFields();
    },
    onError: (e) => message.error((e as Error).message),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.updateSchedule>[1] }) =>
      api.updateSchedule(id, patch),
    onSuccess: () => {
      message.success("已更新");
      qc.invalidateQueries({ queryKey: ["schedules"] });
      setEditing(null);
    },
    onError: (e) => message.error((e as Error).message),
  });

  const toggleMut = useMutation({
    mutationFn: api.toggleSchedule,
    onSuccess: (s) => {
      message.success(s.enabled ? "已启用" : "已暂停");
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
    onError: (e) => message.error((e as Error).message),
  });

  const deleteMut = useMutation({
    mutationFn: api.deleteSchedule,
    onSuccess: () => {
      message.success("已删除");
      qc.invalidateQueries({ queryKey: ["schedules"] });
      qc.invalidateQueries({ queryKey: BOOKS_QUERY_ROOT });
    },
    onError: (e) => message.error((e as Error).message),
  });

  const runNowMut = useMutation({
    mutationFn: (id: string) => api.runScheduleNow(id),
    onSuccess: (r) => {
      const isFlowRun = 'id' in r;
      const runId = 'run' in r ? r.run.id : 'runId' in r ? r.runId : r.id;
      message.success(`已触发 run ${(runId ?? "").slice(0, 8) || "(已排队)"}`);
      qc.invalidateQueries({ queryKey: ["schedules"] });
      if (runId) window.location.hash = `#/${isFlowRun ? 'flow-runs' : 'runs'}/${encodeURIComponent(runId)}`;
    },
    onError: (e) => message.error((e as Error).message),
  });

  /** 预填编辑表单。原先整段塞在操作列一个图标按钮的 onClick 里，
   *  三种 targetType 的分支和表格渲染混在一处读不出来。 */
  const openEditor = (record: Schedule) => {
    form.resetFields();
    setEditing(record);
    const defaults = {
      name: record.name,
      description: record.description,
      cronExpr: record.cronExpr,
      timezone: record.timezone,
      mode: record.mode,
      params: parseParams(record.paramsJson),
      deliveries: deliveryInitialValues(parseDeliveries(record.deliveryOverridesJson ?? record.book?.deliveriesJson ?? "[]")),
      enabled: record.enabled,
    };
    if (record.targetType === "flow") {
      form.setFieldsValue({ ...defaults, targetType: "flow", flowId: record.flow?.id });
    } else if (record.targetType === "script") {
      form.setFieldsValue({ ...defaults, targetType: "script", scriptId: record.script?.id, timeoutMs: record.timeoutMs });
    } else {
      form.setFieldsValue({ ...defaults, targetType: "book", bookId: record.book?.id });
    }
  };

  const scriptParamProblems = useMemo(() => {
    const bySchedule = new Map<string, string[]>();
    if (!scripts.data) return bySchedule;
    for (const schedule of schedules.data ?? []) {
      if (schedule.targetType !== 'script') continue;
      const target = scripts.data.find((script) => script.id === schedule.script?.id);
      if (!target) {
        bySchedule.set(schedule.id, ['关联脚本不存在或已删除']);
        continue;
      }
      try {
        const stored = parseScriptContract(target.inputSchema);
        const effective = resolveScriptContract(stored, (ref) => scheduleSchemaResolver?.(ref));
        const problems = validateParams(
          paramsOfSchema(effective),
          parseConsoleParams(schedule.paramsJson),
          scheduleSchemaResolver,
        );
        if (problems.length > 0) bySchedule.set(schedule.id, problems);
      } catch (error) {
        bySchedule.set(schedule.id, [error instanceof Error ? error.message : String(error)]);
      }
    }
    return bySchedule;
  }, [scheduleSchemaResolver, schedules.data, scripts.data]);

  const columns = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      render: (name: string, record: Schedule) => (
        <div>
          <Space size={6}>
            <div style={{ fontWeight: 500 }}>{name}</div>
            {record.deletedAt && <Tag color="red">已删除</Tag>}
          </Space>
          {record.description != null && record.description !== "" && (
            <TextClamp text={record.description} rows={1} style={{ fontSize: 12, color: "var(--c-ink-3)" }} />
          )}
        </div>
      ),
    },
    {
      title: "类型",
      dataIndex: "targetType",
      key: "targetType",
      width: 90,
      render: (t: string) => {
        const tag = TYPE_TAG[t] ?? TYPE_TAG.book;
        return <Tag color={tag.color}>{tag.label}</Tag>;
      },
    },
    {
      title: "目标",
      key: "target",
      render: (_: unknown, record: Schedule) => {
        // 判据是**目标自己**删没删，不是这条排期删没删。两者只在级联删除时同步
        // （books.service.delete() 把排期一起软删），反过来不成立：单独删掉一条排期
        // 后目标还活着，那时链接照样打得开。
        if (record.targetType === "flow") {
          const f = record.flow;
          if (!f) return <Typography.Text type="secondary">—</Typography.Text>;
          return (
            <>
              <Link to={`/flows/${f.id}`} style={{ fontWeight: 500 }}>{f.name}</Link>
              {!f.enabled && <Tag color="default" style={{ marginLeft: 6 }}>已禁用</Tag>}
            </>
          );
        }
        if (record.targetType === "script") {
          const s = record.script;
          if (!s) return <Typography.Text type="secondary">—</Typography.Text>;
          return (
            <>
              <Link to={`/scripts/${s.id}`} style={{ fontWeight: 500 }}>{s.name}</Link>
              <Tag color="default" style={{ marginLeft: 6 }}>{s.language}</Tag>
            </>
          );
        }
        const b = record.book;
        if (!b) return <Typography.Text type="secondary">—</Typography.Text>;
        const label = (
          <>
            {b.name}
            {!b.enabled && <Tag color="default" style={{ marginLeft: 6 }}>已禁用</Tag>}
          </>
        );
        return bookLinkIsLive(b)
          ? <Link to={`/books/${b.id}`} style={{ fontWeight: 500 }}>{label}</Link>
          : <Typography.Text type="secondary" style={{ fontWeight: 500 }}>{label}</Typography.Text>;
      },
    },
    {
      title: "Cron",
      dataIndex: "cronExpr",
      key: "cronExpr",
      width: 200,
      render: (cron: string, record: Schedule) => (
        <Tooltip title={`时区: ${record.timezone} · 模式: ${record.mode}`}>
          <Tag color="blue">{cron}</Tag>
        </Tooltip>
      ),
    },
    {
      title: '下次触发（任务时区）',
      key: "nextFires",
      width: 220,
      render: (_: unknown, record: Schedule) =>
        record.nextFires.length > 0 ? (
          <div style={{ fontSize: 12 }}>
            {record.nextFires.map((f, i) => (
              <div
                key={i}
                style={{
                  color: i === 0 ? "var(--c-accent)" : "var(--c-ink-3)",
                  fontWeight: i === 0 ? 600 : 400,
                }}
              >
                <CalendarOutlined style={{ marginRight: 4 }} />
                {formatFireTime(f, record.timezone)}
                {i === 0 && (
                  <span style={{ marginLeft: 8, color: "var(--c-ink-3)" }}>
                    ({dayjs(f).diff(dayjs(), "minute")} min)
                  </span>
                )}
              </div>
            ))}
            <div style={{ color: 'var(--c-ink-3)' }}>{record.timezone}</div>
          </div>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: "统计",
      key: "stats",
      width: 100,
      render: (_: unknown, record: Schedule) => {
        if (record.totalFired === 0) return <Typography.Text type="secondary">—</Typography.Text>;
        const rate = Math.round((record.totalSuccess / record.totalFired) * 100);
        return (
          <Tooltip title={`${record.totalSuccess} 成功 / ${record.totalFired} 总数`}>
            <Tag color={rate === 100 ? "success" : rate >= 50 ? "warning" : "error"}>
              {rate}%
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: "状态",
      dataIndex: "enabled",
      key: "enabled",
      width: 120,
      render: (enabled: boolean, record: Schedule) => (
        <Space direction='vertical' size={2}>
          <Tag color={enabled ? "success" : "default"}>{enabled ? "启用" : "暂停"}</Tag>
          {scriptParamProblems.has(record.id) && (
            <Tooltip title={scriptParamProblems.get(record.id)?.join('；')}>
              <Tag color='warning'>参数待修复</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      ...ROW_ACTIONS_COLUMN,
      width: 210,
      // 已删除的行没有操作：触发 / 编辑 / 暂停 / 删除在后端都只认未删除的排期，
      // 摆在那里只会换来一个 404。与 Flows / Schemas 两页同一处理。
      render: (_: unknown, record: Schedule) => (
        <RowActions
          actions={record.deletedAt ? [] : [
            { key: "run", label: "触发", loading: runNowMut.isPending, onClick: () => runNowMut.mutate(record.id) },
            { key: "edit", label: "编辑", onClick: () => openEditor(record) },
            { key: "toggle", label: record.enabled ? "暂停" : "启用", onClick: () => toggleMut.mutate(record.id) },
            {
              key: "delete",
              label: "删除",
              danger: true,
              confirm: { title: "删除此定时任务？", description: "关联的运行历史会保留" },
              onClick: () => deleteMut.mutate(record.id),
            },
          ]}
        />
      ),
    },
  ];

  // Client-side row filter: name, description, and whichever target the row
  // points at. The list is small enough that this never needs to be a query.
  const filteredSchedules = (schedules.data ?? []).filter((s) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const targetName = s.targetType === "flow" ? s.flow?.name : s.targetType === "script" ? s.script?.name : s.book?.name;
    return (
      (s.name ?? "").toLowerCase().includes(q) ||
      (s.description ?? "").toLowerCase().includes(q) ||
      (targetName ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <PageShell
      title="定时任务"
      subtitle="按 Cron 与任务时区自动触发，每分钟检查一次。Book 运行按目标排队。"
      actions={
        <Button
          type="primary"
          icon={<PlusOutlined aria-hidden="true" />}
          onClick={openCreator}
        >
          新建定时任务
        </Button>
      }
      filters={
        <>
          <SearchInput value={search} onChange={setSearch} placeholder="搜索名称 / 描述 / 目标…" />
          <DeletedToggle checked={includeDeleted} onChange={setIncludeDeleted} />
        </>
      }
    >
      <PageTable
        dataSource={filteredSchedules}
        columns={columns}
        rowKey="id"
        pagination={false}
        size="middle"
        query={schedules}
        // 动作就放在空态里。原先写的是「点击右上角"新建定时任务"开始」——
        // 让人从屏幕中央找到一百多像素外的角落，而那一整屏都是空白。
        empty={{
          title: "还没有定时任务",
          description: '选择 Book、Flow 或 Script，设置执行时间、时区和运行参数。',
          action: (
            <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} onClick={openCreator}>
              新建定时任务
            </Button>
          ),
        }}
      />

      <ScheduleFormDialog
        open={creating || !!editing}
        editing={editing}
        books={books.data ?? []}
        flows={flows.data ?? []}
        scripts={scripts.data ?? []}
        form={form}
        onCancel={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSubmit={(values) => {
          const { params, deliveries, ...rest } = values;
          const kind = editing?.targetType ?? values.targetType ?? 'book';
          const paramsJson = JSON.stringify(params ?? {});
          const deliveryOverridesJson = JSON.stringify(collectDeliveries((deliveries ?? {}) as Record<string, Record<string, unknown>>));
          if (editing) {
            // On update we don't allow changing the target — the backend refuses it.
            const { bookId: _unused, flowId: _unused2, scriptId: _unused3, targetType: _unused4, ...patch } = rest;
            void _unused; void _unused2; void _unused3; void _unused4;
            updateMut.mutate({ id: editing.id, patch: { ...patch, paramsJson, deliveryOverridesJson } });
          } else {
            // On create exactly one target id is provided by the form.
            createMut.mutate({
              ...rest,
              targetType: kind,
              bookId: kind === 'book' ? values.bookId : undefined,
              flowId: kind === 'flow' ? values.flowId : undefined,
              scriptId: kind === 'script' ? values.scriptId : undefined,
              timeoutMs: kind === 'script' ? values.timeoutMs : undefined,
              paramsJson,
              deliveryOverridesJson: kind === 'book' ? deliveryOverridesJson : undefined,
            });
          }
        }}
        submitting={createMut.isPending || updateMut.isPending}
      />
    </PageShell>
  );
}

interface ScheduleFormValues {
  targetType?: "book" | "flow" | "script";
  bookId?: string;
  flowId?: string;
  scriptId?: string;
  name?: string;
  description?: string | null;
  cronExpr: string;
  timezone: string;
  mode: "assisted" | "auto";
  /** The target's declared input params, collected under the `params` form path. */
  params?: Record<string, unknown>;
  deliveries?: Record<string, Record<string, unknown>>;
  enabled: boolean;
  timeoutMs?: number;
}

/** Shared dialog for create + edit. Uses the CronSelector component for
 *  the cron picker (presets / visual builder / raw input). On create the user
 *  picks Book / Flow / Script first; editing locks the kind (the backend
 *  refuses to change a schedule's target). */
function ScheduleFormDialog({
  open,
  editing,
  books,
  flows,
  scripts,
  form,
  onCancel,
  onSubmit,
  submitting,
}: {
  open: boolean;
  editing: Schedule | null;
  books: Book[];
  flows: FlowSummary[];
  scripts: Script[];
  form: ReturnType<typeof Form.useForm>[0];
  onCancel: () => void;
  onSubmit: (values: ScheduleFormValues) => void;
  submitting: boolean;
}) {
  const [cronPickerOpen, setCronPickerOpen] = useState(false);
  const cronExpr = Form.useWatch("cronExpr", form);
  const targetType = Form.useWatch("targetType", form) ?? (editing?.targetType ?? "book");
  const bookId = Form.useWatch("bookId", form);
  const flowId = Form.useWatch("flowId", form);
  const scriptId = Form.useWatch("scriptId", form);
  const schemaResolver = useSchemaResolver();
  const scriptParamSchema = useMemo(() => {
    const script = scripts.find((item) => item.id === scriptId);
    const stored = parseScriptContract(script?.inputSchema);
    return paramsOfSchema(resolveScriptContract(stored, (ref) => schemaResolver?.(ref)));
  }, [schemaResolver, scriptId, scripts]);
  // The param schema for whichever target kind is active. book.paramSchema and
  // flow.inputSchema are BOTH ParamSpec[] (flow's is derived from its
  // flowInput nodes); script.inputSchema is converted through the same field
  // model so all three targets use the same controls and validation.
  const schema: ParamSchema = useMemo(() => {
    if (targetType === "book") {
      const b = books.find((x) => x.id === bookId);
      return safeParseSchema(b?.paramSchema ?? "");
    }
    if (targetType === "flow") {
      const f = flows.find((x) => x.id === flowId);
      return safeParseSchema(f?.inputSchema ?? "[]");
    }
    return [];
  }, [books, bookId, flows, flowId, targetType]);
  // Citation params resolve against the registry so the 选存档 picker shows
  // in the schedule dialog too — same reason as the trigger dialog.
  const declaredDeliveries: Delivery[] = useMemo(() => {
    if (targetType !== "book") return [];
    const b = books.find((x) => x.id === bookId);
    return parseDeliveries(b?.deliveriesJson ?? "[]");
  }, [books, bookId, targetType]);

  // When creating and the target changes, pre-fill its param defaults.
  useEffect(() => {
    if (editing) return;
    if (targetType === "book" && bookId) {
      const book = books.find((x) => x.id === bookId);
      form.setFieldsValue({
        params: schema.length > 0 ? paramInitialValues(schema, schemaResolver) : {},
        deliveries: deliveryInitialValues(parseDeliveries(book?.deliveriesJson ?? "[]")),
      });
    } else if (targetType === "flow" && flowId) {
      form.setFieldsValue({ params: schema.length > 0 ? paramInitialValues(schema, schemaResolver) : {} });
    } else if (targetType === "script" && scriptId) {
      form.setFieldsValue({ params: paramInitialValues(scriptParamSchema, schemaResolver) });
    }
  }, [editing, targetType, bookId, flowId, scriptId, schema, scriptParamSchema, form, books, schemaResolver]);

  return (
    <Modal
      open={open}
      centered
      title={editing ? "编辑定时任务" : "新建定时任务"}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okText={editing ? "保存" : "创建"}
      cancelText="取消"
      confirmLoading={submitting}
      width={680}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={(v) => onSubmit(v as ScheduleFormValues)} preserve={false}>
        <ConsoleFormSection title="执行目标" description="选择要定时执行的 Book、流程或脚本。">
        {!editing && (
          <Form.Item label="目标类型" name="targetType">
            <BcpSelect
              options={[
                { label: "📘 Book · 浏览器录制回放", value: "book" },
                { label: "🌊 Flow · 流程编排", value: "flow" },
                { label: "📜 Script · 脚本库", value: "script" },
              ]}
            />
          </Form.Item>
        )}

        {targetType === "book" && (
          <Form.Item
            label="Book"
            name="bookId"
            rules={[{ required: true, message: "请选择 book" }]}
          >
            <BcpSelect
              placeholder="选择要定时执行的 book"
              disabled={!!editing}
              options={books.map((b) => ({ label: b.name, value: b.id }))}
            />
          </Form.Item>
        )}
        {targetType === "flow" && (
          <Form.Item
            label="Flow"
            name="flowId"
            rules={[{ required: true, message: "请选择 flow" }]}
          >
            <BcpSelect
              placeholder="选择要定时触发的流程"
              disabled={!!editing}
              options={flows.map((f) => ({ label: f.name, value: f.id }))}
            />
          </Form.Item>
        )}
        {targetType === "script" && (
          <Form.Item
            label="Script"
            name="scriptId"
            rules={[{ required: true, message: "请选择脚本" }]}
          >
            <BcpSelect
              placeholder="选择要定时执行的脚本"
              disabled={!!editing}
              options={scripts.map((s) => ({ label: s.name, value: s.id }))}
            />
          </Form.Item>
        )}

        <Form.Item label="名称" name="name" tooltip="不填则用目标名">
          <Input placeholder="例: 每天上午9点备份" maxLength={100} />
        </Form.Item>

        <Form.Item label="描述" name="description">
          <Input.TextArea rows={2} placeholder="这个定时任务的用途" maxLength={500} />
        </Form.Item>
        </ConsoleFormSection>

        <ConsoleFormSection title="时间与执行策略" description="按指定时区解释 Cron 表达式。">
        <Form.Item
          label="Cron 表达式"
          name="cronExpr"
          rules={[{ required: true, message: "请设置 cron 表达式" }]}
        >
          <Input
            readOnly
            placeholder="点击右侧按钮选择"
            onClick={() => setCronPickerOpen(true)}
            addonAfter={
              <Button
                type="link"
                size="small"
                icon={<ClockCircleOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  setCronPickerOpen(true);
                }}
                style={{ padding: 0 }}
              >
                选择
              </Button>
            }
          />
        </Form.Item>

        <div className="console-form-row">
          <Form.Item
            label="时区"
            name="timezone"
          >
            <BcpSelect
              options={[
                { label: "Asia/Shanghai", value: "Asia/Shanghai" },
                { label: "Asia/Tokyo", value: "Asia/Tokyo" },
                { label: "Asia/Singapore", value: "Asia/Singapore" },
                { label: "Asia/Dubai", value: "Asia/Dubai" },
                { label: "Europe/London", value: "Europe/London" },
                { label: "Europe/Berlin", value: "Europe/Berlin" },
                { label: "America/New_York", value: "America/New_York" },
                { label: "America/Los_Angeles", value: "America/Los_Angeles" },
                { label: "UTC", value: "UTC" },
              ]}
            />
          </Form.Item>

          <Form.Item label="模式" name="mode">
            <BcpSelect
              options={[
                { label: "自动 (auto)", value: "auto" },
                { label: "人工 (assisted)", value: "assisted" },
              ]}
            />
          </Form.Item>

          {targetType === "script" && (
            <Form.Item label="超时(ms)" name="timeoutMs" rules={[{ type: 'integer', min: 1, message: '请输入正整数毫秒' }]}>
              <InputNumber min={1} precision={0} placeholder="60000" style={{ width: '100%' }} />
            </Form.Item>
          )}
        </div>
        </ConsoleFormSection>

        {(targetType === "book" && bookId) || (targetType === "flow" && flowId) || (targetType === "script" && scriptId) ? (
          <ConsoleFormSection title="输入与交付">
            {targetType === "script" ? (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
                  输入参数（按脚本定义自动生成）
                </Typography.Text>
                <SchemaParamEditor schema={scriptParamSchema} namePrefix={["params"]} schemaResolver={schemaResolver} />
              </>
            ) : (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
                  参数({targetType === "book" ? "按 book 声明" : "按 flow 入参"}动态生成)
                </Typography.Text>
                {schema.length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    该{targetType === "book" ? "book" : "flow"}没有声明参数，将使用空参数运行。
                  </Typography.Text>
                ) : (
                  <ParamFields schema={schema} namePrefix={["params"]} schemaResolver={schemaResolver} />
                )}
              </>
            )}
            {targetType === "book" && declaredDeliveries.length > 0 && (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", margin: "14px 0 8px" }}>
                  出参方式(按 book 声明动态生成)
                </Typography.Text>
                 <DeliveryFields />
              </>
            )}
          </ConsoleFormSection>
        ) : null}

        <ConsoleFormSection title="任务状态">
        <Form.Item label="启用" name="enabled" valuePropName="checked">
          <Switch checkedChildren="启用" unCheckedChildren="暂停" />
        </Form.Item>
        </ConsoleFormSection>
      </Form>

      <CronSelector
        open={cronPickerOpen}
        value={cronExpr ?? null}
        onSave={(cron) => {
          form.setFieldsValue({ cronExpr: cron ?? "" });
          setCronPickerOpen(false);
        }}
        onCancel={() => setCronPickerOpen(false)}
      />
    </Modal>
  );
}

/** Parse a stored paramsJson string back to a plain object (for editing). */
function parseParams(json: string): Record<string, unknown> {
  try {
    return parseConsoleParams(json);
  } catch {
    return {};
  }
}

/** Parse a book's paramSchema JSON string into the param schema array. */
function safeParseSchema(s: string): ParamSchema {
  try {
    return parseConsoleParamSchema(s);
  } catch {
    return [];
  }
}

function parseDeliveries(s: string): Delivery[] {
  try {
    return parseConsoleDeliveries(s) as Delivery[];
  } catch {
    return [];
  }
}

function formatFireTime(value: string, taskTimezone: string): string {
  try {
    return dayjs(value).tz(taskTimezone).format('MM-DD HH:mm:ss');
  } catch {
    return '时间或时区无效';
  }
}
