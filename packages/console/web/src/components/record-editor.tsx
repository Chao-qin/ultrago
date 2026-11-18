import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Drawer, Empty, Input, Modal, Segmented, Select, Tag, Tooltip } from 'antd';
import { AlertCircle, ArrowRight, Check, FileJson, LayoutList, ListFilter, Search, SlidersHorizontal, Info, Maximize2, Minimize2 } from 'lucide-react';
import { schemaLookup } from '../lib/flow-ports-client';
import { presentRecordSchema } from '../lib/record-editor-presentation';
import { diffValues, editorDefault, fieldIndex, getValue, isObject, parseDraft, pointer, schemaFields, setValue, submissionData, validateEditorData, valueSummary } from '../lib/record-editor-model';
import type { EditorIssue, EditorPath, EditorSchema } from '../lib/record-editor-model';
import type { JsonValue, SchemaRecordRow, SchemaRow } from '../lib/types';
import { JsonEditor } from './JsonEditorLazy';
import { RecordEditorField } from './record-editor-field';
import './record-editor.css';

type RecordEditorProps = {
  mode: 'create' | 'edit' | null;
  row?: SchemaRecordRow;
  schemaRows: SchemaRow[];
  onCancel: () => void;
  onSubmit: (input: { schemaName: string; schemaVersion?: number; data: JsonValue }) => void;
  loading: boolean;
};

export function RecordEditor(props: RecordEditorProps) {
  return props.mode ? <RecordEditorSession key={props.row?.id ?? 'create'} {...props} /> : null;
}

function RecordEditorSession({ mode, row, schemaRows, onCancel, onSubmit, loading }: RecordEditorProps) {
  const editing = mode === 'edit';
  const initialRaw = editing ? row?.data ?? '' : '{}';
  const initial = useMemo(() => parseDraft(initialRaw), [initialRaw]);
  const original = initial.ok ? initial.value : undefined;
  const [data, setData] = useState<unknown>(original ?? (initial.ok ? initial.value : {}));
  const [raw, setRaw] = useState(initial.ok ? JSON.stringify(initial.value, null, 2) : initialRaw);
  const [view, setView] = useState<'form' | 'json'>(initial.ok && schemaRows.some((item) => item.name === row?.schemaName && item.version === row?.schemaVersion) ? 'form' : 'json');
  const [selected, setSelected] = useState(row?.schemaName ? `${row.schemaName}@${row.schemaVersion}` : '');
  const [search, setSearch] = useState('');
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [showDescriptions, setShowDescriptions] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirm, confirmContext] = Modal.useModal();
  const contentRef = useRef<HTMLDivElement>(null);
  const schemaRow = schemaRows.find((item) => `${item.name}@${item.version}` === selected);
  const schema = useMemo<EditorSchema | null>(() => {
    if (!schemaRow) return null;
    const parsed = parseDraft(schemaRow.jsonSchema);
    return parsed.ok && isObject(parsed.value) ? presentRecordSchema(parsed.value, schemaRow.name, schemaRow.version) : null;
  }, [schemaRow]);
  const resolver = useMemo(() => schemaLookup(schemaRows.map((item) => {
    const parsed = parseDraft(item.jsonSchema);
    if (!parsed.ok || !isObject(parsed.value)) return item;
    const presented = presentRecordSchema(parsed.value, item.name, item.version);
    return presented === parsed.value ? item : { ...item, jsonSchema: JSON.stringify(presented) };
  })), [schemaRows]);
  const jsonResult = parseDraft(raw);
  const changes = useMemo(() => diffValues(original, data), [original, data]);
  const draftErrors: EditorIssue[] = Object.entries(drafts).flatMap(([key, value]) => {
    const parsed = parseDraft(value);
    return parsed.ok ? [] : [{ path: key === '/' ? [] : key.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')), message: `JSON 格式无效：${parsed.error}` }];
  });
  const issues = useMemo(() => validateEditorData(schema, data, resolver), [schema, data, resolver]);
  const allIssues = [...draftErrors, ...issues];
  const jsonInvalid = view === 'json' && !jsonResult.ok;
  const dirty = changes.length > 0 || (view === 'json' && raw !== (initial.ok ? JSON.stringify(initial.value, null, 2) : initialRaw)) || Object.keys(drafts).length > 0 || (!editing && selected !== '');
  const fields = useMemo(() => schema ? fieldIndex(schema, schema, data, resolver) : [], [schema, data, resolver]);
  const rootFields = schema ? schemaFields(schema, schema, resolver) : [];
  const structuredRoot = schema && rootFields.length > 0 && !schema.oneOf && !schema.anyOf && (data === undefined || isObject(data));
  const query = search.trim().toLowerCase();
  const results = query ? fields.filter((field) => `${field.label} ${pointer(field.path)} ${field.description}`.toLowerCase().includes(query)) : [];

  useEffect(() => {
    if (!dirty) return;
    const handle = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handle);
    return () => window.removeEventListener('beforeunload', handle);
  }, [dirty]);

  const update = (path: EditorPath, value: unknown) => {
    setData((current: unknown) => setValue(current, path, value));
    const id = pointer(path);
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id && !key.startsWith(`${id === '/' ? '' : id}/`))));
  };
  const editDraft = (path: EditorPath, text: string) => {
    const parsed = parseDraft(text);
    setDrafts((current) => ({ ...current, [pointer(path)]: text }));
    if (parsed.ok) setData((current: unknown) => setValue(current, path, parsed.value));
  };
  const requestClose = () => {
    if (loading) return;
    if (!dirty) { onCancel(); return; }
    confirm.confirm({ title: '放弃未保存的更改？', content: '关闭后，当前修改将不会保存。', okText: '放弃更改', cancelText: '继续编辑', okButtonProps: { danger: true }, onOk: onCancel });
  };
  const switchView = (next: 'form' | 'json') => {
    if (next === view) return;
    if (next === 'form') {
      if (!jsonResult.ok) { setShowErrors(true); return; }
      setData(jsonResult.value);
      setDrafts({});
    } else {
      if (draftErrors.length) { setShowErrors(true); return; }
      setRaw(JSON.stringify(data, null, 2) ?? 'null');
    }
    setView(next);
  };
  const locate = (path: EditorPath) => {
    if (jsonInvalid || draftErrors.length && view === 'json') return;
    if (view === 'json') switchView('form');
    const id = pointer(path);
    setFocusPath(id);
    window.setTimeout(() => {
      const nodes = contentRef.current?.querySelectorAll<HTMLElement>('[data-record-path]');
      let node = Array.from(nodes ?? []).find((item) => item.dataset.recordPath === id);
      if (!node) node = Array.from(nodes ?? []).find((item) => id.startsWith(`${item.dataset.recordPath}/`));
      if (node) {
        node.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        (node.querySelector<HTMLElement>('input, textarea, button, [role="switch"]') ?? node).focus({ preventScroll: true });
      }
    }, 80);
  };
  const save = () => {
    setShowErrors(true);
    if (loading || jsonInvalid || draftErrors.length || (!editing && !schemaRow)) return;
    const value = view === 'json' && jsonResult.ok ? jsonResult.value : data;
    const errors = validateEditorData(schema, value, resolver);
    if (errors.length) { if (view === 'form') locate(errors[0].path); return; }
    const normalized = parseDraft(JSON.stringify(value) ?? '');
    if (!normalized.ok) return;
    onSubmit({ schemaName: row?.schemaName ?? schemaRow?.name ?? '', schemaVersion: row?.schemaVersion ?? schemaRow?.version, data: submissionData(normalized.value) });
  };
  const changeSchema = (next: string) => {
    const apply = () => {
      setSelected(next);
      const target = schemaRows.find((item) => `${item.name}@${item.version}` === next);
      const parsed = target ? parseDraft(target.jsonSchema) : null;
      setView(parsed?.ok && isObject(parsed.value) ? 'form' : 'json');
      const value = parsed?.ok && isObject(parsed.value) ? editorDefault(parsed.value, parsed.value, resolver) ?? {} : {};
      setData(value); setRaw(JSON.stringify(value, null, 2)); setDrafts({}); setShowErrors(false); setFocusPath(null); setSearch('');
    };
    if (dirty) confirm.confirm({ title: '切换 Schema 并重置当前内容？', content: '将使用新 Schema 的默认值，当前草稿会被替换。', okText: '切换并重置', cancelText: '保留草稿', onOk: apply });
    else apply();
  };
  const status = jsonInvalid ? 'JSON 格式待修正' : draftErrors.length ? `${draftErrors.length} 处 JSON 待修正` : issues.length ? `${issues.length} 项待修正` : schema ? '已通过本地校验' : '未加载 Schema，保存时由服务端校验';
  return <>
    {confirmContext}
    <Modal open title={editing ? '编辑记录' : '新增记录'} classNames={{ header: 'record-editor__accessible-header' }} footer={null} onCancel={requestClose} width={maximized ? 'calc(100vw - 12px)' : 'min(1480px, calc(100vw - 24px))'} className={`record-editor-modal ${maximized ? 'record-editor-modal--maximized' : ''}`} centered maskClosable={false} closable={!loading} keyboard={!loading}>
      <div className="record-editor">
        <header className="record-editor__header">
          <div className="record-editor__icon"><SlidersHorizontal size={22} /></div>
          <div className="record-editor__heading"><div className="record-editor__eyebrow">SCHEMA 数据 · {editing ? '编辑记录' : '新增记录'}</div><h2 id="record-editor-title">{editing ? valueSummary(isObject(original) && typeof original.configId === 'string' ? original.configId : row?.schemaName ?? '记录内容') : '创建配置记录'}</h2>
            <div className="record-editor__meta">{editing ? <><span>{row?.schemaName ?? '无契约记录'}</span>{row?.schemaVersion != null && <Tag>v{row.schemaVersion}</Tag>}<span className="record-editor__local">更改仅在保存后生效</span></> : <Select aria-label="选择 Schema 和版本" value={selected || undefined} placeholder="选择 Schema 和版本" showSearch optionFilterProp="label" disabled={loading} onChange={changeSchema} options={schemaRows.filter((item) => !item.deletedAt && item.active).map((item) => ({ value: `${item.name}@${item.version}`, label: `${item.name} · v${item.version}` }))} style={{ minWidth: 260, maxWidth: '100%' }} />}</div>
          </div>
          <div className="record-editor__tools">
            <Tooltip title={showDescriptions ? '收起完整字段说明' : '展开完整字段说明'}><Button type="text" className="record-editor__description-toggle" icon={<Info size={15} />} aria-label="展开字段说明" aria-pressed={showDescriptions} onClick={() => setShowDescriptions(!showDescriptions)}>说明</Button></Tooltip>
            <Segmented aria-label="编辑模式" value={view} disabled={loading} options={[{ value: 'form', label: <span className="record-editor__mode"><LayoutList size={14} />表单</span>, disabled: !schema }, { value: 'json', label: <span className="record-editor__mode"><FileJson size={14} />JSON</span> }]} onChange={(next) => switchView(next as 'form' | 'json')} />
            <Tooltip title={maximized ? '还原窗口' : '最大化编辑器'}><Button type="text" icon={maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />} aria-label={maximized ? '还原窗口' : '最大化编辑器'} onClick={() => setMaximized(!maximized)} /></Tooltip>
          </div>
        </header>
        <div className="record-editor__workspace">
          <aside className="record-editor__sidebar">
            <Input aria-label="搜索字段" prefix={<Search size={14} />} allowClear placeholder="搜索名称、字段、说明…" value={search} onChange={(event) => setSearch(event.target.value)} />
            <div className="record-editor__nav-title">{query ? `搜索结果 · ${results.length}` : '配置目录'}<ListFilter size={13} /></div>
            <nav aria-label="配置目录">{(query ? results : structuredRoot ? rootFields.map((field) => ({ path: [field.key], label: field.label, description: '' })) : [{ path: [], label: '配置内容', description: '' }]).map((field, index) => {
              const id = pointer(field.path);
              const modified = changes.some((change) => pointer(change.path) === id || pointer(change.path).startsWith(`${id}/`));
              const hasError = showErrors && allIssues.some((issue) => pointer(issue.path) === id || pointer(issue.path).startsWith(`${id}/`));
              return <button type="button" key={id} disabled={loading || jsonInvalid} className={`record-editor__nav-item ${focusPath === id ? 'is-active' : ''}`} onClick={() => locate(field.path)}><span className="record-editor__nav-number">{String(index + 1).padStart(2, '0')}</span><span>{field.label}{query && <small>{id}</small>}</span>{hasError ? <span className="record-editor__error-dot" aria-label="有错误">!</span> : modified ? <span className="record-editor__change-dot" aria-label="已修改" /> : null}</button>;
            })}{query && !results.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未找到匹配字段" />}</nav>
            <div className="record-editor__sidebar-note">{fields.length} 个可检索字段<br />{changes.length ? `${changes.length} 项更改尚未保存` : '选择分区，快速定位配置'}</div>
          </aside>
          <main className="record-editor__content" ref={contentRef}>
            {showErrors && !editing && !schemaRow && <Alert type="error" showIcon title="请选择要创建记录的 Schema 和版本。" />}
            {!schema && <Alert type="info" showIcon title={editing ? '当前 Schema 未加载，可使用 JSON 编辑完整内容。' : '先选择 Schema，或在 JSON 中准备配置内容。'} />}
            {jsonInvalid && <Alert type="error" showIcon title="JSON 格式无效" description="草稿已保留。修正格式后才能切换到表单或保存。" />}
            {showErrors && allIssues.length > 0 && <div className="record-editor__errors" role="alert"><strong>请修正以下 {allIssues.length} 项</strong>{allIssues.map((issue, index) => <button type="button" key={index} onClick={() => locate(issue.path)}>{pointer(issue.path)} · {issue.message}<ArrowRight size={13} /></button>)}</div>}
            {view === 'json' || !schema ? <div className="record-editor__json"><h3>完整配置</h3><p>支持对象、数组及基础 JSON 值。切换视图会保留当前更改。</p><JsonEditor ariaLabel="完整配置 JSON" value={raw} expected="any" height={430} readOnly={loading} onChange={(next) => { setRaw(next); const parsed = parseDraft(next); if (parsed.ok) setData(parsed.value); }} /></div>
              : <div className="record-editor__sections">{structuredRoot && isObject(data) && Object.keys(data).some((key) => !rootFields.some((field) => field.key === key)) && <Alert type="info" showIcon title="未声明的字段已保留，可在 JSON 模式中查看和编辑。" />}{(structuredRoot ? rootFields : [{ key: '', label: typeof schema.title === 'string' ? schema.title : '配置内容', schema }]).map((field) => <RecordEditorField key={field.key} schema={field.schema} root={schema} resolver={resolver} path={field.key ? [field.key] : []} label={field.key || field.label}
                value={field.key ? getValue(data, [field.key]) : data} original={field.key ? getValue(original, [field.key]) : original}
                required={Array.isArray(schema.required) && schema.required.includes(field.key)} showDescriptions={showDescriptions} disabled={loading} focusPath={focusPath} issues={showErrors ? allIssues : draftErrors} drafts={drafts} onChange={update} onDraft={editDraft} />)}</div>}
          </main>
        </div>
        <footer className="record-editor__footer"><div className="record-editor__status" aria-live="polite"><span className={jsonInvalid || allIssues.length ? 'record-editor__status-warn' : schema ? 'record-editor__status-ok' : ''}>{jsonInvalid || allIssues.length ? <AlertCircle size={14} /> : schema ? <Check size={14} /> : <FileJson size={14} />}{status}</span><span>{changes.length ? `已修改 ${changes.length} 项` : '尚无数据更改'}</span></div><div className="record-editor__actions"><Button onClick={requestClose} disabled={loading}>取消</Button><Button onClick={() => setShowChanges(true)} disabled={!changes.length || loading}>查看变更{changes.length ? ` (${changes.length})` : ''}</Button><Tooltip title={jsonInvalid || draftErrors.length ? '请先修正 JSON 格式' : undefined}><Button type="primary" loading={loading} disabled={jsonInvalid || draftErrors.length > 0 || (editing && !dirty)} onClick={save}>{editing ? '保存更改' : '创建记录'}</Button></Tooltip></div></footer>
      </div>
    </Modal>
    <Drawer title={`变更对比 · ${changes.length} 项`} open={showChanges} onClose={() => setShowChanges(false)} width={620} className="record-editor-changes">
      {!changes.length && <Empty description="暂无更改" />}{changes.map((change) => <section className="record-change" key={pointer(change.path)}><header><code>{pointer(change.path)}</code><Button size="small" disabled={loading || view === 'json'} onClick={() => update(change.path, change.before)}>恢复此项</Button></header><div className="record-change__values"><div><span>原值</span><pre>{JSON.stringify(change.before, null, 2) ?? '未设置'}</pre></div><div><span>当前值</span><pre>{JSON.stringify(change.after, null, 2) ?? '未设置'}</pre></div></div></section>)}
      {view === 'json' && <p>切换到表单后可逐项恢复，避免覆盖 JSON 草稿。</p>}
    </Drawer>
  </>;
}
