import { useMemo, useRef } from 'react';
import { Alert, Button, Form, Modal, Space, Tabs, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import type { ParamMap } from '@bcp/shared';
import type { Script } from '../lib/types';
import { api } from '../lib/api';
import { paramsOfSchema } from '../lib/flow-editor-model';
import { formatDuration } from '../lib/format';
import { ParamFields, paramInitialValues } from './ParamForm';
import { parseScriptContract } from '../lib/script-contract';
import { ContentView } from './content-view';

export function ScriptTestDialog({ script, onClose }: { script: Script; onClose: () => void }) {
  const [form] = Form.useForm();
  const lock = useRef(false);
  const specs = useMemo(() => paramsOfSchema(parseScriptContract(script.inputSchema)), [script.inputSchema]);
  const run = useMutation({ mutationFn: (params: ParamMap) => api.testScript(script.id, params), onSettled: () => { lock.current = false; } });
  const result = run.data;
  return <Modal open title={`试跑 · ${script.name}`} width={820} footer={null} maskClosable={!run.isPending} closable={!run.isPending} keyboard={!run.isPending} onCancel={onClose}>
    <Form form={form} layout="vertical" disabled={run.isPending} initialValues={{ params: paramInitialValues(specs) }} onFinish={(values) => {
      if (lock.current) return;
      lock.current = true;
      run.mutate((values.params ?? {}) as ParamMap);
    }}>
      <ParamFields schema={specs} namePrefix={['params']} />
      <Space style={{ marginBottom: 16 }}><Button type="primary" htmlType="submit" loading={run.isPending}>开始试跑</Button><Typography.Text type="secondary">使用已保存的代码，试跑结果显示在此处。</Typography.Text></Space>
    </Form>
    {run.isError && <Alert type="error" showIcon title="试跑请求失败" description={run.error.message} />}
    {result && <>
      <Alert showIcon type={result.ok ? 'success' : 'error'} title={result.ok ? `试跑成功 · ${formatDuration(result.durationMs)}` : '试跑失败'} description={result.error} />
      <Tabs items={[
        { key: 'output', label: '返回结果', children: <ContentView value={result.output} /> },
        { key: 'stdout', label: '标准输出', children: <ContentView value={result.stdout} contentType="text/plain" /> },
        { key: 'stderr', label: '错误输出', children: <ContentView value={result.stderr} contentType="text/plain" /> },
      ]} />
    </>}
  </Modal>;
}
