// shims/child_process.mjs — no subprocesses in a browser. The core only uses
// spawnSync for its curl fallback; the extension runs with runtime:"node"
// (fetch only), so this should never be reached.

export function spawnSync(cmd) {
  throw new Error(`child_process.spawnSync is unavailable in the browser runtime (${cmd})`);
}
