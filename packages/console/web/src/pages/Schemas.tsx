import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Drawer, Form, Input, Modal, Space, Switch, Tag, Tooltip, Typography, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../lib/api";
import { SCHEMA_KINDS, SCHEMA_KIND_LABELS, checkSchemaContract, rowDeletedAt } from "../lib/types";
import type { SchemaKind, SchemaRow } from "../lib/types";
import { PageTable } from "../components/PageTable";
import { ConsoleFormSection } from '../components/console-form-section';
import { DeletedToggle } from "../components/DeletedToggle";
import { SearchInput } from "../components/SearchInput";
import { BcpSelect } from "../components/BcpSelect";
import { RowActions, ROW_ACTIONS_COLUMN } from "../components/RowActions";
import { PageShell } from "../components/PageShell";

/** How the editor modal is being used. The three share a form because they
 *  edit overlapping fields, but they differ in what is allowed to change:
 *
 *   create  — everything, a brand new name
 *   version — a new version OF an existing name: content is the point, name
 *             and kind are fixed (changing them would make it a different
 *             schema, not a new version)
 *   meta    — metadata only. `jsonSchema` is immutable once registered: some
 *             row already cites this name+version, and rewriting what that
 *             resolves to would rewrite history. Content changes go through
 *             `version`. */
type EditorMode = "create" | "version" | "meta";

const KIND_COLORS: Record<string, string> = {
  canonical: "blue",
  projection: "purple",
  config: "green",
  book_input: "cyan",
  book_output: "geekblue",
  entity: "default",
};

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function Schemas() {
  const qc = useQueryClient();
  const [kindFilter, setKindFilter] = useState<string | undefined>();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [search, setSearch] = useState("");
  const [viewing, setViewing] = useState<SchemaRow | null>(null);
  const [editor, setEditor] = useState<{ mode: EditorMode; row?: SchemaRow } | null>(null);

  const schemas = useQuery({
    queryKey: ["schemas", kindFilter, includeInactive, includeDeleted],
    queryFn: () => api.listSchemas({ kind: kindFilter, includeInactive, includeDeleted }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["schemas"] });

  const toggleActive = useMutation({
    mutationFn: (row: SchemaRow) => api.updateSchema(row.id, { active: !row.active }),
    onSuccess: (row) => {
      message.success(row.active ? `${row.name} 已启用` : `${row.name} 已停用`);
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (row: SchemaRow) => api.deleteSchema(row.id),
    onSuccess: (r) => {
      message.success(`已删除 ${r.name}@${r.version}`);
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  /** Highest version per name — what a "new version" starts from. */
  const latestVersion = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of schemas.data ?? []) map.set(s.name, Math.max(map.get(s.name) ?? 0, s.version));
    return map;
  }, [schemas.data]);

  const columns = [
    {
      title: "名称",
      dataIndex: "name",
      render: (name: string, row: SchemaRow) => (
        <Space size={4}>
          <Typography.Text strong>{name}</Typography.Text>
          <Tag>v{row.version}</Tag>
          {!row.active && <Tag color="default">已停用</Tag>}
          {/* 停用与删除是两回事：停用的版本仍会被历史记录按 name@version 解析，
              删除的一律不解析。两者可以同时成立，所以两个标签各占各的位置。 */}
          {rowDeletedAt(row) && <Tag color="red">已删除</Tag>}
        </Space>
      ),
    },
    {
      title: "角色",
      dataIndex: "kind",
      width: 110,
      render: (kind: string) => (
        <Tag color={KIND_COLORS[kind] ?? "default"}>{SCHEMA_KIND_LABELS[kind as SchemaKind] ?? kind}</Tag>
      ),
    },
    { title: "主题", dataIndex: "entity", width: 90, render: (e: string | null) => e ?? <Typography.Text type="secondary">—</Typography.Text> },
    {
      title: "标题",
      dataIndex: "title",
      ellipsis: true,
      render: (t: string | null, row: SchemaRow) => t ?? row.description ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: "投影自",
      dataIndex: "derivesFrom",
      width: 160,
      render: (d: string | null) => (d ? <Typography.Text code>{d}</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text>),
    },
    {
      title: "出处",
      dataIndex: "source",
      width: 140,
      ellipsis: true,
      render: (s: string) => (
        <Tooltip title={s}>
          <Typography.Text type="secondary">{s.startsWith("file:") ? "文件导入" : s.startsWith("inline:book:") ? "Book 提升" : "控制台创建"}</Typography.Text>
        </Tooltip>
      ),
    },
    { title: "更新时间", dataIndex: "updatedAt", width: 150, render: (t: string) => dayjs(t).format("YYYY-MM-DD HH:mm") },
    {
      ...ROW_ACTIONS_COLUMN,
      width: 210,
      // 已删除的行不给操作：后端没有 schema 的恢复接口，其余按钮又都走
      // `deletedAt: null` 的查找，点下去只会 404。
      render: (_: unknown, row: SchemaRow) => (
        <RowActions
          actions={rowDeletedAt(row) ? [] : [
            { key: "view", label: "查看", onClick: () => setViewing(row) },
            { key: "meta", label: "编辑", onClick: () => setEditor({ mode: "meta", row }) },
            { key: "version", label: "新版本", onClick: () => setEditor({ mode: "version", row }) },
            { key: "active", label: row.active ? "停用" : "启用", onClick: () => toggleActive.mutate(row) },
            {
              key: "delete",
              label: "删除",
              danger: true,
              confirm: {
                title: `删除 ${row.name}@${row.version}？`,
                description: "删除用于清理误建的行。已经被引用过的 schema 请改为「停用」——历史记录仍需要它的文档才能解释。",
              },
              onClick: () => { void remove.mutateAsync(row); },
            },
          ]}
        />
      ),
    },
  ];

  return (
    <PageShell
      title="Schema 契约"
      subtitle="注册表：每个 name@version 是一份不可变契约文档"
      actions={
        <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} onClick={() => setEditor({ mode: "create" })}>
          注册 Schema
        </Button>
      }
      filters={
        <>
          <SearchInput value={search} onChange={setSearch} placeholder="搜索名称 / 标题 / 说明…" />
          <BcpSelect
            allowClear
            placeholder="按角色筛选"
            style={{ width: 160 }}
            value={kindFilter}
            onChange={setKindFilter}
            options={SCHEMA_KINDS.map((k) => ({ value: k, label: SCHEMA_KIND_LABELS[k] }))}
          />
          <Space size={4}>
            <Switch size="small" checked={includeInactive} onChange={setIncludeInactive} />
            <Typography.Text type="secondary">显示已停用</Typography.Text>
          </Space>
          <DeletedToggle checked={includeDeleted} onChange={setIncludeDeleted} />
        </>
      }
    >
      <PageTable
        rowKey="id"
        size="middle"
        query={schemas}
        empty={{ title: "还没有 Schema 契约", description: "每个 name@version 是一份不可变契约文档，运行记录靠它解释自己产出了什么。" }}
        dataSource={(schemas.data ?? []).filter((s) => {
          const q = search.trim().toLowerCase();
          if (!q) return true;
          return (
            s.name.toLowerCase().includes(q) ||
            (s.title ?? "").toLowerCase().includes(q) ||
            (s.description ?? "").toLowerCase().includes(q) ||
            (s.entity ?? "").toLowerCase().includes(q)
          );
        })}
        columns={columns}
        pagination={false}
      />

      <Drawer
        width={720}
        open={!!viewing}
        onClose={() => setViewing(null)}
        title={viewing ? `${viewing.name}@${viewing.version}` : ""}
      >
        {viewing && (
          <>
            <Typography.Paragraph type="secondary">{viewing.description ?? "（无说明）"}</Typography.Paragraph>
            <Typography.Paragraph>
              <Space direction="vertical" size={2}>
                <span>出处：<Typography.Text code>{viewing.source}</Typography.Text></span>
                <span>指纹：<Typography.Text code>{viewing.contentHash.slice(0, 16)}…</Typography.Text></span>
                {viewing.upstreamRef && (
                  <span>
                    外部权威：<a href={viewing.upstreamRef} target="_blank" rel="noreferrer">{viewing.upstreamRef}</a>
                  </span>
                )}
                {viewing.derivesFrom && <span>投影自：<Typography.Text code>{viewing.derivesFrom}</Typography.Text></span>}
              </Space>
            </Typography.Paragraph>
            <Input.TextArea readOnly value={prettyJson(viewing.jsonSchema)} autoSize={{ minRows: 20, maxRows: 40 }} style={{ fontFamily: "monospace", fontSize: 12 }} />
          </>
        )}
      </Drawer>

      {editor && (
        <SchemaEditor
          mode={editor.mode}
          row={editor.row}
          nextVersion={editor.row ? (latestVersion.get(editor.row.name) ?? editor.row.version) + 1 : 1}
          onClose={() => setEditor(null)}
          onDone={() => {
            setEditor(null);
            invalidate();
          }}
        />
      )}
    </PageShell>
  );
}

interface EditorValues {
  name: string;
  kind: SchemaKind;
  entity?: string;
  description?: string;
  upstreamRef?: string;
  derivesFrom?: string;
  jsonSchema: string;
}

function SchemaEditor({
  mode,
  row,
  nextVersion,
  onClose,
  onDone,
}: {
  mode: EditorMode;
  row?: SchemaRow;
  nextVersion: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form] = Form.useForm<EditorValues>();
  const values = Form.useWatch([], form);

  // The same rules the API enforces, run as you type. Not a second
  // implementation — checkSchemaContract is imported from @bcp/shared, so the
  // verdict here and the verdict on the server cannot drift.
  const problems = useMemo(() => {
    if (!values?.name || !values?.kind) return [];
    return checkSchemaContract({
      name: values.name,
      kind: values.kind,
      entity: values.entity || null,
      upstreamRef: values.upstreamRef || null,
      derivesFrom: values.derivesFrom || null,
    });
  }, [values]);

  const submit = useMutation({
    mutationFn: async (v: EditorValues) => {
      if (mode === "meta") {
        return api.updateSchema(row!.id, {
          description: v.description || null,
          entity: v.entity || null,
          upstreamRef: v.upstreamRef || null,
          derivesFrom: v.derivesFrom || null,
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(v.jsonSchema);
      } catch (e) {
        throw new Error(`jsonSchema 不是合法 JSON：${(e as Error).message}`);
      }
      return api.registerSchema({
        name: v.name,
        kind: v.kind,
        version: mode === "version" ? nextVersion : 1,
        entity: v.entity || null,
        description: v.description || null,
        upstreamRef: v.upstreamRef || null,
        derivesFrom: v.derivesFrom || null,
        jsonSchema: parsed,
      });
    },
    onSuccess: (r) => {
      message.success(`${r.name}@${r.version} 已保存`);
      onDone();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const title =
    mode === "create" ? "注册 Schema" : mode === "version" ? `${row!.name} → v${nextVersion}` : `编辑 ${row!.name}@${row!.version} 的元数据`;

  return (
    <Modal
      open
      width={760}
      title={title}
      onCancel={onClose}
      okText="保存"
      confirmLoading={submit.isPending}
      okButtonProps={{ disabled: problems.length > 0 }}
      onOk={() => form.validateFields().then((v) => submit.mutate(v))}
    >
      {mode === "meta" && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="文档本身不可修改"
          description="已经有东西按 name@version 引用了它，改内容等于改写历史。要改内容请建新版本。"
        />
      )}
      {mode === "version" && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`将注册为 v${nextVersion}`}
          description="旧版本保留且仍可解析，历史记录才能按它当初写的那份契约来读。"
        />
      )}
      {problems.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="不满足注册表的契约规则"
          description={<ul style={{ margin: 0, paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        />
      )}
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          name: row?.name ?? "",
          kind: (row?.kind as SchemaKind) ?? "entity",
          entity: row?.entity ?? undefined,
          description: row?.description ?? undefined,
          upstreamRef: row?.upstreamRef ?? undefined,
          derivesFrom: row?.derivesFrom ?? undefined,
          jsonSchema: row ? prettyJson(row.jsonSchema) : "",
        }}
      >
        <ConsoleFormSection title="基本信息" description="名称与角色定义契约的用途。">
        <div className="console-form-row console-form-row--identity">
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "必填" }, { pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/, message: "kebab-case，如 canonical-product" }]}
          >
            <Input disabled={mode !== "create"} placeholder="canonical-product" />
          </Form.Item>
          <Form.Item name="kind" label="角色" rules={[{ required: true }]}>
            <BcpSelect
              disabled={mode !== "create"}
              options={SCHEMA_KINDS.map((k) => ({ value: k, label: SCHEMA_KIND_LABELS[k] }))}
            />
          </Form.Item>
          <Form.Item name="entity" label="主题">
            <Input placeholder="product" />
          </Form.Item>
        </div>

        <Form.Item name="description" label="说明">
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} placeholder="这份契约描述什么" />
        </Form.Item>
        </ConsoleFormSection>

        <ConsoleFormSection title="契约来源" description="保留权威来源与版本引用，便于追溯。">
        <div className="console-form-row">
          <Form.Item
            name="upstreamRef"
            label="外部权威"
            tooltip="这份契约抄的是谁的定义（如平台接口文档）。中间层没有外部权威，留空。"
          >
            <Input placeholder="https://…" />
          </Form.Item>
          <Form.Item
            name="derivesFrom"
            label="投影自"
            tooltip="平台投影必填：它投影自哪个中间层，写 name 或 name@version。"
          >
            <Input placeholder="canonical-product@1" />
          </Form.Item>
        </div>
        </ConsoleFormSection>

        {mode !== "meta" && (
          <ConsoleFormSection title="结构定义">
          <Form.Item
            name="jsonSchema"
            label="JSON Schema 文档"
            rules={[
              { required: true, message: "必填" },
              {
                validator: async (_, v: string) => {
                  if (!v?.trim()) return;
                  try {
                    const parsed = JSON.parse(v);
                    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("必须是 JSON 对象");
                  } catch (e) {
                    throw new Error((e as Error).message);
                  }
                },
              },
            ]}
          >
            <Input.TextArea
              autoSize={{ minRows: 12, maxRows: 28 }}
              style={{ fontFamily: "monospace", fontSize: 12 }}
              placeholder='{ "type": "object", "properties": {} }'
              onBlur={(e) => form.setFieldValue("jsonSchema", prettyJson(e.target.value))}
            />
          </Form.Item>
          </ConsoleFormSection>
        )}
      </Form>
    </Modal>
  );
}
