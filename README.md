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

## 构建

扩展直接复用仓库根部的只读 CLI（`scripts/shuiyuan_discourse.mjs`），通过 `sync-core.mjs`
生成浏览器可用的副本（node 内置模块被重映射到 `shims/`）。生成产物在 `core/`，已被 gitignore：

```bash
cd extension
node sync-core.mjs   # 生成 core/shuiyuan_core.mjs（上游 CLI 更新后需重新执行）
```

## 安装（开发者模式加载）

1. Chrome 打开 `chrome://extensions`（Edge 打开 `edge://extensions`）。
2. 打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本 `extension/` 目录。
4. 安装后会自动打开设置页并发起水源授权；随后在设置页填入你的 LLM API Key。
5. 点击工具栏图标弹出搜索面板（popup），无需新开页面；面板右上角 ⤢ 可切换到完整页面视图。

## 目录结构

```
extension/
├── manifest.json          # MV3 清单（host 权限仅水源；LLM 域名按需动态申请）
├── sw.js                  # service worker：memfs 唯一持有者 + 深度搜索后台执行器
├── sync-core.mjs          # 从 ../scripts/shuiyuan_discourse.mjs 生成 core/（不改上游）
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
  从而绕过 CORS）。
- **追问与历史**：报告作为会话第一轮生成（该请求同时写入提供商 prompt cache），追问走
  `sy.chat.ask`，追加式扩展同一会话；完成的会话（含对话上下文）持久化在
  `chrome.storage.local` 的 `history`（上限 30 条），`sy.history.list/open/delete` 管理，
  从历史打开可无缝继续追问。追问的 system prompt 取代码里的当前版本而非会话里存的旧副本，
  因此提示词规则更新后老会话也会跟着生效。
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
| `https://shuiyuan.sjtu.edu.cn/*` | 论坛只读 API 与授权页 content script |
| 可选 `https://*/*` | 仅在你保存 LLM 配置时，为你填写的 API 域名单独申请 |
