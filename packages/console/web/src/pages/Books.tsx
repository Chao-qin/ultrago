import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Tag, Button, Switch, Typography, Space, message, Tooltip } from "antd";
import { ReloadOutlined, ClockCircleOutlined } from "@ant-design/icons";
import { api } from "../lib/api";
import { TriggerDialog } from "../components/TriggerDialog";
import { TextClamp } from "../components/TextClamp";
import { PageTable } from "../components/PageTable";
import { DeletedToggle } from "../components/DeletedToggle";
import { SearchInput } from "../components/SearchInput";
import type { BookWithSchedules } from "../lib/types";
import dayjs from "dayjs";
import { RunStatusTag } from "../components/RunStatusTag";
import { parseConsoleDeliveries } from "../lib/types";
import { BOOKS_QUERY_ROOT, booksQueryKey, matchesBookFilter, rescanMessages } from "../lib/books";
import { RowActions, ROW_ACTIONS_COLUMN } from "../components/RowActions";
import { PageShell } from "../components/PageShell";
import { RunHistoryDrawer } from "../components/RunHistoryDrawer";
import type { RunHistoryTarget } from "../components/RunHistoryDrawer";

export function Books() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [showDisabled, setShowDisabled] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [triggering, setTriggering] = useState<BookWithSchedules | null>(null);
  const [history, setHistory] = useState<RunHistoryTarget | null>(null);
  // No refetchInterval: a book only changes when someone edits a playbook on
  // disk or presses 重新扫描, neither of which a timer can predict. Polling
  // this list used to be actively harmful — `BooksService.list()` ran a
  // filesync rescan, so an open Books page rewrote every Book row every 5s.
  // The "last run" column is the one live-ish thing here, and it is worth a
  // manual refresh rather than a write-amplifying poll.
  const books = useQuery({
    queryKey: booksQueryKey(includeDeleted),
    queryFn: () => api.listBooks({ includeDeleted }),
  });

  // The button that says 重新扫描 has to be the thing that rescans. Until
  // 2026-08-28 it only invalidated the cache and got away with it, because the
  // refetch it triggered hit `BooksService.list()`, which rescanned as a side
  // effect. That side effect is gone, so this calls the endpoint that was
  // always sitting in api.ts with no caller, then refreshes the list.
  const rescan = useMutation({
    mutationFn: () => api.rescan(),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: BOOKS_QUERY_ROOT });
      // Both strings come from `rescanMessages` so the decision they encode —
      // above all, that a non-empty `missing` is never dropped — sits somewhere
      // the suite can reach. There is no renderer in this project's tests.
      const { success, warning } = rescanMessages(result);
      message.success(success);
      if (warning) message.warning(warning, 8);
    },
    onError: (e) => message.error(`重新扫描失败：${e instanceof Error ? e.message : String(e)}`),
  });

  const filtered = (books.data ?? []).filter((b) => matchesBookFilter(b, { search, showDisabled }));

  const columns = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      render: (name: string, record: BookWithSchedules) => (
        <div>
          <Space size={6}>
            <Link to={`/books/${record.id}`} style={{ fontWeight: 500 }}>{name}</Link>
            {record.deletedAt && <Tag color="red">已删除</Tag>}
          </Space>
          <TextClamp
            text={record.goal || record.description || "—"}
            rows={1}
            style={{ fontSize: 12, color: "var(--c-ink-3)", maxWidth: 420 }}
          />
        </div>
      ),
    },
    {
      title: "步骤数",
      dataIndex: "stepsCount",
      key: "stepsCount",
      width: 80,
    },
    {
      title: "标签",
      dataIndex: "tags",
      key: "tags",
      width: 180,
      render: (tags: string | null) => tags ? <Space size={4} wrap>{tags.split(",").map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space> : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: "出参",
      key: "deliveries",
      width: 180,
      render: (_: unknown, record: BookWithSchedules) => {
        let deliveries: Array<{ kind: string }> = [];
        try { deliveries = parseConsoleDeliveries(record.deliveriesJson || "[]"); } catch { /* stale cache */ }
        return deliveries.length > 0
          ? <Space size={4} wrap>{deliveries.map((d, i) => <Tag key={`${d.kind}-${i}`}>{d.kind}</Tag>)}</Space>
          : <Typography.Text type="secondary">—</Typography.Text>;
      },
    },
    {
      title: "启用",
      dataIndex: "enabled",
      key: "enabled",
      width: 80,
      render: (enabled: boolean) => <Tag color={enabled ? "success" : "default"}>{enabled ? "ON" : "OFF"}</Tag>,
    },
    {
      title: "定时",
      key: "schedules",
      width: 120,
      render: (_: unknown, record: BookWithSchedules) => {
        const enabledSchedules = record.schedules.filter((s) => s.enabled);
        if (record.schedules.length === 0) {
          return <Typography.Text type="secondary">—</Typography.Text>;
        }
        return (
          <Tooltip
            title={
              <div>
                {record.schedules.map((s) => (
                  <div key={s.id} style={{ fontSize: 12 }}>
                    {s.cronExpr} {s.enabled ? "" : "(暂停)"}
                  </div>
                ))}
              </div>
            }
          >
            <Tag
              color={enabledSchedules.length > 0 ? "blue" : "default"}
              style={{ cursor: "pointer" }}
              onClick={() => nav("/schedules")}
            >
              <ClockCircleOutlined style={{ marginRight: 4 }} />
              {enabledSchedules.length > 0
                ? `${enabledSchedules.length} 个启用`
                : `${record.schedules.length} 个已暂停`}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: "最近运行",
      key: "lastRun",
      width: 180,
      render: (_: unknown, record: BookWithSchedules) =>
        record.lastRun ? (
          <Link to={`/runs/${record.lastRun.id}`}>
            <Space size={6} wrap={false}>
              <RunStatusTag status={record.lastRun.status} />
              <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                {dayjs(record.lastRun.queuedAt).format("MM-DD HH:mm")}
              </Typography.Text>
            </Space>
          </Link>
        ) : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      ...ROW_ACTIONS_COLUMN,
      width: 150,
      // 已删除的行没有操作：触发会走 enqueue，而它只认未删除的 book，按钮摆在
      // 那里只会换来一个 404。运行记录同样不给——删 book 会把它的 Run 一起软删
      // （books.service.ts delete），抽屉打开只会是空的。与 Flows / Schemas 两页
      // 同一处理。
      render: (_: unknown, record: BookWithSchedules) => (
        <RowActions
          actions={record.deletedAt ? [] : [
            { key: "run", label: "运行", onClick: () => setTriggering(record) },
            {
              key: "history",
              label: "运行记录",
              onClick: () => setHistory({ kind: "book", id: record.id, name: record.name }),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <PageShell
      title="Books"
      actions={
        <Button icon={<ReloadOutlined />} loading={rescan.isPending} onClick={() => rescan.mutate()}>
          重新扫描
        </Button>
      }
      filters={
        <>
          <SearchInput value={search} onChange={setSearch} placeholder="搜索 name / description…" />
          <Space size={4}>
            <Switch size="small" checked={showDisabled} onChange={setShowDisabled} />
            <Typography.Text type="secondary">包含已禁用</Typography.Text>
          </Space>
          <DeletedToggle checked={includeDeleted} onChange={setIncludeDeleted} />
        </>
      }
    >
      <PageTable
        dataSource={filtered}
        columns={columns}
        rowKey="id"
        pagination={false}
        query={books}
        empty={{ title: "还没有 Book", description: <>Book 是磁盘上的 playbook JSON。把文件放进 <code>resource/playbooks/</code> 后点右上角「重新扫描」。</> }}
        size="middle"
      />

      <RunHistoryDrawer target={history} onClose={() => setHistory(null)} />

      {triggering && (
        <TriggerDialog
          book={triggering}
          onClose={() => setTriggering(null)}
          onTriggered={(runId) => {
            setTriggering(null);
            window.location.hash = `#/runs/${runId}`;
          }}
        />
      )}
    </PageShell>
  );
}
