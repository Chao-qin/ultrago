import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// 设置 → BCP：接口地址、key、默认文本模型的编辑入口。填写后由后台写进 packages/comfyui/.env，
// 节点从那里读。key 填完立即清空输入框：ComfyUI 的设置会被 /api/settings 原样返回，不能留在这里。
const FIELDS = [
  ["image_base", "出图接口", "接口地址", "OpenAI 兼容地址，一般以 /v1 结尾。FlexAI 节点要重启 ComfyUI 才会读到新值"],
  ["image_key", "出图接口", "API Key", "填入后写进服务器的 .env，输入框随即清空，页面上读不回来"],
  ["text_base", "文本模型", "接口地址", "OpenAI 兼容地址，一般以 /v1 结尾"],
  ["text_key", "文本模型", "API Key", "填入后写进服务器的 .env，输入框随即清空，页面上读不回来"],
  ["text_model", "文本模型", "默认模型", "AI 节点上的 model 留空时使用这个模型"],
];
const current = await (await api.fetchApi("/bcp/config")).json();
let ready = false; // 加载时回填 .env 的现值也会触发 onChange，那不是用户修改
// 设置输入框每按一个键就触发一次 onChange：停止输入一段时间后再保存，否则会把半截 key 写进去
const SAVE_DELAY_MS = 1500;
const timers = {};

async function save(field, value) {
  const res = await api.fetchApi("/bcp/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: value }),
  });
  const ok = res.ok;
  app.extensionManager.toast.add({
    severity: ok ? "success" : "error",
    summary: ok ? "已保存到服务器 .env" : "保存失败",
    detail: ok ? "" : (await res.json()).error,
    life: 3000,
  });
  if (!ok) return;
  if (field.endsWith("_key")) await app.extensionManager.setting.set(`BCP.${field}`, "");
  else current[field] = value;
}

app.registerExtension({
  name: "bcp.config",
  // 设置面板按注册顺序倒序显示，反过来注册才是 地址 → Key → 模型
  settings: [...FIELDS].reverse().map(([field, group, name, tooltip]) => ({
    id: `BCP.${field}`,
    name: field.endsWith("_key") ? `${name}（${current[field]}）` : name,
    type: "text",
    defaultValue: "",
    tooltip,
    category: ["BCP", group, name],
    attrs: field.endsWith("_key") ? { type: "password", placeholder: "粘贴新的 key" } : {},
    onChange: (value) => {
      clearTimeout(timers[field]);
      if (ready && value && value !== current[field]) timers[field] = setTimeout(() => save(field, value.trim()), SAVE_DELAY_MS);
    },
  })),
  async setup() {
    for (const [field] of FIELDS) {
      await app.extensionManager.setting.set(`BCP.${field}`, field.endsWith("_key") ? "" : current[field]);
    }
    ready = true;
  },
});
