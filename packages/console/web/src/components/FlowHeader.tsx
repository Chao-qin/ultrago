/**
 * The flow editor's top bar.
 *
 * It used to be nine controls in one wrapping `<Space>`: back link, flow name,
 * 保存, 校验, 触发, problem pill, 运行记录, undo/redo, a help hint and 添加节点,
 * all the same size and weight. A row of equals is a list, not a toolbar —
 * nothing in it says what you reach for first, and on a narrow window it wrapped
 * onto a second line and ate canvas.
 *
 * Three zones instead, by what the control is FOR:
 *   left    leaving, and undoing — things that act on your session
 *   centre  adding a node, and what is currently wrong — the editing loop
 *   right   committing: save, run, the rest behind one menu, then whose flow
 *           this is
 *
 * 校验 / 运行记录 / the wiring hint moved into that menu because each is either
 * rare (校验 re-runs a check the canvas already shows) or a destination rather
 * than an action. 保存 and 触发 stayed out because they are the two things the
 * page exists to do.
 */
import type { JSX, ReactNode } from "react";
import { Button, Dropdown, Space, Tooltip, Typography, theme } from "antd";
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  HistoryOutlined,
  MoreOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  RedoOutlined,
  SaveOutlined,
  UndoOutlined,
} from "@ant-design/icons";

export const WIRING_HINT =
  "连线：从右侧圆点按住拖到左侧圆点，类型冲突会被拒绝。删除：右键节点或连线，或选中后按 Delete";

export interface FlowHeaderProps {
  flowName: string;
  dirty: boolean;
  /** Rendered in the centre zone as-is; the editor keeps ownership of the
   *  problem popover and its fly-to-node behaviour. */
  children?: ReactNode;
  history: { canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void };
  onBack: () => void;
  onAddNode: (anchor: DOMRect) => void;
  save: { run: () => void; pending: boolean; blocked: boolean; blockedReason?: string };
  trigger: { run: () => void; pending: boolean; blocked: boolean; blockedReason: string };
  check: { run: () => void; pending: boolean; blocked: boolean; blockedReason: string };
  onOpenRuns: () => void;
}

export function FlowHeader({
  flowName,
  dirty,
  children,
  history,
  onBack,
  onAddNode,
  save,
  trigger,
  check,
  onOpenRuns,
}: FlowHeaderProps): JSX.Element {
  const { token } = theme.useToken();
  return (
    <div
      className='flow-workbench-header'
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flexWrap: 'wrap',
        minWidth: 0,
      }}
    >
      <Button size="small" type="text" icon={<ArrowLeftOutlined />} onClick={onBack}>
        返回
      </Button>

      <div className='flow-header-title'><span>FLOW WORKBENCH</span><Typography.Text strong ellipsis={{ tooltip: flowName }}>{flowName || '流程编辑器'}</Typography.Text></div>
      <span className={`flow-save-state ${dirty ? 'is-dirty' : ''}`}>{dirty ? '未保存' : '已保存'}</span>

      <Space.Compact size="small">
        <Tooltip title="撤销（Ctrl+Z）">
          <Button icon={<UndoOutlined />} disabled={!history.canUndo} onClick={history.onUndo} />
        </Tooltip>
        <Tooltip title="重做（Ctrl+Shift+Z）">
          <Button icon={<RedoOutlined />} disabled={!history.canRedo} onClick={history.onRedo} />
        </Tooltip>
      </Space.Compact>

      <span style={{ width: 1, height: 18, background: token.colorBorderSecondary, flexShrink: 0 }} />

      <Button
        size="small"
        type="default"
        icon={<PlusOutlined />}
        onClick={(e) => onAddNode((e.currentTarget as HTMLElement).getBoundingClientRect())}
      >
        添加节点
      </Button>

      {children}

      {/* Everything after this sits on the right. */}
      <span style={{ flex: 1, minWidth: 8 }} />

      <Tooltip title={save.blockedReason}>
        <Button
          size="small"
          type='default'
          icon={<SaveOutlined />}
          loading={save.pending}
          disabled={save.blocked}
          onClick={save.run}
        >
          保存{dirty ? " *" : ""}
        </Button>
      </Tooltip>

      <Tooltip title={trigger.blockedReason}>
        <Button size="small" type='primary' icon={<PlayCircleOutlined />} loading={trigger.pending} disabled={trigger.blocked} onClick={trigger.run}>
          运行流程
        </Button>
      </Tooltip>

      <Dropdown
        trigger={["click"]}
        menu={{
          items: [
            {
              key: "check",
              icon: <CheckCircleOutlined />,
              label: check.blocked ? <Tooltip title={check.blockedReason}>校验</Tooltip> : "校验",
              disabled: check.blocked,
              onClick: check.run,
            },
            { key: "runs", icon: <HistoryOutlined />, label: "运行记录", onClick: onOpenRuns },
            { type: "divider" },
            {
              key: "help",
              icon: <QuestionCircleOutlined />,
              label: <Tooltip title={WIRING_HINT}>连线 / 删除怎么操作</Tooltip>,
            },
          ],
        }}
      >
        <Button size="small" icon={<MoreOutlined />} loading={check.pending} title="更多操作" />
      </Dropdown>

    </div>
  );
}
