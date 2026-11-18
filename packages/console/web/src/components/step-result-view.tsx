import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Space } from 'antd';
import type { StepRun } from '../lib/types';
import { api } from '../lib/api';
import { ContentView } from './content-view';
import { ErrorState } from './EmptyState';

export function StepResultView({ step }: { step: StepRun }) {
  const [expanded, setExpanded] = useState(false);
  const result = useQuery({
    queryKey: ['step-result', step.runId, step.id],
    queryFn: () => api.getStepResult(step.runId, step.id),
    enabled: expanded && !!step.resultAvailable,
    staleTime: Infinity,
    retry: false,
  });
  const full = expanded && result.data?.available ? result.data : undefined;
  const legacyCapped = !step.resultAvailable && (step.valuePreview?.length ?? 0) >= 4096;
  return <div className='step-result-view'>
    <Space direction='vertical' style={{ width: '100%' }}>
      {legacyCapped && <Alert type='warning' showIcon title='历史预览达到 4096 字符上限，可能已截断；未保留完整结果。' />}
      {!full && step.previewTruncated && step.resultAvailable && <Alert type='info' title={`当前为截断预览，完整结果共 ${step.resultChars?.toLocaleString() ?? '未知'} 字符。`} />}
      {(full?.upstreamTruncated || step.upstreamTruncated) && <Alert type='warning' showIcon title='执行端已截断此结果；此处只能展示收到的内容，无法恢复被丢弃的部分。' />}
      {expanded && result.isError && <ErrorState error={result.error} onRetry={() => result.refetch()} />}
      {expanded && result.data && !result.data.available && <Alert type='warning' title={result.data.reason} />}
      <ContentView value={full?.raw ?? step.valuePreview ?? ''} maxHeight={360} />
      {step.resultAvailable && <Button loading={result.isFetching} onClick={() => setExpanded(!expanded)}>{expanded ? '收起完整结果' : '查看完整结果'}</Button>}
    </Space>
  </div>;
}
