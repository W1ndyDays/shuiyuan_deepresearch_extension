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
    model: "deepseek-chat",
  },
  kimi: {
    label: "Kimi (Moonshot)",
    style: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
  },
  qwen: {
    label: "通义千问 (DashScope)",
    style: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  glm: {
    label: "智谱 GLM",
    style: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.5",
  },
  openai: {
    label: "OpenAI",
    style: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
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
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.body = body;
  }
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
 * Returns the assistant message text.
 */
export async function chatTurn(cfg, { system, messages, maxTokens = 4096, signal } = {}) {
  const base = trimSlash(cfg.baseUrl);
  if (!base || !cfg.apiKey || !cfg.model) {
    throw new LlmError("LLM 未配置：请先在设置页填写 Base URL / API Key / 模型名。");
  }

  if (cfg.style === "anthropic") {
    const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
    const body = messages.map((m, i) => {
      const block = { type: "text", text: m.content };
      if (messages.length > 1 && (i === 0 || i === lastAssistant)) {
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
    return (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  // OpenAI-compatible
  const body = [];
  if (system) body.push({ role: "system", content: system });
  for (const m of messages) body.push({ role: m.role, content: m.content });
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
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new LlmError("LLM 返回格式异常：缺少 choices[0].message.content。");
  }
  return text;
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
  if (start === -1) throw new LlmError("无法从模型输出中解析 JSON。");
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
  throw new LlmError("无法从模型输出中解析 JSON（括号不平衡）。");
}

/** chatComplete + JSON parsing, with one repair retry. */
export async function chatJson(cfg, { system, user, maxTokens = 4096, signal } = {}) {
  const jsonSystem = `${system || ""}\n\n输出要求：只输出一个合法的 JSON，不要包含任何其他文字或代码块标记。`;
  let first = await chatComplete(cfg, { system: jsonSystem, user, maxTokens, signal });
  if (!String(first || "").trim()) {
    // Some reasoning models can exhaust the output budget before emitting
    // message.content. Retry the original non-empty request instead of sending
    // an invalid empty user message to the JSON repair call below.
    first = await chatComplete(cfg, {
      system: `${jsonSystem}\n直接给出最终 JSON，省略分析过程。`,
      user,
      maxTokens: Math.max(maxTokens * 4, 4096),
      signal,
    });
  }
  if (!String(first || "").trim()) {
    throw new LlmError("LLM 返回了空内容，无法解析 JSON。请尝试增加最大输出长度或更换模型。");
  }
  try {
    return extractJson(first);
  } catch {
    const repaired = await chatComplete(cfg, {
      system: "你是一个 JSON 修复器。将用户给出的内容修复为合法 JSON，只输出 JSON 本身。",
      user: first,
      maxTokens,
      signal,
    });
    return extractJson(repaired);
  }
}
