import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Drawer, Space, Tag, Typography, message } from "antd";
import { StopOutlined, WarningOutlined } from "@ant-design/icons";
import { api } from "../lib/api";
import type { PnpmScript } from "../lib/types";
import { SearchInput } from "./SearchInput";
import { LogPane, useDetachedLog, useRunLog } from "./ScriptLogView";
import { RowActions } from "./RowActions";
import { PageTable } from "./PageTable";

/** What the log drawer is currently showing. `detached` runs have no exec id —
 *  the console they'd report to is the one they are restarting. */
type Watching = { kind: "exec"; id: string } | { kind: "detached"; command: string[] } | null;

/**
 * The workspace's package.json scripts, grouped by package, runnable.
 *
 * Running and stopping are loopback-only on the server (LoopbackGuard). A 403
 * here means the page is open from another machine, and it is worth saying so
 * plainly — "Forbidden" on a button that used to work reads like a bug.
 */
export function SettingsScripts() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [watching, setWatching] = useState<Watching>(null);

  const registry = useQuery({ queryKey: ["pnpm-scripts"], queryFn: api.listPnpmScripts });
  // Kept alive independently of the drawer: closing the drawer must not be the
  // only way to lose track of a build that is still running.
  const runs = useQuery({ queryKey: ["script-runs"], queryFn: api.listScriptRuns, refetchInterval: 3_000 });

  const startMut = useMutation({
    mutationFn: ({ entry }: { entry: PnpmScript }) => api.startPnpmScript(entry.dir, entry.script, entry.danger),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["script-runs"] });
      if (res.detached) {
        message.warning("已 detach 启动：console 可能随之重启，日志改从文件读");
        setWatching({ kind: "detached", command: res.command });
      } else {
        setWatching({ kind: "exec", id: res.exec.id });
      }
    },
    onError: (e) => {
      const err = e as Error & { status?: number };
      message.error(err.status === 403 ? `只能从本机运行脚本：${err.message}` : err.message);
    },
  });

  const stopMut = useMutation({
    mutationFn: (id: string) => api.stopScriptRun(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["script-runs"] }),
    onError: (e) => message.error((e as Error).message),
  });

  /** Package → its scripts, in package.json order, filtered by the search box.
   *  A package whose every script is filtered out drops off the page entirely
   *  rather than leaving an empty card behind. */
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = new Map<string, { dir: string; entries: PnpmScript[] }>();
    for (const e of registry.data?.entries ?? []) {
      if (q && !`${e.pkg} ${e.script} ${e.raw}`.toLowerCase().includes(q)) continue;
      const bucket = out.get(e.pkg) ?? { dir: e.dir, entries: [] };
      bucket.entries.push(e);
      out.set(e.pkg, bucket);
    }
    return [...out.entries()];
  }, [registry.data, search]);

  const total = registry.data?.entries.length ?? 0;
  const shown = grouped.reduce((n, [, g]) => n + g.entries.length, 0);

  const columns = [
    {
      title: "脚本",
      dataIndex: "script",
      width: 220,
      render: (_: unknown, e: PnpmScript) => (
        <Space size={6}>
          <Typography.Text strong>{e.script}</Typography.Text>
          {e.danger && (
            <Tag color={e.detach ? "red" : "orange"} icon={<WarningOutlined />}>
              {e.detach ? "会重启 console" : "危险"}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: "package.json 里写的是",
      dataIndex: "raw",
      render: (raw: string) => (
        <Typography.Text code style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {raw}
        </Typography.Text>
      ),
    },
    {
      title: "",
      width: 120,
      render: (_: unknown, e: PnpmScript) => {
        const pending =
          startMut.isPending &&
          startMut.variables?.entry.dir === e.dir &&
          startMut.variables?.entry.script === e.script;
        return (
          <RowActions
            actions={[{
              key: "run",
              label: "运行",
              loading: pending,
              danger: e.danger,
              confirm: e.danger
                ? { title: `确定要运行 ${e.script}？`, description: <div style={{ maxWidth: 340 }}>{e.reason}</div> }
                : false,
              onClick: () => startMut.mutate({ entry: e }),
            }]}
          />
        );
      },
    },
  ];

  return (
    <div>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message="运行脚本只允许从本机（127.0.0.1）发起"
          description="console 绑在 0.0.0.0 且没有鉴权层，所以列表对局域网可见、运行按钮不对外开放。标红的脚本会杀掉正在服务本页面的 console，它们以 detach 方式执行、日志写进仓库根的 .console-script.log。"
        />
        {(registry.data?.warnings.length ?? 0) > 0 && (
          <Alert
            type="warning"
            showIcon
            message="有 workspace 没能完整读出来"
            description={<ul style={{ margin: 0, paddingLeft: 18 }}>{registry.data?.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          />
        )}
        {(runs.data?.length ?? 0) > 0 && (
          <Card size="small" title="最近执行">
            <Space direction="vertical" size={6} style={{ width: "100%" }}>
              {runs.data?.map((r) => (
                <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Tag color={STATUS[r.status]?.color ?? "default"} style={{ margin: 0 }}>
                    {STATUS[r.status]?.label ?? r.status}
                  </Tag>
                  <Typography.Text code style={{ fontSize: 12 }}>{r.pkg} · {r.script}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(r.startedAt).toLocaleTimeString()}
                    {r.exitCode !== null && ` · 退出码 ${r.exitCode}`}
                  </Typography.Text>
                  <Button size="small" type="link" onClick={() => setWatching({ kind: "exec", id: r.id })}>
                    查看日志
                  </Button>
                  {r.status === "running" && (
                    <Button size="small" danger type="link" icon={<StopOutlined />} onClick={() => stopMut.mutate(r.id)}>
                      停止
                    </Button>
                  )}
                </div>
              ))}
            </Space>
          </Card>
        )}

        <Space>
          <SearchInput value={search} onChange={setSearch} placeholder="搜脚本名 / 命令 / 包名…" />
          <Typography.Text type="secondary">
            {search ? `${shown} / ${total}` : `${total}`} 条脚本，{grouped.length} 个包
          </Typography.Text>
        </Space>

        {grouped.map(([pkg, group]) => (
          <Card
            key={pkg}
            size="small"
            title={
              <Space size={8}>
                <Typography.Text strong>{pkg}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>
                  {group.dir === "." ? "仓库根" : group.dir}
                </Typography.Text>
              </Space>
            }
          >
            <PageTable<PnpmScript>
              size="small"
              rowKey={(e) => `${e.dir}:${e.script}`}
              columns={columns}
              dataSource={group.entries}
              pagination={false}
              fill={false}
            />
          </Card>
        ))}
        {registry.isSuccess && grouped.length === 0 && (
          <Card><Typography.Text type="secondary">没有匹配的脚本</Typography.Text></Card>
        )}
      </Space>

      <LogDrawer watching={watching} onClose={() => setWatching(null)} onStop={(id) => stopMut.mutate(id)} />
    </div>
  );
}

function LogDrawer({
  watching,
  onClose,
  onStop,
}: {
  watching: Watching;
  onClose: () => void;
  onStop: (id: string) => void;
}) {
  const attached = useRunLog(watching?.kind === "exec" ? watching.id : null);
  const detached = useDetachedLog(watching?.kind === "detached");

  const running = attached.exec?.status === "running";
  const title = watching?.kind === "detached"
    ? watching.command.join(" ")
    : attached.exec
      ? attached.exec.command.join(" ")
      : "运行中…";

  return (
    <Drawer
      open={watching !== null}
      onClose={onClose}
      width="min(900px, 92vw)"
      title={<Typography.Text code style={{ fontSize: 13 }}>{title}</Typography.Text>}
      extra={
        watching?.kind === "exec" && running ? (
          <Button danger size="small" icon={<StopOutlined />} onClick={() => onStop(watching.id)}>
            停止
          </Button>
        ) : null
      }
      styles={{ body: { display: "flex", flexDirection: "column", gap: 8 } }}
    >
      {watching?.kind === "detached" && (
        <Alert
          type={detached.offline ? "warning" : "info"}
          showIcon
          message={
            detached.offline
              ? "暂时读不到 console —— 它可能正在被这个脚本重启，日志会继续尝试拉取"
              : "这条日志读的是仓库根的 .console-script.log，console 重启后仍然接得上"
          }
        />
      )}
      {watching?.kind === "exec" && attached.exec && (
        <Space>
          <Tag color={STATUS[attached.exec.status]?.color ?? "default"}>
            {STATUS[attached.exec.status]?.label ?? attached.exec.status}
          </Tag>
          {attached.exec.exitCode !== null && <Typography.Text type="secondary">退出码 {attached.exec.exitCode}</Typography.Text>}
        </Space>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <LogPane text={watching?.kind === "detached" ? detached.text : attached.lines.join("\n")} />
      </div>
    </Drawer>
  );
}

const STATUS: Record<string, { color: string; label: string }> = {
  running: { color: "processing", label: "运行中" },
  success: { color: "success", label: "成功" },
  failed: { color: "error", label: "失败" },
  stopped: { color: "default", label: "已停止" },
};
