// Adapted from Magic UI (MIT); see ./LICENSE and https://github.com/magicuidesign/magicui.
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { m, useMotionTemplate, useMotionValue, useReducedMotion } from 'motion/react';

export function MagicCard({ children, className = '', style }: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const x = useMotionValue(-400);
  const y = useMotionValue(-400);
  const reducedMotion = useReducedMotion();
  const glow = useMotionTemplate`radial-gradient(320px circle at ${x}px ${y}px, color-mix(in srgb, var(--c-accent) 14%, transparent), transparent 100%)`;

  function move(event: PointerEvent<HTMLDivElement>) {
    if (reducedMotion || event.pointerType === 'touch') return;
    const bounds = event.currentTarget.getBoundingClientRect();
    x.set(event.clientX - bounds.left);
    y.set(event.clientY - bounds.top);
  }

  return (
    <div
      className={`magic-card ${className}`}
      style={style}
      onPointerMove={move}
      onPointerLeave={() => { x.set(-400); y.set(-400); }}
    >
      {!reducedMotion && <m.div className="magic-card-glow" aria-hidden="true" style={{ background: glow }} />}
      {children}
    </div>
  );
}
