import { getRunStatusMeta } from "../lib/types";
import type { RunStatus } from "../lib/types";

/**
 * 运行状态药丸。
 *
 * antd Tag 的预设色在暗底上是"贴纸"，这里是"指示灯"：半透明药丸 + 发色圆点，
 * 颜色从 group 语义映射（与 Mission Control 同一套：绿成功 / 红失败 / 琥珀
 * 待办 / 天蓝在跑 / 灰取消）。active 组的圆点常脉——跑着的东西自己会呼吸。
 *
 * escalated 特例：它不是"更糟的失败"，是门禁未达成而有序停下（见 shared 里
 * RUN_STATUS_META 的注释），所以给它独立的紫，而不是跟着 failed 走红。
 */
const GROUP_STYLE: Record<string, string> = {
  success: "#34D399",
  failed: "#F87171",
  attention: "#FBBF24",
  cancelled: "#8B95AB",
  active: "#38BDF8",
};

const STATUS_OVERRIDE: Record<string, string> = {
  escalated: "#A78BFA",
};

function isPulsing(status: string): boolean {
  return ["queued", "starting", "running"].includes(status);
}

export function RunStatusTag({ status }: { status: RunStatus | string }) {
  const meta = getRunStatusMeta(status);
  const color = STATUS_OVERRIDE[status] ?? GROUP_STYLE[meta.group] ?? "#8B95AB";
  const rgba = (alpha: number) => {
    const hex = color.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };
  return (
    <span
      className="status-pill"
      style={{ color, borderColor: rgba(0.32), background: rgba(0.10) }}
      title={meta.label}
    >
      <span className={`status-pill-dot${isPulsing(status) ? " live" : ""}`} />
      {meta.label}
    </span>
  );
}
