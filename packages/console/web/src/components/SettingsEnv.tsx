import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Input, Popconfirm, Space, Tag, Tooltip, Typography, message } from "antd";
import { DeleteOutlined, EyeOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
import { api } from "../lib/api";
import type { EnvEntryView } from "../lib/types";

/** A key/value pair the user is adding that isn't in the file yet. */
interface NewRow {
  id: number;
  key: string;
  value: string;
}

/**
 * The monorepo root `.env`, grouped by prefix and editable.
 *
 * Secrets arrive masked and stay read-only until explicitly revealed. That is
 * not decoration: an editable field pre-filled with `ghp••••••5T` saves the
 * mask the moment someone appends a character to it, and the value it
 * overwrote is a credential.
 */
export function SettingsEnv() {
  const qc = useQueryClient();
  const env = useQuery({ queryKey: ["env"], queryFn: api.readEnv });

  /** Edited values, keyed by env key. Absent = untouched. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** True values fetched for masked keys. */
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [newRows, setNewRows] = useState<NewRow[]>([]);
  const [nextId, setNextId] = useState(1);

  const revealMut = useMutation({
    mutationFn: (key: string) => api.revealEnv(key),
    onSuccess: (r) => setRevealed((prev) => ({ ...prev, [r.key]: r.value })),
    onError: (e) => {
      const err = e as Error & { status?: number };
      message.error(err.status === 403 ? `只能从本机查看密钥原文：${err.message}` : err.message);
    },
  });

  const saveMut = useMutation({
    mutationFn: (updates: Record<string, string>) => api.writeEnv(updates),
    onSuccess: (r) => {
      if (r.changed.length === 0) {
        message.info("没有实际变化");
        return;
      }
      message.success(
        `已写入 ${r.file}（${r.changed.length} 项）${r.backup ? `，改前备份在 ${r.backup}` : ""}。改动要重启才生效。`,
        6,
      );
      setDrafts({});
      setRevealed({});
      setNewRows([]);
      void qc.invalidateQueries({ queryKey: ["env"] });
    },
    onError: (e) => {
      const err = e as Error & { status?: number };
      message.error(err.status === 403 ? `只能从本机修改 .env：${err.message}` : err.message);
    },
  });

  const byKey = useMemo(
    () => Object.fromEntries((env.data?.entries ?? []).map((e) => [e.key, e])),
    [env.data],
  );

  /** The value currently displayed for an entry: the draft if edited, then the
   *  revealed truth, then whatever the list gave us (masked, for secrets). */
  const shownValue = (e: EnvEntryView): string => drafts[e.key] ?? revealed[e.key] ?? e.value;
  const editable = (e: EnvEntryView): boolean => !e.masked || e.key in revealed || e.key in drafts;

  /** Only genuinely changed values go in the payload — comparing against the
   *  revealed truth for secrets, so revealing one and closing the panel is not
   *  a "change". */
  const payload = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(drafts)) {
      const entry = byKey[key];
      const current = entry ? (entry.masked ? revealed[key] : entry.value) : undefined;
      if (value !== current) out[key] = value;
    }
    for (const row of newRows) {
      if (row.key.trim() !== "") out[row.key.trim()] = row.value;
    }
    return out;
  }, [drafts, revealed, newRows, byKey]);

  const dirtyCount = Object.keys(payload).length;

  return (
    <div>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message={`编辑的是仓库根的 ${env.data?.file ?? ".env"} —— console 与 backend 实际加载的就是它`}
          description={
            <>
              保存会先备份成 <Typography.Text code>.env.bak</Typography.Text>，再原子写回，注释与顺序原样保留。
              <b>改动不会作用于正在运行的进程，要重启才生效</b>（这些值多数在启动时读一次）。修改只允许从本机（127.0.0.1）发起。
              {env.data?.notes.map((n) => <div key={n} style={{ marginTop: 4 }}>· {n}</div>)}
            </>
          }
        />

        <Space>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            disabled={dirtyCount === 0}
            loading={saveMut.isPending}
            onClick={() => saveMut.mutate(payload)}
          >
            保存{dirtyCount > 0 ? ` (${dirtyCount})` : ""}
          </Button>
          <Button
            disabled={dirtyCount === 0}
            onClick={() => {
              setDrafts({});
              setNewRows([]);
            }}
          >
            放弃改动
          </Button>
          <Typography.Text type="secondary">{env.data?.entries.length ?? 0} 个变量</Typography.Text>
        </Space>

        {(env.data?.groups ?? []).map((group) => (
          <Card key={group} size="small" title={group}>
            <Space direction="vertical" size={10} style={{ width: "100%" }}>
              {(env.data?.entries ?? [])
                .filter((e) => e.group === group)
                .map((e) => (
                  <div key={e.key} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div style={{ width: 300, flexShrink: 0, paddingTop: 4 }}>
                      <Tooltip title={e.comments.length > 0 ? e.comments.join("\n") : undefined}>
                        <Typography.Text code style={{ fontSize: 12 }}>{e.key}</Typography.Text>
                      </Tooltip>
                      {e.secret && <Tag color="volcano" style={{ marginLeft: 6 }}>密钥</Tag>}
                      {e.comments.length > 0 && (
                        <div style={{ fontSize: 11, color: "var(--c-ink-3)", marginTop: 2, whiteSpace: "pre-wrap" }}>
                          {e.comments.join("\n")}
                        </div>
                      )}
                    </div>
                    <Input
                      value={shownValue(e)}
                      readOnly={!editable(e)}
                      onChange={(ev) => setDrafts((prev) => ({ ...prev, [e.key]: ev.target.value }))}
                      style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 12 }}
                      suffix={
                        e.masked && !(e.key in revealed) ? (
                          <Tooltip title="显示原文后才能编辑">
                            <EyeOutlined
                              style={{ cursor: "pointer", color: "var(--c-ink-3)" }}
                              onClick={() => revealMut.mutate(e.key)}
                            />
                          </Tooltip>
                        ) : (
                          <span />
                        )
                      }
                    />
                  </div>
                ))}
            </Space>
          </Card>
        ))}

        <Card
          size="small"
          title="新增变量"
          extra={
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() => {
                setNewRows((prev) => [...prev, { id: nextId, key: "", value: "" }]);
                setNextId((n) => n + 1);
              }}
            >
              加一行
            </Button>
          }
        >
          {newRows.length === 0 ? (
            <Typography.Text type="secondary">
              代码里读得到但 .env 里没写的变量（例如 BCP_FORCE_PLAN、BCP_MAX_CONCURRENT_RUNS）可以在这里补上，会追加到文件末尾。
            </Typography.Text>
          ) : (
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              {newRows.map((row) => (
                <Space key={row.id} style={{ width: "100%" }} align="start">
                  <Input
                    placeholder="变量名"
                    value={row.key}
                    style={{ width: 300, fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}
                    status={row.key !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.key) ? "error" : undefined}
                    onChange={(ev) =>
                      setNewRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, key: ev.target.value } : r)))
                    }
                  />
                  <Input
                    placeholder="值"
                    value={row.value}
                    style={{ width: 380, fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}
                    onChange={(ev) =>
                      setNewRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, value: ev.target.value } : r)))
                    }
                  />
                  <Popconfirm title="删掉这一行？" onConfirm={() => setNewRows((prev) => prev.filter((r) => r.id !== row.id))}>
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ))}
            </Space>
          )}
        </Card>
      </Space>
    </div>
  );
}
