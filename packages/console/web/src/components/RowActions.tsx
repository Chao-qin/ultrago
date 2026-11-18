import { useState } from "react";
import { Button, Dropdown, Popconfirm, Space, Tooltip, Typography } from "antd";
import type { MenuProps } from "antd";
import {
  CaretRightOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  HistoryOutlined,
  MoreOutlined,
  RollbackOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";

/**
 * The one shape a table's 操作 column takes.
 *
 * Before this existed the nine list pages had five different answers — a filled
 * primary button on Books, a bare `<Link>` on 运行记录, icon-only buttons behind
 * tooltips on 定时任务 and Schema 契约, `type="link"` text buttons on 事件通知,
 * and 定时脚本 managed to mix icon-only and text buttons inside one cell. Two
 * different delete confirmations were in play as well (`Popconfirm` on four
 * pages, `Modal.confirm` on two), so "are you sure" looked like a different
 * product depending on which row you were on.
 *
 * The rules, and they are the whole component:
 *
 *   1. Actions render as small tinted pills with an icon + word. The icon keeps
 *      scan speed high; the word removes the "hover to find out what it does"
 *      tax a pure-icon button charges.
 *   2. Up to `maxInline` (3) sit on the row. Past that the tail collapses into
 *      a ⋯ menu, so the column has a bounded width no matter how many actions a
 *      page invents.
 *   3. Destructive actions render in red behind a confirm — always, everywhere.
 *   4. The icon is optional: pass one, or let `ACTION_ICONS` pick it from the
 *      action key. Pages that want no icon pass `icon: null`.
 *
 * The bounded width is what makes the `fixed: "right"` from the earlier change
 * pay off: 定时任务 used to spend 200px and 定时脚本 220px of pinned width.
 */

export type RowAction = {
  key: string;
  label: ReactNode;
  onClick: () => void;
  /** Renders in red and, unless `confirm` is explicitly false, behind a confirm. */
  danger?: boolean;
  /** Confirm copy. Destructive actions get one by default; pass `false` to opt out. */
  confirm?: { title: ReactNode; description?: ReactNode } | false;
  disabled?: boolean;
  /** Why this action is unavailable. Shown as a tooltip when `disabled`. */
  disabledReason?: string;
  loading?: boolean;
  /**
   * Button icon. Omit to auto-pick from `ACTION_ICONS` by `key`; pass `null`
   * to render text-only.
   */
  icon?: ReactNode;
};

/** Default icon per common action key. Pages override with `action.icon`. */
export const ACTION_ICONS: Record<string, ReactNode> = {
  run: <CaretRightOutlined />,
  edit: <EditOutlined />,
  delete: <DeleteOutlined />,
  detail: <EyeOutlined />,
  view: <EyeOutlined />,
  restore: <RollbackOutlined />,
  history: <HistoryOutlined />,
  test: <ThunderboltOutlined />,
  download: <DownloadOutlined />,
  ack: <CheckCircleOutlined />,
};

export type RowActionsProps = {
  /** In display order. Falsy entries are dropped, so a page can inline a
   *  condition (`cond && {...}`) without building the array by hand. */
  actions: Array<RowAction | false | null | undefined>;
  /** How many sit on the row before the rest collapse into ⋯. Default 3. */
  maxInline?: number;
  /** Shown when nothing is actionable — soft-deleted rows, mostly. */
  placeholder?: ReactNode;
};

/** Spread into a page's 操作 column so the pinning is declared once rather than
 *  nine times. `width` is the 3-inline case; pages with fewer actions narrow it. */
export const ROW_ACTIONS_COLUMN = {
  title: "操作",
  key: "action",
  width: 200,
  fixed: "right" as const,
};

type Confirmation = { title: ReactNode; description?: ReactNode };

function confirmFor(action: RowAction): Confirmation | null {
  if (action.confirm === false) return null;
  if (action.confirm) return action.confirm;
  return action.danger ? { title: "确定执行此操作？" } : null;
}

function iconFor(action: RowAction): ReactNode {
  if (action.icon === null) return null;
  const icon = action.icon ?? ACTION_ICONS[action.key];
  return icon ? <span aria-hidden="true">{icon}</span> : null;
}

export function RowActions({ actions, maxInline = 3, placeholder }: RowActionsProps) {
  // The ⋯ menu unmounts the moment you click an item, taking any popup rendered
  // inside it along. So confirmations for overflow items are one controlled
  // Popconfirm mounted on its own zero-size anchor next to the button — NOT
  // wrapped around the Dropdown, which made the two overlays fight over the
  // same trigger element and left the popup stuck open after 取消.
  const [pending, setPending] = useState<{ action: RowAction; confirm: Confirmation } | null>(null);

  const live = actions.filter((a): a is RowAction => !!a);
  if (live.length === 0) {
    return <Typography.Text type="secondary">{placeholder ?? "—"}</Typography.Text>;
  }

  // Collapse as soon as we exceed maxInline: the ⋯ button roughly matches one
  // text button in width, so 4 actions → 3 inline + ⋯ is always tighter than 4 inline.
  const collapse = live.length > maxInline;
  const inline = collapse ? live.slice(0, maxInline) : live;
  const overflow = collapse ? live.slice(maxInline) : [];

  const items: MenuProps["items"] = overflow.map((action) => ({
    key: action.key,
    icon: iconFor(action),
    label:
      action.disabled && action.disabledReason ? (
        <Tooltip title={action.disabledReason} placement="left">
          <span>{action.label}</span>
        </Tooltip>
      ) : (
        action.label
      ),
    danger: action.danger,
    disabled: action.disabled,
  }));

  const onMenuClick: MenuProps["onClick"] = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    const action = overflow.find((a) => a.key === key);
    if (!action || action.disabled) return;
    const confirm = confirmFor(action);
    if (confirm) setPending({ action, confirm });
    else action.onClick();
  };

  return (
    <Space size={6} onClick={(e) => e.stopPropagation()}>
      {inline.map((action) => (
        <InlineAction key={action.key} action={action} />
      ))}
      {items.length > 0 && (
        <>
          <Dropdown menu={{ items, onClick: onMenuClick }} trigger={["click"]} placement="bottomRight">
            <Button
              size="small"
              type="text"
              className="row-action-btn"
              icon={<MoreOutlined />}
              aria-label="更多操作"
            />
          </Dropdown>
          <Popconfirm
            open={!!pending}
            title={pending?.confirm.title}
            description={pending?.confirm.description}
            okText="确定"
            cancelText="取消"
            okButtonProps={{ danger: pending?.action.danger }}
            onConfirm={() => {
              pending?.action.onClick();
              setPending(null);
            }}
            // `open` is controlled, so this is the close path — 取消, Esc and
            // click-away all arrive here.
            onOpenChange={(next) => {
              if (!next) setPending(null);
            }}
            placement="bottomRight"
          >
            <span style={{ display: "inline-block", width: 0, height: 0 }} />
          </Popconfirm>
        </>
      )}
    </Space>
  );
}

function InlineAction({ action }: { action: RowAction }) {
  const confirm = confirmFor(action);
  const icon = iconFor(action);
  const button = (
    <Button
      size="small"
      type="text"
      className="row-action-btn"
      danger={action.danger}
      loading={action.loading}
      disabled={action.disabled}
      icon={icon}
      onClick={confirm ? undefined : action.onClick}
    >
      {action.label}
    </Button>
  );
  const withTooltip =
    action.disabled && action.disabledReason ? (
      <Tooltip title={action.disabledReason}>
        <span>{button}</span>
      </Tooltip>
    ) : (
      button
    );
  // An inline action owns its own uncontrolled Popconfirm — antd opens and
  // closes it natively, with none of the controlled-state bookkeeping the
  // overflow menu needs.
  if (!confirm || action.disabled) return withTooltip;
  return (
    <Popconfirm
      title={confirm.title}
      description={confirm.description}
      okText="确定"
      cancelText="取消"
      okButtonProps={{ danger: action.danger }}
      onConfirm={action.onClick}
    >
      {withTooltip}
    </Popconfirm>
  );
}
