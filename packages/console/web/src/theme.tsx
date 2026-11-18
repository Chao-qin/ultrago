import { createContext, useContext, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { theme as antdTheme, ConfigProvider } from "antd";
import type { ThemeConfig } from "antd";
import zhCN from "antd/locale/zh_CN";
import { LazyMotion, MotionConfig, domAnimation, useReducedMotion } from 'motion/react';

/**
 * 色板 —— 两套，日夜切换时整块替换。
 *
 * 设计原则：语义色（ok/bad/warn/info）不跟着 accent 漂，但日夜之间会调亮度——
 * 暗底要亮色（#34D399 在黑底上可读），亮底要暗色（#16A34A 在白底上可读）。
 * 灰阶也是镜像翻转的：dark 的 bg 是深空，light 的 bg 是冷白。
 */
export const paletteDark = {
  bg: "#05070F",
  surface: "#0B101D",
  subtle: "#151C2C",
  line: "#232C40",
  lineStrong: "#33405C",
  ink1: "#E8EDF7",
  ink2: "#A9B4C9",
  ink3: "#6E7A94",
  ok: "#34D399",
  bad: "#F87171",
  warn: "#FBBF24",
  info: "#5CA8FF",
  badBg: "#2A1518",
} as const;

export const paletteLight = {
  bg: "#F3F5FA",
  surface: "#FFFFFF",
  subtle: "#F0F3F8",
  line: "#E2E7F0",
  lineStrong: "#CDD5E3",
  ink1: "#0B1020",
  ink2: "#4B5570",
  ink3: "#8690A5",
  ok: "#16A34A",
  bad: "#DC2626",
  warn: "#D97706",
  info: "#2563EB",
  badBg: "#FEF2F2",
} as const;

export type ThemeMode = "dark" | "light";

/** 向后兼容：SettingsAppearance 还在用 palette.xxx —— 它永远拿到当前模式的色板 */
export function getPalette(mode: ThemeMode) {
  return mode === "dark" ? paletteDark : paletteLight;
}
/** 默认导出为 dark（保持原有引用不炸），运行时由 ThemeProvider 注入正确的一套 */
export const palette = paletteDark;

export type AccentPreset = { key: string; label: string; value: string };

/**
 * Accent presets —— 日夜共用同六个色号。
 * 日模式下 antd 的 defaultAlgorithm 会把它们作为暗色按钮底色自动配上白字，
 * 日模式的辉光强度也由 CSS 层单独调低（见 index.css 的 [data-theme="light"] 覆盖）。
 */
export const ACCENT_PRESETS: AccentPreset[] = [
  { key: "tech-cyan", label: "科技青", value: "#22D3EE" },
  { key: "azure", label: "天青", value: "#38BDF8" },
  { key: "indigo", label: "靛蓝", value: "#818CF8" },
  { key: "teal", label: "松绿", value: "#34D399" },
  { key: "plum", label: "梅子", value: "#E879F9" },
  { key: "amber", label: "琥珀", value: "#FBBF24" },
];

export const DEFAULT_ACCENT = ACCENT_PRESETS[0].value;

const ACCENT_KEY = "bcp-console-accent";
const MODE_KEY = "bcp-console-mode";
const HEX = /^#[0-9a-fA-F]{6}$/;
const LEGACY_DEFAULT_ACCENT = "#0B0F19";

function readAccent(): string {
  try {
    const stored = localStorage.getItem(ACCENT_KEY);
    if (stored && HEX.test(stored)) {
      return stored.toUpperCase() === LEGACY_DEFAULT_ACCENT ? DEFAULT_ACCENT : stored;
    }
  } catch { /* noop */ }
  return DEFAULT_ACCENT;
}
function persistAccent(accent: string): void {
  try {
    if (accent === DEFAULT_ACCENT) localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, accent);
  } catch { /* noop */ }
}

function readMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch { /* noop */ }
  // 首访读系统偏好，fallback 到 dark（项目默认）
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}
function persistMode(mode: ThemeMode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* noop */ }
}

const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif`;

function buildTheme(accent: string, mode: ThemeMode, reducedMotion: boolean): ThemeConfig {
  const p = getPalette(mode);
  const isDark = mode === "dark";
  const algorithm = isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm;

  // Light 模式 accent 作为按钮底色时，暗色文字可读性检查反过来：
  // 亮色 → 白字（正常），暗色 → 深底白字也 OK。实际上用 defaultAlgorithm 时 antd
  // 会自动做 colorTextLightSolid，这里只给 dark mode 的 bright accent 做显式处理。
  const textOnPrimary = isDark
    ? (accentFailsWhiteText(accent) ? "#0B0F19" : "#FFFFFF")
    : (accentFailsWhiteText(accent) ? "#0B0F19" : "#FFFFFF");

  return {
    algorithm,
    token: {
      motion: !reducedMotion,
      colorPrimary: accent,
      colorLink: accent,
      colorInfo: p.info,
      colorSuccess: p.ok,
      colorError: p.bad,
      colorWarning: p.warn,
      colorTextBase: p.ink1,
      colorBgBase: p.surface,
      colorBgLayout: p.bg,
      colorBorder: p.lineStrong,
      colorBorderSecondary: p.line,
      colorTextLightSolid: textOnPrimary,
      borderRadius: 10,
      fontSize: 13,
      fontFamily: FONT_STACK,
    },
    components: {
      Tooltip: {
        colorBgSpotlight: p.surface,
        colorTextLightSolid: p.ink1,
        colorText: p.ink1,
        colorTextSecondary: p.ink2,
      },
      Popover: {
        colorBgElevated: p.surface,
        colorText: p.ink1,
        colorTextHeading: p.ink1,
        colorTextSecondary: p.ink2,
      },
      Table: {
        colorBgContainer: isDark ? "#0C1120" : "#FAFBFD",
        headerBg: "transparent",
        headerColor: p.ink3,
        headerSplitColor: "transparent",
        borderColor: p.line,
        rowHoverBg: isDark ? "rgba(34, 211, 238, 0.06)" : "rgba(0, 0, 0, 0.035)",
        cellPaddingBlock: 9,
        cellPaddingInline: 12,
        cellPaddingBlockMD: 9,
        cellPaddingInlineMD: 12,
        cellPaddingBlockSM: 7,
        cellPaddingInlineSM: 10,
      },
      Card: { bodyPadding: 20, headerFontSize: 14, borderRadiusLG: 14 },
      Button: { controlHeight: 34, borderRadius: 8, fontWeight: 500 },
      Input: { controlHeight: 34, activeShadow: `0 0 0 3px ${accent}18` },
      Select: { controlHeight: 34 },
      Modal: { borderRadiusLG: 16 },
      Statistic: { titleFontSize: 12, contentFontSize: 28 },
      Menu: {
        itemHeight: 36,
        itemMarginBlock: 2,
        itemMarginInline: 4,
        itemBorderRadius: 8,
        iconMarginInlineEnd: 10,
        groupTitleFontSize: 11,
        groupTitleLineHeight: "22px",
        groupTitleColor: p.ink3,
        itemSelectedBg: "transparent",
        itemSelectedColor: p.ink1,
        itemHoverBg: "transparent",
        itemColor: p.ink2,
      },
      Layout: { bodyBg: p.bg, lightSiderBg: p.surface, triggerHeight: 48 },
    },
  };
}

/** 把当前模式的色板 + accent 挂到 :root，让 index.css 的 --c-* 变量自动换色 */
function cssVars(accent: string, mode: ThemeMode): Record<string, string> {
  const p = getPalette(mode);
  const isDark = mode === "dark";
  return {
    "--c-bg": p.bg,
    "--c-surface": p.surface,
    // 表格容器底色（= Table.colorBgContainer）。固定列必须用这个实色，
    // 否则横向滚动时其它列会从透明的表头/单元格下面穿帮。
    "--c-table-bg": isDark ? "#0C1120" : "#FAFBFD",
    "--c-subtle": p.subtle,
    "--c-line": p.line,
    "--c-line-strong": p.lineStrong,
    "--c-ink-1": p.ink1,
    "--c-ink-2": p.ink2,
    "--c-ink-3": p.ink3,
    "--c-ok": p.ok,
    "--c-bad": p.bad,
    "--c-warn": p.warn,
    "--c-info": p.info,
    "--c-accent": accent,
    "--c-accent-ink": accentFailsWhiteText(accent) ? '#0B0F19' : '#FFFFFF',
  };
}

export function accentFailsWhiteText(hex: string): boolean {
  if (!HEX.test(hex)) return false;
  const channel = (start: number) => parseInt(hex.slice(start, start + 2), 16) / 255;
  const linear = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance =
    0.2126 * linear(channel(1)) + 0.7152 * linear(channel(3)) + 0.0722 * linear(channel(5));
  return 1.05 / (luminance + 0.05) < 4.5;
}

type ThemeContext = {
  accent: string;
  setAccent: (next: string) => void;
  isDefault: boolean;
  mode: ThemeMode;
  setMode: (next: ThemeMode) => void;
  toggleMode: () => void;
};

const Ctx = createContext<ThemeContext | null>(null);

export function useTheme(): ThemeContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
/** 兼容旧调用：useAccent() 现在返回 ThemeContext 的 accent 子集 */
export function useAccent() {
  const { accent, setAccent, isDefault } = useTheme();
  return { accent, setAccent, isDefault };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  const [accent, setAccentState] = useState(readAccent);
  const [mode, setModeState] = useState<ThemeMode>(readMode);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const vars = cssVars(accent, mode);
    for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
    root.dataset.theme = mode;
    root.style.colorScheme = mode;
  }, [accent, mode]);

  const value = useMemo<ThemeContext>(
    () => ({
      accent,
      isDefault: accent === DEFAULT_ACCENT,
      setAccent: (next) => {
        const clean = HEX.test(next) ? next : DEFAULT_ACCENT;
        persistAccent(clean);
        setAccentState(clean);
      },
      mode,
      setMode: (next) => {
        persistMode(next);
        setModeState(next);
      },
      toggleMode: () => {
        const next: ThemeMode = mode === "dark" ? "light" : "dark";
        persistMode(next);
        setModeState(next);
      },
    }),
    [accent, mode],
  );

  return (
    <Ctx.Provider value={value}>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}>
        <LazyMotion features={domAnimation} strict>
          <ConfigProvider locale={zhCN} theme={buildTheme(accent, mode, !!reducedMotion)}>
            {children}
          </ConfigProvider>
        </LazyMotion>
      </MotionConfig>
    </Ctx.Provider>
  );
}
