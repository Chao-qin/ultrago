import { Button, Input, Space, Typography, message } from "antd";
import { CopyOutlined } from "@ant-design/icons";

const { Text } = Typography;

/**
 * 「接入」这件事的共用零件。
 *
 * 两个地方要它：渠道的「接入」（怎么用这个**模型**）和 key 的「接入」（怎么用
 * 这把**钥匙**）。两边给的都是一份要粘进别的客户端的 OpenAI 配置，字段也一样，
 * 所以复制的语气、等宽字体、以及「复制按钮失灵时还得能手抄」这条都该只有一份
 * 实现——它们各自写一遍，迟早会长出两种不同的措辞和两种不同的 bug。
 */

export function copyText(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => message.success(`已复制${what}`),
    () => message.error("复制失败，请手动选中复制"),
  );
}

/** 一行「标签 + 值 + 复制」。值用等宽并允许选中——复制按钮失灵时还得能手抄。 */
export function ConnectField({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: React.ReactNode;
}) {
  return (
    <div>
      <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>
      <Space.Compact style={{ width: "100%", marginTop: 2 }}>
        <Input readOnly value={value} style={{ fontFamily: "var(--bcp-font-mono, monospace)" }} />
        <Button icon={<CopyOutlined />} onClick={() => copyText(value, label)} />
      </Space.Compact>
      {hint && (
        <div style={{ marginTop: 4 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{hint}</Text>
        </div>
      )}
    </div>
  );
}

/**
 * 一份配置的两种粘贴形态。
 *
 * env 与 JSON 覆盖了几乎所有客户端的读法，而两者由同一组值算出来，不会出现
 * 「env 里是新的、JSON 里还是旧的」。
 */
export function asEnvBlock(baseUrl: string, apiKey: string, model: string): string {
  return [`OPENAI_BASE_URL=${baseUrl}`, `OPENAI_API_KEY=${apiKey}`, `OPENAI_MODEL=${model}`].join("\n");
}

export function asJsonBlock(baseUrl: string, apiKey: string, model: string): string {
  return JSON.stringify({ baseUrl, apiKey, model }, null, 2);
}
