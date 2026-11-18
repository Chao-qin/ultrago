import { useMemo } from 'react';
import { Form, Modal, Typography } from 'antd';
import { PlayCircleOutlined } from '@ant-design/icons';
import type { ParamMap, ParamSchemaFragment, ParamSpec } from '@bcp/shared';
import { ParamFields, paramInitialValues } from './ParamForm';
import { ConsoleFormSection } from './console-form-section';
import { RunLaunchFrame } from './run-launch-frame';
import { ServiceRecoveryPanel } from './service-recovery-panel';

export function FlowTriggerDialog({ specs, schemaResolver, pending, onCancel, onSubmit, error, name }: {
  specs: ParamSpec[];
  schemaResolver: (ref: { name: string; version?: number }) => ParamSchemaFragment | null;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (params: ParamMap) => void;
  error?: string;
  name?: string;
}) {
  const [form] = Form.useForm();
  const initialValues = useMemo(() => ({ params: paramInitialValues(specs, schemaResolver) }), [specs, schemaResolver]);
  return (
    <Modal title={name ? `运行 · ${name}` : '运行流程'} className="run-launch-modal" open centered width={900}
      okText="开始运行" okButtonProps={{ icon: <PlayCircleOutlined /> }} confirmLoading={pending}
      cancelButtonProps={{ disabled: pending }} closable={!pending} maskClosable={!pending} keyboard={!pending}
      onOk={() => { if (!pending) form.submit(); }} onCancel={onCancel}>
      {error && <ServiceRecoveryPanel compact title="运行未启动" description="流程输入已保留，请检查错误原因后再次运行。" issues={[{ id: 'launch', label: '启动请求失败', error }]} />}
      <RunLaunchFrame target={name ?? '当前流程'} kind="流程" parameterCount={specs.length} requiredCount={specs.filter(spec => spec.required).length}>
      <Form form={form} layout="vertical" initialValues={initialValues} disabled={pending}
        onFinish={(values) => { if (!pending) onSubmit((values.params ?? {}) as ParamMap); }}>
        <ConsoleFormSection title="流程输入" description="填写流程的入口参数，后续节点将按流程定义接收这些输入。">
        {specs.length > 0
          ? <ParamFields schema={specs} namePrefix={['params']} schemaResolver={schemaResolver} />
          : <Typography.Paragraph type="secondary">此流程无需填写参数，可以直接开始运行。</Typography.Paragraph>}
        </ConsoleFormSection>
      </Form>
      </RunLaunchFrame>
    </Modal>
  );
}
