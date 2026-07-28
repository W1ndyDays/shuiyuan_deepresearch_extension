// sw.js — MV3 service worker. Single owner of the memfs-backed credential store,
// of all forum (Discourse) requests, AND of the deep-search run itself — the
// search keeps running when the popup closes, and any surface (popup or the
// full search page) can re-attach to its progress.
//
// Message protocol (chrome.runtime messages):
//   {type: "sy.exec", kind, args}         -> {ok, data} | {ok:false, error, ...}
//   {type: "sy.authStart"}                -> runs auth_init, opens the auth tab
//   {type: "sy.authFinish", payload}      -> completes auth from a pasted payload
//   {type: "sy.payloadCaptured", payload} (content script) -> auth_finish +
//        broadcast {type: "sy.authCompleted", ok}
//   {type: "sy.status"}                   -> {auth, llmConfigured}
//   {type: "sy.search.start", topic, options} -> starts a background deep search
//   {type: "sy.search.stop"}              -> aborts the current run
//   {type: "sy.search.state"}             -> full run state (status/events/report)
// Broadcasts while a search runs:
//   {type: "sy.searchEvent", event}       — one deepsearch progress event
//   {type: "sy.searchDone", status, error}

import "./shims/buffer.mjs";
import { __hydrate } from "./shims/fs.mjs";
import { __rsaPool } from "./shims/crypto.mjs";
import { deepSearch, followUp } from "./lib/deepsearch.mjs";
import {
  execute,
  normalizeSite,
  resolvePath,
  normalizeRateLimitPayload,
  SkillError,
  ReadOnlyViolation,
  CredentialError,
  HttpRequestError,
  DEFAULT_SITE,
  DEFAULT_TIMEOUT,
  DEFAULT_AUTH_PATH,
  DEFAULT_AUTH_PENDING_PATH,
  DEFAULT_ROTATION_STATE_PATH,
  DEFAULT_IMAGE_CACHE_DIR,
} from "./core/shuiyuan_core.mjs";

const APPLICATION_NAME = "Shuiyuan Deep Search (browser extension)";

// memfs must be hydrated from chrome.storage.local before any execute() call —
// the SW restarts often and starts with an empty in-memory fs.
const ready = chrome.storage.local
  .get("memfs")
  .then((stored) => __hydrate(stored.memfs))
  .catch(() => __hydrate(null));

function makeCtx() {
  return {
    site: normalizeSite(DEFAULT_SITE),
    runtime: "node", // fetch-based; the curl fallback cannot run in a browser
    timeout: DEFAULT_TIMEOUT,
    authFile: resolvePath(DEFAULT_AUTH_PATH),
    authPendingFile: resolvePath(DEFAULT_AUTH_PENDING_PATH),
    imageCacheDir: resolvePath(DEFAULT_IMAGE_CACHE_DIR),
    rotationStateFile: resolvePath(DEFAULT_ROTATION_STATE_PATH),
  };
}

const EXEC_KINDS = new Set([
  "auth_status",
  "auth_init",
  "auth_finish",
  "auth_import",
  "auth_add",
  "auth_remove",
  "search",
  "latest",
  "categories",
  "filter",
  "topic",
  "post",
  "post_raw",
  "image",
]);

function errPayload(err) {
  if (err instanceof HttpRequestError && err.status === 429) {
    // normalizeRateLimitPayload sets ok:true + rate_limited:true (CLI semantics);
    // flip ok so callers treat it as a failed call they may retry.
    return { ...normalizeRateLimitPayload(err), ok: false };
  }
  const error_type =
    err instanceof ReadOnlyViolation
      ? "read_only_violation"
      : err instanceof CredentialError
        ? "credential_error"
        : err instanceof HttpRequestError
          ? "http_error"
          : err instanceof SkillError
            ? "skill_error"
            : "internal_error";
  const payload = { ok: false, error_type, error: err?.message || String(err) };
  if (err instanceof HttpRequestError) payload.status = err.status;
  return payload;
}

function broadcast(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // No listeners; fine.
  }
}

// ------------------------------------------------------ deep-search runner ----

let searchRun = null; // {topic, options, status, events, report, meta, error,
//                       startedAt, finishedAt, controller, conversation,
//                       followUps, historyId, chatBusy}
let keepaliveTimer = null;

const HISTORY_KEY = "history";
const HISTORY_MAX = 30;

async function loadHistory() {
  const { [HISTORY_KEY]: history } = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(history) ? history : [];
}

async function saveHistoryEntry(entry) {
  const history = await loadHistory();
  const index = history.findIndex((e) => e.id === entry.id);
  if (index >= 0) history[index] = entry;
  else history.unshift(entry);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

async function updateHistoryFromRun() {
  if (!searchRun?.historyId) return;
  await saveHistoryEntry({
    id: searchRun.historyId,
    topic: searchRun.topic,
    report: searchRun.report,
    meta: searchRun.meta,
    finishedAt: searchRun.finishedAt,
    conversation: searchRun.conversation,
    followUps: searchRun.followUps,
  });
}

// MV3 SWs idle out after ~30s; a periodic trivial extension-API call keeps the
// worker alive for the duration of a multi-minute search run.
function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20_000);
}

function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

// Forum adapter for deepsearch: call execute() in-process; shape errors the
// same way the page-side adapter did (err.data.rate_limited drives retries).
async function syLocal(kind, args) {
  await ready;
  try {
    return await execute(makeCtx(), { kind, args });
  } catch (err) {
    const shaped = new Error(err?.message || String(err));
    shaped.data = errPayload(err);
    throw shaped;
  }
}

function pushSearchEvent(event) {
  if (!searchRun) return;
  searchRun.events.push(event);
  if (searchRun.events.length > 500) {
    searchRun.events.splice(0, searchRun.events.length - 500);
  }
  broadcast({ type: "sy.searchEvent", event });
}

async function startDeepSearch({ topic, options }) {
  if (searchRun?.status === "running") {
    throw new SkillError("已有一个深度搜索正在进行，请先停止或等待完成。");
  }
  const { llmConfig } = await chrome.storage.local.get("llmConfig");
  if (!llmConfig?.apiKey || !llmConfig?.model || !llmConfig?.baseUrl) {
    throw new SkillError("尚未配置 AI 模型，请先在设置页完成配置。");
  }
  const auth = await execute(makeCtx(), { kind: "auth_status" });
  if (!auth?.resolved?.found) {
    throw new SkillError("尚未完成水源授权，请先在设置页完成授权。");
  }

  const controller = new AbortController();
  searchRun = {
    topic,
    options: options || {},
    status: "running",
    events: [],
    report: null,
    meta: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    controller,
    conversation: null,
    followUps: [],
    historyId: null,
    chatBusy: false,
  };
  startKeepalive();

  (async () => {
    try {
      const result = await deepSearch({
        topic,
        llm: llmConfig,
        sy: syLocal,
        onEvent: pushSearchEvent,
        signal: controller.signal,
        options: searchRun.options,
      });
      searchRun.status = "done";
      searchRun.report = result.report;
      searchRun.conversation = result.conversation;
      searchRun.finishedAt = Date.now();
      searchRun.historyId = `s_${searchRun.finishedAt}`;
      searchRun.meta = {
        queriesExecuted: result.queriesExecuted.length,
        topicsRead: result.topicsRead,
        agentErrors: result.errors.length,
        seconds: Math.round((Date.now() - searchRun.startedAt) / 1000),
      };
      await updateHistoryFromRun();
    } catch (err) {
      if (err?.name === "AbortError") {
        searchRun.status = "stopped";
      } else {
        searchRun.status = "error";
        searchRun.error = err?.message || String(err);
      }
    } finally {
      stopKeepalive();
      broadcast({
        type: "sy.searchDone",
        status: searchRun.status,
        error: searchRun.error,
      });
    }
  })();

  return { started: true };
}

function searchState() {
  if (!searchRun) return { status: "idle" };
  // conversation can be hundreds of KB — the UI never needs it.
  const { controller, conversation, ...state } = searchRun;
  return state;
}

// -------------------------------------------------------------- follow-up ----

async function startFollowUp(question) {
  if (!question) throw new SkillError("追问内容为空。");
  if (!searchRun || searchRun.status !== "done" || !searchRun.conversation) {
    throw new SkillError("当前没有可追问的搜索结果。");
  }
  if (searchRun.chatBusy) throw new SkillError("上一个追问还在处理中，请稍候。");
  const { llmConfig } = await chrome.storage.local.get("llmConfig");
  if (!llmConfig?.apiKey || !llmConfig?.model) {
    throw new SkillError("尚未配置 AI 模型。");
  }

  searchRun.chatBusy = true;
  searchRun.pendingQuestion = question;
  startKeepalive();
  (async () => {
    const outcome = { question };
    try {
      const result = await followUp({
        question,
        conversation: searchRun.conversation,
        llm: llmConfig,
        sy: syLocal,
        onEvent: (event) => broadcast({ type: "sy.chatEvent", event }),
      });
      const entry = { q: question, answer: result.answer, searched: result.searched, at: Date.now() };
      searchRun.followUps.push(entry);
      Object.assign(outcome, { ok: true, ...entry });
      await updateHistoryFromRun();
    } catch (err) {
      outcome.ok = false;
      outcome.error = err?.message || String(err);
    } finally {
      searchRun.chatBusy = false;
      searchRun.pendingQuestion = null;
      stopKeepalive();
      broadcast({ type: "sy.chatDone", ...outcome });
    }
  })();
  return { accepted: true };
}

// ------------------------------------------------------------- messaging ----

async function handleMessage(msg, sender) {
  await ready;
  switch (msg?.type) {
    case "sy.exec": {
      if (!EXEC_KINDS.has(msg.kind)) {
        throw new SkillError(`Unsupported command kind: ${msg.kind}`);
      }
      if (msg.kind === "auth_init") await __rsaPool.ensure();
      const data = await execute(makeCtx(), { kind: msg.kind, args: msg.args || {} });
      return { ok: true, data };
    }

    case "sy.authStart": {
      await __rsaPool.ensure();
      const data = await execute(makeCtx(), {
        kind: "auth_init",
        args: {
          application_name: APPLICATION_NAME,
          scopes: "read",
          client_id: null,
          nonce: null,
          payload: null,
        },
      });
      await chrome.tabs.create({ url: data.auth_url });
      return {
        ok: true,
        data: {
          auth_url: data.auth_url,
          expires_at: data.auth_session?.expires_at ?? null,
        },
      };
    }

    case "sy.authFinish":
    case "sy.payloadCaptured": {
      const data = await execute(makeCtx(), {
        kind: "auth_finish",
        args: { payload: msg.payload },
      });
      broadcast({ type: "sy.authCompleted", ok: true });
      // Let the auth tab close itself once the credential is saved.
      if (msg.type === "sy.payloadCaptured" && sender?.tab?.id != null) {
        setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 1500);
      }
      return { ok: true, data };
    }

    case "sy.status": {
      const auth = await execute(makeCtx(), { kind: "auth_status" });
      const { llmConfig } = await chrome.storage.local.get("llmConfig");
      return {
        ok: true,
        data: {
          auth,
          llmConfigured: Boolean(llmConfig?.apiKey && llmConfig?.model),
        },
      };
    }

    case "sy.search.start": {
      const data = await startDeepSearch({ topic: msg.topic, options: msg.options });
      return { ok: true, data };
    }

    case "sy.search.stop": {
      searchRun?.controller?.abort();
      return { ok: true, data: { stopping: Boolean(searchRun) } };
    }

    case "sy.search.state": {
      return { ok: true, data: searchState() };
    }

    case "sy.chat.ask": {
      const data = await startFollowUp(String(msg.question || "").trim());
      return { ok: true, data };
    }

    case "sy.history.list": {
      const history = await loadHistory();
      return {
        ok: true,
        data: history.map((e) => ({
          id: e.id,
          topic: e.topic,
          finishedAt: e.finishedAt,
          meta: e.meta,
          followUpCount: e.followUps?.length || 0,
        })),
      };
    }

    case "sy.history.open": {
      if (searchRun?.status === "running" || searchRun?.chatBusy) {
        throw new SkillError("有搜索或追问正在进行，请先等待完成或停止。");
      }
      const entry = (await loadHistory()).find((e) => e.id === msg.id);
      if (!entry) throw new SkillError("该历史记录不存在。");
      searchRun = {
        topic: entry.topic,
        options: {},
        status: "done",
        events: [],
        report: entry.report,
        meta: entry.meta,
        error: null,
        startedAt: 0,
        finishedAt: entry.finishedAt,
        controller: null,
        conversation: entry.conversation || null,
        followUps: entry.followUps || [],
        historyId: entry.id,
        chatBusy: false,
      };
      return { ok: true, data: searchState() };
    }

    case "sy.history.delete": {
      const history = await loadHistory();
      const next = history.filter((e) => e.id !== msg.id);
      await chrome.storage.local.set({ [HISTORY_KEY]: next });
      if (searchRun?.historyId === msg.id && searchRun.status !== "running") {
        searchRun = null;
      }
      return { ok: true, data: { deleted: history.length - next.length } };
    }

    default:
      throw new SkillError(`Unknown message type: ${msg?.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, (err) => sendResponse(errPayload(err)));
  return true; // async response
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    // autostart=1 makes the setup page kick off Shuiyuan authorization
    // immediately on first run.
    chrome.tabs.create({ url: chrome.runtime.getURL("pages/setup.html?autostart=1") });
  }
});
