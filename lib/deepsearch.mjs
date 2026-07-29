// lib/deepsearch.mjs — multi-agent deep search orchestrator.
//
// Pipeline:
//   1. 规划: the LLM expands the user's topic into diverse queries (synonyms,
//      abbreviations, EN/CN variants, Discourse operators).
//   2. 并行 agents: each query becomes an agent that searches the forum, reads
//      the top matching topics, and produces a digest + follow-up queries.
//   3. 发掘: follow-up queries discovered inside the forum content seed the
//      next round of agents (up to maxRounds).
//   4. 综合: a final LLM call merges all digests into a markdown report with
//      links back to the discussions.
//
// `sy(kind, args)` performs a forum call via the service worker; `llm` is the
// user-configured client config for lib/llm.mjs. Progress is reported through
// `onEvent(event)`.

import { chatTurn, chatJson, extractJson } from "./llm.mjs";

const SITE = "https://shuiyuan.sjtu.edu.cn";

const DEFAULTS = {
  agentsPerRound: 4,
  maxRounds: 2,
  topicsPerAgent: 2,
  postsPerTopic: 5,
  maxReadLength: 600,
  maxResults: 8,
};

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    }
  });
}

function normalizeQuery(q) {
  return String(q || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function syWithRetry(sy, kind, args, { signal, onEvent } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await sy(kind, args);
    } catch (err) {
      lastErr = err;
      const rateLimited = err?.data?.rate_limited || err?.data?.status === 429;
      if (!rateLimited || attempt === 2) throw err;
      const wait = Math.min(Number(err?.data?.retry_after_seconds) || 8, 30);
      onEvent?.({ type: "rate-limited", wait });
      await sleep(wait * 1000, signal);
    }
  }
  throw lastErr;
}

const PLANNER_SYSTEM = `你是上海交通大学校园论坛"水源社区"(Discourse) 的搜索策划专家。
你的任务：针对用户想研究的话题，生成一组【多样化】的论坛搜索查询，以便并行搜索。
要求：
- 覆盖不同角度：同义词、别称、缩写、中英文写法、口语/黑话说法、相关联的概念或事件。
- 大多数查询用 1~3 个简短关键词（Discourse 全文搜索对长句效果差，中文不要加引号）。
- 可以少量使用高级语法：in:title（标题匹配）、order:latest、after:YYYY-MM-DD、#分类、tags:标签。
- 查询之间尽量不要重复或高度相似。`;

const AGENT_SYSTEM = `你是一名论坛调研 agent。你会拿到：一个研究主题、你负责的搜索查询、以及论坛搜索/阅读的原始结果。
你的任务：
1. 判断哪些帖子与研究主题真正相关，总结其中的关键信息（观点、事实、数据、时间线、争议）。
2. 从材料中发掘线索：帖子里提到的其他事件、术语、活动、人物、相关讨论标题等，转化为值得进一步搜索的新查询词（followup_queries）。
只依据给定材料，不要编造。`;

// This system prompt drives BOTH the initial report and all follow-up turns.
// It is deliberately stable: the whole conversation is append-only so that
// provider-side prompt caching (see lib/llm.mjs chatTurn) keeps hitting.
const CHAT_SYSTEM = `你是"水源深度搜索"的研究助手。用户会先提供一批来自上海交通大学校园论坛"水源社区"(https://shuiyuan.sjtu.edu.cn) 的调研材料。

第一次回复：输出一份中文 Markdown 深度搜索报告，结构：
## 总览（2-4 句）
## 主要发现（分点，信息密度高）
## 相关讨论（最有价值的帖子，格式：[标题](链接) — 一句话说明）
## 未尽话题与建议追问（可选）
所有提到的帖子必须使用材料中给出的真实链接，绝不编造链接或帖子；观点冲突时如实呈现双方说法。直接输出 Markdown，不要用代码块包裹。

之后用户会继续追问。追问时遵守：
1. 用户可以问任何问题：不限于报告里已经提到的内容，也不限于"未尽话题与建议追问"列出的方向。只要问题与水源社区/校园生活相关，就认真对待，不要以"超出本次搜索范围"为由推脱。
2. 先看已有材料够不够。够就直接回答，并引用相关帖子链接。
3. 不够（材料里没有，或只有零碎线索）就主动去搜，输出且只输出一个 JSON（无任何其他文字）：{"search": ["查询词1", "查询词2", "查询词3"]}（1~3 个简短关键词，中文不要加引号）。系统会执行搜索并把补充材料发给你。不要因为"材料里没提到"就直接回答不知道——先搜。
4. 收到补充材料后：能回答就正式回答；如果补充材料说明该换个说法再搜一次，可以再输出一次 search 指令。系统会在搜索次数用尽时明确告知，那时必须用手上的材料尽力回答。
5. 如果搜过之后论坛里确实没有相关讨论，就直接说明"论坛里没找到相关讨论"，然后可以给出你自己的一般性判断，但必须标注这部分不是来自论坛材料。
6. 回答使用 Markdown，保持简洁、直接。`;

function topicLine(t) {
  const bits = [`- [${t.title}](${t.url}) (topic:${t.id}`];
  if (t.posts_count != null) bits.push(`, ${t.posts_count}帖`);
  if (t.views != null) bits.push(`, ${t.views}浏览`);
  return `${bits.join("")})`;
}

function buildAgentMaterial(query, searchResult, topicReads) {
  const parts = [`### 搜索查询\n${query}`];
  const topics = searchResult?.results || [];
  const posts = searchResult?.post_results || [];
  if (topics.length) {
    parts.push(`### 命中主题\n${topics.map(topicLine).join("\n")}`);
  }
  if (posts.length) {
    const lines = posts
      .slice(0, 6)
      .map(
        (p) =>
          `- [${p.topic_title || "帖子"} #${p.post_number}](${p.url}) @${p.username}: ${String(p.blurb || "").slice(0, 200)}`,
      );
    parts.push(`### 命中楼层摘要\n${lines.join("\n")}`);
  }
  for (const read of topicReads) {
    const postTexts = (read.posts || [])
      .map((p) => `  - #${p.post_number} @${p.username}: ${String(p.raw || "").replace(/\s+/g, " ")}`)
      .join("\n");
    parts.push(
      `### 主题正文节选：[${read.topic?.title}](${SITE}/t/${read.topic?.slug || read.topic?.id}/${read.topic?.id})\n${postTexts}`,
    );
  }
  if (parts.length === 1) parts.push("### 命中主题\n(无结果)");
  return parts.join("\n\n");
}

async function runAgent(ctx, agent) {
  const { sy, llm, options, topic, seenTopics, onEvent, signal } = ctx;
  const emit = (event) => onEvent?.({ round: agent.round, agentId: agent.id, query: agent.query, ...event });

  emit({ type: "agent-start", angle: agent.angle });

  const searchResult = await syWithRetry(
    sy,
    "search",
    { query: agent.query, page: 1, max_results: options.maxResults, max_post_results: 6 },
    { signal, onEvent: emit },
  );
  const topics = searchResult?.results || [];
  emit({ type: "agent-search-done", topicsFound: topics.length, postsFound: (searchResult?.post_results || []).length });

  // Read top unseen topics for real content (not just titles/blurbs).
  const topicReads = [];
  for (const t of topics) {
    if (topicReads.length >= options.topicsPerAgent) break;
    if (t.id == null || seenTopics.has(t.id)) continue;
    seenTopics.add(t.id);
    emit({ type: "agent-read", topicId: t.id, title: t.title });
    try {
      const read = await syWithRetry(
        sy,
        "topic",
        {
          topic_id: t.id,
          post_limit: options.postsPerTopic,
          start_post_number: 1,
          max_batches: 2,
          max_read_length: options.maxReadLength,
          include_html: false,
        },
        { signal, onEvent: emit },
      );
      topicReads.push(read);
    } catch (err) {
      emit({ type: "agent-read-error", topicId: t.id, error: err?.message || String(err) });
    }
  }

  const material = buildAgentMaterial(agent.query, searchResult, topicReads);
  emit({ type: "agent-analyze" });
  const digest = await chatJson(llm, {
    system: AGENT_SYSTEM,
    user: `研究主题：${topic}\n\n以下是论坛原始材料：\n\n${material}\n\n输出 JSON：
{
  "summary": "本查询角度下的调研总结（2-5 句，无相关内容则说明）",
  "findings": ["关键发现1", "..."],
  "relevant_topics": [{"id": 123, "title": "...", "url": "...", "why": "为何相关"}],
  "followup_queries": ["从材料中发掘的新搜索词（0-4个，必须来自材料中出现的线索）"]
}`,
    maxTokens: 2000,
    signal,
  });

  const result = {
    query: agent.query,
    angle: agent.angle,
    round: agent.round,
    summary: String(digest?.summary || ""),
    findings: Array.isArray(digest?.findings) ? digest.findings.map(String) : [],
    relevantTopics: Array.isArray(digest?.relevant_topics) ? digest.relevant_topics : [],
    followupQueries: Array.isArray(digest?.followup_queries) ? digest.followup_queries.map(String) : [],
  };
  emit({ type: "agent-done", summary: result.summary, followups: result.followupQueries });
  return result;
}

export async function deepSearch({ topic, llm, sy, onEvent, options = {}, signal }) {
  const opts = { ...DEFAULTS, ...options };
  const emit = (event) => onEvent?.(event);
  const seenTopics = new Set();
  const executedQueries = new Set();
  const agentResults = [];
  const errors = [];

  // ---- Phase 1: 规划 ----------------------------------------------------
  emit({ type: "phase", phase: "plan" });
  let plan = null;
  try {
    plan = await chatJson(llm, {
      system: PLANNER_SYSTEM,
      user: `研究主题：${topic}\n\n请生成 ${opts.agentsPerRound} 个多样化的搜索查询。输出 JSON：
{"queries": [{"q": "搜索词", "angle": "该查询覆盖的角度"}]}`,
      maxTokens: 1200,
      signal,
    });
  } catch (err) {
    // A misbehaving provider (empty reply / non-JSON output) shouldn't kill the
    // run: searching the raw topic still works. Setup failures — missing key,
    // bad Base URL, HTTP errors — must still abort before we hammer the forum.
    if (!err?.empty && !err?.unparseable) throw err;
    emit({ type: "plan-fallback", error: err.message || String(err) });
  }
  let queue = (Array.isArray(plan?.queries) ? plan.queries : [])
    .map((q) => ({ q: String(q?.q || "").trim(), angle: String(q?.angle || "") }))
    .filter((q) => q.q);
  if (queue.length === 0) queue = [{ q: topic, angle: "原始话题" }];
  emit({ type: "plan-done", queries: queue });

  // ---- Phase 2/3: 并行 agents + 追加发掘轮 -------------------------------
  let agentSeq = 0;
  const ctx = { sy, llm, options: opts, topic, seenTopics, onEvent, signal };

  for (let round = 1; round <= opts.maxRounds; round++) {
    const batch = queue
      .filter((q) => !executedQueries.has(normalizeQuery(q.q)))
      .slice(0, opts.agentsPerRound);
    if (batch.length === 0) break;
    batch.forEach((q) => executedQueries.add(normalizeQuery(q.q)));
    emit({ type: "round-start", round, queries: batch.map((b) => b.q) });

    const settled = await Promise.allSettled(
      batch.map((q, index) => {
        const id = agentSeq++;
        return (async () => {
          // Stagger starts to be gentle on the forum's search rate limit.
          await sleep(index * 900, signal);
          return runAgent(ctx, { id, query: q.q, angle: q.angle, round });
        })();
      }),
    );
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") agentResults.push(outcome.value);
      else {
        if (outcome.reason?.name === "AbortError") throw outcome.reason;
        errors.push(outcome.reason?.message || String(outcome.reason));
        emit({ type: "agent-error", round, error: outcome.reason?.message || String(outcome.reason) });
      }
    }

    // Collect discovered follow-up queries for the next round.
    const followups = [];
    for (const result of agentResults.filter((r) => r.round === round)) {
      for (const fq of result.followupQueries) {
        const norm = normalizeQuery(fq);
        if (norm && !executedQueries.has(norm) && !followups.some((f) => normalizeQuery(f.q) === norm)) {
          followups.push({ q: fq.trim(), angle: "论坛内容中发掘的线索" });
        }
      }
    }
    queue = followups;
    emit({ type: "round-done", round, followups: followups.map((f) => f.q) });
  }

  if (agentResults.length === 0) {
    throw new Error(errors[0] || "所有搜索 agent 均失败，请检查授权与网络后重试。");
  }

  // ---- Phase 4: 综合（作为可追问会话的第一轮） ---------------------------
  emit({ type: "phase", phase: "synthesis" });
  const materials = agentResults
    .map((r, i) => {
      const topicsList = r.relevantTopics
        .map((t) => `  - [${t.title}](${t.url || `${SITE}/t/${t.id}`}) — ${t.why || ""}`)
        .join("\n");
      return `## Agent ${i + 1}（第${r.round}轮，查询"${r.query}"，角度：${r.angle}）
总结：${r.summary}
发现：
${r.findings.map((f) => `  - ${f}`).join("\n") || "  (无)"}
相关帖子：
${topicsList || "  (无)"}`;
    })
    .join("\n\n");

  // The report is generated as turn #1 of an append-only conversation; this
  // very request writes the provider prompt cache that follow-ups then reuse.
  const messages = [
    {
      role: "user",
      content: `研究主题：${topic}\n\n共 ${agentResults.length} 个调研 agent 的材料如下：\n\n${materials}\n\n请先输出深度搜索报告。`,
    },
  ];
  const report = await chatTurn(llm, {
    system: CHAT_SYSTEM,
    messages,
    maxTokens: 4000,
    signal,
  });
  messages.push({ role: "assistant", content: report });
  emit({ type: "done" });

  return {
    report,
    conversation: { system: CHAT_SYSTEM, messages },
    agents: agentResults,
    topicsRead: seenTopics.size,
    queriesExecuted: [...executedQueries],
    errors,
  };
}

// --------------------------------------------------------------- 追问 ----

const FOLLOWUP_DEFAULTS = {
  maxSearchRounds: 2, // how many times the model may ask for more material
  queriesPerRound: 3,
  resultsPerQuery: 6,
  topicsPerQuery: 2,
  postsPerTopic: 4,
  maxReadLength: 500,
};

function parseSearchDirective(text, limit = FOLLOWUP_DEFAULTS.queriesPerRound) {
  const trimmed = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  // Requiring a leading "{" keeps a normal prose answer that merely quotes JSON
  // from being mistaken for a directive.
  if (!trimmed.startsWith("{")) return null;
  let obj = null;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Tolerate trailing prose / stray characters from sloppy providers.
    try {
      obj = extractJson(trimmed);
    } catch {
      return null;
    }
  }
  const raw = Array.isArray(obj?.search)
    ? obj.search
    : typeof obj?.search === "string"
      ? [obj.search]
      : null;
  if (!raw) return null;
  const queries = raw.map((q) => String(q).trim()).filter(Boolean).slice(0, limit);
  return queries.length ? queries : null;
}

/** Search one query and read its top topics — the material for a follow-up round. */
async function fetchSupplement(sy, query, opts, { signal, emit, readTopics } = {}) {
  const res = await syWithRetry(
    sy,
    "search",
    { query, page: 1, max_results: opts.resultsPerQuery, max_post_results: 5 },
    { signal, onEvent: emit },
  );
  const topics = res?.results || [];
  const parts = [`#### 查询「${query}」\n命中主题：\n${topics.map(topicLine).join("\n") || "(无结果)"}`];
  let read = 0;
  for (const t of topics) {
    if (read >= opts.topicsPerQuery) break;
    if (t.id == null) continue;
    // Overlapping queries often hit the same topic; excerpt it only once per
    // follow-up (still listed above, just not re-fetched and re-pasted).
    if (readTopics?.has(t.id)) continue;
    readTopics?.add(t.id);
    read += 1;
    try {
      const detail = await syWithRetry(
        sy,
        "topic",
        {
          topic_id: t.id,
          post_limit: opts.postsPerTopic,
          start_post_number: 1,
          max_batches: 1,
          max_read_length: opts.maxReadLength,
          include_html: false,
        },
        { signal, onEvent: emit },
      );
      const excerpt = (detail.posts || [])
        .map((p) => `  - #${p.post_number} @${p.username}: ${String(p.raw || "").replace(/\s+/g, " ")}`)
        .join("\n");
      if (excerpt) parts.push(`正文节选：[${t.title}](${t.url})\n${excerpt}`);
    } catch {
      // Topic reads are best-effort; titles alone still help.
    }
  }
  return parts.join("\n");
}

/**
 * Ask a follow-up question on a finished deep-search conversation.
 * Any question is allowed — not just the ones the report suggested. When the
 * model reports the existing material isn't enough it emits a
 * {"search": [...]} directive; we run those searches, feed the supplement back,
 * and let it search again (up to opts.maxSearchRounds) before it must answer.
 * Appends to `conversation.messages` (append-only, cache-friendly).
 */
export async function followUp({ question, conversation, llm, sy, onEvent, signal, options = {} }) {
  const opts = { ...FOLLOWUP_DEFAULTS, ...options };
  const messages = conversation.messages;
  const baseLength = messages.length;
  const emit = (event) => onEvent?.(event);
  // Use the live prompt rather than conversation.system: prompt rules are code,
  // and sessions saved by an older build shouldn't stay stuck with old limits.
  const system = CHAT_SYSTEM;

  const ask = async () => {
    emit({ type: "chat-thinking" });
    return chatTurn(llm, { system, messages, maxTokens: 3000, signal });
  };
  const forceAnswer = async (answer, instruction) => {
    messages.push({ role: "assistant", content: answer });
    messages.push({ role: "user", content: instruction });
    return ask();
  };

  try {
    messages.push({ role: "user", content: question });
    let answer = await ask();

    const searched = [];
    const executed = new Set();
    const readTopics = new Set();
    let round = 0;
    while (true) {
      const directive = parseSearchDirective(answer, opts.queriesPerRound);
      if (!directive) break;

      if (round >= opts.maxSearchRounds) {
        // Out of budget: make it answer instead of leaking raw JSON to the UI.
        answer = await forceAnswer(
          answer,
          "搜索次数已用尽，请立即基于现有全部材料正式回答我的问题，不要再输出 search 指令；材料确实不足时说明论坛里没找到，再给出你的一般判断并标注来源。",
        );
        break;
      }

      const fresh = directive.filter((q) => !executed.has(normalizeQuery(q)));
      if (!fresh.length) {
        answer = await forceAnswer(
          answer,
          `「${directive.join("、")}」已经搜索过了，材料就在上面。请基于现有材料正式回答，或换用完全不同的关键词。`,
        );
        break;
      }

      round += 1;
      fresh.forEach((q) => executed.add(normalizeQuery(q)));
      searched.push(...fresh);
      emit({ type: "chat-search", queries: fresh, round });

      const supplements = [];
      for (const query of fresh) {
        try {
          supplements.push(await fetchSupplement(sy, query, opts, { signal, emit, readTopics }));
        } catch (err) {
          supplements.push(`#### 查询「${query}」失败：${err?.message || String(err)}`);
        }
      }

      // Keep the directive turn in history — append-only keeps the cache warm.
      messages.push({ role: "assistant", content: answer });
      const remaining = opts.maxSearchRounds - round;
      messages.push({
        role: "user",
        content:
          `补充材料如下：\n\n${supplements.join("\n\n")}\n\n请基于全部材料正式回答我上面的问题。` +
          (remaining > 0
            ? `如果确实还需要换关键词再搜一次（还剩 ${remaining} 次机会），可以再输出一次 search 指令。`
            : "这是最后一批补充材料，不要再输出 search 指令。"),
      });
      answer = await ask();
    }

    messages.push({ role: "assistant", content: answer });
    emit({ type: "chat-answer" });
    return { answer, searched };
  } catch (err) {
    // Roll back partial turns so a failed follow-up doesn't corrupt history.
    messages.length = baseLength;
    throw err;
  }
}
