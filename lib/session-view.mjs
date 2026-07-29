// lib/session-view.mjs — shared UI controller for the popup and the full
// search page. Both surfaces render the SAME background session held by the
// service worker; this module owns all interaction logic (start/stop search,
// progress replay, report rendering, follow-up chat, history list) against a
// fixed set of element IDs present in both HTML files:
//
//   #notice #q #btn-go #btn-stop #opt-agents #opt-rounds #opt-topics
//   #run-topic #progress-box #progress #phase-badge
//   #report-box #report #report-meta
//   #chat-box #chat #chat-q #btn-ask #chat-status
//   #history-list

import { renderMarkdown } from "./markdown.mjs";
import { createProgressView } from "./progress.mjs";

const $ = (id) => document.getElementById(id);

function send(message) {
  return chrome.runtime.sendMessage(message).then((res) => {
    if (!res) throw new Error("后台服务无响应，请重新加载扩展。");
    if (!res.ok) {
      const err = new Error(res.error || "请求失败");
      err.data = res;
      throw err;
    }
    return res.data;
  });
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function initSessionView({ onOpened } = {}) {
  const progress = createProgressView({ container: $("progress"), badge: $("phase-badge") });

  // ------------------------------------------------------------- helpers --

  function notice(text, kind = "err") {
    const el = $("notice");
    if (!el) return;
    if (text) {
      el.className = `msg ${kind}`;
      el.textContent = text;
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }

  function setRunning(running) {
    $("btn-go").disabled = running;
    $("btn-stop").classList.toggle("hidden", !running);
  }

  function chatStatus(text) {
    const el = $("chat-status");
    if (!el) return;
    if (text) {
      el.innerHTML = `<span class="spinner"></span> `;
      el.appendChild(document.createTextNode(text));
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }

  function bubble(role, html) {
    const wrap = document.createElement("div");
    wrap.className = `bubble ${role}`;
    const inner = document.createElement("div");
    inner.className = "bubble-body";
    if (role === "user") inner.textContent = html;
    else inner.innerHTML = html;
    wrap.appendChild(inner);
    $("chat").appendChild(wrap);
    $("chat").scrollTop = $("chat").scrollHeight;
    return wrap;
  }

  function renderChat(followUps, pendingQuestion) {
    const chat = $("chat");
    chat.innerHTML = "";
    for (const f of followUps || []) {
      bubble("user", f.q);
      if (f.searched?.length) {
        const tag = document.createElement("div");
        tag.className = "chat-searched";
        tag.textContent = `↳ 追加搜索了：${f.searched.join("、")}`;
        chat.appendChild(tag);
      }
      bubble("assistant", renderMarkdown(f.answer));
    }
    if (pendingQuestion) bubble("user", pendingQuestion);
  }

  function showResult(state) {
    $("report").innerHTML = renderMarkdown(state.report);
    const meta = state.meta;
    $("report-meta").textContent = meta
      ? `「${state.topic}」 · ${meta.queriesExecuted} 个查询 · 精读 ${meta.topicsRead} 个主题 · 用时 ${meta.seconds}s` +
        (meta.agentErrors ? ` · ${meta.agentErrors} 个 agent 失败` : "") +
        (state.finishedAt ? ` · ${formatTime(state.finishedAt)}` : "")
      : `「${state.topic}」`;
    $("report-box").classList.remove("hidden");
    $("chat-box").classList.remove("hidden");
    renderChat(state.followUps, state.chatBusy ? state.pendingQuestion : null);
    chatStatus(state.chatBusy ? "回答生成中…" : null);
  }

  function hideResult() {
    $("report-box").classList.add("hidden");
    $("chat-box").classList.add("hidden");
  }

  // -------------------------------------------------------------- state --

  async function refresh() {
    const state = await send({ type: "sy.search.state" });
    if (state.status === "running") {
      setRunning(true);
      hideResult();
      $("run-topic").textContent = `正在搜索：「${state.topic}」`;
      $("progress-box").classList.remove("hidden");
      progress.reset();
      for (const event of state.events) progress.handle(event);
      return state;
    }
    setRunning(false);
    if (state.status === "done" && state.report) {
      $("run-topic").textContent = "";
      if (state.events.length) {
        $("progress-box").classList.remove("hidden");
        progress.reset();
        for (const event of state.events) progress.handle(event);
      } else {
        $("progress-box").classList.add("hidden");
      }
      showResult(state);
      return state;
    }
    if (state.status === "error") {
      notice(`上次搜索失败：${state.error}`);
      return state;
    }
    if (state.status === "stopped") {
      $("progress-box").classList.add("hidden");
    }
    // idle: surface the most recent history entry so 追问 works immediately.
    if (state.status === "idle") {
      const history = await send({ type: "sy.history.list" });
      if (history.length) {
        try {
          const opened = await send({ type: "sy.history.open", id: history[0].id });
          $("q").value = $("q").value || opened.topic;
          $("progress-box").classList.add("hidden");
          showResult(opened);
          return opened;
        } catch {
          // Something is running elsewhere; leave the view empty.
        }
      }
    }
    return state;
  }

  // ------------------------------------------------------------- history --

  async function renderHistory() {
    const listEl = $("history-list");
    if (!listEl) return;
    const entries = await send({ type: "sy.history.list" });
    listEl.innerHTML = "";
    if (!entries.length) {
      listEl.innerHTML = `<div class="history-empty">还没有历史记录。完成一次深度搜索后会自动保存在这里。</div>`;
      return;
    }
    for (const entry of entries) {
      const item = document.createElement("div");
      item.className = "history-item";
      item.innerHTML = `
        <div class="hi-main">
          <div class="hi-topic"></div>
          <div class="hi-meta"></div>
        </div>
        <button class="hi-del" title="删除">×</button>`;
      item.querySelector(".hi-topic").textContent = entry.topic;
      const bits = [formatTime(entry.finishedAt)];
      if (entry.meta) bits.push(`${entry.meta.queriesExecuted} 查询 · ${entry.meta.topicsRead} 主题`);
      if (entry.followUpCount) bits.push(`${entry.followUpCount} 条追问`);
      item.querySelector(".hi-meta").textContent = bits.join(" · ");
      item.querySelector(".hi-main").addEventListener("click", async () => {
        try {
          const opened = await send({ type: "sy.history.open", id: entry.id });
          notice("");
          $("q").value = opened.topic;
          $("progress-box").classList.add("hidden");
          progress.reset();
          showResult(opened);
          onOpened?.(opened);
        } catch (err) {
          notice(err.message);
        }
      });
      item.querySelector(".hi-del").addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await send({ type: "sy.history.delete", id: entry.id });
          renderHistory();
        } catch (err) {
          notice(err.message);
        }
      });
      listEl.appendChild(item);
    }
  }

  // ------------------------------------------------------------- actions --

  async function ensureLlmPermission() {
    const { llmConfig } = await chrome.storage.local.get("llmConfig");
    if (!llmConfig?.baseUrl) return;
    const origin = new URL(llmConfig.baseUrl).origin;
    const has = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    if (!has) {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) {
        throw new Error(`缺少访问 ${origin} 的权限，请在设置页重新保存 LLM 配置。`);
      }
    }
  }

  async function run() {
    const topic = $("q").value.trim();
    if (!topic) return;
    notice("");
    try {
      await ensureLlmPermission();
      progress.reset();
      hideResult();
      $("progress-box").classList.remove("hidden");
      await send({
        type: "sy.search.start",
        topic,
        options: {
          agentsPerRound: Number($("opt-agents").value),
          maxRounds: Number($("opt-rounds").value),
          topicsPerAgent: Number($("opt-topics").value),
        },
      });
      setRunning(true);
      $("run-topic").textContent = `正在搜索：「${topic}」`;
      progress.setBadge("准备中…");
    } catch (err) {
      notice(err.message || String(err));
    }
  }

  async function ask() {
    const input = $("chat-q");
    const question = input.value.trim();
    if (!question) return;
    notice("");
    try {
      await ensureLlmPermission();
      await send({ type: "sy.chat.ask", question });
      input.value = "";
      bubble("user", question);
      chatStatus("回答生成中…");
    } catch (err) {
      notice(err.message || String(err));
    }
  }

  // ------------------------------------------------------------ wiring --

  $("btn-go").addEventListener("click", run);
  $("q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
  $("btn-stop").addEventListener("click", () => {
    send({ type: "sy.search.stop" }).catch(() => {});
  });
  $("btn-ask").addEventListener("click", ask);
  $("chat-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "sy.searchEvent") {
      $("progress-box").classList.remove("hidden");
      progress.handle(msg.event);
    } else if (msg?.type === "sy.searchDone") {
      setRunning(false);
      if (msg.status === "error") notice(`搜索失败：${msg.error}`);
      if (msg.status === "stopped") progress.setBadge("已停止", "warn");
      refresh().then(() => renderHistory());
    } else if (msg?.type === "sy.chatEvent") {
      const event = msg.event;
      if (event.type === "chat-thinking") chatStatus("回答生成中…");
      if (event.type === "chat-search") {
        const prefix = event.round > 1 ? `第 ${event.round} 轮追加搜索` : "材料不足，追加搜索";
        chatStatus(`${prefix}：${event.queries.join("、")}`);
      }
      if (event.type === "rate-limited") chatStatus(`论坛限流，等待 ${event.wait}s…`);
    } else if (msg?.type === "sy.chatDone") {
      chatStatus(null);
      if (msg.ok) {
        send({ type: "sy.search.state" }).then((state) => {
          renderChat(state.followUps, null);
        });
        renderHistory();
      } else {
        notice(`追问失败：${msg.error}`);
        // Remove the optimistic user bubble.
        const chat = $("chat");
        const last = chat.lastElementChild;
        if (last?.classList.contains("user")) last.remove();
      }
    }
  });

  return { refresh, renderHistory, run, notice };
}
