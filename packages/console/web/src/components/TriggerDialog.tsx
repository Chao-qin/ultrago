import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Modal, Form, Radio, message, Typography } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { api } from "../lib/api";
import { TextClamp } from "./TextClamp";
import { ParamFields, paramInitialValues } from "./ParamForm";
import { DeliveryFields, collectDeliveries, deliveryInitialValues } from "./DeliveryForm";
import type { Delivery } from "../lib/types";
import type { ParamMap } from "@bcp/shared";
import type { Book, ParamSchema } from "../lib/types";
import { parseConsoleDeliveries, parseConsoleParamSchema } from "../lib/types";
import { useSchemaResolver } from "../lib/use-schema-resolver";
import { ConsoleFormSection } from './console-form-section';
import { RunLaunchFrame } from './run-launch-frame';
import { Bot, Hand } from 'lucide-react';
import { ServiceRecoveryPanel } from './service-recovery-panel';

export function TriggerDialog({
  book,
  onClose,
  onTriggered,
}: {
  book: Book;
  onClose: () => void;
  onTriggered: (runId: string) => void;
}) {
  const schema: ParamSchema = useMemo(() => safeParse(book.paramSchema ?? "") ?? [], [book.paramSchema]);
  // Citation params (param-level schemaRef) resolve against the registry —
  // without the resolver they degrade to a bare JSON textarea and the 选存档
  // picker never appears in the trigger dialog.
  const schemaResolver = useSchemaResolver();
  const declaredDeliveries = useMemo<Delivery[]>(() => safeParseDeliveries(book.deliveriesJson ?? "[]"), [book.deliveriesJson]);
  const boundOutputParams = useMemo(() => declaredDeliveries.flatMap((d) => {
    if (d.kind !== "file") return [];
    const match = d.artifact.match(/^\{\{([^}]+)\}\}$/);
    return match ? [match[1]] : [];
  }), [declaredDeliveries]);
  const [form] = Form.useForm();
  const [mode, setMode] = useState<"auto" | "assisted">("auto");

  const trigger = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.triggerRun(book.id, mergeBoundOutputParams((values.params ?? {}) as ParamMap, (values.deliveries ?? {}) as Record<string, Record<string, unknown>>, boundOutputParams), mode, undefined, collectDeliveries((values.deliveries ?? {}) as Record<string, Record<string, unknown>>)),
    onSuccess: (r) => {
      message.success(r.deduped ? "已合并到现有 run" : "Run 已触发");
      onTriggered(r.run.id);
    },
    onError: (e: Error) => message.error(e.message),
  });

  // Pre-fill from the schema's defaults (top-level `default` first, then
  // schema.default), so an omitted optional param still gets its intended value.
  const initialValues = useMemo(() => paramInitialValues(schema, schemaResolver), [schema, schemaResolver]);
  const initialDeliveryValues = useMemo(() => {
    const values = deliveryInitialValues(declaredDeliveries);
    for (const name of boundOutputParams) {
      if (typeof initialValues[name] === "string" && values.file && typeof values.file === "object") (values.file as Record<string, unknown>).artifact = initialValues[name];
    }
    return values;
  }, [declaredDeliveries, boundOutputParams, initialValues]);

  return (
    <Modal
      title={`触发运行: ${book.name}`}
      className="run-launch-modal"
      open
      centered
      onOk={() => form.submit()}
      onCancel={onClose}
      cancelButtonProps={{ disabled: trigger.isPending }}
      closable={!trigger.isPending}
      maskClosable={!trigger.isPending}
      keyboard={!trigger.isPending}
      confirmLoading={trigger.isPending}
      okText="开始运行"
      okButtonProps={{ icon: <PlayCircleOutlined aria-hidden="true" /> }}
      width={900}
    >
      <TextClamp text={book.goal || book.description || ""} rows={2} style={{ color: "var(--c-ink-3)" }} />

      <RunLaunchFrame target={book.name} kind="Book" parameterCount={schema.filter(param => !boundOutputParams.includes(param.name)).length} requiredCount={schema.filter(param => param.required && !boundOutputParams.includes(param.name)).length} deliveryCount={declaredDeliveries.length}>
      <ConsoleFormSection title="执行策略" description="选择这次自动化任务的协作方式。">
        <Radio.Group className="run-mode-picker" value={mode} disabled={trigger.isPending} onChange={(event) => setMode(event.target.value)}>
          <Radio value="auto"><span><Bot size={19} aria-hidden="true" /><strong>自动执行</strong><small>按任务定义自动完成步骤</small></span></Radio>
          <Radio value="assisted"><span><Hand size={19} aria-hidden="true" /><strong>辅助执行</strong><small>由执行器与人工协作完成</small></span></Radio>
        </Radio.Group>
      </ConsoleFormSection>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ params: initialValues, deliveries: initialDeliveryValues }}
        onFinish={(v) => trigger.mutate(v)}
        disabled={trigger.isPending}
      >
        <ConsoleFormSection title="运行参数" description="检查本次运行所需的输入。">
        {schema.length > 0 ? <ParamFields schema={schema} namePrefix={["params"]} excludeNames={boundOutputParams} schemaResolver={schemaResolver} /> : (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>这项任务无需填写输入参数。</Typography.Text>
        )}
        </ConsoleFormSection>
        {declaredDeliveries.length > 0 && (
          <ConsoleFormSection title="出参方式" description="配置运行产物的交付方式。">
            <DeliveryFields />
          </ConsoleFormSection>
        )}
      </Form>

      </RunLaunchFrame>

      {trigger.isError && (
        <ServiceRecoveryPanel compact title="运行未启动" description="输入内容已保留，请检查错误原因后再次运行。" issues={[{ id: 'launch', label: '启动请求失败', error: trigger.error }]} />
      )}
    </Modal>
  );
}

function safeParse(s: string): ParamSchema | null {
  try { return parseConsoleParamSchema(s); } catch { return null; }
}

function safeParseDeliveries(s: string): Delivery[] {
  try { return parseConsoleDeliveries(s) as Delivery[]; } catch { return []; }
}

function mergeBoundOutputParams(params: ParamMap, deliveries: Record<string, Record<string, unknown>>, names: string[]): ParamMap {
  const out = { ...params };
  for (const name of names) {
    // artifact is a book-level reference, not the runtime parameter value.
    if (out[name] === undefined || out[name] === "") {
      const artifact = deliveries.file?.artifact;
      if (typeof artifact === "string" && !/^\{\{[^}]+\}\}$/.test(artifact.trim())) out[name] = artifact;
    }
  }
  return out;
}
