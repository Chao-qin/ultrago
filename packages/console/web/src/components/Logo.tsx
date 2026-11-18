/**
 * RPA Console mark — v4 流线品牌版
 *
 * 设计理念: 单色 currentColor 约束下的"分层"——
 *   层 1 · 窗口轮廓（stroke 24 + opacity 0.22）→ 退到背景，
 *          只提供"这是浏览器里自动化"的语义提示
 *   层 2 · 流线主体（fill 1.0）→ 视觉主体，S 曲线上升
 *   层 3 · 加速箭头（fill 1.0）→ 流线末端飞出窗口，暗示"自动化穿越边界"
 *
 * 为什么不用渐变/mask: 用户切 accent 色时渐变要重新算，
 * 单色 + opacity 分层是唯一能自动跟随主题系统的方案。
 */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="RPA Console"
      style={{ display: "block", flex: "none" }}
    >
      {/* ── 层 1: 窗口轮廓（低浓度语义层） ──────────────── */}
      <rect
        x="86" y="68"
        width="340" height="376"
        rx="46" ry="46"
        fill="none"
        stroke="currentColor"
        strokeWidth="24"
        strokeLinejoin="round"
        opacity="0.22"
      />
      {/* 顶部 tab bar 横线 */}
      <line
        x1="132" y1="128"
        x2="380" y2="128"
        stroke="currentColor"
        strokeWidth="12"
        strokeLinecap="round"
        opacity="0.14"
      />

      {/* ── 层 2+3: 流线主体 + 加速箭头（满色视觉主体） ─ */}
      {/* 主体: 入口 → 上升 S 曲线 → 转折出 */}
      <path
        fill="currentColor"
        d="
          M148 396
          C148 378 162 366 180 366
          H230
          C296 366 338 320 338 254
          V216
          C338 186 362 164 392 164
          H414
          C430 164 442 176 442 192
          C442 208 430 220 414 220
          H392
          V254
          C392 348 330 420 230 420
          H180
          C162 420 148 408 148 396
          Z
        "
      />
      {/* 加速箭头: 流线末端飞出窗口 */}
      <path
        fill="currentColor"
        d="
          M382 128
          L484 196
          L382 264
          L382 230
          H358
          V162
          H382
          Z
        "
      />
    </svg>
  );
}
