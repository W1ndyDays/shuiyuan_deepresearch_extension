// shims/os.mjs — minimal os subset for the browser runtime.
// The memfs is rooted at a virtual home; no real filesystem exists.

function homedir() {
  return "/home/browser";
}

function tmpdir() {
  return "/tmp";
}

const api = { homedir, tmpdir, EOL: "\n", platform: () => "linux" };

export { homedir, tmpdir };
export default api;
