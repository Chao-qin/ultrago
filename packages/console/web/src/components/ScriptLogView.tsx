import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ScriptExec } from "../lib/types";

/**
 * Log tailing for the settings panel.
 *
 * Two hooks because the two run modes have genuinely different transports —
 * see ScriptRunnerService. Neither uses react-query: this is an append-only
 * stream read with a moving cursor, and query caching keyed by that cursor
 * would spawn a fresh cache entry per poll for nothing.
 */

/** Tail an ATTACHED run over its cursor. Stops polling once the run settles,
 *  so a finished log costs nothing to keep on screen. */
export function useRunLog(execId: string | null) {
  const [lines, setLines] = useState<string[]>([]);
  const [exec, setExec] = useState<ScriptExec | null>(null);
  const cursor = useRef(0);

  useEffect(() => {
    if (!execId) return;
    setLines([]);
    setExec(null);
    cursor.current = 0;
    let alive = true;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const page = await api.getScriptRun(execId, cursor.current);
        if (!alive) return;
        cursor.current = page.cursor;
        setExec(page.exec);
        const incoming = page.dropped > 0
          ? [`[console] 前面 ${page.dropped} 行超出缓冲上限已被丢弃`, ...page.lines]
          : page.lines;
        if (incoming.length > 0) setLines((prev) => [...prev, ...incoming]);
        if (page.exec.status === "running") timer = window.setTimeout(tick, 800);
      } catch (e) {
        if (!alive) return;
        setLines((prev) => [...prev, `[console] 读日志失败：${(e as Error).message}`]);
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [execId]);

  return { lines, exec };
}

/**
 * Tail the DETACHED log file by byte offset.
 *
 * Keeps polling through failures on purpose: the runs that write this file are
 * the ones that restart the console, so "the request failed" is the expected
 * middle of a successful `pnpm restart`, not a reason to stop watching.
 */
export function useDetachedLog(active: boolean) {
  const [text, setText] = useState("");
  const [offline, setOffline] = useState(false);
  const offset = useRef(0);

  useEffect(() => {
    if (!active) return;
    setText("");
    setOffline(false);
    offset.current = 0;
    let alive = true;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const page = await api.detachedScriptLog(offset.current);
        if (!alive) return;
        setOffline(false);
        // `reset` means the file was truncated by a newer run, or we clamped to
        // its tail — either way what we hold is no longer a prefix of it.
        if (page.reset) setText(page.text);
        else if (page.text) setText((prev) => prev + page.text);
        offset.current = page.offset;
      } catch {
        if (alive) setOffline(true);
      }
      if (alive) timer = window.setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active]);

  return { text, offline };
}

/** The black box the log goes in. Sticks to the bottom while new output
 *  arrives, and lets go the moment you scroll up to read something. */
export function LogPane({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      style={{
        margin: 0,
        padding: 12,
        height: "100%",
        minHeight: 320,
        overflow: "auto",
        background: "#1e1e1e",
        color: "#d4d4d4",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        borderRadius: 6,
      }}
    >
      {text || "（暂无输出）"}
    </pre>
  );
}
