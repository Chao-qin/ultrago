import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Button, Form, Input, Modal, Space, Tag, Typography, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../lib/api";
import { parseFlowGraph, rowDeletedAt } from "../lib/types";

import type { FlowSummary } from "../lib/types";
import { RunStatusTag } from "../components/RunStatusTag";
import { PageTable } from "../components/PageTable";
import { DeletedToggle } from "../components/DeletedToggle";
import { SearchInput } from "../components/SearchInput";
import { RowActions, ROW_ACTIONS_COLUMN } from "../components/RowActions";
import { PageShell } from "../components/PageShell";
import { RunHistoryDrawer } from "../components/RunHistoryDrawer";
import type { RunHistoryTarget } from "../components/RunHistoryDrawer";
import { FlowTriggerDialog } from '../components/flow-trigger-dialog';
import { deriveInputSchema } from '@bcp/shared';
import type { ParamMap } from '@bcp/shared';
import { schemaLookup } from '../lib/flow-ports-client';
import { ConsoleFormSection } from '../components/console-form-section';

/** Mirrors the server's limit so the field can count down instead of failing
 *  after a round trip. */
const MAX_FLOW_NAME = 60;

export function Flows() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [search, setSearch] = useState("");
  const [history, setHistory] = useState<RunHistoryTarget | null>(null);
  const [launch, setLaunch] = useState<FlowSummary | null>(null);
  const launchLock = useRef(false);
  const schemas = useQuery({ queryKey: ['schemas', undefined, true, false], queryFn: () => api.listSchemas({ includeInactive: true }), enabled: !!launch });
  const resolver = useMemo(() => schemaLookup(schemas.data ?? []), [schemas.data]);
  const launchSpecs = useMemo(() => launch ? deriveInputSchema(parseFlowGraph(launch.graphJson), resolver) : [], [launch, resolver]);
  const [form] = Form.useForm<{ name: string; description?: string }>();

  const flows = useQuery({
    queryKey: ["flows", includeDeleted],
    queryFn: () => api.listFlows({ includeDeleted }),
    refetchInterval: 5000,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["flows"] });

  const create = useMutation({
    mutationFn: (values: { name: string; description?: string }) =>
      api.createFlow({ name: values.name.trim(), description: values.description?.trim() || null }),
    onSuccess: (flow) => {
      setCreating(false);
      form.resetFields();
      invalidate();
      navigate(`/flows/${flow.id}`);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: (flow: FlowSummary) => api.updateFlow(flow.id, { enabled: !flow.enabled }),
    onSuccess: invalidate,
    onError: (e: Error) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (flow: FlowSummary) => api.deleteFlow(flow.id),
    onSuccess: () => {
      message.success("已删除");
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const trigger = useMutation({
    mutationFn: ({ flow, params }: { flow: FlowSummary; params: ParamMap }) => api.triggerFlow(flow.id, params),
    onSuccess: (run) => {
      setLaunch(null);
      message.success(`已触发 run ${run.id.slice(0, 8)}`);
      invalidate();
      navigate(`/flow-runs/${run.id}`);
    },
    onError: (e: Error) => message.error(e.message),
    onSettled: () => { launchLock.current = false; },
  });

  const columns = [
    {
      title: "名称",
      dataIndex: "name",
      render: (name: string, flow: FlowSummary) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Link to={`/flows/${flow.id}`}>
              <Typography.Text strong>{name}</Typography.Text>
            </Link>
            {rowDeletedAt(flow) && <Tag color="red">已删除</Tag>}
          </Space>
          {flow.description && <Typography.Text type="secondary">{flow.description}</Typography.Text>}
        </Space>
      ),
    },
    {
      title: "规模",
      width: 150,
      render: (_: unknown, flow: FlowSummary) => {
        const graph = parseFlowGraph(flow.graphJson);
        return (
          <Typography.Text type="secondary">
            {graph.nodes.length} 节点 / {graph.edges.length} 连线
          </Typography.Text>
        );
      },
    },
    {
      title: "最近运行",
      width: 200,
      render: (_: unknown, flow: FlowSummary) => {
        const last = flow.runs?.[0];
        if (!last) return <Typography.Text type="secondary">从未运行</Typography.Text>;
        return (
          <Space size={6}>
            <Link to={`/flow-runs/${last.id}`}>
              <RunStatusTag status={last.status} />
            </Link>
            <Typography.Text type="secondary">{dayjs(last.queuedAt).format("MM-DD HH:mm")}</Typography.Text>
          </Space>
        );
      },
    },
    { title: "更新时间", dataIndex: "updatedAt", width: 150, render: (t: string) => dayjs(t).format("YYYY-MM-DD HH:mm") },
    {
      ...ROW_ACTIONS_COLUMN,
      width: 210,
      // 已删除的行没有操作：后端没有 flow 的恢复接口，启用与删除又只对未删除的行
      // 生效，摆在那里只会得到一个 404。运行记录同样不给——删流程会把它的
      // FlowRun 一起软删（flows.service.ts remove），抽屉打开只会是空的。
      render: (_: unknown, flow: FlowSummary) => (
        <RowActions
          actions={rowDeletedAt(flow) ? [] : [
            { key: 'run', label: '运行', disabled: !flow.enabled, loading: trigger.isPending && trigger.variables?.flow.id === flow.id, onClick: () => { trigger.reset(); setLaunch(flow); } },
            { key: "edit", label: "编辑", onClick: () => navigate(`/flows/${flow.id}`) },
            {
              key: "history",
              label: "运行记录",
              onClick: () => setHistory({ kind: "flow", id: flow.id, name: flow.name }),
            },
            { key: "toggle", label: flow.enabled ? "停用" : "启用", onClick: () => toggle.mutate(flow) },
            {
              key: "delete",
              label: "删除",
              danger: true,
              confirm: {
                title: `删除流程「${flow.name}」？`,
                description: "流程只存在于数据库里，没有文件副本可以找回，运行历史也会一并删除。",
              },
              onClick: () => { void remove.mutateAsync(flow); },
            },
          ]}
        />
      ),
    },
  ];

  return (
    <PageShell
      title="流程编排"
      subtitle="编排 book、脚本与数据映射"
      actions={
        <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} onClick={() => setCreating(true)}>
          新建流程
        </Button>
      }
      filters={
        <>
          <SearchInput value={search} onChange={setSearch} placeholder="搜索名称 / 描述…" />
          <DeletedToggle checked={includeDeleted} onChange={setIncludeDeleted} />
        </>
      }
    >
      <PageTable
        rowKey="id"
        size="middle"
        query={flows}
        empty={{ title: "还没有流程", description: "流程把 book、脚本和数据映射编排成一条链路。" }}
        dataSource={(flows.data ?? []).filter((f) => {
          const q = search.trim().toLowerCase();
          if (!q) return true;
          return (
            (f.name ?? "").toLowerCase().includes(q) ||
            (f.description ?? "").toLowerCase().includes(q)
          );
        })}
        columns={columns}
        pagination={false}
      />

      <RunHistoryDrawer target={history} onClose={() => setHistory(null)} />
      {launch && schemas.isSuccess && <FlowTriggerDialog key={launch.id} name={launch.name} specs={launchSpecs} schemaResolver={resolver}
        pending={trigger.isPending} error={trigger.error?.message} onCancel={() => setLaunch(null)}
        onSubmit={(params) => { if (launchLock.current) return; launchLock.current = true; trigger.mutate({ flow: launch, params }); }} />}
      {launch && !schemas.isSuccess && <Modal open title="准备流程参数" footer={null} onCancel={() => setLaunch(null)}>
        {schemas.isError ? <Space direction="vertical"><Typography.Text type="danger">{schemas.error.message}</Typography.Text><Button onClick={() => void schemas.refetch()}>重试</Button></Space> : <Typography.Text>正在加载参数契约…</Typography.Text>}
      </Modal>}

      <Modal
        open={creating}
        title="新建流程"
        onCancel={() => {
          setCreating(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
        okText="创建"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(values) => create.mutate(values)} requiredMark={false}>
          <ConsoleFormSection title="流程信息" description="先为流程命名，创建后即可进入画布编排节点。">
          <Form.Item
            name="name"
            label="名称"
            rules={[
              { required: true, whitespace: true, message: "给这条流程起个名字" },
              { max: MAX_FLOW_NAME, message: `最多 ${MAX_FLOW_NAME} 个字符` },
            ]}
            // Names carry no identifier duty here — flows are referenced by id —
            // so 中文 is entirely expected and the field says as much.
            extra="中文、空格都可以，同名会被拒绝"
          >
            <Input placeholder="例如：商品预处理与发布" maxLength={MAX_FLOW_NAME} showCount autoFocus />
          </Form.Item>
          <Form.Item name="description" label="说明" extra="这条流程做什么、什么时候用，选填">
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="1688 采集 → 规范化 → 豆包判图 → 抖店发布" />
          </Form.Item>
          </ConsoleFormSection>
        </Form>
      </Modal>
    </PageShell>
  );
}
