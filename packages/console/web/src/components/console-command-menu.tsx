import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Input, Modal } from 'antd';
import type { InputRef } from 'antd';
import { ArrowUpRight, Search } from 'lucide-react';

export type ConsoleDestination = { key: string; label: string; group: string; description: string; icon: ReactNode };

export function ConsoleCommandMenu({ open, onClose, destinations, onNavigate }: {
  open: boolean;
  onClose: () => void;
  destinations: ConsoleDestination[];
  onNavigate: (key: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<InputRef>(null);
  const list = useRef<HTMLDivElement>(null);
  const results = destinations.filter(item => `${item.label} ${item.group} ${item.description}`.toLowerCase().includes(search.trim().toLowerCase()));
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, search]);

  return <Modal open={open} onCancel={onClose} footer={null} closable={false} width={620} className="console-command-modal" title="前往工作区"
    afterOpenChange={visible => { if (visible) { setSearch(''); setActive(0); input.current?.focus(); } }}>
    <Input ref={input} className="console-command-search" variant="borderless" prefix={<Search size={20} aria-hidden="true" />} placeholder="搜索页面、功能或工作区…" value={search}
      role="combobox" aria-label="搜索工作区" aria-autocomplete="list" aria-expanded="true" aria-controls="console-command-results" aria-activedescendant={results[active] ? `console-command-${active}` : undefined}
      onChange={event => { setSearch(event.target.value); setActive(0); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setActive(previous => Math.max(0, Math.min(results.length - 1, previous + (event.key === 'ArrowDown' ? 1 : -1))));
        }
        if (event.key === 'Enter' && results[active]) { event.preventDefault(); onNavigate(results[active].key); onClose(); }
      }} />
    <div className="console-command-results" id="console-command-results" ref={list} role="listbox" aria-label="工作区搜索结果">
      {results.map((item, index) => <button type="button" role="option" aria-selected={index === active} id={`console-command-${index}`} key={item.key} className="console-command-result" onMouseEnter={() => setActive(index)} onClick={() => { onNavigate(item.key); onClose(); }}>
        <span className="console-command-icon" aria-hidden="true">{item.icon}</span>
        <span><strong>{item.label}</strong><small>{item.description}</small></span>
        <span className="console-command-group">{item.group}</span><ArrowUpRight size={15} aria-hidden="true" />
      </button>)}
      {!results.length && <div className="console-command-empty">没有找到对应工作区，试试“运行”“脚本”或“数据”。</div>}
    </div>
    <div className="console-command-footer"><span><kbd>↑</kbd><kbd>↓</kbd>选择 <kbd>↵</kbd>打开</span><span><kbd>Esc</kbd>关闭</span></div>
  </Modal>;
}
