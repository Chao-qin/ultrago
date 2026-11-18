import { useState } from "react";
import { Tabs } from "antd";
import { PageHeader } from "../components/PageHeader";
import { SettingsScripts } from "../components/SettingsScripts";
import { SettingsEnv } from "../components/SettingsEnv";
import { SettingsAppearance } from "../components/SettingsAppearance";

/** 设置：workspace 的 pnpm 脚本 + 仓库根 `.env` + 外观。前两块的读接口都开放，
 *  「运行脚本」和「写 .env」只允许本机调用（后端 LoopbackGuard）；外观纯前端，
 *  存在 localStorage，不经过后端。 */
export function Settings() {
  const [tab, setTab] = useState("scripts");
  return (
    <div className="console-settings-page">
      <PageHeader title="设置" subtitle="workspace 的 pnpm 脚本、仓库根 .env 与外观" />
      <Tabs
        tabPosition="left"
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: "scripts", label: "pnpm 脚本", children: <SettingsScripts /> },
          { key: "env", label: "环境变量", children: <SettingsEnv /> },
          { key: "appearance", label: "外观", children: <SettingsAppearance /> },
        ]}
      />
    </div>
  );
}
