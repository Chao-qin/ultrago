/**
 * One glyph per node type.
 *
 * Drawn rather than imported: an icon set gives you a mail envelope and a
 * database cylinder, and nothing that means "collect the results of a loop".
 * All nine are on the same 20x20 grid with the same 1.5px round-joined stroke,
 * in `currentColor` so a card, a menu row and a disabled item each get the
 * colour they already had.
 *
 * THREE PAIRS ARE MIRRORS, which is the whole reason these are hand-drawn:
 * 入参/出参, 条件分支/分支汇合, and 逐项处理/收集结果 each split and rejoin,
 * and drawing the second as the first reflected means recognising one teaches
 * you the other. The pairs that must be used together look like they belong
 * together — which is the thing the palette most needs to say, since a map
 * without its collect is the mistake everyone makes first.
 */
import type { FlowNodeType } from "@bcp/shared";

const GLYPHS: Record<FlowNodeType, JSX.Element> = {
  // 进门：箭头顶住一条竖线
  flowInput: (
    <>
      <path d="M2 10h9" />
      <path d="M8 7l3 3-3 3" />
      <path d="M15 4v12" />
    </>
  ),
  // 出门：同一个图形左右翻转
  flowOutput: (
    <>
      <path d="M9 10h9" />
      <path d="M15 7l3 3-3 3" />
      <path d="M5 4v12" />
    </>
  ),
  // 浏览器窗口 + 播放三角
  book: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M2.5 7.5h15" />
      <path d="M8.5 10.5l3.5 2-3.5 2z" />
    </>
  ),
  // 终端窗口 + 提示符
  script: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M6 8.5l2 2-2 2" />
      <path d="M10.5 13h4" />
    </>
  ),
  // 左右各三点，中间交叉 —— 字段重映射
  transform: (
    <>
      <circle cx="4" cy="5" r="1.2" />
      <circle cx="4" cy="10" r="1.2" />
      <circle cx="4" cy="15" r="1.2" />
      <circle cx="16" cy="5" r="1.2" />
      <circle cx="16" cy="10" r="1.2" />
      <circle cx="16" cy="15" r="1.2" />
      <path d="M5.6 5l8.8 5" />
      <path d="M5.6 15l8.8-5" />
      <path d="M5.6 10h8.8" />
    </>
  ),
  // 菱形判断 + 右侧分叉
  branch: (
    <>
      <path d="M7 10L10 6.5l3 3.5-3 3.5z" />
      <path d="M2 10h5" />
      <path d="M13 10h2l2-3.5" />
      <path d="M15 10l2 3.5" />
    </>
  ),
  // 分叉的镜像：两条汇进一条
  merge: (
    <>
      <path d="M13 10L10 6.5 7 10l3 3.5z" />
      <path d="M18 10h-5" />
      <path d="M7 10H5L3 6.5" />
      <path d="M5 10l-2 3.5" />
    </>
  ),
  // 循环箭头，环内一个方块 = 逐项
  map: (
    <>
      <path d="M16 7.5a7 7 0 1 0 .6 5" />
      <path d="M16.6 3.5v4h-4" />
      <rect x="8" y="8" width="4" height="4" rx="0.8" />
    </>
  ),
  // 一个框，里面装着一小段流程 —— 「另一条流程，当成一个节点」
  flow: (
    <>
      <rect x="2.5" y="4" width="15" height="12" rx="2" />
      <circle cx="7" cy="10" r="1.6" />
      <circle cx="13.5" cy="10" r="1.6" />
      <path d="M8.6 10h3.3" />
    </>
  ),
  // 漏斗 + 落入的颗粒 —— 逐项的镜像动作：收拢
  collect: (
    <>
      <path d="M3 4.5h14l-5.5 6.5v5l-3 1.5v-6.5z" />
      <circle cx="6.5" cy="2" r="0.9" />
      <circle cx="10" cy="1.6" r="0.9" />
      <circle cx="13.5" cy="2" r="0.9" />
    </>
  ),
};

export function NodeIcon({ type, size = 16 }: { type: FlowNodeType; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative: every place this appears already carries the node's name in
      // text, so announcing the glyph too would read the same thing twice.
      aria-hidden="true"
      style={{ flexShrink: 0, display: "block" }}
    >
      {GLYPHS[type]}
    </svg>
  );
}
