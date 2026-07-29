// lib/llm.mjs — minimal multi-provider LLM chat client for the extension pages.
// The user brings their own key; two wire formats are supported:
//   - "openai":    POST {baseUrl}/chat/completions   (OpenAI-compatible — covers
//                  OpenAI, DeepSeek, Kimi/Moonshot, 通义千问, 智谱 GLM, ...)
//   - "anthropic": POST {baseUrl}/v1/messages        (Claude API)
// Cross-origin fetch works because the LLM origin is granted as an optional
// host permission when the user saves settings.

export const PRESETS = {
  deepseek: {
    label: "DeepSeek",
    style: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-flash",
  },
  kimi: {
    label: "Kimi (Moonshot)",
    style: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k3",
  },
  qwen: {
    label: "通义千问 (DashScope)",
    style: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-3.7-plus",
  },
  glm: {
    label: "智谱 GLM",
    style: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.1",
  },
  openai: {
    label: "OpenAI",
    style: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-luna",
  },
  anthropic: {
    label: "Anthropic Claude",
    style: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-opus-5",
  },
  custom: {
    label: "自定义 (OpenAI 兼容)",
    style: "openai",
    baseUrl: "",
    model: "",
  },
};

function trimSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

export class LlmError extends Error {
  constructor(message, { status = null, body = null, empty = false, unparseable = false } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.body = body;
    // `empty`: the provider answered but produced no text.
    // `unparseable`: it produced text that isn't JSON.
    // Both mean "the model misbehaved, not the setup" — callers may fall back
    // instead of aborting the whole run.
    this.empty = empty;
    this.unparseable = unparseable;
  }
}

function isBlank(text) {
  return !String(text ?? "").trim();
}

/**
 * Drop blank turns and merge same-role neighbours.
 * Providers reject empty message content ("the message at position 1 with role
 * 'user' must not be empty"), and a blank turn can only come from an earlier
 * empty reply — dropping it keeps an already-saved session usable instead of
 * dead. Merging keeps role alternation valid after a drop (Anthropic requires
 * it).
 */
function sanitizeMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    const content = typeof m?.content === "string" ? m.content : normalizeContent(m?.content);
    if (isBlank(content)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n\n${content}`;
    else out.push({ role: m.role === "assistant" ? "assistant" : "user", content });
  }
  return out;
}

/** Some proxies return content as a parts array or a wrapper object, not a string. */
function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : String(part?.text ?? part?.content ?? "")))
      .join("");
  }
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

/** Explain an empty reply concretely — the cause is almost never the same twice. */
function emptyReplyError(cfg, { reason, reasoning, attempts }) {
  let hint =
    "该供应商/模型可能与当前请求不兼容，请在设置页更换模型或供应商后重试。";
  if (reasoning) {
    hint = "输出全部进入了思维链 (reasoning)，正文为空：请调高 max_tokens，或改用非思考型模型。";
  } else if (reason === "length" || reason === "max_tokens") {
    hint = "长度上限被耗尽却没有正文：请调高 max_tokens 或改用其他模型。";
  } else if (reason === "content_filter" || reason === "content-filter") {
    hint = "内容被供应商的安全过滤拦截，请调整措辞或更换供应商。";
  }
  const detail = [`model=${cfg.model}`, reason ? `finish_reason=${reason}` : null, `已尝试 ${attempts} 次`]
    .filter(Boolean)
    .join(", ");
  return new LlmError(`模型返回了空回复（${detail}）。${hint}`, { empty: true });
}

async function readError(response) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    // ignore
  }
  let detail = body.slice(0, 400);
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message || parsed?.message || detail;
  } catch {
    // not JSON
  }
  return new LlmError(`LLM 请求失败 (HTTP ${response.status}): ${detail}`, {
    status: response.status,
    body: body.slice(0, 2000),
  });
}

/**
 * Multi-turn chat. messages = [{role: "user"|"assistant", content: string}].
 * The conversation is append-only by design so provider prefix caching hits:
 *   - Anthropic: explicit cache_control breakpoints on the system prompt, the
 *     big first user turn (the research materials) and the newest assistant
 *     turn — earlier breakpoints remain valid read points, so hits accrue as
 *     the follow-up conversation grows.
 *   - OpenAI-compatible providers (DeepSeek/Kimi/Qwen/GLM/OpenAI) cache
 *     identical prefixes automatically; append-only history is all they need.
 * Returns the assistant message text, which is guaranteed non-blank: an empty
 * reply is retried once and then raised as an LlmError with `.empty === true`.
 * Never returning "" matters because the caller appends the result to the
 * conversation, and a blank turn makes every later request fail with the
 * provider's "message ... must not be empty".
 */
export async function chatTurn(
  cfg,
  { system, messages, maxTokens = 4096, signal, emptyRetries = 1 } = {},
) {
  const base = trimSlash(cfg.baseUrl);
  if (!base || !cfg.apiKey || !cfg.model) {
    throw new LlmError("LLM 未配置：请先在设置页填写 Base URL / API Key / 模型名。");
  }

  const turns = sanitizeMessages(messages);
  if (!turns.length) {
    throw new LlmError("LLM 请求内容为空：没有可发送的对话内容。");
  }

  const send = cfg.style === "anthropic" ? anthropicTurn : openaiTurn;
  const args = { system, turns, maxTokens, signal };
  let last = {};
  for (let attempt = 0; attempt <= emptyRetries; attempt++) {
    last = await send(cfg, base, args);
    if (!isBlank(last.text)) return last.text;
  }
  throw emptyReplyError(cfg, { ...last, attempts: emptyRetries + 1 });
}

async function anthropicTurn(cfg, base, { system, turns, maxTokens, signal }) {
  const lastAssistant = turns.map((m) => m.role).lastIndexOf("assistant");
  const body = turns.map((m, i) => {
    const block = { type: "text", text: m.content };
    if (turns.length > 1 && (i === 0 || i === lastAssistant)) {
      block.cache_control = { type: "ephemeral" };
    }
    return { role: m.role, content: [block] };
  });
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      system: system
        ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
        : undefined,
      messages: body,
    }),
  });
  if (!response.ok) throw await readError(response);
  const data = await response.json();
  if (data.stop_reason === "refusal") {
    throw new LlmError("模型拒绝了该请求 (refusal)。");
  }
  const blocks = Array.isArray(data.content) ? data.content : [];
  return {
    text: blocks
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text ?? ""))
      .join(""),
    reason: data.stop_reason || null,
    reasoning: blocks.some((b) => b?.type === "thinking" || b?.type === "redacted_thinking"),
  };
}

async function openaiTurn(cfg, base, { system, turns, maxTokens, signal }) {
  const body = [];
  if (system) body.push({ role: "system", content: system });
  for (const m of turns) body.push({ role: m.role, content: m.content });
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages: body }),
  });
  if (!response.ok) throw await readError(response);
  const data = await response.json();
  const choice = data?.choices?.[0];
  if (!choice) {
    const dump = JSON.stringify(data ?? null).slice(0, 300);
    throw new LlmError(`LLM 返回格式异常：缺少 choices[0]。原始响应：${dump}`);
  }
  // choice.message is the standard shape; some proxies use delta/text instead.
  const message = choice.message || choice.delta || {};
  return {
    text: normalizeContent(message.content ?? choice.text ?? ""),
    reason: choice.finish_reason || choice.stop_reason || null,
    reasoning: !isBlank(normalizeContent(message.reasoning_content ?? message.reasoning ?? "")),
  };
}

/**
 * One chat completion. cfg = {style, baseUrl, apiKey, model}.
 * Returns the assistant message text.
 */
export async function chatComplete(cfg, { system, user, maxTokens = 4096, signal } = {}) {
  return chatTurn(cfg, {
    system,
    messages: [{ role: "user", content: user }],
    maxTokens,
    signal,
  });
}

/** Extract the first JSON value from model output (tolerates ```json fences and prose). */
export function extractJson(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(body);
  } catch {
    // Fall through: scan for the first balanced {...} or [...] region.
  }
  const start = body.search(/[[{]/);
  if (start === -1) throw new LlmError("无法从模型输出中解析 JSON。", { unparseable: true });
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(body.slice(start, i + 1));
      }
    }
  }
  throw new LlmError("无法从模型输出中解析 JSON（括号不平衡）。", { unparseable: true });
}

/** chatComplete + JSON parsing, with one repair retry. */
export async function chatJson(cfg, { system, user, maxTokens = 4096, signal } = {}) {
  const jsonSystem = `${system || ""}\n\n输出要求：只输出一个合法的 JSON，不要包含任何其他文字或代码块标记。`;
  const first = await chatComplete(cfg, { system: jsonSystem, user, maxTokens, signal });
  try {
    return extractJson(first);
  } catch (err) {
    // Never hand a blank payload to the repairer: an empty user message is
    // rejected by the provider ("the message at position 1 with role 'user'
    // must not be empty"), which would bury the real cause (the model said
    // nothing). chatTurn already guards this, so this is belt-and-braces.
    if (isBlank(first)) throw err;
    const repaired = await chatComplete(cfg, {
      system: "你是一个 JSON 修复器。将用户给出的内容修复为合法 JSON，只输出 JSON 本身。",
      user: first,
      maxTokens,
      signal,
    });
    try {
      return extractJson(repaired);
    } catch {
      const snippet = String(first).trim().slice(0, 200);
      throw new LlmError(`模型输出无法解析为 JSON（修复重试后仍失败）。原始输出片段：${snippet}`, {
        unparseable: true,
      });
    }
  }
}
