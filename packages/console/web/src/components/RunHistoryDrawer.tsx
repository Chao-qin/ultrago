import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Drawer, Typography } from "antd";
import { Link } from "react-router-dom";
import dayjs from "dayjs";
import { api } from "../lib/api";
import { PageTable } from "./PageTable";
import { RunStatusTag } from "./RunStatusTag";
import { formatDuration } from "../lib/format";

/**
 * 一行的运行历史，就地打开。
 *
 * 在这之前，看某个 book / flow 跑过几次只能离开列表：book 要点进详情页再滚到
 * 「运行历史」卡片，flow 更绕——先进画布(一个重量级编辑器)，开 ⋯ 菜单，跳到
 * /flow-runs?flowId=，中途还要过一道「有未保存改动」的确认。两条路都丢掉当前
 * 的搜索与筛选，看完还得回来重新找到那一行。
 *
 * book run 与 flow run 是两张表、两个接口，但这里要看的五件事(状态 / 触发 /
 * 时间 / 耗时 / 进详情)完全一样，所以只在**取数**和**详情路由**两处分叉，表格
 * 本体共用。
 */
export type RunHistoryTarget = { kind: "book" | "flow"; id: string; name: string };

/** RunSummary 与 FlowRunRow 的交集——这张表只读这几个字段。 */
type RunHistoryRow = {
  id: string;
  status: string;
  trigger: string;
  queuedAt: string;
  durationMs: number | null;
};

const EMPTY: Record<RunHistoryTarget["kind"], { title: string; description: string }> = {
  book: { title: "还没有运行过", description: "在列表里点「运行」触发一次，记录会出现在这里。" },
  flow: { title: "还没有运行过", description: "打开流程点「触发」跑一次，记录会出现在这里。" },
};

export function RunHistoryDrawer({
  target,
  onClose,
}: {
  target: RunHistoryTarget | null;
  onClose: () => void;
}) {
  // 关闭时 target 立刻变 null，而抽屉还要滑出约 300ms。渲染与取数若都跟着
  // target 走，这 300ms 里标题会掉回「运行记录」、表格闪成「还没有运行过」——
  // 一个有历史的 book 被当着面说成没跑过。所以**看什么**认 shown（只跟随、不
  // 跟着清空），**要不要继续打接口**认 target：关上就不再轮询。
  const [shown, setShown] = useState<RunHistoryTarget | null>(null);
  if (target && target !== shown) setShown(target);

  const runs = useQuery({
    queryKey: ["run-history", shown?.kind, shown?.id],
    queryFn: (): Promise<RunHistoryRow[]> =>
      shown!.kind === "flow" ? api.listFlowRuns(shown!.id) : api.listRuns({ bookId: shown!.id }),
    // shown 也要判：首帧 setShown 还没生效，那一趟 queryFn 会解引用 null。
    enabled: !!target && !!shown,
    refetchInterval: 3000,
  });

  const columns = [
    { title: "状态", dataIndex: "status", key: "status", width: 110, render: (s: string) => <RunStatusTag status={s} /> },
    { title: "触发", dataIndex: "trigger", key: "trigger", width: 90 },
    {
      title: "开始",
      dataIndex: "queuedAt",
      key: "queuedAt",
      width: 160,
      render: (t: string) => (
        <Typography.Text style={{ fontFamily: "monospace", fontSize: 12 }}>
          {dayjs(t).format("MM-DD HH:mm:ss")}
        </Typography.Text>
      ),
    },
    { title: "耗时", dataIndex: "durationMs", key: "durationMs", width: 90, render: (ms: number | null) => formatDuration(ms) },
    {
      title: "操作",
      key: "action",
      width: 70,
      render: (_: unknown, row: RunHistoryRow) => (
        <Link to={shown?.kind === "flow" ? `/flow-runs/${row.id}` : `/runs/${row.id}`} onClick={onClose}>
          查看
        </Link>
      ),
    },
  ];

  return (
    <Drawer
      open={!!target}
      onClose={onClose}
      width={720}
      title={shown ? `运行记录 · ${shown.name}` : "运行记录"}
      // PageTable 靠一条 CSS flex 链在表体内部滚动，链子的起点得是个 flex 列。
      // .ant-drawer-body 本身已经是定高的（flex:1 + min-height:0），缺的只是它
      // 不是 flex 容器——补上这三行，长历史就滚在表体里，抽屉头不会被推走。
      styles={{ body: { display: "flex", flexDirection: "column", overflow: "hidden" } }}
    >
      <PageTable
        rowKey="id"
        size="small"
        query={runs}
        dataSource={runs.data ?? []}
        columns={columns}
        pagination={false}
        empty={EMPTY[shown?.kind ?? "book"]}
      />
    </Drawer>
  );
}
