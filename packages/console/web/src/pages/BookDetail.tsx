import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Descriptions, Button, Tag, Switch, Typography, Space, Card, Spin, message } from "antd";
import { PlayCircleOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { api } from "../lib/api";
import { TriggerDialog } from "../components/TriggerDialog";
import { TextClamp } from "../components/TextClamp";
import dayjs from "dayjs";
import { RunStatusTag } from "../components/RunStatusTag";
import { BOOKS_QUERY_ROOT } from "../lib/books";
import { RowActions } from "../components/RowActions";
import { PageTable } from "../components/PageTable";
import { DetailHeader } from '../components/detail-header';
import { ErrorState } from '../components/EmptyState';

export function BookDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const book = useQuery({
    queryKey: ["book", id],
    queryFn: () => api.getBook(id!),
    enabled: !!id,
  });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: () => api.listSchedules(),
    enabled: !!id,
  });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [showTrigger, setShowTrigger] = useState(false);

  const b = book.data;
  const initialEnabled = enabled ?? b?.enabled ?? true;

  const update = useMutation({
    mutationFn: () => api.updateBook(id!, { enabled: initialEnabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["book", id] });
      qc.invalidateQueries({ queryKey: BOOKS_QUERY_ROOT });
      message.success("已保存");
    },
  });

  if (book.isError && !b) return <ErrorState error={book.error} onRetry={() => book.refetch()} />;
  if (!b) return <Spin tip="正在加载 Book 详情"><div style={{ minHeight: 200 }} /></Spin>;

  const mySchedules = (schedules.data ?? []).filter((s) => s.bookId === b.id);

  const runColumns = [
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 120,
       render: (s: string) => <RunStatusTag status={s} />,
    },
    { title: "触发方式", dataIndex: "trigger", key: "trigger", width: 100 },
    { title: "时间", dataIndex: "queuedAt", key: "queuedAt", render: (t: string) => dayjs(t).format("MM-DD HH:mm:ss") },
    {
      title: "操作",
      key: "action",
      width: 110,
      fixed: "right" as const,
      render: (_: unknown, record: { id: string }) => (
        <RowActions
          actions={[{ key: "view", label: "查看", onClick: () => nav(`/runs/${record.id}`) }]}
        />
      ),
    },
  ];

  const scheduleColumns = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      render: (name: string) => <span style={{ fontWeight: 500 }}>{name}</span>,
    },
    {
      title: "Cron",
      dataIndex: "cronExpr",
      key: "cronExpr",
      width: 160,
      render: (cron: string) => <Tag color="blue">{cron}</Tag>,
    },
    {
      title: "时区",
      dataIndex: "timezone",
      key: "timezone",
      width: 140,
    },
    {
      title: "下次触发",
      key: "nextFires",
      width: 200,
      render: (_: unknown, record: { nextFires: string[] }) =>
        record.nextFires.length > 0 ? (
          <Typography.Text style={{ fontSize: 12 }}>
            {dayjs(record.nextFires[0]).format("MM-DD HH:mm:ss")}
          </Typography.Text>
        ) : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: "状态",
      dataIndex: "enabled",
      key: "enabled",
      width: 80,
      render: (enabled: boolean) => (
        <Tag color={enabled ? "success" : "default"}>{enabled ? "启用" : "暂停"}</Tag>
      ),
    },
  ];

  return (
    <div className="console-detail-page">
      <DetailHeader title={b.name} subtitle="Book · 浏览器自动化详情" onBack={() => nav(-1)} actions={
        <Button type="primary" icon={<PlayCircleOutlined aria-hidden="true" />} onClick={() => setShowTrigger(true)}>
          触发
        </Button>
      } />

      <TextClamp text={b.goal || b.description || "—"} rows={2} />

      {b.goalDetail && (
        <TextClamp
          text={b.goalDetail}
          rows={3}
          style={{ marginTop: 4, maxWidth: 720 }}
          tooltip="实现细节"
        />
      )}

      <div className="console-resource-layout">
      <aside className="console-resource-context" aria-label="Book 上下文">
      <Card title="任务配置">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="目标">
            <TextClamp text={b.goal || "—"} rows={1} />
          </Descriptions.Item>
          <Descriptions.Item label="文件">
            <code>{b.filePath}</code>
            <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              修改时间 {dayjs(b.fileMtime).format("MM-DD HH:mm")} · sha1 {b.fileHash.slice(0, 8)}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="标签">
            {b.tags ? <Space size={4} wrap>{b.tags.split(",").map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space> : <Typography.Text type="secondary">—</Typography.Text>}
          </Descriptions.Item>
          <Descriptions.Item label="启用">
            <Space>
              <Switch checked={initialEnabled} onChange={setEnabled} />
              <Button size="small" type="primary" onClick={() => update.mutate()} loading={update.isPending}>
                保存
              </Button>
            </Space>
          </Descriptions.Item>
        </Descriptions>
      </Card>
      </aside>

      <div className="console-resource-body">
      <Card
        title={
          <Space>
            <ClockCircleOutlined />
            <span>定时任务 ({mySchedules.length})</span>
          </Space>
        }
        extra={
          <Link to="/schedules">
            <Button type="link" size="small">管理 →</Button>
          </Link>
        }
        style={{ marginBottom: 16 }}
      >
        {schedules.isError ? <ErrorState error={schedules.error} onRetry={() => schedules.refetch()} /> : schedules.isLoading ? (
          <Spin tip="正在加载定时任务"><div style={{ minHeight: 100 }} /></Spin>
        ) : mySchedules.length === 0 ? (
          <Typography.Text type="secondary">
            该 book 还没有定时任务. 去 <Link to="/schedules">定时任务</Link> 页面创建.
          </Typography.Text>
        ) : (
          <PageTable
            dataSource={mySchedules}
            columns={scheduleColumns}
            rowKey="id"
            pagination={false}
            size="small"
            fill={false}
          />
        )}
      </Card>

      <Card title="运行历史">
        <PageTable
          dataSource={b.runs}
          columns={runColumns}
          rowKey="id"
          pagination={{ pageSize: 10, size: "small" }}
          size="small"
          fill={false}
          // 操作列靠 fixed 留在右侧，而 fixed 需要一个横向滚动容器才生效。
          scroll={{ x: "max-content" }}
        />
      </Card>
      </div>
      </div>

      {showTrigger && (
        <TriggerDialog
          book={b}
          onClose={() => setShowTrigger(false)}
          onTriggered={(runId) => {
            setShowTrigger(false);
            window.location.hash = `#/runs/${runId}`;
          }}
        />
      )}
    </div>
  );
}
