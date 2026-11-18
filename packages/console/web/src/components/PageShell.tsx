import type { JSX, ReactNode } from "react";
import { PageHeader } from "./PageHeader";
import { FilterBar } from "./FilterBar";

/**
 * The列表页 skeleton, as a component rather than as a paragraph in a spec.
 *
 * `docs/console-web-ui-unify.md` §1.2 already prescribed this exact stack —
 * page-fill wrapper, PageHeader, FilterBar, table — and every list page then
 * hand-assembled it. A written convention only holds while everyone remembers
 * to read it; the tenth page is where it breaks. This makes the shape the
 * default you get for free and the deviation the thing you have to write.
 *
 * It deliberately does NOT own the table. 运行记录 puts Tabs between the filters
 * and its table, and a shell that insisted on `<table goes here>` would either
 * shut that page out or grow a flag for it. Children go under the filter row,
 * whatever they are.
 */
export function PageShell({
  title,
  subtitle,
  actions,
  filters,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Right-hand side of the header. Operations only — 新建 / 重新扫描 / 注册.
   *  Filters belong in `filters`; that split is the rule FilterBar exists for. */
  actions?: ReactNode;
  /** The filter row. Omit entirely on pages with nothing to filter. */
  filters?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="page-fill console-list-workspace">
      <section className="console-workspace-intro" aria-label={`${title}工作区`}>
        <span className="console-workspace-eyebrow">WORKSPACE / {title}</span>
        <PageHeader title={title} subtitle={subtitle} actions={actions} />
        {filters && <FilterBar>{filters}</FilterBar>}
      </section>
      {children}
    </div>
  );
}
