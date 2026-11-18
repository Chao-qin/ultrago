import { Alert, Button, ColorPicker, Segmented, Space, Typography } from "antd";
import { MoonOutlined, SunOutlined } from "@ant-design/icons";
import { ACCENT_PRESETS, accentFailsWhiteText, getPalette, useTheme } from '../theme';
import type { ThemeMode } from '../theme';
import { MagicCard } from './magicui/magic-card';
import { BorderBeam } from './magicui/border-beam';

/**
 * 设置 → 外观.
 *
 * 两个维度：
 *   - 日夜模式：暗底辉光 vs 亮底克制，一整块色板替换（不是只换个背景色）
 *   - 主题色：只换 accent，语义色（ok/bad/warn/info）和灰阶都不动
 *
 * 偏好都写 localStorage，不进后端——一次浏览器的事。
 */
export function SettingsAppearance() {
  const { accent, setAccent, isDefault, mode, setMode } = useTheme();
  const p = getPalette(mode);
  const tooLight = accentFailsWhiteText(accent);

  return (
    <Space className="console-appearance" direction="vertical" size={20} style={{ width: '100%', maxWidth: 760 }}>
      <MagicCard className="appearance-preview">
        <div className="appearance-preview-top"><span>外观预览</span><span>{mode === 'dark' ? '夜间模式' : '日间模式'}</span></div>
        <div className="appearance-preview-main">
          <div><strong>你的自动化工作空间</strong><small>主题色、面板和控件即时同步</small></div>
          <span className="appearance-preview-button" aria-hidden="true">主要操作</span>
        </div>
        <BorderBeam />
      </MagicCard>
      {/* ── 日夜模式 ─────────────────────────────────── */}
      <div>
        <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 4 }}>
          显示模式
        </Typography.Title>
        <Typography.Text type="secondary">
          暗底辉光还是亮底克制？整个色板跟着切换，不是只换个背景色。
        </Typography.Text>
      </div>

      <Segmented<ThemeMode>
        value={mode}
        onChange={(v) => v && setMode(v)}
        options={[
          { label: (<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MoonOutlined />夜间</span>), value: "dark" },
          { label: (<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SunOutlined />日间</span>), value: "light" },
        ]}
        size="large"
        block
      />

      {/* ── 主题色 ──────────────────────────────────── */}
      <div>
        <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 4 }}>
          主题色
        </Typography.Title>
        <Typography.Text type="secondary">
          用在按钮、选中态、链接和焦点框上。状态色（成功 / 失败 / 警告）不跟着变——
          绿色代表成功是语义，换了就读不出来了。
        </Typography.Text>
      </div>

      <Space size={10} wrap>
        {ACCENT_PRESETS.map((preset) => {
          const active = preset.value.toLowerCase() === accent.toLowerCase();
          return (
            <button
              key={preset.key}
              type="button"
              onClick={() => setAccent(preset.value)}
              aria-pressed={active}
              title={preset.value}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 12px 6px 8px",
                borderRadius: 8,
                cursor: "pointer",
                background: p.surface,
                border: `1px solid ${active ? accent : p.line}`,
                boxShadow: active ? `0 0 0 2px ${accent}22` : "none",
                font: "inherit",
                color: p.ink1,
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  background: preset.value,
                  border: `1px solid ${p.lineStrong}`,
                }}
              />
              {preset.label}
            </button>
          );
        })}
      </Space>

      <Space size={12} align="center" wrap>
        <ColorPicker
          value={accent}
          disabledAlpha
          showText={(color) => <span>{color.toHexString().toUpperCase()}</span>}
          // onChangeComplete, not onChange: dragging the picker would otherwise
          // rewrite localStorage and re-derive antd's whole token set on every
          // mousemove.
          onChangeComplete={(color) => setAccent(color.toHexString())}
        />
        <Typography.Text type="secondary">或自定义任意颜色</Typography.Text>
        <Button size="small" disabled={isDefault} onClick={() => setAccent(ACCENT_PRESETS[0].value)}>
          恢复默认
        </Button>
      </Space>

      {tooLight && (
        <Alert
          type="warning"
          showIcon
          message="这个颜色较亮，实心按钮会自动改用深色文字"
          description="亮色是暗底上的正确方向，但白字压不住它——按钮文字已切到深色以保证对比度。链接和选中态不受影响。"
        />
      )}

      <Alert
        type="info"
        showIcon
        message="偏好存在这台浏览器里"
        description="换浏览器或清掉站点数据会回到默认的科技青。它不写进仓库，也不影响别人。"
      />
    </Space>
  );
}
