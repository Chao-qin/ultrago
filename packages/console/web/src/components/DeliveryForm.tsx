import { Form, Input, Switch, Space, Typography } from "antd";
import type { Delivery } from "../lib/types";
import type { ReactNode } from "react";
import { normalizeDelivery } from "@bcp/shared";
import { BcpSelect } from "./BcpSelect";

const kinds = ["file", "print", "webhook", "message"] as const;

export function deliveryInitialValues(declared: Delivery[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const kind of kinds) {
    const declaredDelivery = declared.find((x) => x.kind === kind);
    const d = declaredDelivery ? normalizeDelivery(declaredDelivery) as Record<string, unknown> : undefined;
    values[kind] = {
      enabled: !!d,
      ...(d ?? {}),
    };
  }
  return values;
}

export function DeliveryFields({ namePrefix = ["deliveries"] }: { namePrefix?: (string | number)[] }) {
  return (
    <>
      {kinds.map((kind) => (
        <div key={kind} className="delivery-card">
          <Space className="delivery-card-header">
            <Form.Item name={[...namePrefix, kind, "enabled"]} valuePropName="checked" noStyle>
              <Switch size="small" />
            </Form.Item>
            <Typography.Text strong>{kindLabel(kind)}</Typography.Text>
          </Space>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.deliveries?.[kind]?.enabled !== next.deliveries?.[kind]?.enabled}>
            {({ getFieldValue }) => getFieldValue([...namePrefix, kind, "enabled"]) ? <DeliveryConfig kind={kind} namePrefix={namePrefix} /> : null}
          </Form.Item>
        </div>
      ))}
    </>
  );
}

function DeliveryConfig({ kind, namePrefix }: { kind: typeof kinds[number]; namePrefix: (string | number)[] }) {
  const field = (key: string, child: ReactNode) => <Form.Item className="delivery-field" name={[...namePrefix, kind, key]} label={fieldLabel(key)}>{child}</Form.Item>;
  return <>
    {kind === "file" && field("artifact", <Input placeholder="例如 baidu-hot-search.md" />)}
    {kind === "print" && field("format", <BcpSelect options={["markdown", "text"].map((v) => ({ label: v, value: v }))} />)}
    {kind === "webhook" && <>{field("url", <Input placeholder="https://..." />)}{field("method", <BcpSelect options={["POST", "PUT"].map((v) => ({ label: v, value: v }))} />)}</>}
    {kind === "message" && <>{field("channel", <BcpSelect options={[{ label: "wechat", value: "wechat" }]} />)}{field("template", <Input.TextArea rows={2} />)}</>}
    {field("on", <BcpSelect options={["success", "failure", "cancelled", "any"].map((v) => ({ label: v, value: v }))} />)}
  </>;
}

function kindLabel(kind: typeof kinds[number]): string {
  return { file: "文件", print: "控制台输出", webhook: "Webhook", message: "微信消息" }[kind];
}

function fieldLabel(key: string): string {
  return { artifact: "文件产出", format: "格式", url: "目标 URL", method: "请求方法", channel: "渠道", template: "消息模板", on: "触发条件" }[key] ?? key;
}

export function collectDeliveries(values: Record<string, Record<string, unknown>>): Delivery[] {
  return kinds.filter((kind) => values[kind]?.enabled).map((kind) => {
    const { enabled: _enabled, ...delivery } = values[kind];
    return { kind, ...delivery } as Delivery;
  });
}
