import { useMemo } from "react";
import { useReducedMotion } from 'motion/react';
import ReactEChartsCore from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import { getPalette, useTheme } from "../theme";
import { AXIS } from "./chart-axis";


echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif`;

/** Shared chrome: everything that should look the same on every chart. */
function baseOption(p: ReturnType<typeof getPalette>): EChartsOption {
  return {
    textStyle: { fontFamily: FONT, color: p.ink2 },
    grid: { top: 16, right: 12, bottom: 24, left: 40, containLabel: false },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: `${p.line}` } },
      backgroundColor: p.surface,
      borderWidth: 1,
      borderColor: p.lineStrong,
      padding: [8, 10],
      textStyle: { color: p.ink1, fontSize: 12, fontFamily: FONT },
      // 日模式换轻阴影，夜模式保留深阴影
      extraCssText:
        p.bg === "#F3F5FA"
          ? "box-shadow: 0 8px 24px -8px rgba(0,0,0,.12); border-radius: 6px;"
          : "box-shadow: 0 8px 24px -6px rgba(0,0,0,.55); border-radius: 6px;",
    },
    legend: {
      top: 0,
      right: 0,
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 14,
      textStyle: { color: p.ink3, fontSize: 12, fontFamily: FONT },
    },
  };
}

export function ChartImpl({
  option,
  height = 220,
  loading = false,
}: {
  option: EChartsOption;
  height?: number;
  loading?: boolean;
}) {
  // mode 变化时 palette 自动换色，useMemo 依赖 mode 让 ECharts 重渲
  const { mode } = useTheme();
  const reducedMotion = useReducedMotion();
  const palette = getPalette(mode);

  const merged = useMemo<EChartsOption>(() => {
    const base = baseOption(palette);
    return {
      ...base,
      ...option,
      ...(reducedMotion ? { animation: false } : {}),
      grid: { ...base.grid, ...(option.grid as object) },
      tooltip: { ...base.tooltip, ...(option.tooltip as object) },
      legend: { ...base.legend, ...(option.legend as object) },
    };
  }, [option, palette, reducedMotion]);

  return (
    <ReactEChartsCore
      echarts={echarts}
      option={merged}
      showLoading={loading}
      style={{ height, width: "100%" }}
      notMerge
      lazyUpdate
      opts={{ renderer: "canvas" }}
    />
  );
}
