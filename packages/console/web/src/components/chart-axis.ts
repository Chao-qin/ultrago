import { palette } from "../theme";

/**
 * 坐标轴默认值：发丝线轴、无刻度、虚线分隔线。
 *
 * 单独一个模块而不是放在 ChartImpl 里，是因为 Chart.tsx 要把它 re-export 出去
 * 给页面用——而**从懒加载模块里静态 re-export 任何东西都会把它拽回主 chunk**，
 * 那样 ECharts 的 570KB 就白拆了（实测：主包纹丝不动地停在 2154KB）。
 * 这里只有普通对象，不碰 echarts 运行时。
 */
export const AXIS = {
  category: {
    type: "category" as const,
    axisLine: { lineStyle: { color: palette.line } },
    axisTick: { show: false },
    axisLabel: { color: palette.ink3, fontSize: 11 },
  },
  value: {
    type: "value" as const,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: palette.line, type: "dashed" as const } },
    axisLabel: { color: palette.ink3, fontSize: 11 },
  },
};
