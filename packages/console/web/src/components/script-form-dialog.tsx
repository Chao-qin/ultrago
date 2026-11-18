import { lazy, Suspense, useEffect, useState } from 'react';
import { Form, Input, Modal, Tag } from 'antd';
import type { ParamSchemaFragment } from '@bcp/shared';
import type { Script } from '../lib/types';
import { JsonEditor } from './JsonEditorLazy';

const ScriptEditor = lazy(async () => ({ default: (await import('./ScriptEditor')).ScriptEditor }));

function ScriptCodeField(props: Parameters<typeof import('./ScriptEditor').ScriptEditor>[0]) {
  return <Suspense fallback={<div style={{ height: 340 }}>正在加载代码编辑器…</div>}><ScriptEditor {...props} /></Suspense>;
}

export interface ScriptFormValues {
  name: string;
  description?: string;
  language: string;
  source: string;
  inputSchema: string;
  outputSchema: string;
}

export function parseScriptSchema(raw?: string): ParamSchemaFragment | null {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ParamSchemaFragment : null;
  } catch {
    return null;
  }
}

const schemaRules = [{ validator: async (_rule: unknown, value: string) => {
  if (!parseScriptSchema(value)) throw new Error('请输入有效的 JSON Schema 对象');
} }];

export function ScriptFormDialog({ script, submitting, onCancel, onSubmit }: {
  script?: Script;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (values: ScriptFormValues) => void;
}) {
  const [form] = Form.useForm<ScriptFormValues>();
  const [dirty, setDirty] = useState(false);
  const input = Form.useWatch('inputSchema', form);
  const output = Form.useWatch('outputSchema', form);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return <Modal open centered title={script ? `编辑脚本 · ${script.name}` : '新建脚本'} width={1120}
    styles={{ body: { maxHeight: '76vh', overflow: 'auto' } }}
    confirmLoading={submitting} okText="保存脚本" cancelText="取消" closable={!submitting} maskClosable={false}
    cancelButtonProps={{ disabled: submitting }} onOk={() => { if (!submitting) form.submit(); }}
    onCancel={() => { if (!submitting && (!dirty || window.confirm('有未保存的脚本改动，确定关闭吗？'))) onCancel(); }}>
    <Form form={form} layout="vertical" disabled={submitting} onValuesChange={() => setDirty(true)}
      initialValues={{ name: script?.name ?? '', description: script?.description ?? '', language: 'ts',
        source: script?.source ?? 'return { ok: true };', inputSchema: script?.inputSchema ?? '{}', outputSchema: script?.outputSchema ?? '{}' }}
      onFinish={(values) => { if (!submitting) onSubmit({ ...values, name: values.name.trim(), language: 'ts' }); }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true, message: '请输入脚本名称' }]} style={{ flex: 1 }}><Input maxLength={100} placeholder="例如：商品数据预处理" /></Form.Item>
        <Tag color="blue">TypeScript / JavaScript</Tag>
      </div>
      <Form.Item name="description" label="说明"><Input maxLength={500} placeholder="描述脚本用途，方便后续查找" /></Form.Item>
      <Form.Item name="source" label="脚本代码" rules={[{ required: true, whitespace: true, message: '请输入脚本代码' }]}
        extra="直接编写函数体；上方显示可用入参，下方显示返回约定。无需重复定义 handler。">
        <ScriptCodeField language="ts" readOnly={submitting} inputSchema={parseScriptSchema(input ?? script?.inputSchema)} outputSchema={parseScriptSchema(output ?? script?.outputSchema)} height={340} />
      </Form.Item>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 16 }}>
        <Form.Item name="inputSchema" label="入参契约" rules={schemaRules}><JsonEditor expected="object" height={180} ariaLabel="脚本入参 Schema" /></Form.Item>
        <Form.Item name="outputSchema" label="出参契约" rules={schemaRules}><JsonEditor expected="object" height={180} ariaLabel="脚本出参 Schema" /></Form.Item>
      </div>
    </Form>
  </Modal>;
}
