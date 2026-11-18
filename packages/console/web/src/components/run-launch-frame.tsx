import type { ReactNode } from 'react';
import { ArrowUpRight, Boxes, Braces, Target } from 'lucide-react';
import { MagicCard } from './magicui/magic-card';
import { BorderBeam } from './magicui/border-beam';
import '../pages/run-workspace.css';

export function RunLaunchFrame({ target, kind, parameterCount, requiredCount, deliveryCount, children }: {
  target: string;
  kind: 'Book' | '流程';
  parameterCount: number;
  requiredCount: number;
  deliveryCount?: number;
  children: ReactNode;
}) {
  return <div className="run-launch-layout">
    <main className="run-launch-fields">{children}</main>
    <aside className="run-launch-summary" aria-label="本次运行摘要">
      <MagicCard className="run-launch-target"><BorderBeam /><div className="run-launch-target-icon" aria-hidden="true"><Target size={24} /></div><span className="run-workspace-eyebrow">READY TO LAUNCH</span><h3>{target}</h3><p>{kind} · 手动触发</p>
        <dl><div><dt><Braces size={13} aria-hidden="true" />输入参数</dt><dd>{parameterCount} 项</dd></div><div><dt>其中必填</dt><dd>{requiredCount} 项</dd></div>{deliveryCount !== undefined && <div><dt><Boxes size={13} aria-hidden="true" />默认交付</dt><dd>{deliveryCount} 项</dd></div>}</dl>
      </MagicCard>
      <div className="run-launch-help"><ArrowUpRight size={16} aria-hidden="true" /><p>确认后会创建运行记录，可在详情页追踪执行步骤与产物。</p></div>
    </aside>
  </div>;
}
