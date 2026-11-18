import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, Divider, Form, Input, Modal, Space, Spin, Tabs, Typography, message } from 'antd';
import { ArrowLeftOutlined, CalendarOutlined, PlayCircleOutlined, SaveOutlined } from '@ant-design/icons';
import { validateParams } from '@bcp/shared';
import type { ParamMap, ParamSchemaFragment, ScriptNodeConfig } from '@bcp/shared';
import { api } from '../lib/api';
import type { Script } from '../lib/types';
import { parseConsoleParams } from '../lib/types';
import { parseScriptContract, resolveScriptContract } from '../lib/script-contract';
import { schemaLookup } from '../lib/flow-ports-client';
import { PageShell } from '../components/PageShell';
import { ScriptContractEditor } from '../components/script-contract-editor';
import { ScriptTestConsole } from '../components/script-test-console';
import { paramInitialValues } from '../components/ParamForm';
import { paramsOfSchema } from '../lib/flow-editor-model';
import { SchemaParamEditor } from '../components/schema-param-editor';
import { useUnsavedChangesGuard } from '../components/unsaved-changes-guard';

const ScriptEditor = lazy(async () => ({ default: (await import('../components/ScriptEditor')).ScriptEditor }));

interface ScriptDraft {
  name: string;
  description: string;
  source: string;
  inputSchema: string;
  outputSchema: string;
}

const EMPTY_DRAFT: ScriptDraft = {
  name: '',
  description: '',
  source: '',
  inputSchema: 'null',
  outputSchema: 'null',
};

const SCRIPT_TEMPLATES: Array<{ label: string; description: string; source: string }> = [
  {
    label: '返回成功对象',
    description: '适合从最小可运行脚本开始。',
    source: 'return { ok: true };',
  },
  {
    label: '转换输入参数',
    description: '读取输入并返回一个整理后的对象。',
    source: 'return {\n  ...params,\n  processedAt: new Date().toISOString(),\n};',
  },
];

function draftOf(script?: Script): ScriptDraft {
  return script ? {
    name: script.name,
    description: script.description ?? '',
    source: script.source,
    inputSchema: script.inputSchema || 'null',
    outputSchema: script.outputSchema || 'null',
  } : EMPTY_DRAFT;
}

export function ScriptWorkbench(): JSX.Element {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const script = useQuery({ queryKey: ['script', id], queryFn: () => api.getScript(id!), enabled: !!id });
  const schemas = useQuery({ queryKey: ['schemas', 'script-workbench'], queryFn: () => api.listSchemas() });
  const [draft, setDraft] = useState<ScriptDraft>(EMPTY_DRAFT);
  const [baseline, setBaseline] = useState<ScriptDraft>(EMPTY_DRAFT);
  const [loadedKey, setLoadedKey] = useState<string>();
  const [recovered, setRecovered] = useState<ScriptDraft>();
  const [starterReady, setStarterReady] = useState(!isNew);
  const [pasting, setPasting] = useState(false);
  const [pastedSource, setPastedSource] = useState('');
  const [running, setRunning] = useState(false);
  const [inputContractValid, setInputContractValid] = useState(true);
  const [outputContractValid, setOutputContractValid] = useState(true);
  const [editorTarget, setEditorTarget] = useState<{ line: number; key: number }>();
  const editorRef = useRef<HTMLDivElement>(null);
  const storageKey = `bcp-script-draft:${id ?? 'new'}`;

  useEffect(() => {
    const key = id ?? 'new';
    if ((!isNew && !script.data) || loadedKey === key) return;
    const initial = draftOf(script.data);
    setDraft(initial);
    setBaseline(initial);
    setLoadedKey(key);
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) setRecovered(JSON.parse(stored) as ScriptDraft);
    } catch {
      localStorage.removeItem(storageKey);
    }
  }, [id, isNew, loadedKey, script.data, storageKey]);

  useEffect(() => {
    if (!id || searchParams.get('run') !== '1') return;
    setRunning(true);
    const next = new URLSearchParams(searchParams);
    next.delete('run');
    setSearchParams(next, { replace: true });
  }, [id, searchParams, setSearchParams]);

  const contractsValid = inputContractValid && outputContractValid;
  const dirty = useMemo(
    () => starterReady && (isNew || !contractsValid || JSON.stringify(draft) !== JSON.stringify(baseline)),
    [baseline, contractsValid, draft, isNew, starterReady],
  );
  const clearUnsavedGuard = useUnsavedChangesGuard(dirty);
  useEffect(() => {
    if (!loadedKey || !dirty) return;
    localStorage.setItem(storageKey, JSON.stringify(draft));
  }, [dirty, draft, loadedKey, storageKey]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = useMutation({
    mutationFn: async ({ pauseScheduleIds = [] }: { pauseScheduleIds?: string[] }) => {
      const payload = { ...draft, name: draft.name.trim(), language: 'ts' };
      if (!payload.name) throw new Error('请先填写脚本名称');
      if (pauseScheduleIds.length > 0) {
        const pauseResults = await Promise.allSettled(
          pauseScheduleIds.map((scheduleId) => api.updateSchedule(scheduleId, { enabled: false })),
        );
        const failedCount = pauseResults.filter((result) => result.status === 'rejected').length;
        if (failedCount > 0) {
          throw new Error(`有 ${failedCount} 个定时任务未能暂停，脚本未保存`);
        }
      }
      return id ? api.updateScript(id, payload) : api.createScript(payload);
    },
    onSuccess: (saved) => {
      const next = draftOf(saved);
      setDraft(next);
      setBaseline(next);
      localStorage.removeItem(storageKey);
      void qc.invalidateQueries({ queryKey: ['scripts'] });
      message.success('脚本已保存');
      if (isNew) {
        clearUnsavedGuard();
        navigate(`/scripts/${saved.id}`, { replace: true });
      }
    },
    onError: (error: Error) => message.error(error.message),
  });
  const leave = (): void => {
    navigate('/scripts');
  };

  const begin = (source: string): void => {
    setDraft({ ...EMPTY_DRAFT, source });
    setStarterReady(true);
    setPasting(false);
  };

  if (!isNew && script.isLoading) return <Spin />;
  if (!isNew && script.isError) return <Alert type='error' showIcon title='脚本加载失败' description={script.error.message} />;

  const inputSchema = parseScriptContract(draft.inputSchema);
  const outputSchema = parseScriptContract(draft.outputSchema);
  const schemaResolver = schemaLookup(schemas.data ?? []);
  const effectiveInputSchema = resolveScriptContract(inputSchema, schemaResolver);
  const effectiveOutputSchema = resolveScriptContract(outputSchema, schemaResolver);
  const config: ScriptNodeConfig = {
    language: 'ts',
    source: draft.source,
    inputSchema: inputSchema ?? undefined,
    outputSchema: outputSchema ?? undefined,
  };
  const requestSave = async (): Promise<void> => {
    if (!contractsValid) {
      message.error('请先修复输入参数或返回结果中的 Schema 错误');
      return;
    }
    if (!id || draft.inputSchema === baseline.inputSchema) {
      save.mutate({});
      return;
    }
    try {
      const schedules = await api.listSchedules();
      const specs = paramsOfSchema(effectiveInputSchema);
      const impacted = schedules.filter((schedule) => {
        if (!schedule.enabled || schedule.deletedAt || schedule.targetType !== 'script' || schedule.script?.id !== id) return false;
        try {
          return validateParams(specs, parseConsoleParams(schedule.paramsJson), schemaResolver).length > 0;
        } catch {
          return true;
        }
      });
      if (impacted.length === 0) {
        save.mutate({});
        return;
      }
      Modal.confirm({
        title: `${impacted.length} 个受影响的定时任务`,
        content: `新的输入参数与这些启用任务不兼容：${impacted.slice(0, 5).map((schedule) => schedule.name).join('、')}。继续后将先暂停这些任务，再保存脚本；任务参数不会被改写。`,
        okText: '保存并暂停',
        cancelText: '返回修改',
        onOk: () => save.mutateAsync({ pauseScheduleIds: impacted.map((schedule) => schedule.id) }),
      });
    } catch (error) {
      message.error(`无法检查定时任务影响：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return (
    <PageShell
      title={isNew ? '新建脚本' : draft.name || '编辑脚本'}
      subtitle={dirty ? '未保存' : '已保存'}
      actions={(
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={leave}>返回脚本库</Button>
          <Button icon={<PlayCircleOutlined />} disabled={isNew || dirty} title={dirty ? '请先保存当前改动' : undefined} onClick={() => setRunning(true)}>运行已保存版本</Button>
          <Button icon={<CalendarOutlined />} disabled={isNew || dirty} title={dirty ? '请先保存当前改动' : undefined} onClick={() => id && navigate(`/schedules?scriptId=${encodeURIComponent(id)}`)}>创建定时任务</Button>
          <Button type='primary' icon={<SaveOutlined />} loading={save.isPending} disabled={!contractsValid} title={!contractsValid ? '请先修复 Schema 错误' : undefined} onClick={() => void requestSave()}>保存</Button>
        </Space>
      )}
    >
      {recovered && (
        <Alert
          type='info'
          showIcon
          title='发现未保存的本地草稿'
          action={<Space><Button size='small' type='primary' onClick={() => { setDraft(recovered); setRecovered(undefined); setStarterReady(true); }}>恢复</Button><Button size='small' onClick={() => { localStorage.removeItem(storageKey); setRecovered(undefined); }}>丢弃</Button></Space>}
          style={{ marginBottom: 12 }}
        />
      )}
      {!contractsValid && <Alert type='error' showIcon title='Schema 尚未应用' description='请修复高级 JSON 中的格式或结构错误后再试跑或保存；编辑中的原文会保留。' style={{ marginBottom: 12 }} />}
      <div className='script-workbench' ref={editorRef}>
        <section className='script-workbench__editor'>
          <Suspense fallback={<div className='script-workbench__loading'>正在加载代码编辑器…</div>}>
            <ScriptEditor
              fill
              language='ts'
              value={draft.source}
              onChange={(source) => setDraft((current) => ({ ...current, source }))}
              inputSchema={effectiveInputSchema}
              outputSchema={effectiveOutputSchema}
              revealLine={editorTarget?.line}
              revealKey={editorTarget?.key}
            />
          </Suspense>
          <Typography.Text type='warning' className='script-workbench__security'>
            模块请用 `await import('包名')` 加载；文件和子进程已被沙箱限制；网络未被禁止，请勿把敏感参数发送到外部。
          </Typography.Text>
        </section>
        <aside className='script-workbench__sidebar'>
          <Tabs items={[
            { key: 'input', label: '输入参数', children: <ScriptContractEditor kind='input' value={draft.inputSchema} schemas={schemas.data ?? []} onValidityChange={setInputContractValid} onChange={(inputSchema) => setDraft((current) => ({ ...current, inputSchema }))} /> },
            { key: 'output', label: '返回结果', children: <ScriptContractEditor kind='output' value={draft.outputSchema} schemas={schemas.data ?? []} onValidityChange={setOutputContractValid} onChange={(outputSchema) => setDraft((current) => ({ ...current, outputSchema }))} /> },
            { key: 'test', label: '试跑', children: <ScriptTestConsole disabled={!contractsValid} config={config} inputSchema={effectiveInputSchema} onErrorLocation={(location) => setEditorTarget((current) => ({ line: location.line, key: (current?.key ?? 0) + 1 }))} onInferOutput={(schema) => setDraft((current) => ({ ...current, outputSchema: JSON.stringify(schema, null, 2) }))} /> },
            { key: 'settings', label: '设置', children: <Space direction='vertical' size={12} style={{ width: '100%' }}><label><Typography.Text strong>名称</Typography.Text><Input value={draft.name} maxLength={100} placeholder='例如：商品数据预处理' onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label><label><Typography.Text strong>用途说明</Typography.Text><Input.TextArea value={draft.description} maxLength={500} rows={4} placeholder='说明这个脚本处理什么问题' onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label></Space> },
          ]} />
        </aside>
      </div>
      {running && id && <ManualRunDialog scriptId={id} inputSchema={effectiveInputSchema} onClose={() => setRunning(false)} />}
      <Modal
        open={isNew && !starterReady}
        title='选择创建方式'
        footer={<Button onClick={() => navigate('/scripts')}>返回脚本库</Button>}
        closable={false}
        maskClosable={false}
        keyboard={false}
      >
        <Space direction='vertical' size={12} style={{ width: '100%' }}>
          <Typography.Text type='secondary'>选择一个起点。之后可随时修改代码、输入参数和返回结果。</Typography.Text>
          {recovered && (
            <Button type='primary' block onClick={() => { setDraft(recovered); setRecovered(undefined); setStarterReady(true); }}>
              恢复本地草稿
            </Button>
          )}
          <Button block onClick={() => begin('')}>空白脚本</Button>
          <Divider plain>常用模板</Divider>
          {SCRIPT_TEMPLATES.map((template) => (
            <Button key={template.label} block onClick={() => begin(template.source)} title={template.description}>
              {template.label}
            </Button>
          ))}
          <Divider plain>已有代码</Divider>
          {!pasting ? (
            <Button block onClick={() => setPasting(true)}>粘贴已有代码</Button>
          ) : (
            <Space direction='vertical' style={{ width: '100%' }}>
              <Input.TextArea
                autoFocus
                rows={8}
                value={pastedSource}
                placeholder='粘贴函数体代码，例如：return { ok: true };'
                onChange={(event) => setPastedSource(event.target.value)}
              />
              <Space>
                <Button type='primary' disabled={!pastedSource.trim()} onClick={() => begin(pastedSource)}>使用这段代码</Button>
                <Button onClick={() => setPasting(false)}>取消</Button>
              </Space>
            </Space>
          )}
        </Space>
      </Modal>
    </PageShell>
  );
}

function ManualRunDialog({ scriptId, inputSchema, onClose }: {
  scriptId: string;
  inputSchema: ParamSchemaFragment | null;
  onClose: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const specs = useMemo(() => paramsOfSchema(inputSchema), [inputSchema]);
  const run = useMutation({
    mutationFn: (params: ParamMap) => api.runScript(scriptId, params),
    onSuccess: ({ runId, status }) => {
      if (status === 'success') message.success('脚本运行完成');
      else message.error('脚本运行失败，请查看运行详情');
      onClose();
      navigate(`/runs/${runId}`);
    },
    onError: (error: Error) => message.error(error.message),
  });
  return (
    <Modal open title='运行已保存版本' footer={null} onCancel={onClose} maskClosable={!run.isPending} closable={!run.isPending}>
      <Form
        form={form}
        layout='vertical'
        initialValues={{ params: paramInitialValues(specs) }}
        disabled={run.isPending}
        onFinish={(values) => run.mutate((values.params ?? {}) as ParamMap)}
      >
        <SchemaParamEditor schema={specs} namePrefix={['params']} />
        <Button type='primary' htmlType='submit' icon={<PlayCircleOutlined />} loading={run.isPending} style={{ marginTop: 16 }}>开始运行</Button>
      </Form>
    </Modal>
  );
}
