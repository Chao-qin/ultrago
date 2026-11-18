import { useEffect, useMemo, useState } from 'react';
import { Form, Typography } from 'antd';
import type { ParamSchemaFragment, ParamSpec } from '@bcp/shared';
import { ParamFields } from './ParamForm';
import { JsonEditor } from './JsonEditorLazy';

type SchemaResolver = (ref?: { name: string; version?: number }) => ParamSchemaFragment | null;

export function SchemaParamEditor({
  schema,
  namePrefix = ['params'],
  schemaResolver,
}: {
  schema: ParamSpec[];
  namePrefix?: (string | number)[];
  schemaResolver?: SchemaResolver;
}): JSX.Element {
  const form = Form.useFormInstance();
  const value = Form.useWatch(namePrefix, form) as Record<string, unknown> | undefined;
  const serialized = useMemo(() => JSON.stringify(value ?? {}, null, 2), [value]);
  const [raw, setRaw] = useState(serialized);
  useEffect(() => setRaw(serialized), [serialized]);
  return (
    <div>
      {schema.length > 0
        ? <ParamFields schema={schema} namePrefix={namePrefix} schemaResolver={schemaResolver} />
        : <Typography.Text type='secondary'>没有声明参数，将使用空对象运行。</Typography.Text>}
      <details className='schema-param-editor__advanced'>
        <summary>高级：JSON 批量编辑</summary>
        <Typography.Text type='secondary' style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>
          可粘贴完整参数对象；字段表单无法识别的历史字段也会保留在这里。
        </Typography.Text>
        <JsonEditor
          value={raw}
          expected='object'
          height={150}
          ariaLabel='运行参数 JSON 编辑器'
          onChange={(next) => {
            setRaw(next);
            try {
              const parsed: unknown = JSON.parse(next);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                form.setFieldValue(namePrefix, parsed);
              }
            } catch {
              // JsonEditor keeps and explains the invalid draft until it becomes valid.
            }
          }}
        />
      </details>
    </div>
  );
}
