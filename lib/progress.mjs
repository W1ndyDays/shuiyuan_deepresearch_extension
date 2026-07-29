// lib/progress.mjs — shared progress renderer for deep-search events.
// Used by both the popup and the full search page; expects the .agent-card /
// .phase-label / .status styles from pages/common.css.

export function createProgressView({ container, badge }) {
  const agentCards = new Map(); // agentId -> log element

  function setBadge(text, kind = "warn") {
    if (!badge) return;
    badge.classList.remove("hidden");
    badge.className = `status ${kind}`;
    badge.textContent = text;
  }

  function addLine(text) {
    const el = document.createElement("div");
    el.className = "phase-label";
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function agentLog(event, text) {
    let log = agentCards.get(event.agentId);
    if (!log) {
      const card = document.createElement("div");
      card.className = "agent-card";
      card.innerHTML = `<div class="q"></div><div class="log"></div>`;
      card.querySelector(".q").textContent =
        `第${event.round}轮 · Agent ${event.agentId + 1} · 「${event.query}」`;
      container.appendChild(card);
      log = card.querySelector(".log");
      agentCards.set(event.agentId, log);
    }
    log.textContent = text;
    container.scrollTop = container.scrollHeight;
  }

  function handle(event) {
    switch (event.type) {
      case "phase":
        if (event.phase === "plan") setBadge("规划查询中…");
        if (event.phase === "synthesis") setBadge("综合报告中…");
        break;
      case "plan-fallback":
        addLine(`⚠ 规划失败（${event.error}），退回用原始话题直接搜索。`);
        break;
      case "llm-retry":
        addLine(
          event.reason === "empty"
            ? `⟳ 模型返回空回复，正在重试（第 ${event.attempt} 次）…`
            : `⟳ LLM 请求失败（${event.error}），${Math.round((event.wait || 0) / 1000)}s 后重试…`,
        );
        break;
      case "synthesis-fallback":
        addLine(`⚠ 综合报告生成失败（${event.error}），已改为输出原始材料汇总。`);
        break;
      case "plan-done":
        addLine(`✓ 规划完成：${event.queries.map((q) => q.q).join("、")}`);
        break;
      case "round-start":
        setBadge(`第 ${event.round} 轮搜索中…`);
        addLine(`— 第 ${event.round} 轮（${event.queries.length} 个 agent 并行）—`);
        break;
      case "agent-start":
        agentLog(event, `启动（角度：${event.angle || "—"}）…`);
        break;
      case "agent-search-done":
        agentLog(event, `搜索完成：${event.topicsFound} 个主题 / ${event.postsFound} 条楼层`);
        break;
      case "agent-read":
        agentLog(event, `精读主题：${event.title}`);
        break;
      case "agent-analyze":
        agentLog(event, "AI 分析材料中…");
        break;
      case "agent-done":
        agentLog(
          event,
          `✓ 完成${event.followups?.length ? `，新线索：${event.followups.join("、")}` : ""}`,
        );
        break;
      case "agent-read-error":
        agentLog(event, `读取主题 ${event.topicId} 失败：${event.error}`);
        break;
      case "agent-error":
        addLine(`✗ 某个 agent 失败：${event.error}`);
        break;
      case "rate-limited":
        addLine(`⏳ 论坛限流，等待 ${event.wait}s 后重试…`);
        break;
      case "round-done":
        addLine(
          event.followups.length
            ? `✓ 第 ${event.round} 轮完成，后续查询：${event.followups.join("、")}`
            : `✓ 第 ${event.round} 轮完成，无新线索。`,
        );
        break;
      case "done":
        setBadge("完成", "ok");
        break;
    }
  }

  function reset() {
    agentCards.clear();
    container.innerHTML = "";
  }

  return { handle, reset, setBadge };
}
