import { useEffect, useMemo, useState } from 'react';
import { Alert, Modal, Segmented, Space, Typography } from 'antd';
import type { ParamSchemaFragment } from '@bcp/shared';
import type { SchemaRow } from '../lib/types';
import { paramsOfSchema } from '../lib/flow-editor-model';
import { parseScriptContract, schemaOfParams, schemaRefContract, scriptContractRef, validateScriptContractDefinition, visualContractProblems } from '../lib/script-contract';
import { JsonEditor } from './JsonEditorLazy';
import { ParamListEditor } from './param-list-editor';
import { SchemaRefSelect, schemaForCitation } from './SchemaSelect';

export function ScriptContractEditor({
  kind,
  value,
  onChange,
  onValidityChange,
  schemas,
}: {
  kind: 'input' | 'output';
  value: string;
  onChange: (value: string) => void;
  onValidityChange?: (valid: boolean) => void;
  schemas: SchemaRow[];
}): JSX.Element {
  const schema = useMemo(() => parseScriptContract(value), [value]);
  const rootRef = useMemo(() => scriptContractRef(schema), [schema]);
  const resolvedRef = schemaForCitation(schemas, rootRef);
  const problems = useMemo(() => visualContractProblems(schema), [schema]);
  const isObjectShape = !schema || schema.type === 'object';
  const visual = isObjectShape && problems.length === 0;
  const [mode, setMode] = useState<'fields' | 'registry' | 'json'>(rootRef ? 'registry' : visual ? 'fields' : 'json');
  const [raw, setRaw] = useState(value === 'null' ? '{}' : value || '{}');
  const [schemaErrors, setSchemaErrors] = useState<string[]>([]);
  const [schemaValid, setSchemaValid] = useState(true);
  useEffect(() => {
    setRaw(value === 'null' ? '{}' : value || '{}');
    if (rootRef) setMode('registry');
    else if (!visual) setMode('json');
  }, [rootRef, value, visual]);
  useEffect(() => onValidityChange?.(schemaValid), [onValidityChange, schemaValid]);

  const confirmReplacement = (nextValue: string, nextMode: 'fields' | 'registry'): void => {
    Modal.confirm({
      title: '替换当前定义？',
      content: (
        <div className='script-schema-diff'>
          <div><Typography.Text strong>当前定义</Typography.Text><pre>{value}</pre></div>
          <div><Typography.Text strong>替换后</Typography.Text><pre>{nextValue}</pre></div>
        </div>
      ),
      okText: '确认替换',
      cancelText: '保留当前定义',
      onOk: () => {
        setSchemaErrors([]);
        setSchemaValid(true);
        onChange(nextValue);
        setMode(nextMode);
      },
    });
  };

  const label = kind === 'input' ? '输入参数' : '返回结果';
  return (
    <Space direction='vertical' size={10} style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <div>
          <Typography.Text strong>{label}</Typography.Text>
          <Typography.Text type='secondary' style={{ display: 'block', fontSize: 12 }}>
            {kind === 'input'
              ? '自动生成代码提示、试跑表单和定时任务参数。'
              : '用于校验 return 结果，并为流程下游提供字段提示。'}
          </Typography.Text>
        </div>
        <Segmented
          size='small'
          value={mode}
          options={[
            { label: '字段', value: 'fields', disabled: !visual && !resolvedRef },
            { label: '已有结构', value: 'registry' },
            { label: '高级 JSON', value: 'json' },
          ]}
          onChange={(next) => {
            const selected = next as 'fields' | 'registry' | 'json';
            if (selected === 'fields' && rootRef && resolvedRef) {
              const resolved = parseScriptContract(resolvedRef.jsonSchema);
              confirmReplacement(resolved ? JSON.stringify(resolved, null, 2) : 'null', 'fields');
              return;
            }
            if (selected !== 'json') {
              setSchemaErrors([]);
              setSchemaValid(true);
            }
            setMode(selected);
          }}
        />
      </Space>
      {!visual && (
        <Alert
          type='warning'
          showIcon
          title='当前结构需要在高级模式编辑'
          description={problems.length > 0 ? `字段模式暂不支持：${problems.join('、')}` : '字段模式只编辑对象结构。原始 Schema 会完整保留。'}
        />
      )}
      {mode === 'fields' ? (
        <ParamListEditor
          schemas={schemas}
          title={kind === 'input' ? '参数字段' : '返回字段'}
          namePlaceholder={kind === 'input' ? '参数名' : '字段名'}
          addLabel={kind === 'input' ? '添加参数' : '添加返回字段'}
          hint={kind === 'input' ? '不添加字段表示脚本无需参数。' : '暂不定义也可以试跑，返回值将不会执行结构校验。'}
          params={paramsOfSchema(schema)}
          onChange={(params) => {
            setSchemaValid(true);
            onChange(params.length > 0 ? JSON.stringify(schemaOfParams(params), null, 2) : 'null');
          }}
        />
      ) : mode === 'registry' ? (
        <div>
          <SchemaRefSelect
            schemas={schemas}
            value={rootRef}
            onChange={(ref) => {
              const nextValue = ref ? JSON.stringify(schemaRefContract(ref), null, 2) : 'null';
              if (schema && !rootRef && nextValue !== value) {
                confirmReplacement(nextValue, 'registry');
                return;
              }
              setSchemaValid(true);
              onChange(nextValue);
            }}
          />
          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
            引用固定版本；注册表出现新版本时不会静默改变脚本行为。
          </Typography.Text>
        </div>
      ) : (
        <Space direction='vertical' size={6} style={{ width: '100%' }}>
          {schemaErrors.length > 0 && (
            <Alert type='error' showIcon title='Schema 结构无效' description={schemaErrors.slice(0, 3).join('；')} />
          )}
          <JsonEditor
            value={raw}
            expected='object'
            height={260}
            ariaLabel={`${label} JSON Schema`}
            onChange={(next) => {
              setRaw(next);
              try {
                const parsed: unknown = JSON.parse(next);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  setSchemaValid(false);
                  return;
                }
                const validation = validateScriptContractDefinition(parsed as Record<string, unknown>);
                setSchemaErrors(validation.errors ?? []);
                setSchemaValid(validation.ok);
                if (validation.ok) onChange(JSON.stringify(parsed, null, 2));
              } catch {
                setSchemaErrors([]);
                setSchemaValid(false);
              }
            }}
          />
        </Space>
      )}
    </Space>
  );
}
