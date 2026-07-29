# 水源深度搜索 — Chrome / Edge 扩展

AI 驱动的水源社区（https://shuiyuan.sjtu.edu.cn）深度搜索浏览器扩展：

- **首次安装自动发起水源授权**：打开 Discourse user-api-key 授权页，用户点击「授权」后由
  content script 自动捕获加密 payload 并解密保存，无需手动复制（仅申请只读 `read` 权限）。
- **自带 LLM Key**：支持任意 OpenAI 兼容 API（DeepSeek / Kimi / 通义千问 / 智谱 GLM / OpenAI）
  以及 Anthropic Claude，Key 只保存在本机 `chrome.storage.local`。
- **多智能体深度搜索**：LLM 先把话题扩展成多个同义词/相关角度查询 → 多个 agent 并行搜索并精读
  命中主题 → 从帖子内容中发掘新线索进入下一轮搜索 → 最终综合成带链接的 Markdown 报告。
- **追问**：报告生成后可就任何问题继续追问，不限于报告已覆盖的内容或「建议追问」里的方向。
  会话为追加式消息历史以最大化提供商 prompt cache 命中
  （Anthropic 显式 `cache_control` 断点：system + 首条材料消息 + 最新 assistant 轮；
  OpenAI 兼容系依赖服务端前缀自动缓存）。材料不足时模型输出 `{"search": [...]}` 指令触发追加
  论坛搜索（每轮最多 3 个查询、每查询精读 2 个主题，最多 2 轮），再基于补充材料作答；
  搜索预算用尽或重复查询时会被要求直接作答，不会把指令 JSON 漏给用户。
- **历史记录**：每次搜索（含追问对话）自动保存（最多 30 条），可回看、继续追问、删除。
- **容错**：LLM 请求有超时与指数退避重试（超时/断网/429/5xx）；综合报告生成失败时退回本地
  材料汇总（保留真实链接）而不是整轮丢弃；本地存储写入失败只降级为提示，不会让已完成的
  搜索变成"失败"；后台被浏览器回收的搜索会在下次启动时报告为中断，而非一直转圈。

## 安装（推荐：直接用发布包）

1. 下载 `shuiyuan-deepresearch-v1.0.0.zip` 并**解压**到任意目录（解压后是一个
   `shuiyuan-deepresearch-v1.0.0` 文件夹）。
2. Chrome 打开 `chrome://extensions`（Edge 打开 `edge://extensions`）。
3. 打开右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择第 1 步解压出来的文件夹。
5. 会自动打开设置页：第 1 步授权水源（点一下按钮，凭证自动捕获），第 2 步填你自己的
   LLM API Key，点「测试连接」确认可用。
6. 点击工具栏里的扩展图标即可开始搜索；面板右上角 ⤢ 切换到完整页面视图。

发布包里已经带好 `core/`，无需安装 Node、无需构建。包内 `安装说明.txt` 是同样的步骤。

## 从源码构建

只读 CLI 已随仓库入库（`vendor/shuiyuan_discourse.mjs`），`sync-core.mjs` 把它的 node 内置
模块导入重映射到 `shims/`，生成浏览器可用的 `core/shuiyuan_core.mjs`（gitignore，按需生成）：

```bash
cd shuiyuan_deepresearch_extension
node sync-core.mjs      # 生成 core/shuiyuan_core.mjs
node build-release.mjs  # 生成 dist/shuiyuan-deepresearch-v<版本>.zip
```

> 未执行 sync-core 时 `core/` 不存在，service worker 会 import 失败，所有界面都只会提示
> 「后台服务无响应」——先跑一次上面的命令（用发布包的用户不会遇到）。

## 目录结构

```
shuiyuan_deepresearch_extension/
├── manifest.json          # MV3 清单（host 权限仅水源；LLM 域名按需动态申请）
├── sw.js                  # service worker：memfs 唯一持有者 + 深度搜索后台执行器
├── vendor/                # 只读 CLI 副本（构建输入，勿手改）
├── sync-core.mjs          # 由 vendor/ 生成 core/（重映射 node 内置模块到 shims/）
├── build-release.mjs      # 打包 dist/ 发布包（含 core/，解压即用）
├── core/                  # 生成产物（gitignore）
├── shims/                 # node:fs/crypto/... 的浏览器替身（fs = chrome.storage 持久化的 memfs）
├── content/auth_capture.js# 授权页 payload 自动捕获
├── lib/
│   ├── llm.mjs            # 多提供商 LLM 客户端（多轮对话 + 缓存断点）
│   ├── deepsearch.mjs     # 多 agent 编排（规划→并行搜索→线索发掘→综合）+ 追问 followUp
│   ├── session-view.mjs   # popup / 全页共用的 UI 控制器（进度/报告/追问/历史）
│   ├── progress.mjs       # 进度事件渲染
│   └── markdown.mjs       # 零依赖 Markdown 渲染（输入已转义）
└── pages/
    ├── setup.html/js      # 步骤 1 水源授权 / 步骤 2 LLM 配置
    ├── popup.html/js      # 工具栏弹出面板（搜索 + 追问 + 历史两个 tab）
    └── search.html/js     # 完整页面视图（与 popup 共享同一个后台会话）
```

## 架构说明

- **凭证与论坛请求只走 service worker**：CLI 的同步凭证读写逻辑运行在一个由
  `chrome.storage.local` 持久化的内存文件系统上（`shims/fs.mjs`），SW 是唯一写入者，
  页面通过 `chrome.runtime.sendMessage` 调用（`sy.exec` / `sy.authStart` / `sy.status`）。
- **深度搜索在 service worker 里后台执行**（`sy.search.start/stop/state`）：popup 关闭不会
  中断搜索，重新点开会自动重放进度；popup 与完整页面看到的是同一个会话。运行期间用周期性
  扩展 API 调用保持 SW 存活。LLM 请求由 SW 直接 fetch
  （保存配置时通过 `chrome.permissions.request` 动态获取该 API 域名的 host 权限，
  从而绕过 CORS；其他页面只做 `permissions.contains` 检查，因为 `request` 必须在真实的
  用户手势里调用，在 popup 里弹窗还会关掉 popup）。
- **单一活动会话 + 所有权检查**：worker 里只有一个 run 对象，可能随时被替换（新搜索、打开
  历史）。启动搜索用同步占位（`starting`）关掉「检查—await—写入」的竞态窗口，所有异步写入者
  都先 `ownsRun(run)` 再改共享状态或广播；追问带 `sessionId`，与当前会话不符时直接拒绝，
  避免多窗口把答案写进别人的会话。搜索/追问进行中不允许删除该会话或开新搜索。
- **追问与历史**：报告作为会话第一轮生成（该请求同时写入提供商 prompt cache），追问走
  `sy.chat.ask`，追加式扩展同一会话；完成的会话（含对话上下文）持久化在
  `chrome.storage.local` 的 `history`（上限 30 条），`sy.history.list/open/delete` 管理，
  从历史打开可无缝继续追问。追问的 system prompt 取代码里的当前版本而非会话里存的旧副本，
  因此提示词规则更新后老会话也会跟着生效。会话超过约 16 万字符时会丢弃最早的中间轮次
  （首轮材料与首份报告始终保留），以免最终超出模型上下文后每次追问都失败。
- **空回复容错**：部分第三方供应商会返回空正文（或把输出全塞进 reasoning 字段）。
  `chatTurn` 会重试一次，仍为空则抛出带原因（`finish_reason` / reasoning）的 `LlmError`，
  绝不返回空串——空串一旦写入会话历史，后续每次请求都会被供应商以
  “message ... must not be empty” 拒绝。JSON 修复器也不会收到空输入。
- **超时与重试**：每个 LLM 请求默认 120s 超时（`options.llmTimeoutMs` 可调），超时/断网/429/5xx
  按 1.5s、4s 退避重试两次；用户主动停止仍是 `AbortError`（run 记为 stopped），不会被当成
  可重试错误。追问可以随时停止（`sy.chat.stop`），busy 标记一定会释放。
- **空回复容错**：部分第三方供应商会返回空正文（或把输出全塞进 reasoning 字段）。
  `chatTurn` 会重试一次，仍为空则抛出带原因（`finish_reason` / reasoning）的 `LlmError`，
  绝不返回空串——空串一旦写入会话历史，后续每次请求都会被供应商以
  “message ... must not be empty” 拒绝。JSON 修复器也不会收到空输入。
- **限流处理**：CLI 自带多 key 轮换；此外 agent 启动做了错峰，429 时按 `retry_after_seconds`
  自动等待重试。可在设置页用 `auth add` 语义追加多个 key（当前 UI 未暴露，可通过
  CLI 授权后把 auth.json 的 key 用「手动粘贴」方式导入多个）。
- **只读保证**：沿用 CLI 的 GET 白名单，扩展不会对论坛做任何写操作。

## 权限

| 权限 | 用途 |
|---|---|
| `storage` | 保存水源凭证（memfs）与 LLM 配置 |
| `unlimitedStorage` | 历史会话（含完整上下文）与凭证共用 `chrome.storage.local`，避免 10MB 配额把凭证挤掉 |
| `https://shuiyuan.sjtu.edu.cn/*` | 论坛只读 API 与授权页 content script |
| 可选 `https://*/*` | 仅在你保存 LLM 配置时，为你填写的 API 域名单独申请 |
