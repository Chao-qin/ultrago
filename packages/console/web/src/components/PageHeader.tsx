import { Space } from "antd";
import { m } from 'motion/react';

/**
 * The one page header. Title (+ optional subtitle) on the left, page actions on
 * the right — every list page used to hand-roll this row, and they had drifted
 * into four shapes: some had no header at all, some put the toggles on the
 * left beside the title, one used a Tag as a fake subtitle. Centralising it is
 * what keeps the next page from inventing shape number five.
 *
 * HUD 化（样式在 index.css 的 `.page-header`）：左侧一道 accent 辉光竖条
 * 点题，标题加字距——与 Mission Control 的段落标题同一套语言。结构不变，
 * 页面调用方式零改动。
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}): JSX.Element {
  return (
    <m.div className="page-header" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div>
        <h1 className="page-header-title">{title}</h1>
        {subtitle && <div className="page-header-subtitle">{subtitle}</div>}
      </div>
      {actions && <Space wrap size={8}>{actions}</Space>}
    </m.div>
  );
}
