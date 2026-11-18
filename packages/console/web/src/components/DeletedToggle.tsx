import { Space, Switch, Typography } from "antd";

/**
 * The one "include soft-deleted rows" toggle. Three shapes coexisted — a
 * bare Switch beside caption text, a Switch with checkedChildren labels, and
 * (on Scripts) a text Button that flipped its own label — which made the same
 * filter read as three different filters. One control, one caption, every page.
 */
export function DeletedToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <Space size={4}>
      <Switch size="small" checked={checked} onChange={onChange} />
      <Typography.Text type="secondary">含已删除</Typography.Text>
    </Space>
  );
}
