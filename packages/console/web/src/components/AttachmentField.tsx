import { useState } from "react";
import { Button, Input, Space, Typography, Upload, message } from "antd";
import { LinkOutlined, PlusOutlined } from "@ant-design/icons";
import type { UploadFile } from "antd";
import type { AttachmentParamShape, UploadSource } from "@bcp/shared";
import { api } from "../lib/api";

/**
 * AttachmentField — the control for a param that carries FILE attachments
 * (schema shape detected by `attachmentParamShape`), replacing the JSON
 * textarea that used to make the user hand-type `[{"type":"image",…}]`.
 *
 * The value it produces is unchanged — the book's declared contract, an array
 * of `{type?, url|localPath, filename, mimeType}` — so books and the backend's
 * upload resolver stay untouched. Two ways in:
 *   local file → staged on the console machine, item carries `localPath`
 *   pasted URL → item carries `url`, fetched by the backend at run time
 * (the contract allows exactly one of the two per item).
 */

export type AttachmentItem = UploadSource & { type?: string };

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|svg)(\?|#|$)/i;

export function AttachmentField({
  shape,
  value,
  onChange,
}: {
  shape: AttachmentParamShape;
  value?: AttachmentItem[];
  onChange?: (next: AttachmentItem[]) => void;
}) {
  const items = Array.isArray(value) ? value : [];
  // Names of the files in the current upload batch. The picker is disabled
  // while it drains, so only one batch is ever in flight — that's what keeps
  // the `items` captured below from going stale under concurrent uploads.
  const [uploading, setUploading] = useState<string[]>([]);
  const [urlDraft, setUrlDraft] = useState("");

  const fileList: UploadFile[] = [
    ...items.map((item, i) => {
      const href = previewUrl(item);
      return {
        uid: `a${i}`,
        name: displayName(item),
        status: "done" as const,
        url: href,
        thumbUrl: isImage(item) ? href : undefined,
      };
    }),
    ...uploading.map((name, i) => ({ uid: `u${i}`, name, status: "uploading" as const, percent: 99 })),
  ];

  const uploadBatch = async (files: File[]) => {
    setUploading(files.map((f) => f.name));
    const added: AttachmentItem[] = [];
    for (const file of files) {
      try {
        const staged = await api.uploadAttachment(file);
        added.push(withKind({ localPath: staged.localPath, filename: staged.filename, mimeType: staged.mimeType }, shape.kinds));
      } catch (e) {
        message.error(`${file.name} 上传失败: ${e instanceof Error ? e.message : String(e)}`);
      }
      setUploading((rest) => rest.slice(1));
    }
    if (added.length) onChange?.([...items, ...added]);
  };

  const addUrl = () => {
    const raw = urlDraft.trim();
    if (!raw) return;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      message.error("请填写完整的链接，例如 https://example.com/a.png");
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      message.error("只支持 http / https 链接");
      return;
    }
    const filename = decodeURIComponent(parsed.pathname.split("/").pop() ?? "") || undefined;
    onChange?.([...items, withKind({ url: raw, filename }, shape.kinds)]);
    setUrlDraft("");
  };

  // One card holds both ways in. They were siblings with nothing around them
  // before — a 104px picture-card tile, then a full-width URL row starting at a
  // different left edge, then loose helper text — which read as two unrelated
  // controls even though they produce the same item. The container is the same
  // one `.delivery-card` uses a few rows down in this dialog, so the form now
  // speaks one language.
  return (
    <div className="attachment-card">
      <Upload
        listType="picture-card"
        multiple
        fileList={fileList}
        // `|| undefined`: antd resolves disabled as `ownProp ?? context`, so a
        // literal false here would re-enable the picker while the surrounding
        // Form is disabled (mid-submit). Only force it ON, never OFF.
        disabled={uploading.length > 0 || undefined}
        // We do the transfer ourselves (one request per file, in order) and
        // never hand the batch to antd's uploader — hence the `false`.
        beforeUpload={(file, batch) => {
          if (file === batch[0]) void uploadBatch(batch);
          return false;
        }}
        onRemove={(file) => {
          if (!file.uid.startsWith("a")) return false;
          const index = Number(file.uid.slice(1));
          onChange?.(items.filter((_, i) => i !== index));
        }}
        onPreview={(file) => {
          if (file.url) window.open(file.url, "_blank", "noopener");
        }}
      >
        <div>
          <PlusOutlined />
          <div style={{ marginTop: 6, fontSize: 12 }}>选择文件</div>
        </div>
      </Upload>

      <div className="attachment-card-alt">
        <Space.Compact style={{ width: "100%" }}>
          <Input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onPressEnter={(e) => {
              e.preventDefault();
              addUrl();
            }}
            prefix={<LinkOutlined />}
            placeholder="或粘贴公网文件链接 (http / https)"
          />
          <Button type="primary" ghost onClick={addUrl} disabled={!urlDraft.trim() || undefined}>
            添加
          </Button>
        </Space.Compact>
      </div>
      <Typography.Text type="secondary" className="attachment-card-hint">
        本地文件会先上传到 console 所在机器的 resource/uploads/ 目录，再由 book 读取；链接则由后端在运行时抓取。单个文件上限 25MB。
      </Typography.Text>
    </div>
  );
}

/** Tag the item with the discriminator its schema declares (image vs file).
 * Inferred from the MIME type / extension — the two are never ambiguous for
 * the kinds books declare today, and a wrong guess only changes which uploader
 * the page uses, not whether the bytes arrive. */
function withKind(item: AttachmentItem, kinds: string[] | null): AttachmentItem {
  if (!kinds?.length) return item;
  if (isImage(item) && kinds.includes("image")) return { type: "image", ...item };
  return { type: kinds.includes("file") ? "file" : kinds[0], ...item };
}

/** Where the picker can show this attachment from. A pasted URL is used
 * as-is; a staged local file is served back by the console so a schedule
 * reopened later still shows its thumbnail. A localPath authored elsewhere
 * (an MCP client) isn't in resource/uploads/ and simply has no preview. */
function previewUrl(item: AttachmentItem): string | undefined {
  if (item.url) return item.url;
  return item.localPath ? `/api/uploads/${encodeURIComponent(basename(item.localPath))}` : undefined;
}

function displayName(item: AttachmentItem): string {
  return item.filename || basename(item.localPath ?? item.url ?? "") || "attachment";
}

function basename(pathOrUrl: string): string {
  return pathOrUrl.split(/[\\/]/).pop() ?? pathOrUrl;
}

function isImage(item: AttachmentItem): boolean {
  if (item.type === "image") return true;
  if (item.mimeType) return item.mimeType.startsWith("image/");
  return IMAGE_EXT.test(item.url ?? item.localPath ?? "");
}
