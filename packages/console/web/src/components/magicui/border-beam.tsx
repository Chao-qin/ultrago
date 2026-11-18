// Adapted from Magic UI (MIT); see ./LICENSE and https://github.com/magicuidesign/magicui.
import { m, useReducedMotion } from 'motion/react';

export function BorderBeam() {
  const reducedMotion = useReducedMotion();
  if (reducedMotion) return null;

  return (
    <div className="border-beam" aria-hidden="true">
      <m.div
        className="border-beam-light"
        initial={{ offsetDistance: '0%' }}
        animate={{ offsetDistance: '100%' }}
        transition={{ duration: 12, repeat: Infinity, ease: 'linear' }}
      />
    </div>
  );
}
