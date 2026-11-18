/**
 * Where a node gets picked — from the toolbar, from a right-click, or from a
 * double-click on empty canvas.
 *
 * ONE component behind all three, which is the arrangement every tool that got
 * this right converged on: ComfyUI keeps a floating search box and a cascading
 * right-click menu side by side rather than replacing one with the other,
 * because "I know what I want, let me type" and "I don't know what exists, let
 * me look" are different states of mind. Sharing the component is what stops
 * the second entry point from quietly growing a different node list.
 *
 * SEARCH FIRST, GROUPS UNDERNEATH. With nine nodes, typing beats navigating —
 * but the groups are what answer the question the palette actually gets asked,
 * which is not "where is 逐项处理" but "what can I even put here". So the empty
 * state is the full grouped list rather than a blank panel, and each row says
 * WHEN to reach for the node rather than what it is: someone who needs to be
 * told that 条件分支 branches on a condition was not helped.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Typography, theme } from "antd";
import { FLOW_NODE_GROUPS, FLOW_NODE_TYPE_HINTS, FLOW_NODE_TYPE_LABELS, type FlowNodeType } from "@bcp/shared";
import { NodeIcon } from "./NodeIcon";

interface Props {
  onPick: (type: FlowNodeType) => void;
  onClose: () => void;
  /** Where the panel sits. Absent for the toolbar's dropdown, which is
   *  positioned by its trigger. */
  at?: { x: number; y: number };
}

/** Matches a node by its label, its hint, or its internal type name — the last
 *  one because someone reading `graphJson` searches for what they read there. */
function matches(type: FlowNodeType, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    FLOW_NODE_TYPE_LABELS[type].toLowerCase().includes(q) ||
    FLOW_NODE_TYPE_HINTS[type].toLowerCase().includes(q) ||
    type.toLowerCase().includes(q)
  );
}

const WIDTH = 300;
const MAX_HEIGHT = 460;

/** Kept inside the window.
 *
 *  Placing a panel at the cursor is one line; placing it at a cursor near the
 *  bottom edge puts half of it past the fold, where the list simply stops and
 *  nothing says there was more. ComfyUI shipped exactly this and it is still
 *  open as issue #12430 — worth spending five lines to not reproduce. */
function clamp(at: { x: number; y: number }): { left: number; top: number } {
  const margin = 8;
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  return {
    left: Math.max(margin, Math.min(at.x, vw - WIDTH - margin)),
    top: Math.max(margin, Math.min(at.y, vh - MAX_HEIGHT - margin)),
  };
}

export function NodePicker({ onPick, onClose, at }: Props): JSX.Element {
  const { token } = theme.useToken();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const groups = useMemo(
    () =>
      FLOW_NODE_GROUPS.map((g) => ({ ...g, types: g.types.filter((t) => matches(t, query)) })).filter(
        (g) => g.types.length > 0,
      ),
    [query],
  );
  // Flattened in display order, so ↑/↓ walk the list the eye walks.
  const flat = useMemo(() => groups.flatMap((g) => g.types), [groups]);

  useEffect(() => setActive(0), [query]);

  // Anywhere outside closes, including the canvas — a picker that survives a
  // click on the thing you were trying to look at is a picker in the way.
  useEffect(() => {
    const away = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    // `capture` so this runs before React Flow's own canvas handlers, which
    // stop propagation on some events.
    document.addEventListener("mousedown", away, true);
    return () => document.removeEventListener("mousedown", away, true);
  }, [onClose]);

  const keys = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && flat[active]) {
      e.preventDefault();
      onPick(flat[active]);
    }
  };

  return (
    <div
      ref={box}
      onKeyDown={keys}
      style={{
        // Fixed rather than absolute: the coordinates come from a mouse event,
        // which is viewport-relative, and the canvas is transformed.
        ...(at ? { position: "fixed", ...clamp(at), zIndex: 1200 } : {}),
        width: WIDTH,
        maxHeight: MAX_HEIGHT,
        overflowY: "auto",
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 8,
        boxShadow: token.boxShadowSecondary,
        padding: 6,
      }}
    >
      <Input
        autoFocus
        size="small"
        allowClear
        placeholder="搜节点，或直接从下面挑"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 6 }}
      />

      {flat.length === 0 && (
        <div style={{ padding: "10px 8px", color: token.colorTextTertiary, fontSize: 12 }}>没有匹配的节点</div>
      )}

      {groups.map((group) => (
        <div key={group.id} style={{ marginBottom: 4 }}>
          <div style={{ padding: "4px 8px 2px", display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
            <Typography.Text strong style={{ fontSize: 11, flexShrink: 0 }}>
              {group.label}
            </Typography.Text>
            <Typography.Text type="secondary" ellipsis style={{ fontSize: 10, minWidth: 0 }} title={group.hint}>
              {group.hint}
            </Typography.Text>
          </div>
          {group.types.map((type) => {
            const isActive = flat[active] === type;
            return (
              <div
                key={type}
                onMouseEnter={() => setActive(flat.indexOf(type))}
                onClick={() => onPick(type)}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-start",
                  padding: "6px 8px",
                  borderRadius: 6,
                  cursor: "pointer",
                  background: isActive ? token.controlItemBgHover : "transparent",
                }}
              >
                <span style={{ color: token.colorTextSecondary, marginTop: 1 }}>
                  <NodeIcon type={type} size={16} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, lineHeight: "16px" }}>{FLOW_NODE_TYPE_LABELS[type]}</div>
                  <div style={{ fontSize: 11, lineHeight: "15px", color: token.colorTextTertiary }}>
                    {FLOW_NODE_TYPE_HINTS[type]}
                  </div>
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
