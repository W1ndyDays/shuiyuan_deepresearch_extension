// shims/process.mjs — minimal process subset for the browser runtime.
// The core's entry guard checks process.argv[1]; leaving argv empty means the
// guard never fires in the service worker and main() never runs.

const processShim = {
  argv: [],
  env: {},
  platform: "linux",
  stdout: { fd: 1 },
  stderr: { fd: 2 },
  cwd: () => "/",
  exit(code) {
    throw new Error(`process.exit(${code}) called in browser runtime`);
  },
};

export default processShim;
