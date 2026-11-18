import { useEffect, useState } from 'react';
import { Button, Input, InputNumber, Popconfirm, Popover, Switch } from 'antd';
import { ChevronDown, ChevronRight, Info, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { JsonEditor } from './JsonEditorLazy';
import { RecordEditorEnum } from './record-editor-enum';
import { editorEnumOptions } from '../lib/record-editor-presentation';
import { editorDefault, equalValues, getValue, isObject, pointer, resolveEditorSchema, schemaFields, valueSummary } from '../lib/record-editor-model';
import type { EditorIssue, EditorPath, EditorResolver, EditorSchema } from '../lib/record-editor-model';

export type RecordFieldProps = {
  schema: EditorSchema;
  root: EditorSchema;
  resolver: EditorResolver;
  path: EditorPath;
  label: string;
  value: unknown;
  original: unknown;
  required?: boolean;
  disabled?: boolean;
  showDescriptions?: boolean;
  focusPath: string | null;
  issues: EditorIssue[];
  drafts: Record<string, string>;
  onChange: (path: EditorPath, value: unknown) => void;
  onDraft: (path: EditorPath, raw: string) => void;
};

export function RecordEditorField(props: RecordFieldProps) {
  const { root, resolver, path, label, value, original, required, focusPath, issues, drafts, onChange, onDraft } = props;
  const schema = resolveEditorSchema(props.schema, root, resolver);
  const disabled = props.disabled || schema.readOnly === true;
  const id = pointer(path);
  const ui = isObject(schema['x-ui']) ? schema['x-ui'] : {};
  const [open, setOpen] = useState(ui.advanced !== true);
  useEffect(() => {
    if (focusPath === id || focusPath?.startsWith(`${id}/`)) setOpen(true);
  }, [focusPath, id]);
  const changed = !equalValues(value, original);
  const title = typeof schema.title === 'string' ? schema.title : label;
  const description = typeof schema.description === 'string' ? schema.description : '';
  const errors = issues.filter((issue) => pointer(issue.path) === id);
  const type = schema.type;
  const fields = schemaFields(schema, root, resolver);
  const complex = schema.oneOf || schema.anyOf || (schema.allOf && !schema.properties) || schema.$ref || schema['x-bcp-schema-ref'] || path.length > 12;
  const object = !complex && (type === 'object' || (!type && schema.properties)) && fields.length > 0 && (value === undefined || isObject(value));
  const array = !complex && type === 'array' && (value === undefined || Array.isArray(value)) && !schema.prefixItems;
  const section = object || array;
  const fieldGroups = fields.reduce<{ section: boolean; fields: typeof fields }[]>((groups, field) => {
    const child = resolveEditorSchema(field.schema, root, resolver);
    const grouped = child.type === 'object' || child.type === 'array' || !!child.properties;
    const last = groups[groups.length - 1];
    if (last?.section === grouped) last.fields.push(field);
    else groups.push({ section: grouped, fields: [field] });
    return groups;
  }, []);
  const branch = object && fieldGroups.some((group) => group.section);
  const fieldId = `record-field-${encodeURIComponent(id)}`;
  const enumOptions = editorEnumOptions(schema);
  const wide = !section && !enumOptions && (complex || !['string', 'number', 'integer', 'boolean'].includes(String(type)) || ui.widget === 'textarea');
  const scalarMismatch = value !== undefined && (
    (type === 'string' && typeof value !== 'string') ||
    ((type === 'number' || type === 'integer') && typeof value !== 'number') ||
    (type === 'boolean' && typeof value !== 'boolean')
  );
  const fieldHeader = <>
    <span className="record-field__name">{title}{required && <span className="record-field__required" aria-label="必填">*</span>}</span>
    {title !== label && <code className="record-field__key">{label}</code>}
    {changed && <span className="record-field__modified">已修改</span>}
    {schema.readOnly === true && <span className="record-field__key">只读</span>}
  </>;
  const reset = changed && !disabled ? <Button type="text" size="small" icon={<RotateCcw size={13} />} title={`恢复 ${title}`} aria-label={`恢复 ${title}`} onClick={() => onChange(path, original)} /> : null;
  const content = object ? <>
    {fieldGroups.map((group) => <div className={group.section ? 'record-field-groups' : 'record-fields'} key={group.fields[0].key}>
      {group.fields.map((field) => <RecordEditorField {...props} key={field.key} schema={field.schema} path={[...path, field.key]} label={field.key}
        value={getValue(value, [field.key])} original={getValue(original, [field.key])} disabled={disabled}
        required={Array.isArray(schema.required) && schema.required.includes(field.key)} />)}
    </div>)}
    {isObject(value) && Object.keys(value).some((key) => !fields.some((field) => field.key === key)) && <p className="record-field__hint">包含未在 Schema 声明的字段，已保留；可在 JSON 模式查看和编辑。</p>}
  </> : array ? <div className="record-array">
    {(!(value as unknown[] | undefined)?.length) && <div className="record-array__empty">暂无条目，添加第一项开始配置。</div>}
    {(Array.isArray(value) ? value : []).map((entry, index) => <div className="record-array__item" key={index}>
      <div className="record-array__bar"><span className="record-array__number">{String(index + 1).padStart(2, '0')}</span><span>{valueSummary(entry)}</span>
        {!disabled && <Popconfirm title="删除此条目？" description="保存前可恢复整个数组。" onConfirm={() => onChange(path, (value as unknown[]).filter((_, i) => i !== index))}>
          <Button type="text" danger size="small" aria-label={`删除第 ${index + 1} 项`} icon={<Trash2 size={14} />} />
        </Popconfirm>}
      </div>
      <RecordEditorField {...props} schema={isObject(schema.items) ? schema.items : {}} path={[...path, index]} label={`第 ${index + 1} 项`} value={entry} original={getValue(original, [index])} disabled={disabled} />
    </div>)}
    {!disabled && <Button type="dashed" block icon={<Plus size={14} />} onClick={() => {
      const item = isObject(schema.items) ? schema.items : {};
      const resolved = resolveEditorSchema(item, root, resolver);
      const initial = editorDefault(item, root, resolver) ?? (resolved.type === 'string' ? '' : resolved.type === 'boolean' ? false : resolved.type === 'number' || resolved.type === 'integer' ? 0 : null);
      onChange(path, [...(Array.isArray(value) ? value : []), initial]);
    }}>添加条目</Button>}
  </div> : <>
    {enumOptions ? <RecordEditorEnum id={fieldId} options={enumOptions} value={value} disabled={disabled} showDescriptions={props.showDescriptions} invalid={errors.length > 0} onChange={(next) => onChange(path, next)} />
      : !complex && !scalarMismatch && type === 'boolean' ? <div className="record-field__switch"><Switch id={fieldId} checked={value === true} disabled={disabled} onChange={(next) => onChange(path, next)} /><span>{value === undefined ? '未设置' : value ? '已启用' : '已关闭'}</span>{value !== undefined && !disabled && <Button size="small" type="link" onClick={() => onChange(path, undefined)}>清除</Button>}</div>
      : !complex && !scalarMismatch && (type === 'number' || type === 'integer') ? <InputNumber id={fieldId} aria-describedby={`${fieldId}-help`} aria-invalid={errors.length > 0} value={typeof value === 'number' ? value : null} disabled={disabled} style={{ width: '100%' }} step={type === 'integer' ? 1 : undefined} placeholder="请输入数值" onChange={(next) => onChange(path, next ?? undefined)} />
      : !complex && !scalarMismatch && type === 'string' ? <Input.TextArea id={fieldId} aria-describedby={`${fieldId}-help`} aria-invalid={errors.length > 0} value={typeof value === 'string' ? value : ''} disabled={disabled} autoSize={{ minRows: ui.widget === 'textarea' ? 3 : 1, maxRows: 10 }} placeholder={typeof ui.placeholder === 'string' ? ui.placeholder : '请输入'} onChange={(event) => onChange(path, event.target.value)} />
      : <><span className="record-field__hint">JSON 值</span><JsonEditor ariaLabel={title} value={drafts[id] ?? JSON.stringify(value ?? null, null, 2)} expected="any" height={160} readOnly={disabled} onChange={(raw) => onDraft(path, raw)} /></>}
  </>;
  return <section data-record-path={id} tabIndex={-1} className={`record-field ${section ? 'record-field--section' : ''} ${branch ? 'record-field--branch' : ''} ${enumOptions || type === 'number' || type === 'integer' || type === 'boolean' ? 'record-field--compact' : ''} ${wide ? 'record-field--wide' : ''} ${changed ? 'record-field--changed' : ''} ${errors.length ? 'record-field--error' : ''} ${focusPath === id ? 'record-field--focused' : ''}`}>
    <div className="record-field__header">
      {section ? <button type="button" className="record-field__toggle" aria-expanded={open} aria-controls={`${fieldId}-body`} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}{fieldHeader}<span className="record-field__summary">{valueSummary(value)}</span></button>
        : <label htmlFor={fieldId} className="record-field__label" title={label}>{fieldHeader}</label>}
      {(description || enumOptions) && <Popover trigger="click" placement="bottom" title={`${title}${enumOptions ? ' · 取值说明' : ' · 字段说明'}`} content={<div className="record-field-help">
        {description && <p>{description}</p>}
        {enumOptions && <table><thead><tr><th>原始值</th><th>含义与说明</th></tr></thead><tbody>{enumOptions.map((option, index) => <tr key={index}><td><code>{option.raw}</code></td><td><strong>{option.label}</strong><p>{option.description || '尚未提供逐值说明。'}</p></td></tr>)}</tbody></table>}
      </div>}><Button className="record-field__help-button" type="text" size="small" icon={<Info size={14} />} aria-label={`查看 ${title} 的${enumOptions ? '取值' : '字段'}说明`} /></Popover>}
      {reset}
    </div>
    {description && <p id={`${fieldId}-help`} className={`record-field__description ${props.showDescriptions ? '' : 'record-field__description--hidden'}`}>{description}</p>}
    <div id={`${fieldId}-body`} hidden={section && !open}>{content}</div>
    {errors.map((issue, index) => <p className="record-field__error" role="alert" key={index}>{issue.message}</p>)}
  </section>;
}
