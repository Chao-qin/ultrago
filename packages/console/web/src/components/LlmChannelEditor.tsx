import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AutoComplete, Button, Drawer, Form, Input, InputNumber, Modal, Popover, Select, Space, Tag, Tooltip, Typography, message } from "antd";
import { ApiOutlined, CopyOutlined, ExclamationCircleFilled, InfoCircleOutlined } from "@ant-design/icons";

import { api } from "../lib/api";
import type { LlmAdapterInfo, LlmChannelDraft, LlmChannelTestResult } from "../lib/types";
import { formatDuration } from "../lib/format";
import { RowActions } from "./RowActions";
import { PageTable } from "./PageTable";
import { ConnectField, asEnvBlock, asJsonBlock, copyText as copy } from "./llm-connect";
import './llm-channel-editor.css';

const { Text } = Typography;

type ChannelEditorRow = LlmChannelDraft & {
  managed?: boolean;
};

/**
 * 能力标签的常见取值。
 *
 * 只是**下拉候选**，不是白名单——控件是 `mode="tags"`，随手打一个新的照样能存，
 * 这与网关侧「不做枚举约束」是同一个立场：加一个新能力不该需要改这里。
 */
const CAPABILITY_OPTIONS = [
  { value: "vision" },
  { value: "json" },
  { value: "tools" },
  { value: "embedding" },
  { value: "reasoning" },
];

/**
 * 保存前把「与 model 同名的 id」摘掉。
 *
 * 这一列显示的是网关算出的生效值，所以未声明 id 的行也会带着 model 名回到
 * 草稿里。原样存下去会让 channels.json 长出一堆 `"id": "<和 model 一模一样>"`
 * ——语义等价（网关就是这么默认的），但那是界面的显示细节渗进用户的配置文件。
 */
/**
 * 输入框里的警告标记。
 *
 * 用图标不用 `<Tag>`：suffix 占的是输入框自己的宽度，一个「多了 /v1？」的文字
 * 标签能把 `https://vulcanapi.com/v1` 挤成 `https://vulcanapi.cor`——警告本身
 * 遮住了它要你去看的那个值。
 */
function WarnMark({ title }: { title: string }) {
  return (
    <Tooltip title={title}>
      <ExclamationCircleFilled style={{ color: "var(--ant-color-warning, #faad14)" }} />
    </Tooltip>
  );
}

function stripInherited(draft: LlmChannelDraft[]): LlmChannelDraft[] {
  return draft.map((c) => {
    const id = (c.id ?? "").trim();
    if (id && id !== (c.model ?? "").trim()) return c;
    const { id: _dropped, ...rest } = c;
    return rest;
  });
}

/**
 * 渠道表编辑器。
 *
 * 三个刻意的设计：
 *
 *  1. **整表保存**，不是逐条 CRUD。配置的真相源是一个 JSON 文件，整表替换与它
 *     天然同构；逐条改则要在两边各维护一套合并逻辑，而合并出错的症状是
 *     「界面显示的和文件里的不一样」。
 *  2. **网关的报错原样显示**，不翻译。它会直接告诉你哪个键拼错了、该改成什么
 *     （`unknown key "num_ctx" — did you mean "numCtx"?`），比任何我们能编的
 *     提示都准确。
 *  3. **apiKey 两种写法都收**：`env.NAME` 引用（真值留在 .env，界面看不到也发
 *     不出去）或直接粘明文。下拉只列 .env 里的**名字**，省掉「我那个 key 叫什么
 *     来着」的翻文件；明文那条路留着，是因为拿到一把新 key 想马上试一下的时候，
 *     强制先去编辑 .env 再回来纯属添堵——代价是它会写进 channels.json，所以界
 *     面上标一个「明文」把这件事说明白，由你决定。
 */
export function LlmChannelEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<LlmChannelDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<number, LlmChannelTestResult | "running">>({});
  const [connect, setConnect] = useState<ChannelEditorRow | null>(null);

  const admin = useQuery({ queryKey: ["llm-admin"], queryFn: () => api.llmAdmin(), enabled: open });
  // 「接入」那份配置要照着网关**此刻的鉴权状态**给 apiKey：开了鉴权还发占位符，
  // 抄出去就是 401，而那个 401 发生在别人的软件里。
  const keys = useQuery({ queryKey: ["llm-keys"], queryFn: () => api.llmKeys(), enabled: open });

  // 打开时从网关拉一份当前声明当草稿。不在 render 里同步，否则每次重渲染都会
  // 把你正在编辑的内容冲掉。
  useEffect(() => {
    if (open && admin.data) {
      // id 用网关算好的 effectiveIds 填上：声明里 `id` 是可选的，不写就等于上游
      // model。此前这一列整列空白 + 灰 placeholder，看起来像数据没加载出来。
      // 保存时 stripInherited 会把「与 model 同名」的那些再摘掉，文件不长冗余。
      setDraft(admin.data.channels.map((c, i) => ({ ...c, id: admin.data!.effectiveIds?.[i] ?? c.id })));
      setError(null);
      setTests({});
    }
  }, [open, admin.data]);

  const adapters = admin.data?.adapters ?? [];
  const managedChannels = admin.data?.managedChannels ?? [];
  // 网关只回了名字。拼成 `env.NAME` 当下拉候选，因为那才是要填进这一栏的东西。
  const secretEnvOptions = (admin.data?.secretEnvNames ?? []).map((name) => ({ value: `env.${name}` }));
  // 网关**此刻真在服务**的对外模型名。「接入」给出的是一份要粘到别的客户端里去
  // 的配置，所以必须照着运行中的表说话——草稿里刚改的 id 还不是它的名字，照着
  // 草稿抄出去的配置会 404，而那个 404 发生在别的软件里，最难查。
  const servedIds = new Set([
    ...(admin.data?.effectiveIds ?? []),
    ...managedChannels.map((c) => c.id),
  ]);
  const rows: ChannelEditorRow[] = [
    ...draft,
    ...managedChannels.map((channel) => ({ ...channel, managed: true })),
  ];
  const infoOf = (name: string): LlmAdapterInfo | undefined => adapters.find((a) => a.name === name);

  const save = useMutation({
    mutationFn: () => api.saveLlmChannels(stripInherited(draft)),
    onSuccess: () => {
      setError(null);
      message.success("已保存并热加载");
      void qc.invalidateQueries({ queryKey: ["llm-admin"] });
      void qc.invalidateQueries({ queryKey: ["llm-channels"] });
    },
    // 网关校验不过时什么都没改，所以这里只显示错误、不回滚草稿——
    // 你要能看着报错继续改，而不是被打回原形。
    onError: (e: Error) => setError(e.message),
  });

  /**
   * 测一行。
   *
   * 结果按**行下标**存，不按渠道 id。id 是可选的：不填时它默认等于上游 model，
   * 所以草稿里的 `id` 常常是 undefined —— 原先用它当 key，三条没填 id 的渠道
   * 就共用 `tests[undefined]` 这一个格子，点一行测试，三行一起亮。同理，两条
   * 故意同名的渠道（同一模型的多个来源，本来就是设计里允许的）也会互相串。
   */
  const runTest = async (index: number, channel: LlmChannelDraft) => {
    const id = (channel.id ?? "").trim() || (channel.model ?? "").trim();
    if (!id) {
      setTests((t) => ({ ...t, [index]: { ok: false, latencyMs: 0, error: "这一行还没有 id 或 model，先填一个再测" } }));
      return;
    }
    setTests((t) => ({ ...t, [index]: "running" }));
    try {
      const result = await api.testLlmChannel(id);
      setTests((t) => ({ ...t, [index]: result }));
    } catch (e) {
      setTests((t) => ({ ...t, [index]: { ok: false, latencyMs: 0, error: (e as Error).message } }));
    }
  };

  const patch = (index: number, next: Partial<LlmChannelDraft>) =>
    setDraft((d) => d.map((c, i) => (i === index ? { ...c, ...next } : c)));

  const columns = [
    {
      title: "渠道 id",
      width: 200,
      render: (_: unknown, row: ChannelEditorRow, i: number) => (
        // 显示的是**实际生效的 id**，不是原始字段。声明里 `id` 是可选的（不写就
        // 等于上游 model 名），三条渠道都没写，于是这一列原先整列空白 + 灰
        // placeholder——看起来像数据没加载出来，而不是「继承自 model」。
        // 保存时同名的会被 stripInherited 摘掉，文件不会因此长出冗余字段。
        row.managed ? <Space size={4}><Text>{row.id}</Text><Tag color="blue">本地受管</Tag></Space> : <Input
          value={row.id ?? ""}
          placeholder="调用方填在 model 里的名字"
          onChange={(e) => patch(i, { id: e.target.value })}
          suffix={
            !((row.id ?? "").trim()) && row.model
              ? <Tooltip title="没有单独声明 id，默认等于上游模型名"><Tag style={{ marginInlineEnd: 0 }}>继承</Tag></Tooltip>
              : <span />
          }
        />
      ),
    },
    {
      title: "适配器",
      width: 120,
      render: (_: unknown, row: ChannelEditorRow, i: number) => (
        row.managed ? <Tag>{row.adapter}</Tag> : <Select
          value={row.adapter}
          style={{ width: "100%" }}
          options={adapters.map((a) => ({ value: a.name, label: a.name }))}
          onChange={(v) => patch(i, { adapter: v })}
        />
      ),
    },
    {
      title: "baseUrl",
      width: 220,
      render: (_: unknown, row: ChannelEditorRow, i: number) => {
        const info = infoOf(row.adapter);
        if (row.managed) return <Text type="secondary">{row.baseUrl ?? "受管渠道，URL 自动派生"}</Text>;
        // direct 适配器的地址不由这张表决定（opencode 打的是 .env 里
        // BCP_LLM_OPENCODE_PORT 指定的受管服务），别给一个填了也没用的框。
        if (info && !info.needsBaseUrl) return <Text type="secondary">受管渠道，URL 自动派生</Text>;
        // 适配器自己接 `/v1/models`、`/v1/chat/completions`（见 openai.ts 的
        // baseUrlOf 用法），所以这里再带一层就会打成 `/v1/v1/...` → 404。
        // placeholder 早就写了「不含 /v1」，但没人会读一个填满了的输入框的
        // placeholder，而 404 的症状（模型列表空、测试失败）完全不指向这里。
        // 只标不改：个别上游确实把 `/v1` 当成路径的一部分，替用户删掉就是替他
        // 猜，猜错了他连「我填的是什么」都看不见。
        const trailingVersion = /\/v\d+\/?$/.test((row.baseUrl ?? "").trim());
        return (
          <Input
            value={row.baseUrl ?? ""}
            placeholder="https://api.example.com（不含 /v1）"
            onChange={(e) => patch(i, { baseUrl: e.target.value || undefined })}
            suffix={
              trailingVersion
                ? <WarnMark title="适配器会自己接 /v1/chat/completions。这里再带一层，实际打出去的是 /v1/v1/… —— 多数上游会 404" />
                : <span />
            }
          />
        );
      },
    },
    {
      title: "模型 / API Key",
      width: 280,
      render: (_: unknown, row: ChannelEditorRow, i: number) => {
        const raw = (row.apiKey ?? "").trim();
        // 明文和引用都合法（网关的 resolveSecret 只对 `env.` 前缀做解引用），
        // 但两者的去向不同：引用留在 .env，明文会**原样写进 channels.json**。
        // 这是个值得知道的区别，所以标出来——只提示，不拦。
        const plain = raw !== "" && !raw.startsWith("env.");
        return (
          <div className="llm-channel-combined-field">
            <div className="llm-channel-combined-field-row">
              <Text type="secondary" className="llm-channel-combined-field-label">模型</Text>
              <div className="llm-channel-combined-field-control">
                {row.managed ? <Text>{row.model}</Text> : <ModelPicker
                  value={row.model ?? ""}
                  // 整行的声明都给它：问上游要什么模型，靠的是 adapter + baseUrl + apiKey，
                  // 不是这条渠道叫什么、更不是它存没存过。
                  channel={row}
                  canList={infoOf(row.adapter)?.canListModels ?? false}
                  onChange={(v) => patch(i, { model: v })}
                />}
              </div>
            </div>
            <div className="llm-channel-combined-field-row">
              <Text type="secondary" className="llm-channel-combined-field-label">API Key</Text>
              <div className="llm-channel-combined-field-control">
                {row.managed ? <Text type="secondary">—</Text> : <AutoComplete
                  value={row.apiKey ?? ""}
                  style={{ width: "100%" }}
                  options={secretEnvOptions}
                  // 默认的 filterOption 只在「已输入」时过滤；这里要的是聚焦即看见
                  // 全部候选，输入后再收窄，所以显式给一个大小写无关的包含匹配。
                  filterOption={(input, option) =>
                    String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())
                  }
                  onChange={(v: string) => patch(i, { apiKey: v || undefined })}
                >
                  <Input
                    placeholder="选 env.NAME，或直接粘贴 sk-..."
                    suffix={
                      plain
                        ? <WarnMark title="明文。这把 key 会原样写进 channels.json —— 想让它留在 .env 里，把这栏换成 env.NAME 引用" />
                        : <span />
                    }
                  />
                </AutoComplete>}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      title: "并发 / 单价 / 能力",
      width: 300,
      render: (_: unknown, row: ChannelEditorRow, i: number) => {
        if (row.managed) return <Text type="secondary">—</Text>;
        const pricing = row.pricing;
        // 单价两栏要么都填要么都不填：网关的 parsePricing 要求两个数都在，
        // 只填一半会在保存时被拒，不如在这里就把它当作「一组」来编辑。
        const setRate = (key: "inputPer1M" | "outputPer1M", value: number | null) => {
          const next = {
            inputPer1M: pricing?.inputPer1M ?? 0,
            outputPer1M: pricing?.outputPer1M ?? 0,
            ...(pricing?.currency ? { currency: pricing.currency } : {}),
            [key]: value ?? 0,
          };
          patch(i, { pricing: value == null && !pricing ? undefined : next });
        };
        return (
          <div className="llm-channel-combined-field">
            <div className="llm-channel-combined-field-row">
              <Text type="secondary" className="llm-channel-combined-field-label">并发</Text>
              <div className="llm-channel-combined-field-control">
                <InputNumber
                  min={1}
                  precision={0}
                  placeholder="不限"
                  style={{ width: "100%" }}
                  value={row.maxConcurrency ?? null}
                  onChange={(v) => patch(i, { maxConcurrency: v ?? undefined })}
                />
              </div>
            </div>
            <div className="llm-channel-combined-field-row">
              <Text type="secondary" className="llm-channel-combined-field-label">
                <Tooltip title="照厂商价格页填「每 100 万 token」的价钱。不填 = 这条渠道的调用不核算花费（显示为「—」，不是 0）">
                  单价
                </Tooltip>
              </Text>
              <div className="llm-channel-combined-field-control">
                <Space.Compact style={{ width: "100%" }}>
                  <InputNumber
                    min={0}
                    placeholder="入/1M"
                    style={{ width: "34%" }}
                    value={pricing?.inputPer1M ?? null}
                    onChange={(v) => setRate("inputPer1M", v as number | null)}
                  />
                  <InputNumber
                    min={0}
                    placeholder="出/1M"
                    style={{ width: "34%" }}
                    value={pricing?.outputPer1M ?? null}
                    onChange={(v) => setRate("outputPer1M", v as number | null)}
                  />
                  <Input
                    placeholder="USD"
                    style={{ width: "32%" }}
                    value={pricing?.currency ?? ""}
                    onChange={(e) =>
                      patch(i, {
                        pricing: pricing
                          ? { ...pricing, currency: e.target.value || undefined }
                          : undefined,
                      })
                    }
                  />
                </Space.Compact>
              </div>
            </div>
            <div className="llm-channel-combined-field-row">
              <Text type="secondary" className="llm-channel-combined-field-label">
                <Tooltip title="人工声明，仅供挑选：网关既不据它路由，也不据它拒绝请求。填错会误导人，但不会让调用失败">
                  能力
                </Tooltip>
              </Text>
              <div className="llm-channel-combined-field-control">
                <Select
                  mode="tags"
                  style={{ width: "100%" }}
                  placeholder="vision / json / tools…"
                  value={row.capabilities ?? []}
                  options={CAPABILITY_OPTIONS}
                  onChange={(v: string[]) => patch(i, { capabilities: v.length ? v : undefined })}
                />
              </div>
            </div>
          </div>
        );
      },
    },
    {
      title: "操作",
      width: 252,
      fixed: "right" as const,
      render: (_: unknown, row: ChannelEditorRow, i: number) => {
        const result = tests[i];
        return (
          <Space size={8} align="center">
            <RowActions
              actions={[
                {
                  key: "connect",
                  label: "接入",
                  icon: <ApiOutlined />,
                  onClick: () => setConnect(row),
                },
                { key: "test", label: "测试", loading: result === "running", onClick: () => void runTest(i, row) },
                !row.managed && {
                  key: "delete",
                  label: "删除",
                  danger: true,
                  confirm: { title: "从表里移除这条？" },
                  onClick: () => setDraft((d) => d.filter((_, j) => j !== i)),
                },
              ]}
            />
            {result && result !== "running" && (
              <Tooltip title={result.ok ? result.reply : result.error}>
                <Tag color={result.ok ? "green" : "red"} style={{ marginInlineEnd: 0 }}>
                  {result.ok ? formatDuration(result.latencyMs) : "失败"}
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
      // 那段「保存会先校验再落盘再切换」收进标题旁的 ⓘ：它是**一次性**的知识
      // ——读懂一遍就够了，之后每次打开抽屉都占掉表格上方一整块，反而把要干活
      // 的那张表往下推。收纳不是删除，点一下全文还在。
      title={
        <div className="llm-channel-editor-title">
          <div>
            <strong>渠道管理</strong>
            <span>{draft.length} 条可编辑{managedChannels.length ? ` · ${managedChannels.length} 条本地受管` : ''}</span>
          </div>
          <Popover
            placement="bottomLeft"
            overlayStyle={{ maxWidth: 460 }}
            title="保存会先校验再落盘再切换"
            content="校验不过时磁盘和运行中的网关都不会被改动——正在服务的请求不受影响。channels.json 是可编辑渠道的真相源；本地受管渠道由运行时适配器自动接入，只读展示。"
          >
            <InfoCircleOutlined className="llm-channel-editor-info" />
          </Popover>
        </div>
      }
      className="llm-channel-editor-drawer"
      width="min(1560px, calc(100vw - 24px))"
      open={open}
      onClose={onClose}
      extra={
        <Space>
          <Button
            onClick={() =>
              setDraft((d) => [...d, { id: "", adapter: adapters[0]?.name ?? "openai", model: "" }])
            }
          >
            新增渠道
          </Button>
          <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>
            保存并热加载
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        {/* 报错不收纳：它是**这一次**才有的消息，而且你正等着它告诉你哪里填错了。 */}
        {error && <Alert type="error" showIcon message="网关拒绝了这份配置" description={error} />}
        <PageTable
          className="llm-channel-editor-table"
          rowKey={(_, i) => String(i)}
          dataSource={rows}
          columns={columns}
          pagination={false}
          size="small"
          loading={admin.isLoading}
          fill={false}
          tableLayout="fixed"
          scroll={{ x: 1072 }}
        />
        <Form.Item extra="测试会走完整调用链真发一次请求——打通 /v1/models 不代表这条渠道能出货。" />
      </Space>
      <ConnectModal
        row={connect}
        authRequired={keys.data?.authRequired ?? false}
        gatewayBaseUrl={admin.data?.gatewayBaseUrl}
        served={!!connect && servedIds.has((connect.id ?? "").trim() || (connect.model ?? "").trim())}
        onClose={() => setConnect(null)}
      />
    </Drawer>
  );
}

/**
 * 没开鉴权时那一栏填什么。
 *
 * 绝大多数 OpenAI 客户端要求 apiKey 非空，所以给一个占位。**开了鉴权就不能用它**
 * ——这里原本硬写着「网关的 /v1 不校验 key（它只听 127.0.0.1）」，那句话在入站
 * 鉴权落地之后就不成立了，照着它抄出去的配置会 401，而那个 401 发生在别人的软件
 * 里，最难查。现在按网关此刻的真实状态给值。
 */
const PLACEHOLDER_KEY = "bcp";

/**
 * 「接入」：把**用这条渠道**所需的三件套摆出来，供粘进别的客户端。
 *
 * 三个值都不是这张表里的字段，这正是它存在的理由——表里填的是「网关怎么打上游」，
 * 而你要的是「别人怎么打网关」，两者只有模型名重叠，且重叠的是**对外的 id** 而
 * 不是上游模型名。此前这套换算只能靠人自己在脑子里做一遍。
 *
 * `served` = 网关此刻真在服务这个名字。照着一份还没保存的草稿抄配置，404 会发生
 * 在别的软件里——那是最难查的一种，所以宁可先挡一句话。
 */
function ConnectModal({
  row,
  authRequired,
  gatewayBaseUrl,
  served,
  onClose,
}: {
  row: ChannelEditorRow | null;
  authRequired: boolean;
  gatewayBaseUrl?: string;
  served: boolean;
  onClose: () => void;
}) {
  if (!row) return null;
  const model = (row.id ?? "").trim() || (row.model ?? "").trim();
  const baseUrl = `${(gatewayBaseUrl ?? "http://127.0.0.1:11435").replace(/\/+$/, "")}/v1`;
  // 开了鉴权就必须带一把真 key —— 占位符那条路已经走不通了。
  const apiKey = authRequired ? "<在「访问与限流」里签发一把 key>" : PLACEHOLDER_KEY;
  const asEnv = asEnvBlock(baseUrl, apiKey, model);
  const asJson = asJsonBlock(baseUrl, apiKey, model);

  return (
    <Modal
      open
      onCancel={onClose}
      title={`接入「${model}」`}
      footer={[
        <Button key="env" icon={<CopyOutlined />} onClick={() => copy(asEnv, "环境变量")}>复制为 env</Button>,
        <Button key="json" icon={<CopyOutlined />} onClick={() => copy(asJson, "JSON")}>复制为 JSON</Button>,
        <Button key="close" type="primary" onClick={onClose}>知道了</Button>,
      ]}
      width={560}
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Text type="secondary">
          任何说 OpenAI 协议的客户端都能用这三个值接进来——Claude Code / Cursor / Cherry Studio / SDK 都一样。
        </Text>
        {!served && (
          <Alert
            type="warning"
            showIcon
            message="网关还不认这个名字"
            description="这一行还没保存，或者 id 改过之后没「保存并热加载」。现在抄出去的配置会在对方那边报 404。"
          />
        )}
        <ConnectField label="Base URL" value={baseUrl} />
        <ConnectField label="Model" value={model} hint="就是左边那个「渠道 id」——调用方填的是它，不是上游模型名。" />
        <ConnectField
          label="API Key"
          value={PLACEHOLDER_KEY}
          hint="网关只听 127.0.0.1 且不校验这一栏，填什么都行；给个值只是因为多数客户端不接受空。"
        />
      </Space>
    </Modal>
  );
}

/**
 * 模型输入：能拉就给下拉，拉不了就退回纯文本框。
 *
 * 退回而不是禁用，是因为「问不到上游的模型列表」不等于「这条渠道不能填模型」——
 * opencode 的模型来自它自己的 provider 配置，网关这一侧根本问不到，但你照样要能填。
 *
 * 问的是**这一行当前的声明**，不是「网关记得的那条渠道」——所以一条刚新增、
 * 还没保存、连 id 都没有的行，只要 baseUrl 和 apiKey 填了就能拉到列表。此前
 * 必须先保存才能看到，而保存又要求先填一个模型名，成了鸡生蛋；那条路上的每一
 * 种失败还都掉进同一句「上游没给出列表」，把人往唯一不该查的方向指。
 */
function ModelPicker({
  value,
  channel,
  canList,
  onChange,
}: {
  value: string;
  channel: LlmChannelDraft;
  canList: boolean;
  onChange: (v: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  // 只有这三个字段决定「问哪个上游、拿什么问」。id / model 不进 key：改个别名
  // 或选个模型都不该让已经拿到的列表作废。
  const { adapter, baseUrl, apiKey } = channel;
  const models = useQuery({
    queryKey: ["llm-upstream-models", adapter, baseUrl ?? "", apiKey ?? ""],
    queryFn: () => api.llmUpstreamModels({ adapter, baseUrl, apiKey }),
    // 只在真正点开下拉时才去问上游——它是一次网络调用，不该在渲染时白花。
    enabled: opened && canList,
  });

  if (!canList) {
    return <Input value={value} placeholder="上游模型名" onChange={(e) => onChange(e.target.value)} />;
  }
  const empty = models.isFetching
    ? "正在问上游…"
    : models.data?.error ?? models.data?.reason ?? "上游没给出列表";
  return (
    <Select
      showSearch
      // 允许自由输入：下拉是帮忙，不是白名单。上游刚上线的新模型不该被界面挡住。
      mode="tags"
      maxTagCount={1}
      value={value ? [value] : []}
      style={{ width: "100%" }}
      placeholder="上游模型名"
      onDropdownVisibleChange={setOpened}
      onChange={(v: string[]) => onChange(v[v.length - 1] ?? "")}
      notFoundContent={empty}
      options={(models.data?.models ?? []).map((m) => ({ value: m, label: m }))}
    />
  );
}
