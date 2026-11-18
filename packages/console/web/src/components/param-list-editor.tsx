import { useEffect, useState } from 'react';
import { Button, Input, InputNumber, Modal, Space, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { ParamSchemaFragment, ParamSpec } from '@bcp/shared';
import type { SchemaRow } from '../lib/types';
import { paramsOfSchema } from '../lib/flow-editor-model';
import { parseContractDefault, replaceObjectFields } from '../lib/script-contract';
import { ArrayItemTypeSelect, FieldTypeSelect, SchemaFieldMeta, isArrayField } from './SchemaSelect';

export function ParamListEditor({
  params,
  onChange,
  schemas,
  title = '流程参数',
  namePlaceholder = '参数名',
  addLabel = '添加参数',
  hint = '每个参数会成为本节点的一个输出端口，触发流程时按名字填值',
}: {
  params: ParamSpec[];
  onChange: (next: ParamSpec[]) => void;
  schemas: SchemaRow[];
  title?: string;
  namePlaceholder?: string;
  addLabel?: string;
  hint?: string;
}): JSX.Element {
  const patch = (index: number, next: Partial<ParamSpec>) =>
    onChange(params.map((param, current) => (current === index ? { ...param, ...next } : param)));
  return (
    <div>
      <Typography.Text type='secondary'>{title}</Typography.Text>
      <Space direction='vertical' size={6} style={{ width: '100%', marginTop: 4 }}>
        {params.map((param, index) => (
          <div key={index} className='contract-field-editor'>
            <div className='contract-field-controls'>
              <Input className='contract-field-name' placeholder={namePlaceholder} value={param.name} status={!param.name.trim() ? 'error' : undefined} onChange={(event) => patch(index, { name: event.target.value })} />
              <div className='contract-field-type'>
                <FieldTypeSelect style={{ width: '100%' }} schemas={schemas} value={param} onChange={(next) => patch(index, next)} />
              </div>
              <Button className='contract-field-required' type={param.required ? 'primary' : 'default'} onClick={() => patch(index, { required: !param.required })} title={param.required ? '必填（点击改为可选）' : '可选（点击改为必填）'}>{param.required ? '必填' : '可选'}</Button>
              <Button danger className='contract-field-delete' aria-label={`删除字段：${param.name || '未命名'}`} icon={<DeleteOutlined />} onClick={() => Modal.confirm({ title: `删除字段「${param.name || '未命名'}」？`, content: '使用这个字段的代码或连线可能需要同步修改。', okText: '删除', okType: 'danger', cancelText: '取消', onOk: () => onChange(params.filter((_, current) => current !== index)) })} />
            </div>
            {isArrayField(param) && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0 0 4px' }}>
                <Typography.Text type='secondary' style={{ fontSize: 11, flexShrink: 0 }}>元素类型</Typography.Text>
                <ArrayItemTypeSelect style={{ flex: 1, minWidth: 0 }} schemas={schemas} value={param} onChange={(next) => patch(index, next)} />
              </span>
            )}
            {param.schemaRef && <SchemaFieldMeta schemas={schemas} refValue={param.schemaRef} />}
            {Array.isArray(param.schema?.enum) && (
              <Input size='small' style={{ margin: '4px 0 0 4px', width: 'calc(100% - 4px)' }} value={param.schema.enum.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join(', ')} placeholder='枚举值，用逗号分隔' onChange={(event) => patch(index, { schema: { ...param.schema, type: param.schema?.type ?? 'string', enum: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) } })} />
            )}
            {!param.schemaRef && (
              <details className='contract-field-details'>
                <summary>说明、默认值与约束</summary>
                <Input
                  size='small'
                  value={typeof param.schema?.title === 'string' ? param.schema.title : ''}
                  placeholder='显示名称'
                  onChange={(event) => patch(index, { schema: withSchemaValue(param.schema, 'title', event.target.value || undefined) })}
                />
                <Input size='small' value={param.description ?? ''} placeholder='这个参数的用途' onChange={(event) => patch(index, { description: event.target.value || undefined })} />
                {(param.schema?.type === 'string' || Array.isArray(param.schema?.enum)) && (
                  <>
                    <Space.Compact block>
                      <InputNumber
                        size='small'
                        min={0}
                        precision={0}
                        value={numberValue(param.schema?.minLength)}
                        placeholder='最小长度'
                        onChange={(value) => patch(index, { schema: withSchemaValue(param.schema, 'minLength', value ?? undefined) })}
                      />
                      <InputNumber
                        size='small'
                        min={0}
                        precision={0}
                        value={numberValue(param.schema?.maxLength)}
                        placeholder='最大长度'
                        onChange={(value) => patch(index, { schema: withSchemaValue(param.schema, 'maxLength', value ?? undefined) })}
                      />
                    </Space.Compact>
                    <Input
                      size='small'
                      value={typeof param.schema?.pattern === 'string' ? param.schema.pattern : ''}
                      placeholder='匹配规则（正则表达式）'
                      onChange={(event) => patch(index, { schema: withSchemaValue(param.schema, 'pattern', event.target.value || undefined) })}
                    />
                    <Input
                      size='small'
                      value={typeof param.schema?.format === 'string' ? param.schema.format : ''}
                      placeholder='格式，例如 email、uri、date-time'
                      aria-label='格式'
                      onChange={(event) => patch(index, { schema: withSchemaValue(param.schema, 'format', event.target.value || undefined) })}
                    />
                  </>
                )}
                {(param.schema?.type === 'number' || param.schema?.type === 'integer') && (
                  <Space.Compact block>
                    <InputNumber
                      size='small'
                      value={numberValue(param.schema.minimum)}
                      placeholder='最小值'
                      onChange={(value) => patch(index, { schema: withSchemaValue(param.schema, 'minimum', value ?? undefined) })}
                    />
                    <InputNumber
                      size='small'
                      value={numberValue(param.schema.maximum)}
                      placeholder='最大值'
                      onChange={(value) => patch(index, { schema: withSchemaValue(param.schema, 'maximum', value ?? undefined) })}
                    />
                  </Space.Compact>
                )}
                {param.schema?.type === 'array' && (
                  <Space.Compact block>
                    <InputNumber
                      size='small'
                      min={0}
                      precision={0}
                      value={numberValue(param.schema.minItems)}
                      placeholder='最少元素'
                      onChange={(value) => patch(index, { schema: withSchemaValue(param.schema, 'minItems', value ?? undefined) })}
                    />
                    <InputNumber
                      size='small'
                      min={0}
                      precision={0}
                      value={numberValue(param.schema.maxItems)}
                      placeholder='最多元素'
                      onChange={(value) => patch(index, { schema: withSchemaValue(param.schema, 'maxItems', value ?? undefined) })}
                    />
                  </Space.Compact>
                )}
                <ContractDefaultInput schema={param.schema ?? {}} onChange={(schema) => patch(index, { schema })} />
              </details>
            )}
            {!param.schemaRef && nestedObjectSchema(param) && (
              <details className='contract-field-details'>
                <summary>嵌套字段</summary>
                <ParamListEditor
                  params={paramsOfSchema(nestedObjectSchema(param))}
                  schemas={schemas}
                  title='嵌套字段'
                  namePlaceholder='子字段名'
                  addLabel='添加子字段'
                  hint='对象字段可以继续添加更深层字段。'
                  onChange={(nested) => {
                    const objectSchema = nestedObjectSchema(param);
                    if (!objectSchema) return;
                    const nextObject = replaceObjectFields(objectSchema, nested);
                    if (param.schema?.type === 'array') {
                      patch(index, { schema: { ...param.schema, items: nextObject } });
                    } else {
                      patch(index, { schema: nextObject });
                    }
                  }}
                />
              </details>
            )}
          </div>
        ))}
        <Button block size='small' icon={<PlusOutlined />} onClick={() => onChange([...params, { name: `param${params.length + 1}`, required: false, schema: { type: 'string' } }])}>{addLabel}</Button>
      </Space>
      <Typography.Text type='secondary' style={{ fontSize: 12 }}>{hint}</Typography.Text>
    </div>
  );
}

function withSchemaValue(
  schema: ParamSchemaFragment | undefined,
  key: string,
  value: unknown,
): ParamSchemaFragment {
  const next = { ...(schema ?? {}) };
  if (value === undefined || value === '') delete next[key];
  else next[key] = value;
  return next;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nestedObjectSchema(param: ParamSpec): ParamSchemaFragment | null {
  if (param.schema?.type === 'object') return param.schema;
  if (param.schema?.type !== 'array') return null;
  const items = param.schema.items;
  return items && typeof items === 'object' && !Array.isArray(items) && (items as ParamSchemaFragment).type === 'object'
    ? items as ParamSchemaFragment
    : null;
}

function defaultText(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function ContractDefaultInput({ schema, onChange }: {
  schema: ParamSchemaFragment;
  onChange: (schema: ParamSchemaFragment) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(() => defaultText(schema.default));
  const [error, setError] = useState<string>();
  useEffect(() => setDraft(defaultText(schema.default)), [schema.default]);
  return (
    <div>
      <Input
        size='small'
        value={draft}
        status={error ? 'error' : undefined}
        placeholder='默认值（留空表示无默认值）'
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          if (!raw.trim()) {
            const { default: _default, ...rest } = schema;
            onChange(rest);
            setError(undefined);
            return;
          }
          try {
            onChange({ ...schema, default: parseContractDefault(raw, schema) as ParamSchemaFragment['default'] });
            setError(undefined);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}
      />
      {error && <Typography.Text type='danger' style={{ fontSize: 11 }}>{error}</Typography.Text>}
    </div>
  );
}
