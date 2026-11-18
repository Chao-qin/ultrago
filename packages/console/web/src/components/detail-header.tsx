import type { ReactNode } from 'react';
import { Button } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { PageHeader } from './PageHeader';

export function DetailHeader({ title, subtitle, actions, onBack }: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  onBack: () => void;
}) {
  return (
    <header className="console-detail-header">
      <div className="console-detail-path"><Button className="console-detail-back" type="text" icon={<ArrowLeftOutlined aria-hidden="true" />} onClick={onBack}>返回</Button><span>DETAIL WORKSPACE</span></div>
      <div className="console-detail-intro"><PageHeader title={title} subtitle={subtitle} actions={actions} /></div>
    </header>
  );
}
