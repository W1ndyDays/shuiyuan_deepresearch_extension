// pages/search.js — full-page shell. All session logic (search / progress /
// report / follow-up chat / history) lives in lib/session-view.mjs; this file
// only handles page-level init and the ?q= deep link.
import { initSessionView } from "../lib/session-view.mjs";

const $ = (id) => document.getElementById(id);

const view = initSessionView({
  onOpened: () => {
    $("report-box").scrollIntoView({ behavior: "smooth" });
  },
});

async function init() {
  const params = new URLSearchParams(location.search);
  const state = await view.refresh().catch(() => null);
  view.renderHistory();

  const initialQ = params.get("q");
  if (initialQ && state?.status !== "running") {
    $("q").value = initialQ;
    view.run();
  }
}

init();
