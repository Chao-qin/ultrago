export interface RunHistoryItem {
  id: string;
  key: string;
  source: 'run' | 'flow';
  targetType: string;
  status: string;
  trigger: string;
  mode: string;
  queuedAt: string;
  durationMs: number | null;
  deletedAt: string | null;
  book?: { name: string } | null;
  script?: { name: string } | null;
  flow?: { name: string } | null;
}

export interface RunHistoryPage {
  items: RunHistoryItem[];
  total: number;
  page: number;
  pageSize: number;
}
