import { Input } from "antd";
import { SearchOutlined } from "@ant-design/icons";

/**
 * The one list-filter search box. Books had one; every other list page made
 * you read the table to find a row. Same shape everywhere: a SearchOutlined
 * prefix, allowClear, and a width that leaves the toolbar to the actions.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}): JSX.Element {
  return (
    <Input
      prefix={<SearchOutlined style={{ color: "var(--c-ink-3)" }} />}
      placeholder={placeholder ?? "搜索…"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      allowClear
      style={{ width: 260 }}
    />
  );
}
