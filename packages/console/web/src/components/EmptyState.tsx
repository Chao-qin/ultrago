import { Typography } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";
import { useTheme, getPalette } from "../theme";
import { ServiceRecoveryPanel } from './service-recovery-panel';

/**
 * What a list shows when it has nothing to show.
 *
 * Two states, because they are two different situations and the old code
 * rendered them identically:
 *
 *   - EMPTY  — the query succeeded and there is genuinely nothing here. Say
 *              what the thing is for and put the action that creates one right
 *              here, rather than pointing at a button 100+px away in the corner
 *              ("点击右上角…" was the actual copy).
 *   - ERROR  — the query FAILED. Every list page used to swallow this: the
 *              `useQuery` error went nowhere and the table rendered its empty
 *              placeholder, so a backend that was down looked exactly like a
 *              console with no data in it. That is the worst possible failure
 *              mode for an ops tool.
 */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  const { mode } = useTheme();
  const palette = getPalette(mode);
  return (
    <Frame icon={<InboxOutlined />} tone={palette.ink3}>
      <Typography.Text strong style={{ fontSize: 14 }}>{title}</Typography.Text>
      {description && (
        <Typography.Text type="secondary" style={{ maxWidth: 380, textAlign: "center" }}>
          {description}
        </Typography.Text>
      )}
      {action && <div style={{ marginTop: 4 }}>{action}</div>}
    </Frame>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => unknown }) {
  return (
    <div className="console-error-state"><ServiceRecoveryPanel
      title="数据暂时不可用"
      description="页面已保留，恢复连接后即可继续查看。"
      issues={[{ id: 'data', label: '数据连接', error }]}
      onRetry={onRetry}
    /></div>
  );
}

function Frame({ icon, tone, children }: { icon: ReactNode; tone: string; children: ReactNode }) {
  const { mode } = useTheme();
  const palette = getPalette(mode);
  return (
    <div
      className="console-empty-state"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        // Vertical breathing room without claiming the whole viewport: the table
        // body is a flex child that already fills the page, and an empty list
        // used to leave ~700px of blank white with one grey line floating at the
        // top of it.
        padding: "56px 24px",
        textAlign: "center",
      }}
    >
      <div
        className="console-empty-state-icon"
        style={{
          width: 40,
          height: 40,
          borderRadius: 9,
          display: "grid",
          placeItems: "center",
          background: palette.subtle,
          border: `1px solid ${palette.line}`,
          color: tone,
          fontSize: 18,
        }}
      >
        {icon}
      </div>
      {children}
    </div>
  );
}
