import { useEffect, useMemo, useState } from 'react';
import ReactDOM from "react-dom/client";
import { Studio } from "@prisma/studio-core/ui";
import type { CustomTheme } from '@prisma/studio-core/ui';
import { createSQLiteAdapter } from "@prisma/studio-core/data/sqlite-core";
import { createStudioBFFClient } from "@prisma/studio-core/data/bff";
import "@prisma/studio-core/ui/index.css";

/** Entry point for `studio.html` — a SEPARATE document from the console SPA,
 *  embedded by the 数据库 page as an iframe.
 *
 *  Why its own document instead of a route component: Studio persists its view
 *  state (schema/table/filters) through nuqs with a hard-wired hash adapter
 *  that rewrites the WHOLE `location.hash` on every click. The console runs on
 *  a HashRouter, so sharing a document meant Studio's first table click
 *  clobbered `#/database` and blanked the app. An iframe gives Studio its own
 *  `location` to own — plus it keeps Studio's multi-MB bundle and its stylesheet
 *  out of the console document entirely.
 *
 *  `/api/studio` is same-origin from in here (the iframe is served off the same
 *  host), so the BFF call needs no CORS handling.
 */
function readConsoleTheme(): CustomTheme | undefined {
  const root = window.parent.document.documentElement;
  const styles = window.parent.getComputedStyle(root);
  const value = (name: string) => styles.getPropertyValue(name).trim();
  if (!value('--c-bg')) return undefined;
  const variables = {
    '--background': value('--c-bg'), '--foreground': value('--c-ink-1'),
    '--card': value('--c-surface'), '--card-foreground': value('--c-ink-1'),
    '--popover': value('--c-surface'), '--popover-foreground': value('--c-ink-1'),
    '--primary': value('--c-accent'), '--primary-foreground': value('--c-accent-ink'),
    '--secondary': value('--c-subtle'), '--secondary-foreground': value('--c-ink-1'),
    '--muted': value('--c-subtle'), '--muted-foreground': value('--c-ink-2'),
    '--accent': value('--c-subtle'), '--accent-foreground': value('--c-ink-1'),
    '--border': value('--c-line'), '--input': value('--c-line-strong'), '--ring': value('--c-accent'),
    '--destructive': value('--c-bad'), '--radius': '0.625rem',
  };
  return { light: variables, dark: variables };
}

function StudioApp() {
  const [theme, setTheme] = useState(readConsoleTheme);
  useEffect(() => {
    const root = window.parent.document.documentElement;
    const observer = new MutationObserver(() => setTheme(readConsoleTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    return () => observer.disconnect();
  }, []);
  const adapter = useMemo(
    () => createSQLiteAdapter({ executor: createStudioBFFClient({ url: "/api/studio" }) }),
    [],
  );
  return <Studio adapter={adapter} theme={theme} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<StudioApp />);
