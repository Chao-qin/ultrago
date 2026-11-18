import { useState } from 'react';
import { Button, Input, Tag } from 'antd';
import { DownOutlined, UpOutlined, SearchOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { FLOW_NODE_GROUPS, FLOW_NODE_TYPE_HINTS, FLOW_NODE_TYPE_LABELS } from '@bcp/shared';
import type { FlowNodeType } from '@bcp/shared';
import type { FlowRunRow } from '../lib/types';
import { FLOW_STATUS_LABELS } from '../lib/flow-execution';
import { NodeIcon } from './NodeIcon';
import { FlowRunSummary } from './flow-run-summary';
import { diagnosticRun } from '../lib/flow-diagnostics';

export function FlowNodeLibrary({ onAdd }: { onAdd: (type: FlowNodeType) => void }) {
  const [query, setQuery] = useState('');
  const groups = FLOW_NODE_GROUPS.map((group) => ({ ...group, types: group.types.filter((type) => `${FLOW_NODE_TYPE_LABELS[type]} ${FLOW_NODE_TYPE_HINTS[type]} ${type}`.toLowerCase().includes(query.trim().toLowerCase())) })).filter((group) => group.types.length);
  return <aside className='flow-node-library' aria-label='节点库'>
    <div className='flow-panel-eyebrow'>BUILD YOUR FLOW</div>
    <h2>节点库 <span>{FLOW_NODE_GROUPS.reduce((count, group) => count + group.types.length, 0)}</span></h2>
    <Input aria-label='搜索节点' prefix={<SearchOutlined />} placeholder='搜索节点…' allowClear value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className='flow-library-groups'>
      {groups.map((group) => <section key={group.id}>
        <h3>{group.label}</h3>
        {group.types.map((type) => <button key={type} type='button' className='flow-library-node' onClick={() => onAdd(type)}>
          <span className={`flow-library-icon flow-type-${type}`}><NodeIcon type={type} size={19} /></span>
          <span><strong>{FLOW_NODE_TYPE_LABELS[type]}</strong><small>{FLOW_NODE_TYPE_HINTS[type]}</small></span>
          <span className='flow-library-add'>+</span>
        </button>)}
      </section>)}
      {!groups.length && <p className='flow-muted'>没有匹配的节点</p>}
    </div>
  </aside>;
}

export function FlowExecutionPanel({ run, loading, error, onLocate, onOpen }: { run?: FlowRunRow; loading: boolean; error: boolean; onLocate: (nodeId: string) => void; onOpen: () => void }) {
  const [expanded, setExpanded] = useState(false);
  run = run ? diagnosticRun(run) : undefined;
  return <section className={`flow-execution-panel ${expanded ? 'is-expanded' : ''}`} aria-label='最近执行'>
    <div className='flow-execution-heading'>
      <button type='button' onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls='flow-execution-body'>
        {expanded ? <DownOutlined /> : <UpOutlined />} <strong>执行监控</strong>
        <span className='flow-muted'>{error ? '加载失败' : loading ? '正在同步…' : run ? `${run.nodes?.length ?? 0} 条节点记录` : '暂无执行'}</span>
      </button>
      {run && <Tag color={run.status === 'running' ? 'processing' : run.status === 'success' ? 'success' : run.status === 'failed' ? 'error' : 'default'}>{FLOW_STATUS_LABELS[run.status] ?? run.status}</Tag>}
      {run && <Button type='text' size='small' onClick={onOpen}>运行详情 <ArrowRightOutlined /></Button>}
    </div>
    {expanded && <div id='flow-execution-body' className='flow-execution-body'>
      {error ? <p className='flow-muted' role='alert'>执行记录加载失败，请稍后重试。</p> : !run ? <p className='flow-muted'>{loading ? '正在加载执行记录…' : '暂无执行记录。保存流程后，点击「运行流程」开始。'}</p> : <>
        <div className='flow-execution-meta'><code>{run.id}</code><span>{new Date(run.queuedAt).toLocaleString()}</span><span>{run.durationMs == null ? '执行耗时 —' : `${(run.durationMs / 1000).toFixed(2)} s`}</span></div>
        {/* 运行级错误由 FlowRunSummary 统一渲染（它还能指出是哪个节点挂的），
            这里不再重复一遍同样的字符串。 */}
        <FlowRunSummary run={run} />
        <div className='flow-execution-nodes'>{(run.nodes ?? []).map((node) => <button type='button' key={node.id} className={`flow-execution-node flow-status-${node.status}`} onClick={() => onLocate(node.nodeId)} title={node.errorMessage ?? node.nodeId}>
          <span className='flow-status-dot' /><strong>{node.nodeId}</strong>{node.iteration != null && <small>#{node.iteration}</small>}<span>{FLOW_STATUS_LABELS[node.status] ?? node.status}</span><small>{node.durationMs == null ? '—' : `${node.durationMs} ms`}</small>
        </button>)}</div>
      </>}
    </div>}
  </section>;
}
