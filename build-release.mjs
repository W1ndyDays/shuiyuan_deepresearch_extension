#!/usr/bin/env node
// build-release.mjs — produce a ready-to-use release zip.
//
// The result is what a non-technical user needs: unzip, load unpacked, done.
// That means core/ (normally a gitignored build artifact) MUST be inside, and
// everything only developers need (vendor/, build scripts, .git) must not be.
//
//   node build-release.mjs            -> dist/shuiyuan-deepresearch-v<version>.zip
//   node build-release.mjs --keep-dir -> also leave dist/<name>/ unzipped
//
// Version comes from manifest.json, so the zip name can never drift from it.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");

// Runtime payload only. Anything not listed here never reaches the user.
const INCLUDE = [
  "manifest.json",
  "sw.js",
  "core",
  "lib",
  "pages",
  "shims",
  "content",
];

const README_NAME = "安装说明.txt";

function fail(message) {
  console.error(`build-release: ${message}`);
  process.exit(1);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyInto(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src).sort()) {
      copyInto(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

const INSTALL_TEXT = (version) => `水源深度搜索 (Shuiyuan Deep Search) v${version}
================================================

【第一步】安装扩展（约 30 秒）

1. 你现在看到的这个文件夹，就是扩展本体，不要再往里翻，也不要删任何文件。
   （如果你还没解压，请先把 zip 解压出来，Chrome 不能直接读 zip。）
2. 打开 Chrome，地址栏输入：chrome://extensions   然后回车。
   （用 Edge 的话输入：edge://extensions）
3. 打开右上角的「开发者模式」开关。
4. 点左上角「加载已解压的扩展程序」，选中这个文件夹（包含 manifest.json 的那一层），确定。
5. 扩展会自动打开设置页。若没有自动打开，点浏览器右上角的扩展（拼图）图标，
   找到「水源深度搜索」，再点它的「设置」。

【第二步】授权水源（点一下就行）

在设置页第 1 步点「开始授权」，会打开水源社区的授权页面（需要你已登录水源）。
点页面上的「授权」后，扩展会自动抓取凭证并保存，你不需要复制任何东西。
只申请只读 (read) 权限，扩展不会发帖、回帖、点赞或修改任何内容。

【第三步】填 AI 模型的 API Key

设置页第 2 步：选一个服务商预设（DeepSeek / Kimi / 通义千问 / 智谱 / OpenAI / Claude），
填上你自己的 API Key，点「保存配置」，浏览器会问你是否允许访问该 API 域名，请点「允许」。
然后点「测试连接」，看到「连接成功」就可以用了。

Key 只保存在你自己的浏览器里（chrome.storage.local），只会发给你填的那个 API 地址。
这个扩展没有任何自己的服务器，作者收不到你的 Key，也看不到你搜了什么。
API 的调用费用由你自己的账号承担。

【怎么用】

点浏览器工具栏里的扩展图标 → 输入你想深入了解的话题 → 点「搜索」。
它会自动把话题扩展成多个搜索词、并行搜索水源、精读命中的帖子，最后给你一份带原帖链接的
报告。报告下面可以继续追问任何问题，材料不够时它会自己再去论坛搜。
面板右上角 ⤢ 可以切到完整页面视图，搜索在后台跑，关掉面板也不会中断。

【常见问题】

· 提示「后台服务无响应」：在 chrome://extensions 里点扩展卡片上的「刷新」按钮。
· 提示「尚未完成水源授权」：回设置页重做第二步，注意先在浏览器里登录水源。
· 提示「模型返回了空回复」：多半是模型/服务商不兼容，换一个模型名或服务商再试；
  如果提示里说输出都进了思维链，请换非思考型模型。
· 提示「缺少访问 xxx 的权限」：回设置页点一次「保存配置」，并在弹窗里点「允许」。
· 论坛限流：正常现象，扩展会自动等待并重试，耐心等一会儿。

【卸载】

在 chrome://extensions 里点「移除」即可，凭证和历史记录会随扩展一起删除。
`;

function main() {
  const manifestPath = path.join(HERE, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const version = manifest.version;
  if (!/^\d+(\.\d+){0,3}$/.test(version || "")) fail(`manifest.json version 不合法: ${version}`);

  // core/ is generated; build it if missing so the zip can never ship without it.
  if (!fs.existsSync(path.join(HERE, "core/shuiyuan_core.mjs"))) {
    console.log("build-release: core/ 不存在，先执行 sync-core.mjs …");
    execFileSync(process.execPath, [path.join(HERE, "sync-core.mjs")], { stdio: "inherit" });
  }

  for (const item of INCLUDE) {
    if (!fs.existsSync(path.join(HERE, item))) fail(`缺少必需文件/目录: ${item}`);
  }

  const name = `shuiyuan-deepresearch-v${version}`;
  const stageDir = path.join(DIST, name);
  const zipPath = path.join(DIST, `${name}.zip`);
  rmrf(stageDir);
  rmrf(zipPath);
  fs.mkdirSync(stageDir, { recursive: true });

  for (const item of INCLUDE) copyInto(path.join(HERE, item), path.join(stageDir, item));
  fs.writeFileSync(path.join(stageDir, README_NAME), INSTALL_TEXT(version), "utf8");

  // Sanity: the payload must be self-contained. Nothing may point outside the
  // package, and no secret-ish file may have slipped in.
  const files = walk(stageDir);
  const escaping = [];
  for (const rel of files) {
    if (!/\.(mjs|js|json|html|css)$/.test(rel)) continue;
    const text = fs.readFileSync(path.join(stageDir, rel), "utf8");
    for (const m of text.matchAll(/from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g)) {
      const spec = m[1] || m[2];
      if (!spec.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(path.join(stageDir, rel)), spec);
      if (!resolved.startsWith(stageDir) || !fs.existsSync(resolved)) {
        escaping.push(`${rel} -> ${spec}`);
      }
    }
  }
  if (escaping.length) fail(`包内存在无法解析/越界的 import:\n  ${escaping.join("\n  ")}`);

  const banned = files.filter((f) => /(^|\/)(\.git|\.env|auth\.json|node_modules)/.test(f));
  if (banned.length) fail(`包内含不该发布的文件: ${banned.join(", ")}`);

  execFileSync("zip", ["-r", "-q", "-X", zipPath, name], { cwd: DIST, stdio: "inherit" });

  const bytes = fs.statSync(zipPath).size;
  console.log(`build-release: v${version}`);
  console.log(`  ${files.length} 个文件, ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`  -> ${path.relative(HERE, zipPath)}`);
  if (!process.argv.includes("--keep-dir")) {
    rmrf(stageDir);
    console.log("  （已清理暂存目录；加 --keep-dir 可保留）");
  }
}

main();
