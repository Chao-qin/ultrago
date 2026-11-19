import { useState } from 'react';
import { Button, Tooltip, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Toolbar refresh: re-pulls the current page's data without relying on the
 * page's own refresh / retry wiring.
 *
 * `invalidateQueries()` marks the whole cache stale and refetches every query
 * the current page has mounted, cancelling and restarting requests that are
 * still hanging. Pages that are not mounted refetch when you return to them.
 * Local state (filters, unsaved edits) is untouched — nothing is remounted.
 */
export function ConsoleRefreshButton() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    if (refreshing) return;
    const active = () => queryClient.getQueryCache().findAll({ type: 'active' });
    if (active().length === 0) {
      message.info({ key: 'console-refresh', content: '当前页面没有可刷新的数据' });
      return;
    }
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries();
      const failed = active().filter((query) => query.state.status === 'error').length;
      if (failed > 0) message.warning({ key: 'console-refresh', content: `${failed} 项数据刷新失败，原因见页面提示` });
      else message.success({ key: 'console-refresh', content: '数据已刷新' });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Tooltip title="刷新当前页数据">
      <Button type="text" icon={<ReloadOutlined spin={refreshing} />} onClick={() => void refresh()} aria-label="刷新当前页数据" aria-busy={refreshing} />
    </Tooltip>
  );
}
