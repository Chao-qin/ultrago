import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Form, Modal, Space, Tabs, Typography } from 'antd';
import { PlayCircleOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import type { ParamMap, ParamSchemaFragment, ScriptNodeConfig } from '@bcp/shared';
import { api } from '../lib/api';
import { paramsOfSchema } from '../lib/flow-editor-model';
import { inferSchema, inferenceUncertainPaths, mergeInferredFields } from '../lib/script-contract';
import type { ScriptDryRunResult } from '../lib/types';
import { formatDuration } from '../lib/format';
import { paramInitialValues } from './ParamForm';
import { ContentView } from './content-view';
import { SchemaParamEditor } from './schema-param-editor';

const ERROR_CATEGORY_LABELS: Record<NonNullable<ScriptDryRunResult['errorCategory']>, string> = {
  input: '输入参数',
  syntax: '语法',
  runtime: '运行异常',
  timeout: '超时',
  output: '输出不匹配',
  permission: '权限限制',
  network: '网络',
  module: '模块加载',
  cancelled: '已取消',
};

export function ScriptTestConsole({
  config,
  inputSchema,
  initialParams,
  onInferOutput,
  onErrorLocation,
  disabled = false,
}: {
  config: ScriptNodeConfig;
  inputSchema: ParamSchemaFragment | null;
  initialParams?: ParamMap;
  onInferOutput?: (schema: ParamSchemaFragment) => void;
  onErrorLocation?: (location: { line: number; column?: number }) => void;
  disabled?: boolean;
}): JSX.Element {
  const [form] = Form.useForm();
  const lock = useRef(false);
  const abortRef = useRef<AbortController>();
  const startedAtRef = useRef(0);
  const [result, setResult] = useState<ScriptDryRunResult | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [suggestion, setSuggestion] = useState<{ schema: ParamSchemaFragment; fields: string[]; selected: string[]; uncertain: string[] }>();
  const specs = useMemo(() => paramsOfSchema(inputSchema), [inputSchema]);
  const run = useMutation({
    mutationFn: (params: ParamMap) => {
      const controller = new AbortController();
      abortRef.current = controller;
      startedAtRef.current = Date.now();
      return api.dryRunScript(config, params, controller.signal);
    },
    onSuccess: setResult,
    onError: (error: Error) => {
      const cancelled = error.name === 'AbortError';
      const common = {
        ok: false as const,
        stdout: '',
        stderr: '',
        durationMs: Math.max(0, Date.now() - startedAtRef.current),
        notices: [],
      };
      setResult(cancelled
        ? { ...common, error: '试跑已取消', errorCategory: 'cancelled' }
        : { ...common, error: error.message, errorCategory: 'runtime' });
    },
    onSettled: () => {
      lock.current = false;
      abortRef.current = undefined;
    },
  });
  useEffect(() => {
    if (!run.isPending) return;
    const update = () => setElapsedMs(Math.max(0, Date.now() - startedAtRef.current));
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [run.isPending]);
  return (
    <div className='script-test-console' aria-label='脚本试跑控制台'>
      <Form
        form={form}
        layout='vertical'
        initialValues={{ params: { ...paramInitialValues(specs), ...(initialParams ?? {}) } }}
        disabled={disabled}
        onFinish={(values) => {
          if (lock.current) return;
          lock.current = true;
          run.mutate((values.params ?? {}) as ParamMap);
        }}
      >
        <SchemaParamEditor schema={specs} namePrefix={['params']} />
        <Space style={{ marginBlock: 12 }}>
          {run.isPending
            ? <Button danger icon={<StopOutlined />} onClick={() => abortRef.current?.abort()}>停止试跑</Button>
            : <Button type='primary' htmlType='submit' icon={<PlayCircleOutlined />}>试跑当前草稿</Button>}
          {run.isPending && <Typography.Text type='secondary'>已运行 {formatDuration(elapsedMs)}</Typography.Text>}
          <Typography.Text type='secondary'>不会保存脚本，也不会产生正式运行记录。</Typography.Text>
        </Space>
      </Form>
      {result && (
        <>
          <Alert
            showIcon
            type={result.ok ? 'success' : result.errorCategory === 'cancelled' ? 'warning' : 'error'}
            title={result.ok ? `试跑成功 · ${formatDuration(result.durationMs)}` : result.errorCategory === 'cancelled' ? '试跑已取消' : '试跑失败'}
            description={(
              <Space direction='vertical' size={2}>
                <span>{result.error ?? result.warning}</span>
                {result.errorCategory && (
                  <Typography.Text type='secondary'>
                    错误分类：{ERROR_CATEGORY_LABELS[result.errorCategory]}
                    {result.errorLocation ? ` · 脚本第 ${result.errorLocation.line} 行${result.errorLocation.column ? `，第 ${result.errorLocation.column} 列` : ''}` : ''}
                  </Typography.Text>
                )}
              </Space>
            )}
            action={(
              <Space>
                {!result.ok && result.errorLocation && onErrorLocation && (
                  <Button size='small' onClick={() => onErrorLocation(result.errorLocation!)}>跳到代码</Button>
                )}
                {result.ok && result.output !== undefined && onInferOutput && (
                  <Button size='small' onClick={() => {
                    const inferred = inferSchema(result.output);
                    const fields = inferred.type === 'object' && inferred.properties && typeof inferred.properties === 'object' && !Array.isArray(inferred.properties)
                      ? Object.keys(inferred.properties)
                      : [];
                    setSuggestion({ schema: inferred, fields, selected: fields, uncertain: inferenceUncertainPaths(inferred) });
                  }}>从结果生成返回定义</Button>
                )}
              </Space>
            )}
          />
          <Tabs items={[
            { key: 'output', label: '返回结果', children: <ContentView value={result.output} /> },
            { key: 'stdout', label: '日志', children: <ContentView value={result.stdout} contentType='text/plain' /> },
            { key: 'stderr', label: '错误输出', children: <ContentView value={result.stderr} contentType='text/plain' /> },
          ]} />
        </>
      )}
      <Modal
        open={!!suggestion}
        title='审阅返回结构建议'
        okText={suggestion?.fields.length ? '逐字段采用' : '采用定义'}
        cancelText='取消'
        okButtonProps={{ disabled: !!suggestion?.fields.length && suggestion.selected.length === 0 }}
        onCancel={() => setSuggestion(undefined)}
        onOk={() => {
          if (!suggestion || !onInferOutput) return;
          onInferOutput(mergeInferredFields(config.outputSchema, suggestion.schema, suggestion.selected));
          setSuggestion(undefined);
        }}
      >
        <Typography.Paragraph type='secondary'>建议只来自本次返回值，不会自动覆盖当前定义。对象结果可逐字段采用。</Typography.Paragraph>
        {!!suggestion?.uncertain.length && (
          <Alert type='warning' showIcon title='以下位置待确认' description={suggestion.uncertain.join('、')} style={{ marginBottom: 12 }} />
        )}
        {suggestion?.fields.length ? (
          <Checkbox.Group
            value={suggestion.selected}
            options={suggestion.fields.map((field) => ({ label: field, value: field }))}
            onChange={(selected) => setSuggestion((current) => current ? { ...current, selected: selected as string[] } : current)}
          />
        ) : null}
        {suggestion && (
          <div className='script-schema-diff'>
            <div><Typography.Text strong>当前定义</Typography.Text><pre>{JSON.stringify(config.outputSchema ?? {}, null, 2)}</pre></div>
            <div><Typography.Text strong>建议定义</Typography.Text><pre>{JSON.stringify(suggestion.schema, null, 2)}</pre></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
