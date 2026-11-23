# @bcp/comfyui

ComfyUI 自动检测设备并选择 PyTorch 后端，通过 [Comfyui-flexai](https://github.com/Semonxue/Comfyui-flexai) 节点调用远端 OpenAI 兼容接口出图。

| 设备 | 后端 |
|---|---|
| Apple Silicon / 支持 Metal 的 AMD Mac | MPS |
| NVIDIA GPU（Windows/Linux） | CUDA |
| AMD / Intel GPU（Windows） | DirectML |
| 未检测到 GPU | CPU |

DirectML 是 ComfyUI 上游的实验性后端，兼容性和性能有限。检测到 GPU 但对应 PyTorch 后端不可用时，初始化或启动会报错，不会静默切换到 CPU。

ComfyUI 本体不提交进仓库：`setup` 会把锁定版本的上游代码拉到 `./ComfyUI`（已被 git 忽略）。

| 上游 | 锁定版本 |
|---|---|
| [ComfyUI](https://github.com/comfyanonymous/ComfyUI) | `1d2ea29` |
| [Comfyui-flexai](https://github.com/Semonxue/Comfyui-flexai) | `a5acb9f` |

## 使用

```bash
pnpm --filter @bcp/comfyui run setup    # 幂等：拉代码、建 venv、检测设备并安装对应 torch 和依赖
# 编辑 packages/comfyui/.env，填写 OPENAI_API_BASE / OPENAI_API_KEY
pnpm --filter @bcp/comfyui start    # 后台启动，默认 http://0.0.0.0:8188
pnpm --filter @bcp/comfyui status
pnpm --filter @bcp/comfyui stop
pnpm --filter @bcp/comfyui check:nodes    # nodes/bcp 的离线测试（不联网、不调接口），没 setup 时退出码 2
pnpm --filter @bcp/comfyui check:device   # 设备后端检测测试（不需要 GPU）
```

监听地址和端口可以用 `COMFYUI_LISTEN` / `COMFYUI_PORT` 修改。日志在 `ComfyUI/comfyui.log`。

## 配置

| 文件 | 作用 | 是否提交 |
|---|---|---|
| `.env` | 出图接口的 base url 和 key（`OPENAI_*`），以及文本模型的 base url、key 和模型名（`TEXT_*`），由 `.env.example` 复制而来 | 否 |
| `flexai_models.json` | 节点里模型下拉框的选项 | 是 |
| `prompt_library.json` | 拍摄维度的可选值（`dimensions`）和技能：画面模板 + 各维度预设（`shot`）+ 尺寸 | 是 |
| `workflows/*.json` | 现成的工作流，`setup` 复制到 `ComfyUI/user/default/workflows/`，**不覆盖**界面里改过的同名文件；由 `scripts/gen_workflows.py` 生成，节点参数变了就重新生成；已经 setup 过的机器要先删掉 `ComfyUI/user/default/workflows/` 里的旧文件才会拿到新版 | 是 |

前两个文件通过软链接接入 `ComfyUI/custom_nodes/Comfyui-flexai/`。在节点的 `custom_model` 里填过的新模型会自动写回 `flexai_models.json`。

key 只放在 `.env` 里，不要填到节点的输入框中：节点参数会被写进工作流 JSON 和生成图片的元数据。

## 出图

在界面里添加 **OpenAI Image (FlexAI)** 节点，后面接一个 **Save Image**。尺寸用 `size` 下拉框选择。把图片接到 `image_1`–`image_4` 时会改走改图接口。

## 工作流

| 工作流 | 做什么 | 可选开关（左上角「开关」节点） |
|---|---|---|
| 出图 | 通用出图：选技能或交给 AI 选，拍摄规格按维度覆盖，透明底直接出 PNG | 参考图、批量描述 |
| 电商主图套图 | 01~06 六张分工固定的 1:1 主图，后面五张以 01 为色调基准 | 更多参考图、02~06 每一张 |
| 图文笔记套图 | 3:4 封面 + 3 张内页，内页参考封面 | 封面叠加中文标题 |
| 公众号文章套图 | 文本模型写文章，出首图 900x383、次图 200x200 和正文配图 | 首图叠加文章标题 |
| 图片编辑 | 局部重绘、扩图 | 局部重绘、扩图 |
| 本地后期 | 本机 CPU 抠图、2 倍放大，不调接口 | 抠图、高清放大 |

可选功能放在标题以「可选：」开头的分组里，开关节点（rgthree 的 Fast Groups Bypasser）只列这些分组。

## 本包自带的节点

`nodes/bcp` 由 `setup` 软链接到 `ComfyUI/custom_nodes/bcp`，节点都在 `bcp` 分类下：

| 节点 | 作用 | 常见接法 |
|---|---|---|
| **OpenAI Image (BCP)** | 调同一个远端接口出图 / 改图，比 FlexAI 多了画质 `quality`、张数 `n`、透明背景 `background`、蒙版 `mask`，`image_1`–`image_8` 的参考图全部发送（FlexAI 改图只用第一张） | 输出 `images` 接 Save Image；透明底时 `images` + `alpha` 接 JoinImageWithAlpha |
| **技能 (BCP)** | 按技能模板和拍摄预设拼好的提示词、尺寸、实际用的技能名。下拉选「AI 自动选择」时由文本模型按技能的 `description` 挑技能并扩写描述；`batch` 接批量描述时按行出图 | `prompt` / `size` 接出图节点 |
| **拍摄规格 (BCP)** | 机位、镜头、景深、构图、布光、色调、风格各一个下拉框：「默认」沿用技能预设，选了别的就覆盖这一项；`extra` 是补充要求 | 接技能节点的 `spec`（也可以直接接一段文字当补充） |
| **批量描述 (BCP)** | 每行一条描述组成的列表，下游节点按行各执行一次 | 接技能节点的 `batch` |
| **中文标题 (BCP)** | 用系统中文字体在图上叠加标题，按字换行。内置 TextOverlay 的默认字体没有中文字形 | 接在出图节点后面 |
| **公众号文章 (BCP)** | 文本模型按主题写标题、Markdown 正文（带【配图N】占位）、封面和配图的画面描述 | `article` 接 SaveText；`cover`、`images` 分别接公众号封面、公众号配图技能 |

技能模板的写法与 lumen-studio 一致：`{{input}}` 是画面描述，`{{refs}}` 是参考图说明。提示词按「画面内容 → 拍摄（机位、镜头、景深、构图）→ 光影（布光、色调）→ 风格 → 补充」的固定顺序输出，维度名只能用 `nodes/bcp/prompt.py` 的 `SECTIONS` 里列出的。尺寸直接写成宽 x 高，宽高都是 16 的倍数。修改 `prompt_library.json` 后刷新浏览器就能生效，不需要重启。

技能节点的「AI 自动选择」和公众号文章节点用 `.env` 里的 `TEXT_API_BASE` / `TEXT_API_KEY` / `TEXT_MODEL`（OpenAI 兼容的 chat.completions），可以和出图不是同一个渠道，每次执行都重新读取，改完不用重启。节点上的 `model` 不为空时覆盖默认模型。

### 在页面上配置

ComfyUI 的 **设置 → BCP** 里可以直接填出图接口和文本模型的地址、API Key、默认模型，填完由后台写进 `.env`（`nodes/bcp/config_api.py` 的 `/bcp/config`），BCP 节点下次执行就用新值；FlexAI 在启动时读 `.env`，要重启才生效。

- key 只写不读：输入框保存后清空，页面上只显示「已配置（…末 4 位）」。ComfyUI 自己的设置会被 `/api/settings` 原样返回给任何能访问端口的人，所以 key 不留在设置里。
- 输入停止 1.5 秒后才保存：设置输入框每按一个键都会触发一次变更。
- ComfyUI 没有登录，能访问端口的人也能通过 `/bcp/config` 修改接口地址，把之后的请求连同 key 引到别处。只在端口不对外开放、或网络可信时使用页面配置。

中文标题节点依赖系统中文字体（`fc-match` 能找到即可），没有时安装 `fonts-wqy-zenhei`。

`setup` 还会下载 RealESRGAN 2 倍放大模型到 `ComfyUI/models/upscale_models/`，供内置的 ImageUpscaleWithModel 节点使用，在 CPU 上运行。

### 重跑与种子

ComfyUI 在输入完全不变时直接复用上次的结果，不会重新执行。所以出图节点和公众号文章节点都带一个 `seed`：它不发给接口，只在每次运行后自动换值（`control_after_generate = randomize`），保证每次 Run 都重新出图。想复用上次结果、不再调用接口，就把它改成 `fixed`。

## 第三方节点

`setup` 按锁定版本安装，`start` 带 `--enable-manager` 启动：

| 节点 | 用途 | 说明 |
|---|---|---|
| ComfyUI-Manager | 在页面上安装、更新、管理节点 | ComfyUI 官方的 pip 包（`manager_requirements.txt`），不再克隆仓库 |
| rgthree-comfy | 一键开关整组节点、改前改后对比、种子、整理连线 | 无额外依赖。新版节点渲染（Vue 节点）下部分功能可能显示不正常，这是它自己的提示 |
| ComfyUI-RMBG | 本机 CPU 抠图（工作流「本地抠图」），不调接口 | 依赖去掉了 `onnxruntime-gpu`（显卡版）和 `groundingdino-py`（要编译，只给按文字分割用）；SAM3、Florence2 两个节点因缺依赖不加载，抠图不受影响。上游加载器有个 bug 会让任一节点出错就整包失败，`setup` 用 sed 修正。RMBG-2.0 第一次使用时下载约 845MB，之后每张约 6 秒；它的官方许可是自定义许可，商用前确认 BRIA 的条款 |

第三方节点会在服务器上执行任意 Python 代码，只装来源可靠的。
