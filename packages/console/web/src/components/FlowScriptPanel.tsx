/**
 * The script node's panel: command, stdin shape, and the editor/dry-run
 * workbench.
 *
 * Split out of FlowEditor.tsx. The CodeMirror editor stays lazily imported
 * here for the reason documented on `ScriptEditor` below.
 */
import { Suspense, lazy, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Drawer, Form, Input, Modal, Segmented, Space, Typography, message } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import type { ParamSchemaFragment } from "@bcp/shared";
import type { FlowNode, FlowPort, ScriptNodeConfig } from "../lib/types";
import { ScriptTestConsole } from './script-test-console';
import { api } from '../lib/api';
import { parseScriptContract } from '../lib/script-contract';
import { BcpSelect } from './BcpSelect';

type DescribedScriptNodeConfig = ScriptNodeConfig & { description?: string };

// Lazily, and deliberately: CodeMirror plus two language grammars is ~160KB
// gzipped, and this console does not split by route — imported eagerly it
// landed in the main chunk and was downloaded by everyone who opened the
// dashboard. It is now fetched when a script node's panel is actually opened.
export const ScriptEditor = lazy(() => import("../components/ScriptEditor").then((m) => ({ default: m.ScriptEditor })));

/**
 * The two ways a script node can say what to run: code written here, or a
 * command line pointing at a file in the repo.
 *
 * Kept mutually exclusive in the UI — the runner prefers `source` when a graph
 * somehow carries both, so letting an author fill in a command that would then
 * be ignored is exactly the kind of quietly-dead configuration this panel has
 * been burned by before.
 */
export function ScriptBody({
  config,
  ports,
  onChange,
}: {
  config: FlowNode["config"];
  ports: FlowPort[];
  onChange: (config: FlowNode["config"]) => void;
}): JSX.Element {
  const script = config as ScriptNodeConfig;
  const [trying, setTrying] = useState(false);
  const inline = script.source !== undefined;
  const inputs = ports.filter((p) => p.direction === "in");
  // The contracts as the editor needs them: one object built from the resolved
  // ports rather than re-fetched, so the signature the author reads is derived
  // from the same ports the runner will key by.
  // ALWAYS the object form, one key per port. The runner keys the stdin payload
  // by port id without exception — a node with the single undeclared `input`
  // port receives `{"input": <value>}`, which is what a live run shows.
  //
  // There used to be a special case here saying "one port called `input` means
  // Params IS that port's schema". For an undeclared port it was harmlessly
  // vague (`Record<string, unknown>`) and said nothing about the `input` key —
  // the very thing nobody could work out. For a DECLARED non-object contract
  // it was wrong: the header announced `type Params = string` while the
  // process received `{input: "..."}`. Dropping it fixes the generated type
  // and gives `params.` something to complete in the commonest case.
  const inputSchema = {
    type: "object",
    properties: Object.fromEntries(inputs.map((p) => [p.id, p.schema ?? {}])),
    required: inputs.filter((p) => p.required).map((p) => p.id),
  } as ParamSchemaFragment;
  const outputSchema = ports.find((p) => p.direction === "out" && p.id === "output")?.schema ?? null;

  return (
    <div>
      <Segmented
        size="small"
        block
        style={{ marginBottom: 6 }}
        value={inline ? "inline" : "command"}
        options={[
          { label: "写代码", value: "inline" },
          { label: "跑命令", value: "command" },
        ]}
        onChange={(mode) => {
          const { source: _s, language: _l, command: _c, ...rest } = script;
          onChange(mode === "inline" ? { ...rest, source: "", language: "ts" as const } : { ...rest, command: [] });
        }}
      />

      {inline ? (
        <>
          {/* The inspector is 320px wide. A code editor that narrow, with a
              language tag and a run button competing for the same row, is what
              this pane used to be — and both the editor and the button spilled
              out of it. So the pane previews and the workbench edits: the
              preview answers "what does this node do" at a glance, which is the
              question you have while looking at a graph. */}
          <ScriptPreview source={script.source ?? ""} onOpen={() => setTrying(true)} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            TypeScript · 沙箱封掉文件和子进程，<b>网络没封</b>
          </Typography.Text>
        </>
      ) : (
        <>
          <Typography.Text type="secondary">命令（每行一个参数）</Typography.Text>
          <CommandEditor
            value={(script.command ?? []).join("\n")}
            onChange={(command) => onChange({ ...script, command })}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            入参从 stdin 传入，结果取 stdout 最后一行 JSON
          </Typography.Text>
          <StdinShape ports={ports} />
        </>
      )}

      {trying && (
        <ScriptWorkbench
          config={script}
          inputSchema={inputSchema}
          outputSchema={outputSchema}
          onChange={onChange}
          onClose={() => setTrying(false)}
        />
      )}
    </div>
  );
}

/** What the node runs, at inspector width: enough to recognise it, with the
 *  way in. Read-only on purpose — the thing this replaced was an editable box
 *  too narrow to edit in. */
function ScriptPreview({ source, onOpen }: { source: string; onOpen: () => void }): JSX.Element {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const shown = lines.slice(0, 8);
  const empty = source.trim() === "";
  return (
    <div style={{ marginBottom: 6 }}>
      <pre
        onDoubleClick={onOpen}
        title="双击打开编辑器"
        style={{
          margin: 0,
          padding: "6px 8px",
          fontSize: 11,
          lineHeight: 1.5,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          background: "rgba(127,127,127,0.10)",
          borderRadius: 4,
          maxHeight: 160,
          overflow: "auto",
          whiteSpace: "pre",
          cursor: "pointer",
          opacity: empty ? 0.6 : 1,
        }}
      >
        {empty ? "// 还没有代码，点下面「编辑代码」开始写" : shown.join("\n") + (lines.length > shown.length ? `\n… 还有 ${lines.length - shown.length} 行` : "")}
      </pre>
      <Button size="small" block icon={<PlayCircleOutlined />} style={{ marginTop: 6 }} onClick={onOpen}>
        编辑代码 / 试运行
      </Button>
    </div>
  );
}

/**
 * Where a script node is actually written.
 *
 * The inspector could not be this: it is 320px wide, which is a column for
 * reading a value, not for writing a program in. Everything got squeezed there
 * anyway — an eight-line editor, a language tag and a run button on one row
 * that overflowed the pane, and a trial that opened a second modal on top of
 * the first, so the code and its result were never on screen together.
 *
 * Here they are side by side, which is the arrangement the work needs: change a
 * line, run it, read what came back without closing anything. The trial goes
 * through the same execution path as a real run — the point is not to simulate
 * the node but to be it, once, with values typed by hand.
 */
function ScriptWorkbench({
  config,
  inputSchema,
  outputSchema,
  onChange,
  onClose,
}: {
  config: ScriptNodeConfig;
  inputSchema: ParamSchemaFragment | null;
  outputSchema: ParamSchemaFragment | null;
  onChange: (config: FlowNode["config"]) => void;
  onClose: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedScriptId, setSelectedScriptId] = useState<string>();
  const [saveForm] = Form.useForm<{ name: string; description?: string }>();
  const describedConfig = config as DescribedScriptNodeConfig;
  const scripts = useQuery({ queryKey: ['scripts', false], queryFn: () => api.listScripts({ includeDeleted: false }) });
  const saveToLibrary = useMutation({
    mutationFn: (values: { name: string; description?: string }) => api.createScript({
      name: values.name,
      description: values.description,
      language: 'ts',
      source: config.source ?? '',
      inputSchema: JSON.stringify(config.inputSchema ?? inputSchema ?? null, null, 2),
      outputSchema: JSON.stringify(config.outputSchema ?? outputSchema ?? null, null, 2),
    }),
    onSuccess: () => {
      message.success('已复制到脚本库');
      setSaving(false);
      saveForm.resetFields();
      void qc.invalidateQueries({ queryKey: ['scripts'] });
    },
    onError: (error: Error) => message.error(error.message),
  });
  const importSelected = (): void => {
    const selected = scripts.data?.find((item) => item.id === selectedScriptId);
    if (!selected) return;
    const imported: DescribedScriptNodeConfig = {
      ...config,
      source: selected.source,
      description: selected.description ?? undefined,
      language: 'ts',
      inputSchema: parseScriptContract(selected.inputSchema),
      outputSchema: parseScriptContract(selected.outputSchema),
      inputSchemaRef: undefined,
      outputSchemaRef: undefined,
    };
    onChange(imported as FlowNode['config']);
    setImporting(false);
    message.success('已从脚本库复制，后续修改不会自动同步');
  };
  return (
    <Drawer
      open
      onClose={onClose}
      placement="right"
      width="min(1180px, 92vw)"
      title={config.source === undefined ? "脚本" : "编辑脚本"}
      styles={{ body: { padding: 0, overflow: "hidden" } }}
    >
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, padding: 16, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Suspense fallback={<Typography.Text type="secondary">编辑器加载中…</Typography.Text>}>
            <ScriptEditor
              fill
              language={config.language ?? "ts"}
              value={config.source ?? ""}
              onChange={(source) => onChange({ ...config, source })}
              inputSchema={inputSchema}
              outputSchema={outputSchema}
            />
          </Suspense>
          <Typography.Text type="warning" style={{ fontSize: 12, marginTop: 8 }}>
            沙箱封掉了文件和子进程，但<b>网络没封</b>——这段代码能把入参发到外网。别粘贴来路不明的代码。
          </Typography.Text>
        </div>

        <div
          style={{
            width: 360,
            flex: "none",
            borderInlineStart: "1px solid rgba(127,127,127,0.24)",
            padding: 16,
            overflowY: "auto",
          }}
        >
          <Space wrap style={{ marginBottom: 8 }}>
            <Button size='small' onClick={() => setImporting(true)}>从脚本库导入</Button>
            <Button size='small' onClick={() => {
              saveForm.setFieldsValue({ description: describedConfig.description });
              setSaving(true);
            }}>保存到脚本库</Button>
          </Space>
          <Typography.Text type='secondary' style={{ display: 'block', fontSize: 12, marginBottom: 12 }}>
            导入和保存均为复制，流程节点与脚本库不会自动同步。
          </Typography.Text>
          <ScriptTestConsole config={config} inputSchema={inputSchema} />
        </div>
      </div>
      <Modal open={importing} title='从脚本库导入' okText='复制到节点' cancelText='取消' okButtonProps={{ disabled: !selectedScriptId }} onOk={importSelected} onCancel={() => setImporting(false)}>
        <BcpSelect
          value={selectedScriptId}
          placeholder='选择脚本'
          options={(scripts.data ?? []).map((item) => ({ label: item.name, value: item.id }))}
          onChange={setSelectedScriptId}
        />
        <Typography.Text type='secondary' style={{ display: 'block', marginTop: 8 }}>会替换当前节点的代码、输入参数和返回结果。</Typography.Text>
      </Modal>
      <Modal open={saving} title='保存到脚本库' footer={null} onCancel={() => setSaving(false)}>
        <Form form={saveForm} layout='vertical' onFinish={(values) => saveToLibrary.mutate(values)}>
          <Form.Item name='name' label='名称' rules={[{ required: true, whitespace: true, message: '请输入脚本名称' }]}><Input maxLength={100} /></Form.Item>
          <Form.Item name='description' label='用途说明'><Input.TextArea rows={3} maxLength={500} /></Form.Item>
          <Button type='primary' htmlType='submit' loading={saveToLibrary.isPending}>保存副本</Button>
        </Form>
      </Modal>
    </Drawer>
  );
}

/**
 * The exact object the process will read on stdin, spelled out.
 *
 * "How do I get at my parameters?" was unanswerable from this panel, and the
 * honest reason is that the answer was never written down anywhere: the runner
 * sends whatever `resolveInputs` produced, keyed by the ports the node happens
 * to have. Now that a declared contract expands into one port per field, that
 * object IS the contract — so show it, and the question stops being asked.
 *
 * Built from the node's RESOLVED ports rather than from its schema, because
 * the ports are what the runner keys by; deriving it a second way here is how
 * a panel ends up confidently describing a payload that never arrives.
 */
function StdinShape({ ports }: { ports: FlowPort[] }): JSX.Element | null {
  const inputs = ports.filter((p) => p.direction === "in");
  if (inputs.length === 0) return null;
  const body = inputs.map((p) => `  "${p.id}": …${p.required ? "" : "   // 可选"}`).join("\n");
  return (
    <pre
      style={{
        fontSize: 11,
        lineHeight: 1.5,
        margin: "6px 0 0",
        padding: "6px 8px",
        borderRadius: 4,
        background: "rgba(127,127,127,0.10)",
        overflowX: "auto",
      }}
    >
      {`stdin = {\n${body}\n}`}
    </pre>
  );
}

/**
 * The command, edited as TEXT rather than as the `string[]` it is stored as.
 *
 * A blank line is not an argument, so the config drops them — but a controlled
 * box that renders `command.join("\n")` and hands back
 * `text.split("\n").filter(Boolean)` deletes the blank line the caret is
 * standing on: press Enter after `python3` and the value comes straight back
 * as `python3`, unchanged, so a second line could never be typed AT ALL. (A
 * two-line command pasted in one go survived that round trip, which is how the
 * multi-line commands that do exist got there.) Holding the raw text here lets
 * the empty line live until it has something on it, and the config still never
 * sees one.
 */
function CommandEditor({ value, onChange }: { value: string; onChange: (next: string[]) => void }) {
  const [text, setText] = useState(value);
  /** The stored command as this box last left it. Anything else arriving in
   *  `value` came from somewhere this box does not know about — an undo — and
   *  is worth pulling in; its own echo is not, or the blank line it is holding
   *  open would be yanked out from under the caret on the next render. */
  const echo = useRef(value);
  if (value !== echo.current) {
    echo.current = value;
    if (value !== toCommand(text).join("\n")) setText(value);
  }

  return (
    <Input.TextArea
      autoSize={{ minRows: 2, maxRows: 5 }}
      placeholder={"python3\n.claude/skills/product-preprocess/preprocess.py"}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const command = toCommand(e.target.value);
        echo.current = command.join("\n");
        onChange(command);
      }}
    />
  );
}

/** One argument per line, blank lines discarded — `spawn` would pass an empty
 *  line on to the script as an empty argument. */
function toCommand(text: string): string[] {
  return text.split("\n").filter(Boolean);
}
