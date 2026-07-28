// shims/path.mjs — minimal POSIX path subset used by the core copy.
// Only what shuiyuan_core actually calls: join, resolve, dirname, relative,
// isAbsolute, sep (plus normalize/basename for completeness).

const sep = "/";

function normalizePath(p) {
  const input = String(p ?? "");
  const isAbs = input.startsWith("/");
  const parts = input.split("/").filter((seg) => seg !== "" && seg !== ".");
  const out = [];
  for (const seg of parts) {
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
    } else {
      out.push(seg);
    }
  }
  let result = (isAbs ? "/" : "") + out.join("/");
  if (result === "") result = isAbs ? "/" : ".";
  return result;
}

function resolve(...parts) {
  let resolved = "";
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = String(parts[i] ?? "");
    if (part === "") continue;
    resolved = `${part}/${resolved}`;
    if (part.startsWith("/")) break;
  }
  if (!resolved.startsWith("/")) resolved = `/${resolved}`;
  return normalizePath(resolved);
}

function join(...parts) {
  const joined = parts.filter((p) => p !== "" && p != null).join("/");
  return joined === "" ? "." : normalizePath(joined);
}

function dirname(p) {
  const input = String(p ?? "");
  if (input === "/" ) return "/";
  const trimmed = input.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return trimmed.slice(0, idx);
}

function basename(p, ext) {
  const trimmed = String(p ?? "").replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  let base = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  if (base === "") base = "/";
  if (ext && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
  return base;
}

function isAbsolute(p) {
  return String(p ?? "").startsWith("/");
}

function relative(from, to) {
  const fromParts = resolve(from).split("/").filter(Boolean);
  const toParts = resolve(to).split("/").filter(Boolean);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }
  const ups = fromParts.length - common;
  const downs = toParts.slice(common);
  const parts = [...Array.from({ length: ups }, () => ".."), ...downs];
  return parts.join("/");
}

const api = { sep, delimiter: ":", normalize: normalizePath, resolve, join, dirname, basename, isAbsolute, relative };

export { sep, normalizePath as normalize, resolve, join, dirname, basename, isAbsolute, relative };
export default api;
