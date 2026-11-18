import { useState, useMemo } from "react";
import { Modal, Radio, Space, Input, Tag, Typography, Divider, Button } from "antd";
import { ClockCircleOutlined } from "@ant-design/icons";
import { BcpSelect } from "./BcpSelect";
import { useTheme, getPalette } from "../theme";
import parser from 'cron-parser';

/** Human-readable cron presets + a visual builder. */
interface Props {
  open: boolean;
  value: string | null;
  onSave: (cron: string | null) => void;
  onCancel: () => void;
}

type Tab = "preset" | "builder" | "raw";

// ── Presets ──────────────────────────────────────────────────────────
interface Preset {
  label: string;
  cron: string;
}
const PRESETS: Preset[] = [
  { label: "每 5 分钟", cron: "*/5 * * * *" },
  { label: "每 15 分钟", cron: "*/15 * * * *" },
  { label: "每 30 分钟", cron: "*/30 * * * *" },
  { label: "每小时", cron: "0 * * * *" },
  { label: "每天 0 点", cron: "0 0 * * *" },
  { label: "每天 9 点", cron: "0 9 * * *" },
  { label: "每天 18 点", cron: "0 18 * * *" },
  { label: "每天 9 点和 18 点", cron: "0 9,18 * * *" },
  { label: "每周一 0 点", cron: "0 0 * * 1" },
  { label: "每月 1 号 0 点", cron: "0 0 1 * *" },
];

// ── Human readable ───────────────────────────────────────────────────
const DOW_MAP = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function describeCron(cron: string): string {
  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return "无效表达式";
    const [min, hour, dom, month, dow] = parts;

    if (min === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "每分钟";
    if (min.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') return `每 ${min.slice(2)} 分钟`;
    if (hour.startsWith('*/') && min === '0' && dom === '*' && month === '*' && dow === '*') return `每 ${hour.slice(2)} 小时`;
    if (min === "0" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "每小时整点";
    if (min === "0" && hour !== "*" && dom === "*" && month === "*" && dow === "*") return `每天 ${hour}:00`;
    if (min === "0" && hour !== "*" && dom === "*" && month === "*" && dow !== "*") {
      const days = dow.split(",").map((d) => DOW_MAP[Number(d)] ?? d).join(", ");
      return `每星期 ${days} ${hour}:00`;
    }
    if (min === "0" && hour !== "*" && dom !== "*" && month === "*" && dow === "*") {
      return `每月 ${dom} 号 ${hour}:00`;
    }
    return cron;
  } catch {
    return "无效表达式";
  }
}

// ── Builder helpers ──────────────────────────────────────────────────
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => ({ label: `${i}`, value: i }));
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => ({ label: `${i}:00`, value: i }));
const DOM_OPTIONS = Array.from({ length: 31 }, (_, i) => ({ label: `${i + 1}`, value: i + 1 }));
const DOW_OPTIONS = DOW_MAP.map((d, i) => ({ label: d, value: i }));

export function CronSelector(props: Props) {
  return props.open ? <CronSelectorDialog {...props} /> : null;
}

function CronSelectorDialog({ open, value, onSave, onCancel }: Props) {
  const { mode } = useTheme();
  const palette = getPalette(mode);
  const [tab, setTab] = useState<Tab>("preset");
  const [raw, setRaw] = useState(value ?? "");
  const [selectedPreset, setSelectedPreset] = useState(value ?? '');
  const parts = (value ?? '0 * * * *').trim().split(/\s+/);
  const builderSupported = parts.length === 5 && /^\d+$/.test(parts[0]) && parts[3] === '*'
    && [parts[1], parts[2], parts[4]].every(part => /^(\*|\d+)$/.test(part));
  const [bMin, setBMin] = useState<number>(builderSupported ? Number(parts[0]) : 0);
  const [bHour, setBHour] = useState<number | '*'>(builderSupported && parts[1] !== '*' ? Number(parts[1]) : '*');
  const [bDom, setBDom] = useState<number | '*'>(builderSupported && parts[2] !== '*' ? Number(parts[2]) : '*');
  const [bDow, setBDow] = useState<number | '*'>(builderSupported && parts[4] !== '*' ? Number(parts[4]) % 7 : '*');

  const builderCron = useMemo<string>(() => {
    const h = bHour === "*" ? "*" : String(bHour);
    const d = bDom === "*" ? "*" : String(bDom);
    const w = bDow === "*" ? "*" : String(bDow);
    return `${bMin} ${h} ${d} * ${w}`;
  }, [bMin, bHour, bDom, bDow]);

  const previewCron = (tab === 'preset' ? selectedPreset : tab === 'builder' ? builderCron : raw).trim();
  const validationError = useMemo(() => {
    if (!previewCron) return '请选择或输入 Cron 表达式';
    if (previewCron.split(/\s+/).length !== 5) return '仅支持 5 字段 Cron：分 时 日 月 星期';
    try {
      parser.parseExpression(previewCron);
      return null;
    } catch {
      return 'Cron 表达式无效，请检查各字段的范围和格式';
    }
  }, [previewCron]);
  const description = previewCron ? describeCron(previewCron) : "";

  const handlePreset = (cron: string) => {
    setSelectedPreset(cron);
  };

  const handleSave = () => {
    if (!validationError) onSave(previewCron);
  };

  return (
    <Modal
      title={
        <Space>
          <ClockCircleOutlined />
          <span>定时任务配置</span>
        </Space>
      }
      open={open}
      centered
      onCancel={onCancel}
      width={520}
      footer={
        <Space>
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" onClick={handleSave} disabled={!!validationError}>
            保存
          </Button>
        </Space>
      }
    >
      <Radio.Group
        optionType="button"
        buttonStyle="solid"
        value={tab}
        onChange={(e) => setTab(e.target.value as Tab)}
        style={{ marginBottom: 16, width: "100%" }}
      >
        <Radio.Button value="preset" style={{ width: "33.33%", textAlign: "center" }}>常用预设</Radio.Button>
        <Radio.Button value="builder" disabled={!builderSupported} style={{ width: "33.33%", textAlign: "center" }}>可视化配置</Radio.Button>
        <Radio.Button value="raw" style={{ width: "33.33%", textAlign: "center" }}>自定义</Radio.Button>
      </Radio.Group>

      {/* ── Preset tab ── */}
      {tab === "preset" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {PRESETS.map((p) => (
            <Button
              key={p.cron}
              size="small"
              type={selectedPreset === p.cron ? "primary" : "default"}
              onClick={() => handlePreset(p.cron)}
            >
              {p.label}
              <Typography.Text
                code
                style={{
                  marginLeft: 6,
                  fontSize: 11,
                  opacity: 0.7,
                  color: selectedPreset === p.cron ? '#fff' : undefined,
                }}
              >
                {p.cron}
              </Typography.Text>
            </Button>
          ))}
        </div>
      )}

      {/* ── Builder tab ── */}
      {tab === "builder" && (
        <div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                分钟
              </Typography.Text>
              <BcpSelect
                value={bMin}
                onChange={setBMin}
                options={MINUTE_OPTIONS}
                style={{ width: 100 }}
                size="small"
              />
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                小时
              </Typography.Text>
              <BcpSelect
                value={bHour}
                onChange={(v) => setBHour(v)}
                options={[{ label: "每小时", value: "*" as const }, ...HOUR_OPTIONS]}
                style={{ width: 100 }}
                size="small"
              />
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                日期
              </Typography.Text>
              <BcpSelect
                value={bDom}
                onChange={(v) => setBDom(v)}
                options={[{ label: "每天", value: "*" as const }, ...DOM_OPTIONS]}
                style={{ width: 100 }}
                size="small"
              />
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                星期
              </Typography.Text>
              <BcpSelect
                value={bDow}
                onChange={(v) => setBDow(v)}
                options={[{ label: "每天", value: "*" as const }, ...DOW_OPTIONS]}
                style={{ width: 100 }}
                size="small"
              />
            </div>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {bDom !== '*' && bDow !== '*' ? '日期和星期同时指定时，满足任一条件即可执行。' : describeCron(builderCron)}
          </Typography.Text>
        </div>
      )}

      {/* ── Raw tab ── */}
      {tab === "raw" && (
        <div>
          <Input
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="0 9 * * *"
            style={{ fontFamily: "monospace" }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
            标准 5 字段 cron: 分 时 日 月 星期
          </Typography.Text>
        </div>
      )}

      <Divider style={{ margin: "12px 0" }} />
      {!builderSupported && <Typography.Paragraph type="secondary">当前表达式包含复杂规则，请使用自定义编辑，以保留完整条件。</Typography.Paragraph>}
      {validationError && <Typography.Paragraph type="danger">{validationError}</Typography.Paragraph>}

      {/* ── Preview ── */}
      <div style={{ textAlign: "center" }}>
        {previewCron ? (
          <>
            <Tag color="blue" style={{ fontSize: 14, padding: "2px 12px" }}>{previewCron}</Tag>
            <div style={{ marginTop: 6, color: palette.ink2, fontSize: 13 }}>{description}</div>
          </>
        ) : (
          <Typography.Text type="secondary">选择一个定时方式</Typography.Text>
        )}
      </div>
    </Modal>
  );
}
