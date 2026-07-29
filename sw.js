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
//   {type: "sy.search.stop"}              -> aborts the current run (and follow-up)
//   {type: "sy.search.state"}             -> full run state (status/events/report)
//   {type: "sy.chat.ask", question, sessionId} -> follow-up on the active session
//        (sessionId must match the active historyId, or the ask is refused —
//         another surface may have switched the worker's active session)
//   {type: "sy.chat.stop"}                -> aborts the in-flight follow-up
// Broadcasts while a search runs:
//   {type: "sy.searchEvent", event}       — one deepsearch progress event
//   {type: "sy.searchDone", status, error, historyError}
//   {type: "sy.storageWarning", error}    — chrome.storage write failed
//
// There is exactly ONE active run object. It may be replaced at any time (new
// search, opening a history entry), so every async writer captures its own `run`
// and checks ownsRun() before mutating shared state or broadcasting.

import "./shims/buffer.mjs";
import { __hydrate, __persistError } from "./shims/fs.mjs";
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
const RUN_MARKER_KEY = "activeRun";

let searchRun = null; // {topic, options, status, events, report, meta, error,
//                       startedAt, finishedAt, controller, chatController,
//                       conversation, followUps, historyId, chatBusy,
//                       historyError}
let starting = false; // set synchronously; closes the start() race window

// A run whose worker died mid-flight: nothing will ever finish it, so report it
// as failed instead of leaving every surface spinning forever.
function interruptedRun(marker) {
  return {
    topic: marker.topic || "",
    options: {},
    status: "error",
    events: [],
    report: null,
    meta: null,
    error: `上次「${marker.topic || "未知话题"}」的深度搜索被浏览器中断（后台 Service Worker 被回收），请重新搜索。`,
    startedAt: marker.startedAt || 0,
    finishedAt: null,
    controller: null,
    chatController: null,
    conversation: null,
    followUps: [],
    historyId: null,
    chatBusy: false,
    historyError: null,
  };
}

// memfs must be hydrated from chrome.storage.local before any execute() call —
// the SW restarts often and starts with an empty in-memory fs. The same boot
// pass adopts any orphaned run marker (see interruptedRun).
// Each step is guarded separately on purpose: a failure while adopting the
// marker must never fall through to __hydrate(null), which would throw away the
// credentials we just loaded.
const ready = (async () => {
  let stored = {};
  try {
    stored = await chrome.storage.local.get(["memfs", RUN_MARKER_KEY]);
  } catch {
    // Storage unreadable — continue with an empty fs.
  }
  try {
    __hydrate(stored.memfs);
  } catch {
    __hydrate(null);
  }
  try {
    const marker = stored[RUN_MARKER_KEY];
    if (marker && typeof marker === "object") {
      searchRun = interruptedRun(marker);
      await chrome.storage.local.remove(RUN_MARKER_KEY);
    }
  } catch {
    // Best effort: a stale marker only costs one bogus "interrupted" notice.
  }
})();

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

let keepaliveTimer = null;

const HISTORY_KEY = "history";
const HISTORY_MAX = 30;

/** Every write to the shared run state must first prove it still owns it. */
function ownsRun(run) {
  return run != null && run === searchRun;
}

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

/**
 * Persist a finished run/turn. Storage can legitimately fail (quota, disk), and
 * that must NOT turn a successful search into a failed one — the report is
 * already in hand. Record the problem on the run so the UI can warn instead.
 */
async function persistRun(run) {
  if (!run?.historyId) return;
  try {
    await saveHistoryEntry({
      id: run.historyId,
      topic: run.topic,
      report: run.report,
      meta: run.meta,
      finishedAt: run.finishedAt,
      conversation: run.conversation,
      followUps: run.followUps,
    });
    if (ownsRun(run)) run.historyError = null;
  } catch (err) {
    const message = err?.message || String(err);
    if (ownsRun(run)) run.historyError = message;
    broadcast({ type: "sy.storageWarning", error: message });
  }
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

function pushSearchEvent(run, event) {
  if (!ownsRun(run)) return; // a superseded run must not pollute the live one
  run.events.push(event);
  if (run.events.length > 500) {
    run.events.splice(0, run.events.length - 500);
  }
  broadcast({ type: "sy.searchEvent", event });
}

// Clamp caller-supplied knobs: they drive fan-out over a rate-limited forum and
// paid LLM calls, so a bad value must not become 10k agents (or zero).
function sanitizeOptions(options) {
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const src = options && typeof options === "object" ? options : {};
  const out = {};
  if (src.agentsPerRound != null) out.agentsPerRound = num(src.agentsPerRound, 4, 1, 8);
  if (src.maxRounds != null) out.maxRounds = num(src.maxRounds, 2, 1, 4);
  if (src.topicsPerAgent != null) out.topicsPerAgent = num(src.topicsPerAgent, 2, 0, 5);
  // Per-request LLM timeout; mainly a testing/tuning knob, clamped either way.
  if (src.llmTimeoutMs != null) out.llmTimeoutMs = num(src.llmTimeoutMs, 120_000, 200, 300_000);
  return out;
}

async function startDeepSearch({ topic, options }) {
  const cleanTopic = String(topic || "").trim();
  if (!cleanTopic) throw new SkillError("请输入要研究的话题。");
  // `starting` is set synchronously below, so a double-click (two messages sent
  // before the UI can disable its button) can no longer start two runs.
  if (starting || searchRun?.status === "running") {
    throw new SkillError("已有一个深度搜索正在进行，请先停止或等待完成。");
  }
  if (searchRun?.chatBusy) {
    throw new SkillError("追问正在处理中，请等待完成后再开始新搜索。");
  }
  starting = true;
  try {
    const { llmConfig } = await chrome.storage.local.get("llmConfig");
    if (!llmConfig?.apiKey || !llmConfig?.model || !llmConfig?.baseUrl) {
      throw new SkillError("尚未配置 AI 模型，请先在设置页完成配置。");
    }
    const auth = await execute(makeCtx(), { kind: "auth_status" });
    if (!auth?.resolved?.found) {
      throw new SkillError("尚未完成水源授权，请先在设置页完成授权。");
    }

    const controller = new AbortController();
    const run = {
      topic: cleanTopic,
      options: sanitizeOptions(options),
      status: "running",
      events: [],
      report: null,
      meta: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      controller,
      chatController: null,
      conversation: null,
      followUps: [],
      historyId: null,
      chatBusy: false,
      historyError: null,
    };
    // Installing the run is the last synchronous step: from here the "running"
    // check above protects us, and every writer below re-checks ownership.
    searchRun = run;
    startKeepalive();
    // The marker survives a worker kill; the next boot turns it into an error.
    chrome.storage.local
      .set({ [RUN_MARKER_KEY]: { topic: cleanTopic, startedAt: run.startedAt } })
      .catch(() => {});

    (async () => {
      try {
        const result = await deepSearch({
          topic: cleanTopic,
          llm: llmConfig,
          sy: syLocal,
          onEvent: (event) => pushSearchEvent(run, event),
          signal: controller.signal,
          options: run.options,
        });
        if (!ownsRun(run)) return; // superseded while we were working
        run.status = "done";
        run.report = result.report;
        run.conversation = result.conversation;
        run.finishedAt = Date.now();
        run.historyId = `s_${run.finishedAt}`;
        run.meta = {
          queriesExecuted: result.queriesExecuted.length,
          topicsRead: result.topicsRead,
          agentErrors: result.errors.length,
          degraded: Boolean(result.degraded),
          seconds: Math.round((run.finishedAt - run.startedAt) / 1000),
        };
        await persistRun(run); // never fails the run; sets run.historyError
      } catch (err) {
        if (!ownsRun(run)) return;
        if (err?.name === "AbortError") {
          run.status = "stopped";
        } else {
          run.status = "error";
          run.error = err?.message || String(err);
        }
      } finally {
        if (ownsRun(run)) {
          stopKeepalive();
          chrome.storage.local.remove(RUN_MARKER_KEY).catch(() => {});
          broadcast({
            type: "sy.searchDone",
            status: run.status,
            error: run.error,
            historyError: run.historyError || null,
          });
        }
      }
    })();

    return { started: true };
  } finally {
    starting = false;
  }
}

function searchState() {
  if (!searchRun) return { status: "idle" };
  // conversation can be hundreds of KB — the UI never needs it; the controllers
  // aren't structured-cloneable.
  const { controller, chatController, conversation, ...state } = searchRun;
  return state;
}

// -------------------------------------------------------------- follow-up ----

async function startFollowUp(question, sessionId) {
  if (!question) throw new SkillError("追问内容为空。");
  if (starting) throw new SkillError("正在启动新的搜索，请稍候。");
  if (!searchRun || searchRun.status !== "done" || !searchRun.conversation) {
    throw new SkillError("当前没有可追问的搜索结果。");
  }
  if (searchRun.chatBusy) throw new SkillError("上一个追问还在处理中，请稍候。");
  // The active session is global to the worker: if another surface switched it
  // (e.g. the popup auto-opened a different history entry), answering here would
  // silently attach this answer to someone else's conversation.
  if (sessionId && searchRun.historyId && sessionId !== searchRun.historyId) {
    throw new SkillError("当前会话已在其他窗口被切换，请刷新页面后再追问。");
  }

  // Claim the session SYNCHRONOUSLY, before the first await: two asks dispatched
  // in the same tick (two open surfaces) would otherwise both be accepted and
  // mutate one conversation array, and a rollback from one would truncate the
  // other's answered turn.
  const run = searchRun;
  const chatController = new AbortController();
  run.chatController = chatController;
  run.chatBusy = true;
  run.pendingQuestion = question;

  let llmConfig;
  try {
    ({ llmConfig } = await chrome.storage.local.get("llmConfig"));
    if (!llmConfig?.apiKey || !llmConfig?.model) {
      throw new SkillError("尚未配置 AI 模型。");
    }
    if (!ownsRun(run)) throw new SkillError("会话已切换，请刷新页面后重试。");
  } catch (err) {
    // Pre-flight failed: release the latch we just took.
    run.chatBusy = false;
    run.pendingQuestion = null;
    run.chatController = null;
    throw err;
  }

  startKeepalive();
  (async () => {
    const outcome = { question };
    try {
      const result = await followUp({
        question,
        conversation: run.conversation,
        llm: llmConfig,
        sy: syLocal,
        signal: chatController.signal,
        options: run.options,
        onEvent: (event) => {
          if (ownsRun(run)) broadcast({ type: "sy.chatEvent", event });
        },
      });
      if (!ownsRun(run)) return; // session was switched/deleted under us
      const entry = { q: question, answer: result.answer, searched: result.searched, at: Date.now() };
      run.followUps.push(entry);
      Object.assign(outcome, { ok: true, ...entry });
      await persistRun(run);
      outcome.historyError = run.historyError || null;
    } catch (err) {
      if (!ownsRun(run)) return;
      outcome.ok = false;
      outcome.error =
        err?.name === "AbortError" ? "追问已停止。" : err?.message || String(err);
    } finally {
      // Always release the busy latch on the run we started on, even if it is no
      // longer the active one — otherwise a switched-away session stays locked.
      run.chatBusy = false;
      run.pendingQuestion = null;
      run.chatController = null;
      if (ownsRun(run)) {
        stopKeepalive();
        broadcast({ type: "sy.chatDone", ...outcome });
      }
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
          // Non-null means credentials/history could not be written to disk —
          // the user would otherwise silently lose their authorization.
          storageError: __persistError(),
        },
      };
    }

    case "sy.search.start": {
      const data = await startDeepSearch({ topic: msg.topic, options: msg.options });
      return { ok: true, data };
    }

    case "sy.search.stop": {
      const stopping = Boolean(searchRun?.status === "running" || searchRun?.chatBusy);
      searchRun?.controller?.abort();
      searchRun?.chatController?.abort();
      return { ok: true, data: { stopping } };
    }

    case "sy.search.state": {
      return { ok: true, data: searchState() };
    }

    case "sy.chat.stop": {
      const stopping = Boolean(searchRun?.chatBusy);
      searchRun?.chatController?.abort();
      return { ok: true, data: { stopping } };
    }

    case "sy.chat.ask": {
      const data = await startFollowUp(String(msg.question || "").trim(), msg.sessionId || null);
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
      const before = searchRun;
      if (starting || searchRun?.status === "running" || searchRun?.chatBusy) {
        throw new SkillError("有搜索或追问正在进行，请先等待完成或停止。");
      }
      const entry = (await loadHistory()).find((e) => e.id === msg.id);
      if (!entry) throw new SkillError("该历史记录不存在。");
      // loadHistory() awaited: a search/follow-up may have started meanwhile.
      // Installing this session anyway would orphan that run — it would keep
      // burning forum/LLM calls with nobody listening, never release keepalive,
      // and leave a stale activeRun marker that fakes an error on the next boot.
      if (searchRun !== before || starting || searchRun?.status === "running" || searchRun?.chatBusy) {
        throw new SkillError("有搜索或追问正在进行，请先等待完成或停止。");
      }
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
        chatController: null,
        conversation: entry.conversation || null,
        followUps: entry.followUps || [],
        historyId: entry.id,
        chatBusy: false,
        historyError: null,
      };
      return { ok: true, data: searchState() };
    }

    case "sy.history.delete": {
      // Deleting the session that a follow-up is currently answering used to
      // null out searchRun and crash that follow-up's finally block, leaving the
      // UI spinning forever.
      const busyWith = (run) => run?.status === "running" || run?.chatBusy;
      if (searchRun?.historyId === msg.id && busyWith(searchRun)) {
        throw new SkillError("该会话正在处理中，请先等待完成或停止后再删除。");
      }
      const history = await loadHistory();
      const next = history.filter((e) => e.id !== msg.id);
      await chrome.storage.local.set({ [HISTORY_KEY]: next });
      // Re-check after the awaits: an ask/search dispatched in the same tick may
      // have claimed this run in the meantime, and dropping it would orphan that
      // work (no sy.chatDone -> spinner forever).
      if (searchRun?.historyId === msg.id && !busyWith(searchRun)) {
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
