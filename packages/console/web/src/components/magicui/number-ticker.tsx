// Adapted from Magic UI (MIT); see ./LICENSE and https://github.com/magicuidesign/magicui.
import { useEffect, useMemo, useRef } from 'react';
import { useReducedMotion, useSpring } from 'motion/react';

export function NumberTicker({ value, decimalPlaces = 0, suffix = '' }: {
  value: number;
  decimalPlaces?: number;
  suffix?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reducedMotion = useReducedMotion();
  const spring = useSpring(value, { damping: 40, stiffness: 160 });
  const formatter = useMemo(() => new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }), [decimalPlaces]);
  const finalText = `${formatter.format(value)}${suffix}`;

  useEffect(() => {
    if (reducedMotion) spring.jump(value);
    else spring.set(value);
  }, [spring, value, reducedMotion]);

  useEffect(() => spring.on('change', (latest) => {
    if (ref.current) ref.current.textContent = `${formatter.format(latest)}${suffix}`;
  }), [spring, formatter, suffix]);

  return (
    <span className="number-ticker">
      <span ref={ref} aria-hidden="true">{finalText}</span>
      <span className="number-ticker-accessible">{finalText}</span>
    </span>
  );
}
