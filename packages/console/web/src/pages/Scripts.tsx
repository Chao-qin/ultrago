import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Space, Tag, Typography, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { api } from '../lib/api';
import { rowDeletedAt } from '../lib/types';
import type { Script } from '../lib/types';
import { PageTable } from '../components/PageTable';
import { DeletedToggle } from '../components/DeletedToggle';
import { SearchInput } from '../components/SearchInput';
import { RowActions, ROW_ACTIONS_COLUMN } from '../components/RowActions';
import { PageShell } from '../components/PageShell';
import { RunStatusTag } from '../components/RunStatusTag';
import { ScriptTestDialog } from '../components/script-test-dialog';
import { parseScriptContract } from '../lib/script-contract';
import { paramsOfSchema } from '../lib/flow-editor-model';

export function Scripts() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [search, setSearch] = useState('');
  const [testing, setTesting] = useState<Script | null>(null);
  const scripts = useQuery({ queryKey: ['scripts', includeDeleted], queryFn: () => api.listScripts({ includeDeleted }), refetchInterval: 5000 });
  const remove = useMutation({ mutationFn: api.deleteScript, onSuccess: () => { message.success('已删除'); void qc.invalidateQueries({ queryKey: ['scripts'] }); }, onError: (error: Error) => message.error(error.message) });
  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name', render: (name: string, script: Script) => <Space direction="vertical" size={2}>
      <Space><Link to={`/scripts/${script.id}`} style={{ fontWeight: 600 }}>{name}</Link>{rowDeletedAt(script) && <Tag color="red">已删除</Tag>}</Space>
      {script.description && <Typography.Text type="secondary">{script.description}</Typography.Text>}
    </Space> },
    { title: '输入参数', width: 120, render: (_value: unknown, script: Script) => {
      const count = paramsOfSchema(parseScriptContract(script.inputSchema)).length;
      return count > 0 ? `${count} 个参数` : <Typography.Text type='secondary'>无需参数</Typography.Text>;
    } },
    { title: '返回结果', width: 120, render: (_value: unknown, script: Script) => parseScriptContract(script.outputSchema)
      ? <Tag color='green'>已定义</Tag>
      : <Typography.Text type='secondary'>未定义</Typography.Text> },
    { title: '最近运行', width: 210, render: (_value: unknown, script: Script) => script.lastRunAt
      ? <Space direction="vertical" size={2}><RunStatusTag status={script.lastRunStatus ?? 'pending'} /><Typography.Text type="secondary">{new Date(script.lastRunAt).toLocaleString('zh-CN', { hour12: false })}</Typography.Text></Space>
      : <Typography.Text type="secondary">暂无运行</Typography.Text> },
    { title: '更新时间', width: 180, render: (_value: unknown, script: Script) => new Date(script.updatedAt).toLocaleString('zh-CN', { hour12: false }) },
    { ...ROW_ACTIONS_COLUMN, width: 260, render: (_value: unknown, script: Script) => <RowActions actions={rowDeletedAt(script) ? [] : [
      { key: 'edit', label: '编辑', onClick: () => navigate(`/scripts/${script.id}`) },
      { key: 'test', label: '试跑', onClick: () => setTesting(script) },
      { key: 'run', label: '运行已保存版本', onClick: () => navigate(`/scripts/${script.id}?run=1`) },
      { key: 'schedule', label: '创建定时任务', onClick: () => navigate(`/schedules?scriptId=${encodeURIComponent(script.id)}`) },
      { key: 'history', label: '运行记录', onClick: () => navigate(`/runs?type=script&search=${encodeURIComponent(script.name)}`) },
      { key: 'delete', label: '删除', danger: true, loading: remove.isPending && remove.variables === script.id, confirm: { title: '删除此脚本？', description: '关联的定时任务会被停用。' }, onClick: () => remove.mutate(script.id) },
    ]} /> },
  ];
  return <PageShell title="脚本库" subtitle="集中编写、试跑和复用自动化脚本，也可以交给定时任务或流程调用。" actions={<Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/scripts/new')}>新建脚本</Button>}
    filters={<><SearchInput value={search} onChange={setSearch} placeholder="搜索名称 / 说明…" /><DeletedToggle checked={includeDeleted} onChange={setIncludeDeleted} /></>}>
    <PageTable dataSource={(scripts.data ?? []).filter((script) => `${script.name} ${script.description ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))}
      columns={columns} rowKey="id" pagination={{ defaultPageSize: 20, showSizeChanger: true }} query={scripts} size="middle"
      empty={{ title: '还没有脚本', description: '创建脚本后可以立即试跑，也可以交给定时任务或流程调用。', action: <Button type='primary' icon={<PlusOutlined />} onClick={() => navigate('/scripts/new')}>新建脚本</Button> }} />
    {testing && <ScriptTestDialog key={testing.id} script={testing} onClose={() => setTesting(null)} />}
  </PageShell>;
}
