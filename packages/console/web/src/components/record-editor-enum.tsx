import { Select, Tooltip } from 'antd';
import { equalValues } from '../lib/record-editor-model';
import type { EditorEnumOption } from '../lib/record-editor-presentation';

export function RecordEditorEnum({ id, value, options, disabled, showDescriptions, invalid, onChange }: {
  id: string;
  value: unknown;
  options: EditorEnumOption[];
  disabled?: boolean;
  showDescriptions?: boolean;
  invalid: boolean;
  onChange: (value: unknown) => void;
}) {
  const selectedIndex = options.findIndex((option) => equalValues(option.value, value));
  const selected = options[selectedIndex];
  const unknown = value !== undefined && selectedIndex < 0;
  const items = options.map((option, index) => ({
    value: String(index), label: option.label, raw: option.raw, description: option.description,
    documented: option.documented, search: option.search,
  }));
  if (unknown) items.push({ value: 'unrecognized', label: '未声明的值', raw: JSON.stringify(value) ?? String(value), description: '当前值不在 Schema 声明的选项中，请选择有效值。', documented: false, search: '' });
  return <div className="record-enum">
    <Select id={id} aria-describedby={`${id}-enum-note`} aria-invalid={invalid || unknown} disabled={disabled}
      style={{ width: '100%' }} allowClear placeholder="请选择" showSearch optionFilterProp="search"
      value={unknown ? 'unrecognized' : selectedIndex < 0 ? undefined : String(selectedIndex)} options={items}
      virtual={options.length > 40} classNames={{ popup: { root: 'record-enum-popup' } }}
      labelRender={({ value: key }) => {
        const option = items.find((item) => item.value === key);
        return option ? <span className="record-enum__value" title={`${option.label} · ${option.raw}`}><span>{option.label}</span>{option.label !== option.raw && <code>{option.raw}</code>}</span> : null;
      }}
      optionRender={({ data: option }) => <div className="record-enum__option"><div><strong>{option.label}</strong><code>{option.raw}</code></div><p>{option.description || (option.documented ? '按此选项的业务含义设置。' : '尚未提供此值的业务说明。')}</p></div>}
      onChange={(index) => { if (index !== 'unrecognized') onChange(index === undefined ? undefined : options[Number(index)].value); }}
    />
    {(selected?.description || selected && !selected.documented || unknown) && <Tooltip title={unknown ? '当前值不在 Schema 声明的选项中。' : selected?.description || 'Schema 尚未提供此值的业务说明。'}>
      <p className={`record-enum__note ${unknown ? 'record-enum__note--unknown' : showDescriptions ? '' : 'record-field__description--hidden'}`} id={`${id}-enum-note`}>{unknown ? '未声明的值，请核对选项。' : selected?.description || '此值尚未提供业务说明。'}</p>
    </Tooltip>}
  </div>;
}
