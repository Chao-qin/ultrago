import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Descriptions, Drawer, Empty, Image, Space, Tag, Tooltip, Typography, message } from "antd";
import { CheckOutlined, UndoOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../lib/api";
import type { BrowserEventRow } from "../lib/types";
import { PageTable } from "../components/PageTable";
import { DeletedToggle } from "../components/DeletedToggle";
import { SearchInput } from "../components/SearchInput";
import { BcpSelect } from "../components/BcpSelect";
import { useTheme, getPalette } from "../theme";
import { RowActions, ROW_ACTIONS_COLUMN } from "../components/RowActions";
import { PageShell } from "../components/PageShell";

const { Text, Paragraph } = Typography;

/** 每种事件一个颜色。未列出的 kind 用默认灰——backend 往 NOTIFY_KINDS 里加一种
 *  新事件时，这里不改也不会崩，只是没有专属颜色（与后端「加 kind 不需要联动改
 *  接收端」的立场一致）。 */
const KIND_COLOR: Record<string, string> = {
  captcha_appeared: "red",
  captcha_cleared: "green",
  browser_offline: "orange",
};

const KIND_LABEL: Record<string, string> = {
  captcha_appeared: "验证码出现",
  captcha_cleared: "验证码解除",
  browser_offline: "浏览器掉线",
};

const KIND_OPTIONS = [
  { label: "全部类型", value: "" },
  ...Object.entries(KIND_LABEL).map(([value, label]) => ({ label, value })),
];

const ACK_OPTIONS = [
  { label: "全部", value: "" },
  { label: "未处理", value: "true" },
  { label: "已处理", value: "false" },
];

export function BrowserEvents() {
  const { mode } = useTheme();
  const palette = getPalette(mode);
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["browser-events"] });

  const [kind, setKind] = useState("");
  const [ack, setAck] = useState("");
  const [search, setSearch] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [detail, setDetail] = useState<BrowserEventRow | null>(null);

  const query = {
    ...(kind ? { kind } : {}),
    // 三态：空串 = 不筛选（两种都要），"true" = 只看未处理，"false" = 只看已处理。
    // 写成 `unacknowledged: ack === "true"` 会把「全部」悄悄变成「只看已处理」。
    ...(ack ? { unacknowledged: ack === "true" } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
    includeDeleted,
  };

  const events = useQuery({
    queryKey: ["browser-events", query, page, pageSize],
    queryFn: () => api.listBrowserEvents({ ...query, page, pageSize }),
    // 这是一个「有没有新通知」的页面，轮询是它的主要用途。
    refetchInterval: 5000,
  });

  const stats = useQuery({
    queryKey: ["browser-events", "stats", query],
    queryFn: () => api.browserEventStats(query),
    refetchInterval: 5000,
  });

  const ackMut = useMutation({
    mutationFn: ({ id, acknowledged }: { id: string; acknowledged: boolean }) =>
      api.acknowledgeBrowserEvent(id, acknowledged),
    onSuccess: (row) => {
      setDetail((d) => (d && d.id === row.id ? row : d));
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteBrowserEvent(id),
    onSuccess: () => { message.success("已删除"); invalidate(); },
    onError: (e: Error) => message.error(e.message),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => api.restoreBrowserEvent(id),
    onSuccess: () => { message.success("已恢复"); invalidate(); },
    onError: (e: Error) => message.error(e.message),
  });

  const columns = [
    {
      title: "收到时间",
      dataIndex: "receivedAt",
      key: "receivedAt",
      width: 160,
      render: (t: string) => (
        <Text style={{ fontFamily: "monospace", fontSize: 12 }}>{dayjs(t).format("MM-DD HH:mm:ss")}</Text>
      ),
    },
    {
      title: "类型",
      dataIndex: "kind",
      key: "kind",
      width: 130,
      render: (k: string) => <Tag color={KIND_COLOR[k] ?? "default"}>{KIND_LABEL[k] ?? k}</Tag>,
    },
    {
      title: "摘要",
      dataIndex: "summary",
      key: "summary",
      render: (s: string, row: BrowserEventRow) => (
        <Space size={6} wrap>
          <Text>{s}</Text>
          {row.screenshotUrl && <Tag color="blue">有截图</Tag>}
          {row.deletedAt && <Tag color="red">已删除</Tag>}
        </Space>
      ),
    },
    {
      title: "浏览器 / tab",
      key: "origin",
      width: 190,
      render: (_: unknown, row: BrowserEventRow) => (
        <Text type="secondary" style={{ fontFamily: "monospace", fontSize: 12 }}>
          {/* instanceId 是 uuid，全长挤掉整行；前 8 位已经足够区分本机同时在线的几个浏览器 */}
          {row.browser ? row.browser.slice(0, 8) : "—"}
          {/* -1 是「与 tab 无关」的既定取值，显示成 — 而不是让人去猜一个负数 tabId */}
          {row.tabId >= 0 ? ` · tab ${row.tabId}` : ""}
        </Text>
      ),
    },
    {
      title: "状态",
      key: "ack",
      width: 100,
      render: (_: unknown, row: BrowserEventRow) =>
        row.acknowledgedAt ? (
          <Tooltip title={dayjs(row.acknowledgedAt).format("YYYY-MM-DD HH:mm:ss")}>
            <Tag color="green">已处理</Tag>
          </Tooltip>
        ) : (
          <Tag>未处理</Tag>
        ),
    },
    {
      ...ROW_ACTIONS_COLUMN,
      width: 190,
      render: (_: unknown, row: BrowserEventRow) => (
        <RowActions
          actions={[
            { key: "detail", label: "详情", onClick: () => setDetail(row) },
            {
              key: "ack",
              label: row.acknowledgedAt ? "未处理" : "已处理",
              onClick: () => ackMut.mutate({ id: row.id, acknowledged: !row.acknowledgedAt }),
            },
            row.deletedAt
              ? { key: "restore", label: "恢复", onClick: () => restoreMut.mutate(row.id) }
              : {
                  key: "delete",
                  label: "删除",
                  danger: true,
                  confirm: { title: "删除这条事件？", description: "可在「含已删除」里恢复" },
                  onClick: () => deleteMut.mutate(row.id),
                },
          ]}
        />
      ),
    },
  ];

  return (
    <PageShell
      title="事件通知"
      subtitle="backend 经 BCP_EVENT_WEBHOOK 推来的浏览器事件"
      actions={
        <Space size={12}>
          <Badge count={stats.data?.unacknowledged ?? 0} showZero color={palette.warn} overflowCount={999}>
            <Text type="secondary" style={{ paddingRight: 8 }}>未处理</Text>
          </Badge>
          <Text type="secondary">共 {stats.data?.total ?? 0} 条</Text>
        </Space>
      }
      filters={
        <>
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="搜索摘要 / detail…" />
          <BcpSelect
            options={KIND_OPTIONS}
            value={kind}
            onChange={(v) => { setKind(v ?? ""); setPage(1); }}
            style={{ width: 140 }}
          />
          <BcpSelect
            options={ACK_OPTIONS}
            value={ack}
            onChange={(v) => { setAck(v ?? ""); setPage(1); }}
            style={{ width: 110 }}
          />
          <DeletedToggle checked={includeDeleted} onChange={(v) => { setIncludeDeleted(v); setPage(1); }} />
        </>
      }
    >
      <PageTable
        dataSource={events.data?.items ?? []}
        columns={columns}
        rowKey="id"
        query={events}
        empty={{ title: "还没有事件", description: "backend 经 BCP_EVENT_WEBHOOK 推来的浏览器事件会出现在这里。" }}
        size="middle"
        pagination={{
          current: events.data?.page ?? page,
          pageSize: events.data?.pageSize ?? pageSize,
          total: events.data?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100, 200],
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps); },
        }}
      />
      <EventDrawer
        row={detail}
        onClose={() => setDetail(null)}
        onToggleAck={(row) => ackMut.mutate({ id: row.id, acknowledged: !row.acknowledgedAt })}
      />
    </PageShell>
  );
}

/** 详情抽屉：两个时钟、原始 detail、截图。 */
function EventDrawer({
  row,
  onClose,
  onToggleAck,
}: {
  row: BrowserEventRow | null;
  onClose: () => void;
  onToggleAck: (row: BrowserEventRow) => void;
}) {
  return (
    <Drawer
      open={!!row}
      onClose={onClose}
      width={720}
      title={row ? (KIND_LABEL[row.kind] ?? row.kind) : ""}
      extra={
        row && (
          <Button
            type={row.acknowledgedAt ? "default" : "primary"}
            icon={row.acknowledgedAt ? <UndoOutlined /> : <CheckOutlined />}
            onClick={() => onToggleAck(row)}
          >
            {row.acknowledgedAt ? "撤销处理" : "标记已处理"}
          </Button>
        )
      }
    >
      {row && (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Paragraph style={{ marginBottom: 0 }}>{row.summary}</Paragraph>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="kind">
              <Tag color={KIND_COLOR[row.kind] ?? "default"}>{row.kind}</Tag>
            </Descriptions.Item>
            {/* 两个时钟都显示，且标明来源。它们正常只差几十毫秒，但 SW 被回收又
                复活、或机器时钟不同步时能差很远，那个差值本身就是排查线索。 */}
            <Descriptions.Item label="发生时间（浏览器时钟）">
              {dayjs(row.occurredAt).format("YYYY-MM-DD HH:mm:ss.SSS")}
            </Descriptions.Item>
            <Descriptions.Item label="收到时间（console 时钟）">
              {dayjs(row.receivedAt).format("YYYY-MM-DD HH:mm:ss.SSS")}
            </Descriptions.Item>
            <Descriptions.Item label="浏览器实例">
              <Text style={{ fontFamily: "monospace", fontSize: 12 }}>{row.browser ?? "—"}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="tab">{row.tabId >= 0 ? row.tabId : "与 tab 无关"}</Descriptions.Item>
            {/* seq 只在同一个 backend 进程内单调，重启会从头开始——标出来，
                免得有人拿它当全局游标去做增量同步。 */}
            <Descriptions.Item label="seq">
              {row.seq ?? "—"}
              <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>backend 进程内序号，重启后重新计数</Text>
            </Descriptions.Item>
            {row.acknowledgedAt && (
              <Descriptions.Item label="处理时间">
                {dayjs(row.acknowledgedAt).format("YYYY-MM-DD HH:mm:ss")}
              </Descriptions.Item>
            )}
          </Descriptions>

          <div>
            <Text strong>detail</Text>
            <pre style={{ marginTop: 8, background: "var(--c-subtle)", padding: 12, borderRadius: 6, fontSize: 12, overflowX: "auto" }}>
              {formatDetail(row.detail)}
            </pre>
          </div>

          <div>
            <Text strong>截图</Text>
            <div style={{ marginTop: 8 }}>
              {row.screenshotUrl ? (
                <Image src={row.screenshotUrl} alt="事件截图" style={{ maxWidth: "100%", border: "1px solid var(--c-line-strong)", borderRadius: 6 }} />
              ) : (
                // 无图不是错误，而且原因有三种；说清楚比留一个空框有用。
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      无截图 —— 该类事件本就不带图（只有「验证码出现」会带），或后端拍到的是同窗口里另一个 tab 而主动丢弃
                    </Text>
                  }
                />
              )}
            </div>
          </div>
        </Space>
      )}
    </Drawer>
  );
}

/** detail 是 JSON 文本。存进来时是 `JSON.stringify` 的结果，所以正常总能解开；
 *  真解不开时**原样显示**而不是显示「解析失败」——那串字符本身就是唯一的线索，
 *  用一句错误提示把它盖掉等于把证据删了。 */
function formatDetail(detail: string | null): string {
  if (!detail) return "（无）";
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}
