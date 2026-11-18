import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Select, Space, Tabs, Tag, Typography } from "antd";
import { api } from "../lib/api";
import { RUN_STATUS_FILTERS } from "@bcp/shared";
import { RunStatusTag } from "../components/RunStatusTag";
import { PageTable } from "../components/PageTable";
import { DeletedToggle } from "../components/DeletedToggle";
import { SearchInput } from "../components/SearchInput";
import { rowDeletedAt } from "../lib/types";
import dayjs from "dayjs";
import { formatDuration } from "../lib/format";
import { RowActions, ROW_ACTIONS_COLUMN } from "../components/RowActions";
import { PageShell } from "../components/PageShell";
import type { RunHistoryItem } from '../lib/run-history';

const TABS = RUN_STATUS_FILTERS;

export function Runs() {
  const navigate = useNavigate();
  const [urlParams] = useSearchParams();
  const [tab, setTab] = useState("all");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [search, setSearch] = useState(urlParams.get('search') ?? '');
  const [targetType, setTargetType] = useState<string | undefined>(() => ['book', 'script', 'flow'].includes(urlParams.get('type') ?? '') ? urlParams.get('type')! : undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const cfg = TABS.find((t) => t.key === tab) ?? TABS[0];

  const runs = useQuery({
    queryKey: ['run-history', tab, includeDeleted, targetType, search, page, pageSize],
    queryFn: () =>
      api.listRunHistory({ page, pageSize, targetType, search, ...(cfg.statuses.length ? { status: [...cfg.statuses] } : {}), includeDeleted }),
    refetchInterval: 2000,
  });

  const columns = [
    {
      title: "时间",
      dataIndex: "queuedAt",
      key: "queuedAt",
      width: 160,
      render: (t: string) => <Typography.Text style={{ fontFamily: "monospace", fontSize: 12 }}>{dayjs(t).format("MM-DD HH:mm:ss")}</Typography.Text>,
    },
    {
      title: "目标",
      dataIndex: "targetType",
      key: "target",
      render: (_: string, record: { targetType?: string; book?: { name: string } | null; flow?: { name: string } | null; script?: { name: string } | null }) => {
        const t = record.targetType ?? "book";
        const name = t === "flow" ? record.flow?.name : t === "script" ? record.script?.name : record.book?.name;
        const tag = t === "flow" ? "cyan" : t === "script" ? "purple" : "blue";
        return (
          <Space size={6}>
            <Tag color={tag}>{t}</Tag>
            <Typography.Text strong>{name ?? "—"}</Typography.Text>
            {rowDeletedAt(record) && <Tag color="red">已删除</Tag>}
          </Space>
        );
      },
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 120,
       render: (s: string) => <RunStatusTag status={s} />,
    },
    { title: "触发", dataIndex: "trigger", key: "trigger", width: 80 },
    { title: "模式", dataIndex: "mode", key: "mode", width: 80 },
    {
      title: "耗时",
      dataIndex: "durationMs",
      key: "durationMs",
      width: 100,
      render: (d: number | null) => formatDuration(d),
    },
    {
      ...ROW_ACTIONS_COLUMN,
      width: 90,
      render: (_: unknown, record: RunHistoryItem) => (
        <RowActions actions={[{ key: 'view', label: '查看', onClick: () => navigate(`/${record.source === 'flow' ? 'flow-runs' : 'runs'}/${record.id}`) }]} />
      ),
    },
  ];

  return (
    <PageShell
      title="运行记录"
      filters={
        <>
          <SearchInput value={search} onChange={(value) => { setSearch(value); setPage(1); }} placeholder="搜索目标名称…" />
          <Select aria-label="运行类型" value={targetType ?? 'all'} style={{ width: 150 }} onChange={(value) => { setTargetType(value === 'all' ? undefined : value); setPage(1); }} options={[
            { value: 'all', label: '全部类型' }, { value: 'book', label: 'Book' }, { value: 'script', label: '脚本' }, { value: 'flow', label: 'Flow' },
          ]} />
          <DeletedToggle checked={includeDeleted} onChange={(value) => { setIncludeDeleted(value); setPage(1); }} />
        </>
      }
    >
      <Tabs
        activeKey={tab}
        onChange={(value) => { setTab(value); setPage(1); }}
        items={TABS.map((t) => ({
          key: t.key,
          label: t.label,
          children: (
            <PageTable
              dataSource={runs.data?.items ?? []}
              columns={columns}
              rowKey="key"
              pagination={{ current: runs.data?.page ?? page, pageSize, total: runs.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [10, 25, 50, 100], showTotal: (total) => `共 ${total} 条`, onChange: (next, size) => { setPage(size === pageSize ? next : 1); setPageSize(size); } }}
              query={runs}
        empty={{ title: '没有匹配的运行记录', description: 'Book、脚本和 Flow 的运行会汇总显示在这里，可调整筛选条件。' }}
              size="middle"
            />
          ),
        }))}
      />
    </PageShell>
  );
}
