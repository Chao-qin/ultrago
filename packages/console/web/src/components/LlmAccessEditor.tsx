import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  DatePicker,
  Divider,
  Drawer,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popover,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import {
  ApiOutlined,
  CopyOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";

import { api } from "../lib/api";
import type { LlmApiKeyView, LlmKeySettings, LlmKeyTestResult } from "../lib/types";
import { formatDuration } from "../lib/format";
import { RowActions } from "./RowActions";
import { ConnectField, asEnvBlock, asJsonBlock, copyText } from "./llm-connect";
import "./llm-access-editor.css";

const { Text, Paragraph } = Typography;

/** `{ 别名: [模型…] }` 在界面上是一张可编辑的两列表，这是它的行形态。 */
type AliasRow = { name: string; targets: string[] };

function toRows(aliases: Record<string, string[]> | undefined): AliasRow[] {
  return Object.entries(aliases ?? {}).map(([name, targets]) => ({ name, targets }));
}

function toTable(rows: AliasRow[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name && row.targets.length) out[name] = row.targets;
  }
  return out;
}

/**
 * 小节标题 + 收进 ⓘ 的长说明。
 *
 * 这些说明都是**一次性的知识**：读一遍就懂，之后每次打开这个抽屉它们都还占着
 * 正文最显眼的一整块，把真正要操作的控件挤到下面去。`LlmChannelEditor` 早先把
 * 「保存会先校验再落盘再切换」收进标题旁的 ⓘ 也是同一个理由。
 *
 * 收起来不是删掉：判断依据仍然必须能查到，只是不该每次都念一遍。
 */
function SectionTitle({
  title,
  hint,
  extra,
}: {
  title: string;
  hint?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <div className="llm-access-title">
      <h4>{title}</h4>
      {hint && (
        <Popover
          trigger="click"
          placement="bottomLeft"
          content={<div className="llm-access-hint">{hint}</div>}
        >
          <Button type="text" size="small" aria-label={`${title}说明`} icon={<InfoCircleOutlined />} />
        </Popover>
      )}
      {extra && <div className="llm-access-title-extra">{extra}</div>}
    </div>
  );
}

const EXPIRY_PRESETS: { label: string; days: number }[] = [
  { label: "7 天", days: 7 },
  { label: "30 天", days: 30 },
  { label: "90 天", days: 90 },
  { label: "1 年", days: 365 },
];

/**
 * 一把 key 的四项配置。签发与编辑共用。
 *
 * 共用不是为了省代码，是为了让两条路**给出同一套选项**：能签发出来的配置，编辑
 * 时也该改得回去，否则总有一项只能在某一边设置，而那种不对称没人会记得住。
 */
function KeySettingsForm({
  value,
  onChange,
  models,
}: {
  value: LlmKeySettings;
  onChange: (next: LlmKeySettings) => void;
  models: string[];
}) {
  const patch = (part: LlmKeySettings) => onChange({ ...value, ...part });
  const expires = value.expiresAt ? dayjs(value.expiresAt) : null;

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <div className="llm-access-field">
        <Text type="secondary">有效期</Text>
        <Space wrap>
          <DatePicker
            showTime
            value={expires}
            placeholder="永不过期"
            onChange={(d: Dayjs | null) => patch({ expiresAt: d ? d.toISOString() : null })}
          />
          {EXPIRY_PRESETS.map((preset) => (
            <Button
              key={preset.days}
              size="small"
              onClick={() => patch({ expiresAt: dayjs().add(preset.days, "day").toISOString() })}
            >
              {preset.label}
            </Button>
          ))}
          {value.expiresAt && (
            <Button size="small" type="text" onClick={() => patch({ expiresAt: null })}>
              清除
            </Button>
          )}
        </Space>
      </div>

      <div className="llm-access-field">
        <Text type="secondary">每分钟请求数</Text>
        <InputNumber
          min={1}
          precision={0}
          placeholder="不限"
          style={{ width: 160 }}
          value={value.rateLimitPerMinute ?? null}
          onChange={(v) => patch({ rateLimitPerMinute: (v as number | null) ?? null })}
        />
      </div>

      <div className="llm-access-field">
        <Text type="secondary">并发上限</Text>
        <InputNumber
          min={1}
          precision={0}
          placeholder="不限"
          style={{ width: 160 }}
          value={value.maxConcurrency ?? null}
          onChange={(v) => patch({ maxConcurrency: (v as number | null) ?? null })}
        />
      </div>

      <div className="llm-access-field">
        <Text type="secondary">可用模型</Text>
        <Select
          mode="multiple"
          allowClear
          style={{ width: "100%" }}
          placeholder="留空 = 全部可用"
          value={value.allowedModels ?? []}
          options={models.map((id) => ({ value: id, label: id }))}
          onChange={(v: string[]) => patch({ allowedModels: v.length ? v : null })}
        />
      </div>
    </Space>
  );
}

/**
 * 访问控制与限流。
 *
 * 三块配置放在一个抽屉里，因为它们回答的是同一个问题：**这个网关现在对谁开放、
 * 能被打多狠、以及一个用途该落到哪条渠道上。**
 *
 * 两处刻意的设计：
 *
 *  1. **没有「启用鉴权」开关。** 有没有启用中的 key 本身就是那个开关。多一个布尔
 *     量意味着多一个可以和事实对不上的状态，而对不上的那一面是「以为开着，其实
 *     敞着」。
 *  2. **新 key 的明文用 Modal 强制确认。** 它只在签发那一次响应里存在过，网关
 *     磁盘上只有哈希。抽屉里随手一关就再也取不回来，所以必须挡一下。
 */
export function LlmAccessEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [aliasRows, setAliasRows] = useState<AliasRow[]>([]);
  const [maxConcurrency, setMaxConcurrency] = useState<number | null>(null);
  const [keyName, setKeyName] = useState("");
  const [draftSettings, setDraftSettings] = useState<LlmKeySettings>({});
  const [minted, setMinted] = useState<{ name: string; plaintext: string } | null>(null);
  const [editing, setEditing] = useState<LlmApiKeyView | null>(null);
  const [editSettings, setEditSettings] = useState<LlmKeySettings>({});
  // 已经取回来的明文，按 key id 存。**只在点了「显示」之后才有**——列表接口不带
  // 明文，见 LlmApiKeyView.revealable。
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, LlmKeyTestResult | "running">>({});
  const [connect, setConnect] = useState<LlmApiKeyView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const admin = useQuery({ queryKey: ["llm-admin"], queryFn: () => api.llmAdmin(), enabled: open });
  const keys = useQuery({ queryKey: ["llm-keys"], queryFn: () => api.llmKeys(), enabled: open });
  // 别名与白名单的候选必须来自**网关此刻真在服务的**那张表（/v1/models），不能用
  // `admin.effectiveIds`——后者只覆盖 channels.json 里声明的渠道，漏掉按硬件档
  // 推导出来的本机渠道（它在 managedChannels 里单独回）。漏掉的后果很具体：
  // 本机模型明明能用，却选不到。
  const channels = useQuery({
    queryKey: ["llm-channels"],
    queryFn: () => api.listLlmChannels(),
    enabled: open,
  });
  const runtime = useQuery({
    queryKey: ["llm-runtime"],
    queryFn: () => api.llmRuntime(),
    enabled: open,
    refetchInterval: 5_000,
  });

  // 打开时把网关的当前声明拉成草稿。不在 render 里同步，否则每次重渲染都会把
  // 正在编辑的内容冲掉。
  useEffect(() => {
    if (open && admin.data) {
      setAliasRows(toRows(admin.data.aliases));
      setMaxConcurrency(admin.data.limits?.maxConcurrency ?? null);
      setError(null);
    }
  }, [open, admin.data]);

  const refreshKeys = () => void qc.invalidateQueries({ queryKey: ["llm-keys"] });
  const refreshAdmin = () => {
    void qc.invalidateQueries({ queryKey: ["llm-admin"] });
    void qc.invalidateQueries({ queryKey: ["llm-channels"] });
  };

  const saveAliases = useMutation({
    mutationFn: () => api.saveLlmAliases(toTable(aliasRows)),
    onSuccess: () => { setError(null); refreshAdmin(); message.success("别名已保存"); },
    // 网关的原文比任何我们能编的提示都准确：它会直接说这条链上哪个模型不存在，
    // 以及当前有哪些可选。拒绝时配置已回滚，磁盘上不会留下起不来的文件。
    onError: (e: Error) => setError(e.message),
  });
  const saveLimits = useMutation({
    mutationFn: () => api.saveLlmLimits(maxConcurrency ? { maxConcurrency } : {}),
    onSuccess: () => { setError(null); refreshAdmin(); message.success("并发上限已保存"); },
    onError: (e: Error) => setError(e.message),
  });
  const createKey = useMutation({
    mutationFn: () => api.createLlmKey(keyName.trim(), draftSettings),
    onSuccess: (data) => {
      setKeyName("");
      setDraftSettings({});
      refreshKeys();
      setMinted({ name: data.created.name, plaintext: data.created.plaintext });
    },
    onError: (e: Error) => message.error(e.message),
  });
  const updateKey = useMutation({
    mutationFn: ({ id, settings }: { id: string; settings: LlmKeySettings }) =>
      api.updateLlmKey(id, settings),
    onSuccess: () => { setEditing(null); refreshKeys(); message.success("已保存"); },
    onError: (e: Error) => message.error(e.message),
  });
  const keyAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "revoke" | "restore" | "delete" }) =>
      action === "delete"
        ? api.deleteLlmKey(id)
        : action === "revoke"
          ? api.revokeLlmKey(id)
          : api.restoreLlmKey(id),
    onSuccess: () => { refreshKeys(); message.success("已更新"); },
    onError: (e: Error) => message.error(e.message),
  });
  /** 取一次明文并记住。取不到时把网关给的原因原样说出来，不假装是空字符串。 */
  const reveal = async (row: LlmApiKeyView): Promise<string | null> => {
    if (revealed[row.id]) return revealed[row.id];
    try {
      const { secret, reason } = await api.revealLlmKey(row.id);
      if (!secret) {
        message.warning(reason ?? "这把 key 取不回明文");
        return null;
      }
      setRevealed((r) => ({ ...r, [row.id]: secret }));
      return secret;
    } catch (e) {
      message.error((e as Error).message);
      return null;
    }
  };

  const runTest = async (row: LlmApiKeyView) => {
    setTests((t) => ({ ...t, [row.id]: "running" }));
    try {
      const result = await api.testLlmKey(row.id);
      setTests((t) => ({ ...t, [row.id]: result }));
    } catch (e) {
      setTests((t) => ({ ...t, [row.id]: { ok: false, error: (e as Error).message } }));
    }
  };

  const saveLoopback = useMutation({
    mutationFn: (allow: boolean) => api.saveLlmKeySettings(allow),
    onSuccess: () => { refreshKeys(); message.success("已更新"); },
    onError: (e: Error) => message.error(e.message),
  });

  const authRequired = keys.data?.authRequired ?? false;
  const allowLoopback = keys.data?.allowLoopback ?? true;
  const models = (channels.data ?? []).map((c) => c.id);
  const rateWindow = runtime.data?.rateWindow ?? {};
  // 别名/白名单候选同理：旧网关或连不上时给空表，而不是让下游拿 undefined。

  /** 某一行别名的候选。当前值也并进去：目标被删时这一栏不该变成空白——那看起来
   *  像「没配」，而真相是「配了但目标没了」，后者才是要修的。 */
  const modelOptions = (current: string[]) => {
    const all = new Set(models);
    for (const id of current) all.add(id);
    return [...all].map((id) => ({ value: id, label: id }));
  };

  const keyColumns = [
    {
      title: "名称",
      dataIndex: "name",
      width: 120,
      render: (v: string, row: LlmApiKeyView) => (
        <div className="llm-access-key-identity">
          <Text strong className="llm-access-key-name" title={v}>{v}</Text>
          {row.disabledAt && <Tag color="red">已吊销</Tag>}
          {!row.disabledAt && row.expired && <Tag color="orange">已过期</Tag>}
        </div>
      ),
    },
    {
      title: "标识",
      dataIndex: "prefix",
      width: 230,
      /**
       * 默认只显示前 12 位，点眼睛才展开完整 key。
       *
       * 打码不是因为拿不到——明文就在一次请求之外。它挡的是**截图与屏幕共享**，
       * 也就是这个场景下真正会发生的泄漏方式；一个默认摊开在表格里的 key，迟早
       * 会出现在某张贴给别人看的图里。
       *
       * 旧版签发的 key 磁盘上只有哈希，两个按钮都禁用并说明原因，不假装能取到。
       */
      render: (v: string, row: LlmApiKeyView) => {
        const full = revealed[row.id];
        const canReveal = row.revealable !== false;
        return (
          <Space size={2}>
            <Text code className="llm-access-secret">{full ?? `${v}…`}</Text>
            <Tooltip
              title={
                canReveal
                  ? full ? "隐藏" : "显示完整 key"
                  : "这把 key 由旧版本签发，磁盘上只有哈希，取不回明文"
              }
            >
              <Button
                type="text"
                size="small"
                disabled={!canReveal}
                aria-label={`${full ? "隐藏" : "显示"} ${row.name} 的完整 key`}
                icon={full ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                onClick={() => {
                  if (full) {
                    setRevealed(({ [row.id]: _drop, ...rest }) => rest);
                    return;
                  }
                  void reveal(row);
                }}
              />
            </Tooltip>
            <Tooltip title={canReveal ? "复制完整 key" : "只能复制前缀——这把 key 取不回明文"}>
              <Button
                type="text"
                size="small"
                aria-label={`复制 ${row.name}`}
                icon={<CopyOutlined />}
                onClick={() => {
                  if (!canReveal) {
                    copyText(v, "标识前缀");
                    return;
                  }
                  void reveal(row).then((secret) => secret && copyText(secret, "完整 key"));
                }}
              />
            </Tooltip>
          </Space>
        );
      },
    },
    {
      title: "限制",
      width: 165,
      render: (_: unknown, row: LlmApiKeyView) => {
        const used = rateWindow[row.id];
        return (
          <Space size={4} wrap>
            {row.rateLimitPerMinute ? (
              <Tooltip title={`最近一分钟已用 ${used ?? 0} / ${row.rateLimitPerMinute}`}>
                <Tag color={used && used >= row.rateLimitPerMinute ? "red" : "blue"}>
                  {used ?? 0}/{row.rateLimitPerMinute} 每分钟
                </Tag>
              </Tooltip>
            ) : null}
            {row.maxConcurrency ? <Tag>并发 {row.maxConcurrency}</Tag> : null}
            {row.allowedModels?.length ? (
              <Tooltip title={row.allowedModels.join("、")}>
                <Tag color="purple">{row.allowedModels.length} 个模型</Tag>
              </Tooltip>
            ) : null}
            {!row.rateLimitPerMinute && !row.maxConcurrency && !row.allowedModels?.length && (
              <Text type="secondary">不限</Text>
            )}
          </Space>
        );
      },
    },
    {
      title: "有效期",
      dataIndex: "expiresAt",
      width: 145,
      render: (v: string | null, row: LlmApiKeyView) =>
        v ? (
          <Tooltip title={`签发于 ${dayjs(row.createdAt).format("YYYY-MM-DD HH:mm")}`}>
            <Text type={row.expired ? "danger" : undefined}>{dayjs(v).format("YYYY-MM-DD HH:mm")}</Text>
          </Tooltip>
        ) : (
          <Tooltip title={`签发于 ${dayjs(row.createdAt).format("YYYY-MM-DD HH:mm")}`}>
            <Text type="secondary">永不过期</Text>
          </Tooltip>
        ),
    },
    {
      title: "",
      width: 210,
      render: (_: unknown, row: LlmApiKeyView) => {
        const result = tests[row.id];
        return (
        <Space size={6} align="center">
        <RowActions
          maxInline={2}
          actions={[
            {
              key: "connect",
              label: "接入",
              icon: <ApiOutlined />,
              onClick: () => {
                setConnect(row);
                // 接入面板要摆出完整 key，先把它取回来。
                if (row.revealable !== false) void reveal(row);
              },
            },
            {
              key: "test",
              label: "测试",
              loading: result === "running",
              onClick: () => void runTest(row),
            },
            {
              key: "edit",
              label: "编辑",
              onClick: () => {
                setEditing(row);
                setEditSettings({
                  expiresAt: row.expiresAt ?? null,
                  rateLimitPerMinute: row.rateLimitPerMinute ?? null,
                  maxConcurrency: row.maxConcurrency ?? null,
                  allowedModels: row.allowedModels?.length ? row.allowedModels : null,
                });
              },
            },
            row.disabledAt
              ? {
                  key: "restore",
                  label: "恢复",
                  onClick: () => keyAction.mutate({ id: row.id, action: "restore" }),
                }
              : {
                  key: "revoke",
                  label: "吊销",
                  onClick: () => keyAction.mutate({ id: row.id, action: "revoke" }),
                },
            {
              key: "delete",
              label: "彻底删除",
              danger: true,
              confirm: {
                title: "彻底删除这把 key？",
                // 吊销与删除是两个不同的决定，说清楚区别再让人选。
                description: "历史调用日志里它的名字将不再有对应记录。只想停用请选「吊销」。",
              },
              onClick: () => keyAction.mutate({ id: row.id, action: "delete" }),
            },
          ]}
        />
        {result && result !== "running" && (
          <Tooltip title={result.ok ? `${result.model} · ${result.reply}` : result.error}>
            <Tag color={result.ok ? "green" : "red"} style={{ marginInlineEnd: 0 }}>
              {result.ok ? formatDuration(result.latencyMs) : result.httpStatus ?? "失败"}
            </Tag>
          </Tooltip>
        )}
        </Space>
        );
      },
    },
  ];

  return (
    <Drawer
      title={
        <div className="llm-access-drawer-title">
          <strong>访问与限流</strong>
          <span>API Key、用途路由与全局并发策略</span>
        </div>
      }
      className="llm-access-drawer"
      width="min(1080px, calc(100vw - 24px))"
      open={open}
      onClose={onClose}
      destroyOnClose
      extra={
        <Tooltip
          title={
            authRequired
              ? allowLoopback
                ? "本机（127.0.0.1）免 key，其余一律要带 Authorization: Bearer <key>"
                : "所有模型调用都必须带 key，本机也不例外（Console 管理面除外）"
              : "还没有签发任何 key，网关不做鉴权。网关默认只监听 127.0.0.1；要对外提供服务请先签发一把 key"
          }
        >
          <Tag color={authRequired ? "green" : "default"}>
            {authRequired ? (allowLoopback ? "已鉴权 · 本机免 key" : "已鉴权 · 全员需 key") : "未鉴权 · 对本机开放"}
          </Tag>
        </Tooltip>
      }
    >
      {keys.isError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="读不到 key 列表"
          description={
            <>
              {(keys.error as Error).message}
              <br />
              下面显示的不是网关的真实状态。若网关回的是 401，多半是它还在跑旧版本——
              旧版把管理面也一并锁住了，重启 LLM 网关即可恢复。
            </>
          }
        />
      )}
      {error && (
        <Alert
          type="error"
          showIcon
          closable
          style={{ marginBottom: 16 }}
          message="网关拒绝了这份配置"
          description={<pre className="llm-access-error">{error}</pre>}
          onClose={() => setError(null)}
        />
      )}

      <SectionTitle
        title="API Key"
        hint={
          <>
            <p>
              <b>只存 sha256，明文仅在签发那一次返回。</b>关掉签发弹窗之后就再也取不回来了，
              要重新拿到只能吊销旧的、签发新的——能读回明文的 key，一次屏幕共享就泄了。
            </p>
            <p>
              <b>没有「启用鉴权」开关</b>：有没有启用中的 key 本身就是那个开关。签发第一把就会
              立刻开启鉴权；本机的三个调用方（captcha 校验 / 商品预处理 / Console 流程）走的是
              127.0.0.1，只要「本机免 key」开着就不受影响。
            </p>
            <p>
              key 的名字会成为调用日志里的<b>调用方</b>，所以起一个说得清「谁在用」的名字。
              有效期到点即拒，没有宽限期；所有 key 都过期时网关<b>继续鉴权</b>（拒绝所有），
              不会退回「没有 key = 敞开」那一档。
            </p>
            <p>
              「本机免 key」只管 <Text code>/v1/*</Text> 那些真正花钱的调用。<b>Console 的管理面对本机
              永远开放</b>——能连到 127.0.0.1 的进程直接打开 <Text code>keys.json</Text> 就什么都有了，
              把管理面锁上不增加安全性，只会造出一扇自己也进不去的门。外部地址打管理面仍然要 key。
            </p>
          </>
        }
        extra={
          <Space size={8}>
            <Switch
              size="small"
              checked={allowLoopback}
              loading={saveLoopback.isPending}
              onChange={(v) => saveLoopback.mutate(v)}
            />
            <Tooltip title="关掉之后本机的模型调用（/v1）也必须带 key；Console 的管理面不受影响，本机永远进得来。把网关对外提供服务时应当关掉它——这一个开关就是「对内 → 对外」的全部切换">
              <Text type="secondary">本机免 key</Text>
            </Tooltip>
          </Space>
        }
      />

      <Space.Compact style={{ width: "100%", marginBottom: 10 }}>
        <Input
          placeholder="给这把 key 起个名（会成为调用日志里的调用方）"
          value={keyName}
          onChange={(e) => setKeyName(e.target.value)}
          onPressEnter={() => keyName.trim() && createKey.mutate()}
        />
        <Popover
          trigger="click"
          placement="bottomRight"
          title="签发时的限制（可留空，之后也能改）"
          content={
            <div style={{ width: 340 }}>
              <KeySettingsForm value={draftSettings} onChange={setDraftSettings} models={models} />
            </div>
          }
        >
          <Button>限制…</Button>
        </Popover>
        <Button
          type="primary"
          loading={createKey.isPending}
          disabled={!keyName.trim()}
          onClick={() => createKey.mutate()}
        >
          签发
        </Button>
      </Space.Compact>

      <Table
        size="small"
        rowKey="id"
        tableLayout="fixed"
        scroll={{ x: 870 }}
        pagination={false}
        dataSource={keys.data?.keys ?? []}
        columns={keyColumns}
        loading={keys.isPending}
        locale={{ emptyText: <Empty description="还没有签发过 key" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
      />

      <Divider />

      <SectionTitle
        title="用途别名"
        hint={
          <>
            <p>
              给一个用途起个稳定的名字（如 <Text code>task.vision</Text>），让调用方写它而不是写死
              模型名。换模型时只改这里，不用改代码。
            </p>
            <p>
              右边选的是<b>对外模型名</b>——调用方写进请求 <Text code>model</Text> 字段的那个字符串。
              它不是「某一条渠道」：同一个模型名下配了多条渠道时（多把 key 的写法），别名照样享受
              轮询与自动 failover，钉死一条反而把这两样都丢了。
            </p>
            <p>
              <b>可以选多个，顺序就是备用顺序</b>：第一个是首选，它的所有渠道都失败（且失败是可重试
              的那类）时才落到下一个。<b>链上任何一个指向不存在的模型，网关都会拒绝保存</b>，不会等
              到调用时才 404。
            </p>
          </>
        }
      />
      {aliasRows.map((row, index) => (
        <Space.Compact key={index} style={{ width: "100%", marginBottom: 8 }}>
          <Input
            style={{ width: "34%" }}
            placeholder="别名，如 task.vision"
            value={row.name}
            onChange={(e) =>
              setAliasRows(aliasRows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))
            }
          />
          <Select
            mode="multiple"
            style={{ width: "56%" }}
            placeholder={channels.isPending ? "正在读取网关…" : "首选模型，可再加备用"}
            showSearch
            loading={channels.isPending}
            value={row.targets}
            options={modelOptions(row.targets)}
            notFoundContent={channels.isError ? "连不上网关" : "网关暂无可用模型"}
            onChange={(v: string[]) =>
              setAliasRows(aliasRows.map((r, i) => (i === index ? { ...r, targets: v } : r)))
            }
          />
          <Button danger onClick={() => setAliasRows(aliasRows.filter((_, i) => i !== index))}>
            删除
          </Button>
        </Space.Compact>
      ))}
      <Space>
        <Button onClick={() => setAliasRows([...aliasRows, { name: "", targets: [] }])}>
          添加别名
        </Button>
        <Button type="primary" loading={saveAliases.isPending} onClick={() => saveAliases.mutate()}>
          保存别名
        </Button>
      </Space>

      <Divider />

      <SectionTitle
        title="全局并发上限"
        hint={
          <>
            <p>所有渠道加起来最多同时在飞多少个请求。留空 = 不限。</p>
            <p>
              超出的请求<b>排队等待</b>而不是立刻失败——批处理宁可等，而每个请求自带的
              <Text code>X-BCP-Request-Timeout-Ms</Text> 预算就是它愿意等多久。再加一个「队列多深」
              的阈值只是用一个没人能正确选的数字去近似同一件事。
            </p>
            <p>单条渠道自己的上限在「渠道管理」里设；每把 key 的上限在上面那张表里设。</p>
          </>
        }
        extra={
          runtime.data?.concurrency?.global && (
            <Tooltip title="网关此刻的内存快照，每 5 秒刷新；不打上游">
              <Text type="secondary">
                {runtime.data.concurrency.global.active} 在飞 · {runtime.data.concurrency.global.queued} 排队
              </Text>
            </Tooltip>
          )
        }
      />
      <Space>
        <InputNumber
          min={1}
          precision={0}
          placeholder="不限"
          value={maxConcurrency}
          onChange={(v) => setMaxConcurrency(v ?? null)}
        />
        <Button type="primary" loading={saveLimits.isPending} onClick={() => saveLimits.mutate()}>
          保存
        </Button>
      </Space>

      {/* 降级中的渠道值得单独说一句：它不会被剔除，只是被排到最后。 */}
      {runtime.data?.channelHealth &&
        Object.entries(runtime.data.channelHealth).some(([, v]) => v.demotedUntil) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 16 }}
          message="有渠道因连续失败被降级"
          description={
            <>
              {Object.entries(runtime.data!.channelHealth)
                .filter(([, v]) => v.demotedUntil)
                .map(([id, v]) => `${id}（连续失败 ${v.consecutiveFailures} 次）`)
                .join("、")}
              。它们仍在候选里，只是被排到最后；冷却到期会自动排回来。
            </>
          }
        />
      )}

      <Modal
        open={!!minted}
        title="这把 key 只显示这一次"
        onCancel={() => setMinted(null)}
        footer={[
          <Button key="ok" type="primary" onClick={() => setMinted(null)}>
            我已保存
          </Button>,
        ]}
      >
        <Paragraph>
          网关只存它的哈希，关掉这个窗口之后<b>再也取不回来</b>。请现在复制保存。
        </Paragraph>
        <Input.TextArea readOnly autoSize value={minted?.plaintext ?? ""} />
        <Button
          icon={<CopyOutlined />}
          style={{ marginTop: 10 }}
          onClick={() => copyText(minted?.plaintext ?? "", "完整 key")}
        >
          复制
        </Button>
      </Modal>

      <KeyConnectModal
        row={connect}
        secret={connect ? revealed[connect.id] : undefined}
        gatewayBaseUrl={admin.data?.gatewayBaseUrl}
        models={models}
        onClose={() => setConnect(null)}
      />

      <Modal
        open={!!editing}
        title={`编辑「${editing?.name ?? ""}」`}
        onCancel={() => setEditing(null)}
        okText="保存"
        confirmLoading={updateKey.isPending}
        onOk={() => editing && updateKey.mutate({ id: editing.id, settings: editSettings })}
      >
        <Paragraph type="secondary" style={{ fontSize: 12 }}>
          改的是这把 key 的<b>设置</b>，不是它的密钥——我们没有旧明文，「重置密钥」除了重新签发
          之外没有别的实现。
        </Paragraph>
        <KeySettingsForm value={editSettings} onChange={setEditSettings} models={models} />
      </Modal>
    </Drawer>
  );
}

/**
 * 「接入」：把**用这把 key** 所需的三件套摆出来，供粘进别的客户端。
 *
 * 与渠道那个「接入」的分工：那边回答「用哪个模型」，这边回答「拿什么钥匙」。
 * 两边给的是同一份 OpenAI 配置的不同栏位，所以共用 llm-connect 里的零件——各写
 * 一遍迟早长出两种措辞和两种 bug。
 *
 * 模型那一栏按白名单给：这把 key 若限定了可用模型，写别的就是 403，而那个 403
 * 会发生在对方的软件里。没限定就给网关此刻服务的第一个，并说明可以换。
 */
function KeyConnectModal({
  row,
  secret,
  gatewayBaseUrl,
  models,
  onClose,
}: {
  row: LlmApiKeyView | null;
  secret?: string;
  gatewayBaseUrl?: string;
  models: string[];
  onClose: () => void;
}) {
  if (!row) return null;
  const baseUrl = `${(gatewayBaseUrl ?? "http://127.0.0.1:11435").replace(/\/+$/, "")}/v1`;
  const scoped = row.allowedModels?.length ? row.allowedModels : models;
  const model = scoped[0] ?? "（网关当前没有可用模型）";
  // 取不到明文时不编一个假的：摆出占位，并说清楚为什么。
  const apiKey = secret ?? (row.revealable === false ? "（旧版签发，取不回明文）" : "（正在读取…）");

  return (
    <Modal
      open
      onCancel={onClose}
      title={`接入「${row.name}」`}
      width={560}
      footer={[
        <Button key="env" icon={<CopyOutlined />} onClick={() => copyText(asEnvBlock(baseUrl, apiKey, model), "环境变量")}>
          复制为 env
        </Button>,
        <Button key="json" icon={<CopyOutlined />} onClick={() => copyText(asJsonBlock(baseUrl, apiKey, model), "JSON")}>
          复制为 JSON
        </Button>,
        <Button key="close" type="primary" onClick={onClose}>知道了</Button>,
      ]}
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Text type="secondary">
          任何说 OpenAI 协议的客户端都能用这三个值接进来——Claude Code / Cursor / Cherry Studio / SDK 都一样。
        </Text>
        <ConnectField label="Base URL" value={baseUrl} />
        <ConnectField
          label="API Key"
          value={apiKey}
          hint={
            row.expired
              ? "⚠ 这把 key 已过期，现在用它会被拒"
              : row.disabledAt
                ? "⚠ 这把 key 已吊销，现在用它会被拒"
                : undefined
          }
        />
        <ConnectField
          label="Model"
          value={model}
          hint={
            row.allowedModels?.length
              ? `这把 key 只能用：${row.allowedModels.join("、")}`
              : "这把 key 不限模型，换成 /v1/models 里的任何一个都行"
          }
        />
        {row.rateLimitPerMinute || row.maxConcurrency ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            限制：
            {row.rateLimitPerMinute ? `每分钟 ${row.rateLimitPerMinute} 次` : ""}
            {row.rateLimitPerMinute && row.maxConcurrency ? " · " : ""}
            {row.maxConcurrency ? `并发 ${row.maxConcurrency}` : ""}
            。超出会收到 429（带 Retry-After）或排队。
          </Text>
        ) : null}
      </Space>
    </Modal>
  );
}
