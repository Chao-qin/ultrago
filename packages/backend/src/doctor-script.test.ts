import { test } from "node:test";
import assert from "node:assert/strict";
import { CHROME_RENDERING_FLAGS } from "@bcp/shared";
// @ts-expect-error — plain ESM script outside the package, imported for its exported helpers.
import { chromeFlagStatus, CHROME_RENDERING_FLAGS as DOCTOR_FLAGS, readEnv } from "../../../scripts/doctor.mjs";

test("doctor 的 Chrome 参数清单与共享常量一致", () => {
  assert.deepEqual(DOCTOR_FLAGS, [...CHROME_RENDERING_FLAGS]);
});

test("doctor 只看 Chrome 主进程的命令行，判断渲染参数是否带上", () => {
  const helper = "/opt/google/chrome/chrome --type=renderer --disable-backgrounding-occluded-windows";
  const bare = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.deepEqual(chromeFlagStatus(["/usr/bin/zsh", "node scripts/doctor.mjs"]), { running: false, missing: [] });
  assert.deepEqual(chromeFlagStatus([helper, bare]), { running: true, missing: [...CHROME_RENDERING_FLAGS] }, "子进程带参数不算数");
  assert.deepEqual(chromeFlagStatus([`${bare} ${CHROME_RENDERING_FLAGS.join(" ")}`]), { running: true, missing: [] });
  assert.deepEqual(
    chromeFlagStatus([`"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ${CHROME_RENDERING_FLAGS[1]}`]),
    { running: true, missing: [CHROME_RENDERING_FLAGS[0]] },
  );
});

test("doctor 不拿自动化浏览器（Playwright / 托管 profile）当成用户的 Chrome，且每个用户 profile 都要带参数", () => {
  const flags = CHROME_RENDERING_FLAGS.join(" ");
  const playwright = "/root/.cache/ms-playwright/chromium-1200/chrome-linux/chrome --headless --remote-debugging-pipe";
  const managed = `/opt/google/chrome/chrome --user-data-dir=/home/u/.bcp/browser/profiles/x ${flags}`;
  assert.deepEqual(chromeFlagStatus([playwright]), { running: false, missing: [] });
  assert.deepEqual(chromeFlagStatus([managed]), { running: false, missing: [] });
  assert.deepEqual(chromeFlagStatus([`/opt/google/chrome/chrome ${flags}`, "/opt/google/chrome/chrome --profile-directory=Work"]), { running: true, missing: [...CHROME_RENDERING_FLAGS] });
});

test("doctor 读 .env 的写法与 backend.sh 一致", () => {
  assert.deepEqual(readEnv("# c\nBCP_TOKEN=\nBCP_EVAL = off \n\nX=a=b"), { BCP_TOKEN: "", BCP_EVAL: "off", X: "a=b" });
});
