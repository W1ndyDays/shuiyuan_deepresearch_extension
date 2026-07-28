// pages/popup.js — popup shell: tabs + configured-state notice. All session
// logic (search / progress / report / follow-up chat / history) lives in the
// shared lib/session-view.mjs controller.
import { initSessionView } from "../lib/session-view.mjs";

const $ = (id) => document.getElementById(id);

function openTab(url) {
  chrome.tabs.create({ url: chrome.runtime.getURL(url) });
  window.close();
}

$("lnk-setup").addEventListener("click", (e) => {
  e.preventDefault();
  openTab("pages/setup.html");
});
$("lnk-fullpage").addEventListener("click", (e) => {
  e.preventDefault();
  openTab("pages/search.html");
});
$("btn-open-full").addEventListener("click", () => openTab("pages/search.html"));

// ---- tabs ----
function showTab(name) {
  $("tab-search").classList.toggle("active", name === "search");
  $("tab-history").classList.toggle("active", name === "history");
  $("view-search").classList.toggle("hidden", name !== "search");
  $("view-history").classList.toggle("hidden", name !== "history");
}
$("tab-search").addEventListener("click", () => showTab("search"));
$("tab-history").addEventListener("click", () => {
  showTab("history");
  view.renderHistory();
});

// ---- session view ----
const view = initSessionView({
  onOpened: () => showTab("search"), // opening a history entry jumps to it
});

async function init() {
  try {
    const status = await chrome.runtime.sendMessage({ type: "sy.status" });
    if (status?.ok) {
      const missing = [];
      if (!status.data.auth?.resolved?.found) missing.push("水源授权");
      if (!status.data.llmConfigured) missing.push("AI 模型配置");
      if (missing.length) {
        view.notice(`尚未完成：${missing.join("、")}。点击右上角 ⚙ 前往设置。`);
      }
    }
    await view.refresh();
    view.renderHistory();
  } catch (err) {
    view.notice(err.message || String(err));
  }
  $("q").focus();
}

init();
