# 桌面客户端扩展上架 Chrome 应用商店

目前桌面客户端随包附带一个解压后的扩展，用户需要手动安装和维护：

- 在 `chrome://extensions` 打开开发者模式，再加载随包目录；
- Windows 正式版 Chrome 会持续提示“停用开发者模式扩展”；
- 0.1.6 及更早的扩展，每次升级后要手动点“重新加载”。从包含版本比对逻辑的版本起，扩展发现随包版本不同会自动重新加载一次，前提是发版时递增扩展版本号。

扩展上架商店后，客户端可以写入当前用户的注册表，由 Chrome 从商店自动安装并自动更新，不再需要开发者模式。

本文是上架和接入步骤。**上架本身需要维护者的开发者账号，属于对外发布，由维护者执行。**接入代码等拿到商店分配的 key 后再补，届时可以实际验证。

## 已核实的前提

| 事项 | 结论 | 来源 |
|---|---|---|
| Windows 上能否用本地 CRX 安装 | 不能。Chrome 33 起，Windows 不允许从本地 CRX 路径做外部安装 | [Use alternative installation methods](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions) |
| 注册表外部安装的更新地址 | `update_url` 必须指向商店：`https://clients2.google.com/service/update2/crx` | 同上 |
| 是否需要管理员权限 | 不需要。Chromium 先读 HKLM；只有 HKLM 下的键打不开时，才回退读 `HKCU\Software\Google\Chrome\Extensions` | [external_registry_loader_win.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/external_registry_loader_win.cc) |
| 用户是否需要确认 | 需要。Windows 和 macOS 上，外部安装的扩展要在 Chrome 弹出的确认框里手动启用 | [Use alternative installation methods](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions) |
| 用户在界面卸载之后 | 该扩展进入阻止列表，之后启动不再安装或更新；用户正常安装一次再卸载可以解除 | 同上 |
| 本地加载与商店 ID 一致 | 先上传、不发布，从开发者控制台复制公钥写入 manifest 的 `key` | [Manifest - key](https://developer.chrome.com/docs/extensions/reference/manifest/key) |

## 维护者操作步骤

1. 注册 Chrome 应用商店开发者账号。
2. 在 Windows 维护机上构建扩展，执行 `pnpm --filter @bcp/extension build`，把 `packages/extension/.output/chrome-mv3` 打成 zip。
3. 在开发者控制台上传 zip，**先不要发布**。
   - 现有 manifest 带了自定义的 `key`（定义在 `packages/extension/wxt.config.ts`）。上传包里能否保留这个字段，目前未核实。如果控制台拒绝，删掉 `key` 后重新打包上传。
4. 在控制台的扩展页面复制公钥，替换 `wxt.config.ts` 里的 `key`。重新构建，本地加载解压包，确认 `chrome://extensions` 显示的 ID 与控制台的 Item ID 一致。
   - 扩展 ID 会变。桌面客户端注册连接宿主时，`allowed_origins` 由随包扩展 manifest 的 `key` 计算得出（见 `packages/desktop/src/native-registration.mjs` 的 `extensionId`），只要随包目录用新 key 构建，就无需额外修改。
5. 可见性选择“不公开（Unlisted）”，提交审核。
6. 审核通过后，把 Item ID 和新 `key` 告诉开发者，用来补接入代码。

## 拿到 key 后要补的代码（约 20 行）

| 位置 | 改动 |
|---|---|
| `packages/desktop/src/native-registration.mjs` | 注册连接宿主时，同时写入 `HKCU\Software\Google\Chrome\Extensions\<扩展 ID>`，字符串值 `update_url` = `https://clients2.google.com/service/update2/crx` |
| `packages/desktop/ui/index.html` | “安装扩展”步骤改为“在 Chrome 弹出的提示中启用扩展”，保留“加载已解压”作为备用说明 |
| `packages/desktop/build/installer.nsh` | 卸载时删除上述注册表键 |
| `packages/desktop/package.json` | **必须继续随包附带扩展目录**：准备流程要检查它的 `manifest.json`，连接宿主的 `allowed_origins` 由其中的 `key` 计算，扩展自动重载也要读其中的版本。换成商店 key 后，随包目录同样使用新 key 构建，也可用于离线安装 |

验证方式：在 Windows 干净机上安装客户端，确认 Chrome 弹出启用提示；启用后扩展连接客户端；在商店更新版本后，Chrome 能自动更新。

## 风险

- 用户在 Chrome 里卸载扩展后会进入阻止列表，客户端无法再次自动安装。需要在界面上给出商店安装链接作为兜底。
- 如果 HKLM 下已有同名键，Chromium 不会回退读 HKCU。客户端只写 HKCU，不处理 HKLM。
- 改用商店 key 后，旧 ID 的解压扩展会和新扩展并存。需要在升级说明里提示用户移除旧扩展。
