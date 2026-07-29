# vendor/

`shuiyuan_discourse.mjs` 是水源社区只读 CLI 的完整副本，随扩展一起入库：克隆下来即可构建，
不依赖任何仓库外的文件。

- 88351 字节，`md5 7e35bb6719627a8d72b889f2dc87b1cd`
- 用途：`sync-core.mjs` 读取它，把 7 个 node 内置模块的导入重映射到 `shims/`，
  生成浏览器可用的 `core/shuiyuan_core.mjs`。

## 重新生成 core/

```bash
node sync-core.mjs        # 生成 core/shuiyuan_core.mjs
node build-release.mjs    # 打包 dist/ 发布包
```

请不要手工编辑这个文件：`sync-core.mjs` 会逐行精确匹配它的 `import ... from "node:xxx"`
以及若干必需符号，对不上就直接退出并说明原因。要改行为请改 `lib/` 或 `shims/`。
