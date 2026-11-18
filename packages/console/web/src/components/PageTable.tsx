import type { JSX, ReactNode } from "react";
import { Table } from "antd";
import type { TableProps } from "antd";
import type { ColumnsType } from "antd/es/table";
import { EmptyState, ErrorState } from "./EmptyState";
import { TextClamp } from "./TextClamp";

/** The three fields this component needs off a react-query result. Structural,
 *  not the real `UseQueryResult`, so a page can hand-roll one if it has to. */
export type TableQuery = {
  isLoading: boolean;
  error: unknown;
  refetch: () => unknown;
};

type PageTableProps<RecordType> = TableProps<RecordType> & {
  className?: string;
  /**
   * The list query. Supplying it wires loading, error and retry in one prop.
   *
   * Doing that by hand is three lines per page that are identical everywhere
   * and silent when wrong — the `error` line in particular was missing from
   * ALL NINE list pages, so a dead backend rendered as an empty table. Wiring
   * a query is now one thing to remember instead of three.
   */
  query?: TableQuery;
  /** Escape hatches, and what `query` feeds. Explicit props win. */
  error?: unknown;
  onRetry?: () => void;
  /** What to say when the query succeeded and there genuinely are no rows. */
  empty?: { title: string; description?: ReactNode; action?: ReactNode };
  /**
   * Whether the table fills its parent's height and scrolls inside its own
   * body (list pages), or grows with its content and lets the page scroll
   * (detail / drawer tables). Default `true`.
   *
   * - `fill` (default): `scroll.y` dummy + flex-fill host, body scrolls
   *   internally. Needs a flex-column parent with a bounded height.
   * - `fill={false}`: natural height, no forced `scroll.y` / `tableLayout`,
   *   `scroll` and `tableLayout` pass straight through from props. Use this
   *   for tables inside Cards / Drawers that should flow with the document.
   */
  fill?: boolean;
};

function withDefaultTextEllipsis<RecordType extends object>(columns: ColumnsType<RecordType> | undefined): ColumnsType<RecordType> | undefined {
  return columns?.map((column) => {
    if ("children" in column) {
      return { ...column, children: withDefaultTextEllipsis(column.children) ?? [] };
    }
    if (column.render || column.ellipsis === false || !column.dataIndex) return column;
    return {
      ...column,
      ellipsis: column.ellipsis ?? { showTitle: false },
      render: (value: unknown): ReactNode =>
        typeof value === "string"
          ? <TextClamp text={value} rows={1} />
          : typeof value === "number" || typeof value === "boolean"
            ? value
            : null,
    };
  });
}

/**
 * A list table that scrolls INSIDE its own body instead of stretching the
 * page, by pure CSS flex — no JS measurement at all.
 *
 * The first cut of this component measured the wrapper with a
 * ResizeObserver + MutationObserver and wrote the result back as antd's
 * `scroll.y`. That is a render → measure → re-render feedback loop, and it is
 * the only mechanism that can produce the "table slowly shrinks while
 * scrolling, ends up a few pixels tall" report: one transient mis-measure
 * (mid-animation, mid-font-load, fractional-zoom rounding) gets written back,
 * antd re-renders, the observer fires again — and a guard can only stop the
 * loop while the value is stable, not when it drifts.
 *
 * The CSS version has nothing to loop: `scroll.y` is a dummy (1px, just to
 * make antd render the fixed-header body division), and `index.css` flexes
 * `.page-table-fill` so the body takes exactly the space left under the
 * header and pagination, at any wrapper height, with zero observers.
 */
export function PageTable<RecordType extends object = any>({
  scroll,
  columns,
  className,
  query,
  error,
  onRetry,
  loading,
  empty,
  locale,
  fill = true,
  tableLayout,
  ...rest
}: PageTableProps<RecordType>): JSX.Element {
  // Explicit props win over the query, so a page with two data sources (Runs
  // filters client-side across tabs) can still say exactly what it means.
  const resolvedError = error ?? query?.error ?? undefined;
  const resolvedLoading = loading ?? query?.isLoading;
  const resolvedRetry = onRetry ?? (query ? () => query.refetch() : undefined);

  // A failed query outranks an empty one. Before this, every list page dropped
  // its `useQuery` error on the floor and rendered the empty placeholder, so a
  // backend that was down was indistinguishable from a console with no data.
  const emptyText = resolvedError ? (
    <ErrorState error={resolvedError} onRetry={resolvedRetry} />
  ) : empty ? (
    <EmptyState {...empty} />
  ) : undefined;
  const displayColumns = withDefaultTextEllipsis(columns);

  // fill (list pages): flex-fill host + scroll.y dummy, so the body scrolls
  // inside itself. page-table-fill CSS makes the body take the leftover height
  // with zero JS measurement.
  // fill={false} (detail/drawer): natural height — pass scroll / tableLayout
  // straight through, and don't apply the fill host styles or class.
  const hostStyle = fill
    ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" } as const
    : undefined;
  const tableClassName = fill
    ? (className ? `page-table-fill ${className}` : "page-table-fill")
    : className;
  const mergedScroll = fill
    ? { x: "max-content", ...(scroll ?? {}), y: 1 }
    : scroll;
  const mergedTableLayout = fill ? "fixed" : tableLayout;

  return (
    <div className="page-table-host" style={hostStyle}>
      <Table<RecordType>
        {...rest}
        tableLayout={mergedTableLayout}
        columns={displayColumns}
        loading={resolvedLoading}
        // Merged rather than replaced so a page can still override other locale
        // keys (filter/sort labels) without losing the shared empty state.
        locale={emptyText ? { ...locale, emptyText } : locale}
        className={tableClassName}
        scroll={mergedScroll}
      />
    </div>
  );
}
