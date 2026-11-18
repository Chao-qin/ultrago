import { useState } from 'react';
import { Button } from 'antd';
import { ArrowRight, ChevronDown, RefreshCw, ShieldAlert, Unplug } from 'lucide-react';
import { m, useReducedMotion } from 'motion/react';
import { MagicCard } from './magicui/magic-card';
import { BorderBeam } from './magicui/border-beam';
import './service-recovery.css';

export type RecoveryIssue = { id: string; label: string; error: unknown; description?: string };

function errorInfo(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '未知错误');
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number(error.status)
    : Number(message.match(/^\s*(\d{3})\b/)?.[1]);
  return { message, status };
}

export function ServiceRecoveryPanel({ title, description, issues, onRetry, retrying = false, compact = false, retryLabel = '重新加载数据' }: {
  title: string;
  description: string;
  issues: RecoveryIssue[];
  onRetry?: () => unknown;
  retrying?: boolean;
  compact?: boolean;
  retryLabel?: string;
}) {
  const reducedMotion = useReducedMotion();
  const [pending, setPending] = useState(false);
  const [retryError, setRetryError] = useState<unknown>();
  const denied = issues.some(issue => [401, 403].includes(errorInfo(issue.error).status));
  const Icon = denied ? ShieldAlert : Unplug;
  const busy = retrying || pending;

  async function retry() {
    setPending(true);
    setRetryError(undefined);
    try { await onRetry?.(); }
    catch (error) { setRetryError(error); }
    finally { setPending(false); }
  }

  return (
    <MagicCard className={`service-recovery${compact ? ' is-compact' : ''}`}>
      <BorderBeam />
      <div className="recovery-heading">
        <div className="recovery-signal" aria-hidden="true">
          <m.svg viewBox="0 0 80 80" animate={reducedMotion ? undefined : { rotate: 360 }} transition={{ duration: 28, repeat: Infinity, ease: 'linear' }}>
            <circle cx="40" cy="40" r="34" /><circle cx="40" cy="6" r="3" />
          </m.svg>
          <Icon size={23} />
        </div>
        <div className="recovery-copy" role="alert">
          <span className="recovery-eyebrow">{denied ? 'ACCESS RESTRICTED' : 'CONNECTION INTERRUPTED'}</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {onRetry && <Button type="primary" className="recovery-retry" loading={busy} disabled={busy} icon={!busy && <RefreshCw size={15} aria-hidden="true" />} onClick={() => void retry()}>
          {busy ? '正在重新连接' : retryLabel}<ArrowRight size={14} aria-hidden="true" />
        </Button>}
      </div>
      <div className="recovery-issues">
        {issues.map(issue => {
          const { message, status } = errorInfo(issue.error);
          const explanation = status === 403 ? '服务器拒绝了访问，请检查访问权限或当前服务入口。'
            : status === 401 ? '当前访问凭证无效，请检查登录状态。'
            : issue.description ?? '服务暂时没有响应，恢复后可重新获取数据。';
          return <div className="recovery-issue" key={issue.id}>
            <div className="recovery-issue-label"><i aria-hidden="true" /><strong>{issue.label}</strong><span>{Number.isFinite(status) ? `HTTP ${status}` : '连接中断'}</span></div>
            <p>{explanation}</p>
            <details><summary>技术详情<ChevronDown size={12} aria-hidden="true" /></summary><pre>{message}</pre></details>
          </div>;
        })}
      </div>
      {retryError !== undefined && <p className="recovery-retry-error" role="alert">重新连接未成功：{errorInfo(retryError).message}</p>}
    </MagicCard>
  );
}
