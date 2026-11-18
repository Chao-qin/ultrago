import { type CSSProperties, type ReactNode } from "react";
import { Typography } from "antd";

/** Props for the unified long-text clamp component. */
export interface TextClampProps {
  /** Text to clamp. Prefer this over children. */
  text?: ReactNode;
  /** Fallback children if `text` is not provided. */
  children?: ReactNode;
  /** Max lines. 1 = single-line ellipsis w/ full-text tooltip; >=2 = clamped
   *  multi-line with expand/collapse. Default 2. */
  rows?: number;
  /** Optional explicit width (px or CSS string). Default: fill parent. */
  width?: number | string;
  /** Extra styles (e.g. maxWidth, fontSize). */
  style?: CSSProperties;
  /** Override the hover/expand tooltip. Default: the raw text. */
  tooltip?: ReactNode;
  /** Allow expand/collapse when rows >= 2. Default true. */
  expandable?: boolean;
  className?: string;
}

/**
 * Unified long-text clamping component. Wraps antd `Typography` ellipsis so
 * callers don't repeat the antd boilerplate across the app.
 *
 * - `rows` default 2; `rows=1` renders a single-line ellipsis whose full text
 *   shows on hover.
 * - `width`/`style` optional; without a width it fills its parent.
 * - Short text renders as-is (no clamp), matching antd's behavior.
 *
 * Example:
 *   <TextClamp text={book.goal} rows={1} />
 *   <TextClamp text={book.goalDetail} rows={3} width={720} />
 */
export function TextClamp({
  text,
  children,
  rows = 2,
  width,
  style,
  tooltip,
  expandable = rows >= 2,
  className,
}: TextClampProps): ReactNode {
  const body = text ?? children;
  const mergedStyle: CSSProperties | undefined =
    width !== undefined ? { width, ...(style ?? {}) } : style;

  if (rows === 1) {
    return (
      <Typography.Text
        ellipsis={{ tooltip: tooltip ?? text }}
        style={{ display: "block", ...(mergedStyle ?? {}) }}
        className={className}
      >
        {body}
      </Typography.Text>
    );
  }

  return (
    <Typography.Paragraph
      ellipsis={{ rows, expandable }}
      style={mergedStyle}
      className={className}
    >
      {body}
    </Typography.Paragraph>
  );
}