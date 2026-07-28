// pages/setup.js — onboarding: Shuiyuan authorization + LLM key configuration.
import { PRESETS, chatComplete } from "../lib/llm.mjs";

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

function setStatus(el, kind, text) {
  el.className = `status ${kind}`;
  el.textContent = text;
}

function setMsg(el, kind, text) {
  el.className = `msg ${kind || ""}`;
  el.textContent = text || "";
}

// ---------------------------------------------------------------- auth ----

async function refreshAuthStatus() {
  const statusEl = $("auth-status");
  try {
    const { auth } = await send({ type: "sy.status" });
    if (auth?.resolved?.found) {
      setStatus(statusEl, "ok", "已授权");
      $("auth-waiting").classList.add("hidden");
      return true;
    }
    setStatus(statusEl, "warn", auth?.pending_auth?.exists ? "待完成" : "未授权");
    return false;
  } catch (err) {
    setStatus(statusEl, "err", "检查失败");
    setMsg($("auth-msg"), "err", err.message);
    return false;
  }
}

$("btn-auth").addEventListener("click", async () => {
  setMsg($("auth-msg"), "", "");
  $("btn-auth").disabled = true;
  try {
    await send({ type: "sy.authStart" });
    $("auth-waiting").classList.remove("hidden");
    setMsg(
      $("auth-msg"),
      "",
      "已打开授权页面。请在该页面登录水源并点击「授权」，之后此处会自动更新。",
    );
  } catch (err) {
    setMsg($("auth-msg"), "err", `发起授权失败：${err.message}`);
  } finally {
    $("btn-auth").disabled = false;
  }
});

$("btn-auth-recheck").addEventListener("click", refreshAuthStatus);

$("btn-manual-finish").addEventListener("click", async () => {
  const payload = $("manual-payload").value.trim();
  if (!payload) return;
  try {
    await send({ type: "sy.authFinish", payload });
    setMsg($("auth-msg"), "ok", "授权成功！");
    $("manual-payload").value = "";
    refreshAuthStatus();
  } catch (err) {
    setMsg($("auth-msg"), "err", `授权失败：${err.message}`);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "sy.authCompleted" && msg.ok) {
    setMsg($("auth-msg"), "ok", "授权成功，凭证已保存！");
    refreshAuthStatus();
  }
});

// ----------------------------------------------------------------- llm ----

const presetSelect = $("llm-preset");
for (const [key, preset] of Object.entries(PRESETS)) {
  const option = document.createElement("option");
  option.value = key;
  option.textContent = preset.label;
  presetSelect.appendChild(option);
}

presetSelect.addEventListener("change", () => {
  const preset = PRESETS[presetSelect.value];
  if (!preset) return;
  $("llm-base").value = preset.baseUrl;
  $("llm-style").value = preset.style;
  $("llm-model").value = preset.model;
});

function readLlmForm() {
  return {
    preset: presetSelect.value,
    baseUrl: $("llm-base").value.trim(),
    style: $("llm-style").value,
    model: $("llm-model").value.trim(),
    apiKey: $("llm-key").value.trim(),
  };
}

async function requestOriginPermission(baseUrl) {
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    throw new Error("Base URL 不是合法的网址。");
  }
  if (!origin.startsWith("https://")) {
    throw new Error("Base URL 必须是 https:// 地址。");
  }
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    throw new Error(`未授予访问 ${origin} 的权限，无法调用该 API。`);
  }
}

async function saveLlm({ silent = false } = {}) {
  const cfg = readLlmForm();
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    throw new Error("请完整填写 Base URL、模型名和 API Key。");
  }
  await requestOriginPermission(cfg.baseUrl);
  await chrome.storage.local.set({ llmConfig: cfg });
  setStatus($("llm-status"), "ok", "已配置");
  if (!silent) setMsg($("llm-msg"), "ok", "已保存。");
  return cfg;
}

$("btn-llm-save").addEventListener("click", async () => {
  try {
    await saveLlm();
  } catch (err) {
    setMsg($("llm-msg"), "err", err.message);
  }
});

$("btn-llm-test").addEventListener("click", async () => {
  $("llm-testing").classList.remove("hidden");
  setMsg($("llm-msg"), "", "");
  try {
    const cfg = await saveLlm({ silent: true });
    const reply = await chatComplete(cfg, {
      user: "请只回复两个字：正常",
      maxTokens: 16,
    });
    setMsg($("llm-msg"), "ok", `连接成功，模型回复：${reply.trim().slice(0, 50)}`);
  } catch (err) {
    setMsg($("llm-msg"), "err", `测试失败：${err.message}`);
  } finally {
    $("llm-testing").classList.add("hidden");
  }
});

// ---------------------------------------------------------------- init ----

$("btn-go-search").addEventListener("click", () => {
  location.href = "search.html";
});

async function init() {
  const authed = await refreshAuthStatus();
  // First-run auto-start: the SW opens setup.html?autostart=1 on install.
  if (!authed && new URLSearchParams(location.search).get("autostart") === "1") {
    $("btn-auth").click();
  }
  const { llmConfig } = await chrome.storage.local.get("llmConfig");
  if (llmConfig) {
    presetSelect.value = llmConfig.preset || "custom";
    $("llm-base").value = llmConfig.baseUrl || "";
    $("llm-style").value = llmConfig.style || "openai";
    $("llm-model").value = llmConfig.model || "";
    $("llm-key").value = llmConfig.apiKey || "";
    if (llmConfig.apiKey && llmConfig.model) setStatus($("llm-status"), "ok", "已配置");
  } else {
    presetSelect.value = "deepseek";
    presetSelect.dispatchEvent(new Event("change"));
  }
}

init();
