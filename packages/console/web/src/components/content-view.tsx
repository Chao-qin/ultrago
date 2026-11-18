import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Segmented, Tag, Typography, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { CONTENT_PREVIEW_LIMIT, detectContent, safeContentHref } from '../lib/content-format';
import { PageTable } from './PageTable';
import './content-view.css';

export function ContentView({ value, contentType, maxHeight = 420 }: { value: unknown; contentType?: string; maxHeight?: number }) {
  const content = useMemo(() => detectContent(value, contentType), [value, contentType]);
  const [view, setView] = useState('preview');
  const raw = content.raw.slice(0, CONTENT_PREVIEW_LIMIT);
  return <section className="content-view">
    <div className="content-view-toolbar">
      <Tag>{content.kind === 'json' ? 'JSON' : content.kind === 'markdown' ? 'Markdown' : '文本'}</Tag>
      <span className="content-view-size">{content.raw.length.toLocaleString()} 字符</span>
      {content.kind !== 'text' && <Segmented size="small" value={view} onChange={setView} options={[{ value: 'preview', label: '预览' }, { value: 'raw', label: '原文' }]} />}
      <Button size="small" type="text" icon={<CopyOutlined />} aria-label="复制当前内容" onClick={() => {
        void navigator.clipboard.writeText(content.raw).then(() => message.success('已复制'), () => message.error('复制失败，请选择原文手动复制'));
      }}>复制</Button>
    </div>
    {content.warning && <Alert type="warning" showIcon title={content.warning} />}
    {(view === 'raw' || content.kind !== 'json') && content.raw.length > CONTENT_PREVIEW_LIMIT && <Alert type='info' title='仅预览前 200,000 字符；复制可获取收到的全部内容。' />}
    <div className="content-view-body" style={{ maxHeight }}>
      {view === 'raw' || content.kind === 'text' ? <pre>{raw || '（空内容）'}</pre>
        : content.kind === 'markdown' ? <MarkdownContent text={raw} />
          : <JsonContent value={content.value} />}
    </div>
  </section>;
}

function JsonContent({ value }: { value: unknown }) {
  if (Array.isArray(value) && value.length > 0 && value.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    const keys = [...new Set(value.slice(0, 100).flatMap((row) => Object.keys(row)))].slice(0, 20);
    return <PageTable size="small" dataSource={value.map((row, index) => ({ ...row, __content_row_index: index }))} rowKey="__content_row_index"
      scroll={{ x: 'max-content' }} pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (total) => `${total} 项` }}
      columns={keys.map((key) => ({ title: key, key, render: (_value: unknown, row: Record<string, unknown>) => <JsonBranch value={row[key]} depth={1} /> }))} fill={false} />;
  }
  return <JsonBranch value={value} depth={0} />;
}

function JsonBranch({ value, depth }: { value: unknown; depth: number }) {
  if (value === null) return <code className="content-null">null</code>;
  if (value === undefined) return <span className="content-null">—</span>;
  if (typeof value === 'string') return <JsonString value={value} depth={depth} />;
  if (typeof value !== 'object') return <span className={`content-${typeof value}`} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{typeof value === 'string' ? value : String(value)}</span>;
  const entries = Object.entries(value);
  if (depth > 10) return <code>{JSON.stringify(value).slice(0, 1000)}</code>;
  return <details className="content-json-branch" open={depth < 2}>
    <summary>{Array.isArray(value) ? `数组 · ${entries.length} 项` : `对象 · ${entries.length} 个字段`}</summary>
    <dl>{entries.slice(0, 100).map(([key, child]) => <div key={key} data-long-text={typeof child === 'string' && (child.length > 160 || child.includes('\n')) || undefined}><dt>{key}</dt><dd><JsonBranch value={child} depth={depth + 1} /></dd></div>)}</dl>
    {entries.length > 100 && <Typography.Text type="secondary">仅预览前 100 项，原文包含完整内容。</Typography.Text>}
  </details>;
}

function JsonString({ value, depth }: { value: string; depth: number }) {
  const [open, setOpen] = useState(false);
  const candidate = depth < 10 && /^[\s]*[\[{]/.test(value);
  const content = useMemo(() => open && candidate ? detectContent(value) : undefined, [value, open, candidate]);
  if (!candidate && value.length <= 1000) return <span className='content-string'>{value}</span>;
  return <details className='content-json-string' onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{candidate ? 'JSON 字符串' : '长文本'} · {value.length.toLocaleString()} 字符</summary>
    {open && (content?.kind === 'json'
      ? <JsonBranch value={content.value} depth={depth + 1} />
      : <pre>{value.slice(0, CONTENT_PREVIEW_LIMIT)}</pre>)}
    {open && candidate && content?.kind !== 'json' && <span>无法解析为完整 JSON，保留原文。</span>}
    {open && value.length > CONTENT_PREVIEW_LIMIT && content?.kind !== 'json' && <span>仅显示部分文本；完整收到的内容可从顶部复制。</span>}
  </details>;
}

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\))/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part);
    if (link) {
      const href = safeContentHref(link[2]);
      return href ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">{link[1]}</a> : <span key={index}>{link[1]}</span>;
    }
    return part;
  });
}

export function MarkdownContent({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^```/.test(line)) {
      const code: string[] = [];
      const language = line.slice(3).trim();
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      blocks.push(<div className="content-code" key={i}>{language && <small>{language}</small>}<pre><code>{code.join('\n')}</code></pre></div>);
    } else if (/^#{1,6} /.test(line)) {
      const level = line.indexOf(' ');
      blocks.push(<div role="heading" aria-level={level} className={`content-heading content-heading-${level}`} key={i}>{inline(line.slice(level + 1))}</div>);
    } else if (/^([-*+] |\d+\. )/.test(line)) {
      const ordered = /^\d+\./.test(line);
      const pattern = ordered ? /^\d+\. / : /^[-*+] /;
      const items: ReactNode[] = [];
      do { items.push(<li key={i}>{inline(lines[i].replace(pattern, ''))}</li>); i++; } while (i < lines.length && pattern.test(lines[i]));
      i--;
      blocks.push(ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>);
    } else if (/^> /.test(line)) {
      blocks.push(<blockquote key={i}>{inline(line.slice(2))}</blockquote>);
    } else if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={i} />);
    } else if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const headings = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      i--;
      blocks.push(<div className="content-markdown-table" key={i}><table><thead><tr>{headings.map((cell, n) => <th key={n}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, n) => <tr key={n}>{row.map((cell, col) => <td key={col}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>);
    } else {
      blocks.push(<p key={i}>{inline(line)}</p>);
    }
  }
  return <article className="content-markdown">{blocks}</article>;
}
