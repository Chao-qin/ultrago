import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button, Space, Tag, Tooltip, Typography, message,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api } from "../lib/api";
import { ContractTag } from "../components/PayloadView";
import { hasPayload, isPreviewBrokenJson } from "../lib/schema-records";
import type { DataPreview, JsonValue, SchemaRecordRow, SchemaRecordListRow, SchemaRow } from "../lib/types";
import { PageTable } from "../components/PageTable";
import { DeletedToggle } from "../components/DeletedToggle";
import { SearchInput } from "../components/SearchInput";
import { BcpSelect } from "../components/BcpSelect";
import { formatBytes } from "../lib/format";
import { RowActions, ROW_ACTIONS_COLUMN } from "../components/RowActions";
import { PageShell } from "../components/PageShell";
import { RecordEditor } from '../components/record-editor';

const { Text } = Typography;

export function SchemaRecords() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["schema-records"] });

  const [schemaFilter, setSchemaFilter] = useState<string | undefined>();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<{ mode: "create" } | { mode: "edit"; row: SchemaRecordRow } | null>(null);
  // Which row is having its full payload fetched for the edit modal. The list
  // deliberately does not carry payload bodies, so 编辑 has to go get one.
  const [opening, setOpening] = useState<string | null>(null);

  // 加载 schema 列表供下拉选择
  const schemas = useQuery({
    queryKey: ["schemas"],
    queryFn: () => api.listSchemas(),
  });

  // No `sourcePrefix`: this page browses the whole table on purpose. It asks for
  // the preview projection because a list cell shows at most a couple of lines —
  // pulling every payload body across the wire to render 200 characters of one
  // of them is the cost this page used to pay on every poll.
  const records = useQuery({
    queryKey: ["schema-records", schemaFilter, includeDeleted],
    queryFn: () => api.listSchemaRecordPreviews({ schemaName: schemaFilter, includeDeleted }),
  });

  const createMut = useMutation({
    mutationFn: (input: { schemaName: string; schemaVersion?: number; data: JsonValue }) =>
      api.createSchemaRecord(input),
    onSuccess: () => { message.success("已创建"); setEditor(null); invalidate(); },
    onError: (e: Error) => message.error(e.message),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: JsonValue }) =>
      api.updateSchemaRecord(id, { data }),
    onSuccess: () => { message.success("已更新"); setEditor(null); invalidate(); },
    onError: (e: Error) => message.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteSchemaRecord(id),
    onSuccess: () => { message.success("已删除"); invalidate(); },
    onError: (e: Error) => message.error(e.message),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => api.restoreSchemaRecord(id),
    onSuccess: () => { message.success("已恢复"); invalidate(); },
    onError: (e: Error) => message.error(e.message),
  });

  const schemaOptions = useMemo(
    () => (schemas.data ?? []).map((s: SchemaRow) => ({ label: `${s.name}@${s.version}`, value: s.name })),
    [schemas.data],
  );

  /** 打开编辑器。列表行只带预览，拿预览当初值保存等于把一行截断成 200 字符
   *  写回去，所以载荷本体在这里单独取。 */
  const openRecord = async (row: SchemaRecordListRow) => {
    setOpening(row.id);
    try {
      setEditor({ mode: "edit", row: await api.getSchemaRecord(row.id) });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setOpening(null);
    }
  };

  const columns = [
    { title: "Schema", dataIndex: "schemaName", key: "schemaName", width: 200,
      // 这一列显示的是**契约身份**，与载荷存哪无关：超过 INLINE_OUTPUT_LIMIT 的
      // 有契约载荷落在文件支，`schemaName` 照记，所以这里照样出契约 Tag——
      // 「是不是文件」看 Data 列的下载链接，不看这一列。
      // 空 schemaName 有两种，别合并：无契约的载荷（空载荷落地时 planOutputRecord
      // 就产出这种行）与无契约的文件。判哪一种要看载荷在不在，不能看 schemaName。
      render: (v: string | null, r: SchemaRecordListRow) =>
        v ? <Tag>{v}@{r.schemaVersion}</Tag>
          : hasPayload(r) ? <Text type="secondary">无契约</Text>
          : <Tag color="default">文件</Tag> },
    { title: "类型", dataIndex: "contentType", key: "contentType", width: 160,
      render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: "Data", key: "data",
      // 判据是载荷在不在（`dataPreview`），不是 `schemaName`。理由见
      // lib/schema-records.ts 的 hasPayload。
      render: (_: unknown, row: SchemaRecordListRow) =>
        hasPayload(row)
          ? <PayloadPreview preview={row.dataPreview} broken={isPreviewBrokenJson(row)} />
          : <FileCell row={row} /> },
    { title: "契约", key: "contract", width: 140,
      // 空单元格 = 没有契约可查，不是「查过了没问题」。红标是这一列存在的理由：
      // 收录时的宽松策略让违约行照样入库，不标出来就等于默默接受脏数据。
      render: (_: unknown, row: SchemaRecordListRow) => <ContractTag errors={row.schemaErrors} /> },
    { title: "体积", dataIndex: "bytes", key: "bytes", width: 100,
      render: (v: number) => <Text type="secondary">{formatBytes(v)}</Text> },
    { title: "溯源", dataIndex: "source", key: "source", width: 220, ellipsis: true,
      render: (v: string | null) =>
        v ? <Tooltip title={v}><Text code style={{ fontSize: 12 }}>{v}</Text></Tooltip>
          : <Text type="secondary">手工</Text> },
    { title: "创建时间", dataIndex: "createdAt", key: "createdAt", width: 180,
      render: (v: string) => new Date(v).toLocaleString() },
    { ...ROW_ACTIONS_COLUMN, width: 140,
      render: (_: unknown, row: SchemaRecordListRow) => (
        <RowActions
          actions={row.deletedAt ? [
            { key: "restore", label: "恢复", confirm: { title: "恢复此记录？" }, onClick: () => restoreMut.mutate(row.id) },
          ] : [
            // 只有载荷支能编辑。PATCH 写的是 `data`，而文件支的载荷是盘上的字节，
            // 给它写 data 会撞上「data 与 url 恰好一支非空」的 CHECK 约束。判据同
            // Data 列，不是 `schemaName`：一行有载荷但没契约名时 PATCH 照样受理
            // （update() 只在 schemaName 非空时才校验契约），按 schemaName 藏按钮
            // 等于凭空取消一行可编辑记录的编辑入口。
            hasPayload(row) && { key: "edit", label: "编辑", loading: opening === row.id, onClick: () => void openRecord(row) },
            {
              key: "delete",
              label: "删除",
              danger: true,
              confirm: { title: "删除这条记录？", description: "可在「含已删除」里恢复" },
              onClick: () => deleteMut.mutate(row.id),
            },
          ]}
        />
      ),
    },
  ];

  return (
    // Fixed-height flex column (page-fill): the toolbar stays pinned and the
    // table body scrolls internally — no more double padding either.
    <PageShell
      title="Schema 数据"
      subtitle="契约支与文件支的落地记录；文件支由 run 产出写入"
      actions={
        <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} onClick={() => setEditor({ mode: "create" })}>新增记录</Button>
      }
      filters={
        <>
          <SearchInput value={search} onChange={setSearch} placeholder="搜索 Schema / 溯源…" />
          <BcpSelect
            allowClear placeholder="按 Schema 筛选" style={{ width: 220 }}
            options={schemaOptions} value={schemaFilter} onChange={setSchemaFilter}
          />
          <DeletedToggle checked={includeDeleted} onChange={setIncludeDeleted} />
        </>
      }
    >
      <PageTable
        rowKey="id" size="middle" query={records}
        empty={{ title: "还没有 Schema 数据", description: "运行产出的载荷与文件会落在这里。" }}
        dataSource={(records.data ?? []).filter((r) => {
          const q = search.trim().toLowerCase();
          if (!q) return true;
          return (
            (r.schemaName ?? "").toLowerCase().includes(q) ||
            (r.source ?? "").toLowerCase().includes(q)
          );
        })}
        columns={columns} pagination={{ pageSize: 20 }}
      />
      <RecordEditor
        mode={editor?.mode ?? null} row={editor && "row" in editor ? editor.row : undefined}
        schemaRows={schemas.data ?? []}
        onCancel={() => setEditor(null)}
        onSubmit={(input) => {
          if (editor?.mode === "create") createMut.mutate(input);
          else if (editor?.mode === "edit" && editor.row) updateMut.mutate({ id: editor.row.id, data: input.data });
        }}
        loading={createMut.isPending || updateMut.isPending}
      />
    </PageShell>
  );
}

/** The payload branch's preview. Full text lives behind 编辑 — a list cell that
 *  grows with the payload stops being a list.
 *
 *  Rendered raw, NOT pretty-printed: what arrives may be the head of a payload,
 *  and the head of a JSON document is not itself JSON. The 非法 JSON marker is
 *  therefore decided upstream by `isPreviewBrokenJson`, which only speaks when
 *  the preview is the whole payload; a truncated one gets no verdict rather
 *  than the truncation reported as a defect in the data. */
function PayloadPreview({ preview, broken }: { preview: DataPreview; broken: boolean }) {
  if (broken) {
    return (
      <Space size={6} wrap>
        <Text type="danger" style={{ fontSize: 12 }}>非法 JSON</Text>
        <Text code delete style={{ fontSize: 12 }}>{preview.head}</Text>
      </Space>
    );
  }
  // "" is a payload that is empty, not a payload that is absent — the latter is
  // the file branch and never reaches here. Marking it keeps the two apart.
  if (preview.head === "") return <Text type="secondary">（空载荷）</Text>;
  return (
    <Text code style={{ fontSize: 12, maxHeight: 80, overflow: "hidden", display: "block", whiteSpace: "pre-wrap" }}>
      {preview.truncated ? `${preview.head}…` : preview.head}
    </Text>
  );
}

/** The file branch's payload: a name and a way to fetch it.
 *
 *  `bytes === 0` rows are dead links — the row remembers a file name but no
 *  bytes were ever written, so `GET /api/records/<fileName>` 404s. (All four
 *  such rows in the current database do exactly that; every row with bytes > 0
 *  resolves.) They render as plain text plus a warning rather than as an anchor:
 *  a download link that 404s reports the row as healthy and pushes the discovery
 *  one click further away. The row is still shown — it is real state, and hiding
 *  it would just make the count not add up. */
function FileCell({ row }: { row: SchemaRecordListRow }) {
  if (!row.fileName) return <Text type="secondary">—</Text>;
  if (row.bytes === 0) {
    return (
      <Space size={6} wrap>
        <Text delete type="secondary" style={{ fontSize: 12 }}>{row.fileName}</Text>
        <Tooltip title="库里记着文件名，但落盘字节数为 0，下载会 404">
          <Tag color="red">文件缺失</Tag>
        </Tooltip>
      </Space>
    );
  }
  return <a href={row.url ?? undefined} download>{row.fileName}</a>;
}
