import type { JSX, ReactNode } from "react";

/**
 * The one filter row: sits between the page header and the table, holds EVERY
 * filter (search box, filter selects, view toggles) left-aligned in one row.
 *
 * The rule it enforces: 表格顶部放筛选条件，右上角放操作控件. Before this row
 * existed the header's right side collected both, and the table top ended up
 * with a single lonely search box — two pages, two mental models.
 *
 * Only spacing lives here: a bottom margin and a wrapping flex gap. Controls
 * bring their own width (SearchInput 260px, selects set their own).
 */
export function FilterBar({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="console-filter-bar">
      {children}
    </div>
  );
}
