// content/auth_capture.js — runs on https://shuiyuan.sjtu.edu.cn/user-api-key*
//
// The extension starts the Discourse user-api-key flow WITHOUT auth_redirect
// (arbitrary redirect URLs must be whitelisted server-side, which we can't rely
// on). After the user clicks "授权", Discourse renders a page showing the
// encrypted payload for manual copying. This script finds that payload in the
// DOM and sends it to the service worker, which decrypts it and stores the key
// — so the user never has to copy anything by hand.

(function () {
  "use strict";
  if (window.__syDeepSearchAuthCapture) return;
  window.__syDeepSearchAuthCapture = true;

  var done = false;
  var inflight = false; // one auth_finish at a time; Ember fires many mutations
  var lastSubmitted = null;
  var attempts = 0;
  var MAX_ATTEMPTS = 240; // ~2 minutes at 500ms

  function looksLikePayload(text) {
    if (!text) return false;
    var compact = text.replace(/\s+/g, "");
    // RSA-2048-encrypted, base64-encoded payload: ~344 chars of base64.
    if (compact.length < 200 || compact.length > 4096) return false;
    if (text.indexOf("-----") !== -1) return false; // PEM public key, not payload
    return /^[A-Za-z0-9+/=_-]+$/.test(compact);
  }

  function findPayload() {
    var candidates = document.querySelectorAll("textarea, pre, code");
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var text = (el.value || el.textContent || "").trim();
      if (looksLikePayload(text)) return text.replace(/\s+/g, "");
    }
    return null;
  }

  function showBanner(text, ok) {
    var el = document.createElement("div");
    el.textContent = text;
    el.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
      "padding:12px 16px;font:14px/1.4 system-ui,sans-serif;text-align:center;" +
      (ok
        ? "background:#0a7d33;color:#fff;"
        : "background:#b3261e;color:#fff;");
    document.documentElement.appendChild(el);
  }

  function submit(payload) {
    // The payload can only be consumed once (auth_finish clears the pending
    // session), so never let concurrent submissions pile up.
    if (done || inflight || payload === lastSubmitted) return;
    inflight = true;
    lastSubmitted = payload;
    chrome.runtime.sendMessage(
      { type: "sy.payloadCaptured", payload: payload },
      function (res) {
        inflight = false;
        if (chrome.runtime.lastError) {
          lastSubmitted = null; // SW unavailable; allow a retry
          return;
        }
        if (res && res.ok) {
          done = true;
          showBanner("✅ 水源深度搜索：授权成功，此页面即将自动关闭。", true);
        }
        // On failure (e.g. stale pending session) keep polling — the page may
        // still be mid-render, or the user may restart auth from the setup tab.
      }
    );
  }

  function tick() {
    if (done) return;
    attempts += 1;
    var payload = findPayload();
    if (payload) submit(payload);
    if (!done && attempts < MAX_ATTEMPTS) setTimeout(tick, 500);
  }

  // Ember renders asynchronously; observe mutations and also poll as a fallback.
  var observer = new MutationObserver(function () {
    if (done) {
      observer.disconnect();
      return;
    }
    var payload = findPayload();
    if (payload) submit(payload);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  tick();
})();
