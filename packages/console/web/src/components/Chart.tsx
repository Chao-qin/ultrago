import { Suspense, lazy } from "react";
import { Skeleton } from "antd";
import type { EChartsOption } from "echarts";

/**
 * 懒加载边界。
 *
 * ECharts 即使按需注册也有 ~570KB，放进主包等于让每一个页面都为仪表盘的图
 * 买单——而十二个页面里只有一个用得到。切成独立 chunk，进仪表盘时才拉。
 * 同 FlowScriptPanel 对 ScriptEditor 的做法（那边是 470KB 的 CodeMirror）。
 *
 * 图表的公共主题、tree-shaking 的注册清单、坐标轴默认值都在 ChartImpl 里。
 */
const ChartImpl = lazy(() => import("./ChartImpl").then((m) => ({ default: m.ChartImpl })));

export { AXIS } from "./chart-axis";

export function Chart({
  option,
  height = 220,
  loading = false,
}: {
  option: EChartsOption;
  height?: number;
  loading?: boolean;
}) {
  return (
    // 骨架高度与图表一致：加载完不会把下面的内容顶一下
    <Suspense fallback={<Skeleton.Node active style={{ width: "100%", height }} />}>
      <ChartImpl option={option} height={height} loading={loading} />
    </Suspense>
  );
}
