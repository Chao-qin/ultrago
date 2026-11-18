import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';

interface UnsavedChangesContextValue {
  setDirty: (dirty: boolean) => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }): JSX.Element {
  const dirtyRef = useRef(false);
  const [, setDirtyState] = useState(false);
  const setDirty = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirtyState(next);
  }, []);
  const blocker = useBlocker(() => dirtyRef.current);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('有未保存的脚本改动，确定离开吗？')) {
      dirtyRef.current = false;
      setDirtyState(false);
      blocker.proceed();
    } else {
      blocker.reset();
    }
  }, [blocker]);
  const value = useMemo(() => ({ setDirty }), [setDirty]);
  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>;
}

export function useUnsavedChangesGuard(dirty: boolean): () => void {
  const context = useContext(UnsavedChangesContext);
  if (!context) throw new Error('useUnsavedChangesGuard must be used inside UnsavedChangesProvider');
  useEffect(() => {
    context.setDirty(dirty);
    return () => context.setDirty(false);
  }, [context, dirty]);
  return useCallback(() => context.setDirty(false), [context]);
}
