// shims/fs.mjs — synchronous in-memory filesystem ("memfs") backed by
// chrome.storage.local. The core's credential handling (readJsonFile /
// writeJsonFileSecure / renameSync / chmodSync ...) is fully synchronous, so
// the only way to reuse it unchanged in a service worker is a sync store:
//
//   - sw.js hydrates memfs from chrome.storage.local at startup (__hydrate);
//   - reads are served synchronously from memory;
//   - writes update memory synchronously, then persist fire-and-forget.
//     chrome.storage writes are executed by the browser process, so they
//     complete even if the service worker is suspended right after the call.
//
// Paths are virtual (see shims/path.mjs + shims/os.mjs): the CLI's
// ~/.shuiyuan-discourse/auth.json maps to /home/browser/.shuiyuan-discourse/auth.json.

import path from "./path.mjs";
import { ShimBuffer, base64FromBytes, bytesFromBase64 } from "./buffer.mjs";

const STORAGE_KEY = "memfs";

// normalized absolute path -> { data: Uint8Array, mtimeMs: number }
const files = new Map();

function normalizeKey(p) {
  return path.resolve(String(p));
}

function storageBackend() {
  return globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local
    ? globalThis.chrome.storage.local
    : null;
}

function persist() {
  const backend = storageBackend();
  if (!backend) return; // plain-Node test runs: memory only
  const snapshot = {};
  for (const [key, entry] of files) {
    snapshot[key] = { data: base64FromBytes(entry.data, false), mtimeMs: entry.mtimeMs };
  }
  try {
    const maybePromise = backend.set({ [STORAGE_KEY]: snapshot });
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch {
    // Best effort persistence only.
  }
}

export function __hydrate(stored) {
  files.clear();
  if (!stored || typeof stored !== "object") return;
  for (const [key, value] of Object.entries(stored)) {
    if (!value || typeof value.data !== "string") continue;
    files.set(key, {
      data: new Uint8Array(bytesFromBase64(value.data, false)),
      mtimeMs: typeof value.mtimeMs === "number" ? value.mtimeMs : 0,
    });
  }
}

function enoent(p) {
  const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
  err.code = "ENOENT";
  return err;
}

function assertNotFd(p) {
  if (typeof p === "number") {
    // Only printJson() (CLI main()) writes by fd; it never runs in the browser.
    throw new Error("fs file-descriptor writes are unsupported in the browser runtime");
  }
}

function existsSync(p) {
  assertNotFd(p);
  return files.has(normalizeKey(p));
}

function statSync(p) {
  assertNotFd(p);
  const key = normalizeKey(p);
  const entry = files.get(key);
  if (!entry) throw enoent(p);
  return {
    isFile: () => true,
    isDirectory: () => false,
    size: entry.data.length,
    mtime: new Date(entry.mtimeMs),
    mtimeMs: entry.mtimeMs,
  };
}

function readFileSync(p, encoding) {
  assertNotFd(p);
  const entry = files.get(normalizeKey(p));
  if (!entry) throw enoent(p);
  if (encoding === "utf8" || encoding === "utf-8") {
    return new TextDecoder("utf-8").decode(entry.data);
  }
  return ShimBuffer.from(entry.data);
}

function writeFileSync(p, data, encoding) {
  assertNotFd(p);
  let bytes;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    throw new TypeError(`writeFileSync: unsupported data type (${typeof data})`);
  }
  files.set(normalizeKey(p), { data: new Uint8Array(bytes), mtimeMs: Date.now() });
  persist();
}

function renameSync(from, to) {
  const src = normalizeKey(from);
  const entry = files.get(src);
  if (!entry) throw enoent(from);
  files.delete(src);
  files.set(normalizeKey(to), entry);
  persist();
}

function unlinkSync(p) {
  const key = normalizeKey(p);
  if (!files.has(key)) throw enoent(p);
  files.delete(key);
  persist();
}

function mkdirSync() {
  // Directories are implicit in memfs; always succeeds (recursive or not).
}

function chmodSync() {
  // No permission bits in chrome.storage; 0600 semantics are inherent
  // (extension storage is per-profile and not world-readable).
}

function mkdtempSync(prefix) {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${String(prefix)}${suffix}`;
}

function rmSync(p) {
  files.delete(normalizeKey(p));
  persist();
}

const api = {
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
  mkdtempSync,
  rmSync,
};

export {
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
  mkdtempSync,
  rmSync,
};
export default api;
