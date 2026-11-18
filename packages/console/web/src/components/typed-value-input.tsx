import { useEffect, useRef, useState } from 'react';
import { BcpSelect } from './BcpSelect';
import { JsonEditor } from './JsonEditorLazy';
import { enumOptionIndex, jsonInputText, parseJsonInput } from '../lib/typed-input';

export function JsonValueInput({ value, onChange, placeholder, height = 144, expected = 'any' }: {
  value?: unknown;
  onChange?: (value: unknown) => void;
  placeholder?: string;
  height?: number;
  expected?: 'object' | 'any';
}) {
  const [draft, setDraft] = useState(() => jsonInputText(value));
  const emitted = useRef(value);
  useEffect(() => {
    if (Object.is(value, emitted.current)) return;
    emitted.current = value;
    setDraft(jsonInputText(value));
  }, [value]);
  return <JsonEditor value={draft} expected={expected} height={height} placeholder={placeholder} onChange={(raw) => {
    setDraft(raw);
    emitted.current = parseJsonInput(raw);
    onChange?.(emitted.current);
  }} />;
}

export function EnumValueInput({ options, value, onChange }: { options: unknown[]; value?: unknown; onChange?: (value: unknown) => void }) {
  return <BcpSelect value={enumOptionIndex(options, value)} allowClear placeholder="选择…"
    options={options.map((option, index) => ({ label: typeof option === 'string' ? option : JSON.stringify(option), value: String(index) }))}
    onChange={(index) => onChange?.(index === undefined ? undefined : options[Number(index)])} />;
}
