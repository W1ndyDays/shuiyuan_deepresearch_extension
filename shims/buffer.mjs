// shims/buffer.mjs — minimal Buffer replacement for the browser runtime.
// Installs globalThis.Buffer (the core copy references bare `Buffer`) and also
// exports ShimBuffer for direct use by the other shims.

const textDecoder = new TextDecoder("utf-8");
const textEncoder = new TextEncoder();

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function normalizeB64(input, urlSafe) {
  let s = String(input).replace(/\s+/g, "");
  if (urlSafe) s = s.replace(/-/g, "+").replace(/_/g, "/");
  const mod = s.length % 4;
  if (mod) s += "=".repeat(4 - mod);
  return s;
}

function bytesFromBase64(input, urlSafe) {
  const bin = atob(normalizeB64(input, urlSafe));
  const out = new ShimBuffer(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function base64FromBytes(bytes, urlSafe) {
  // Chunked to avoid call-stack limits on large inputs.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  let s = btoa(bin);
  if (urlSafe) s = s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return s;
}

function bytesFromHex(input) {
  const s = String(input).trim();
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new TypeError("Invalid hex string");
  const out = new ShimBuffer(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hexFromBytes(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export class ShimBuffer extends Uint8Array {
  static from(input, encoding = "utf8") {
    if (input == null) throw new TypeError("Buffer.from requires an argument");
    if (typeof input === "number") return new ShimBuffer(input);
    if (typeof input === "string") {
      const enc = String(encoding).toLowerCase();
      if (enc === "base64") return bytesFromBase64(input, false);
      if (enc === "base64url") return bytesFromBase64(input, true);
      if (enc === "hex") return bytesFromHex(input);
      if (enc === "latin1" || enc === "binary" || enc === "ascii") {
        const out = new ShimBuffer(input.length);
        for (let i = 0; i < input.length; i += 1) out[i] = input.charCodeAt(i) & 0xff;
        return out;
      }
      return new ShimBuffer(textEncoder.encode(input));
    }
    if (input instanceof ArrayBuffer) return new ShimBuffer(new Uint8Array(input));
    if (ArrayBuffer.isView(input)) {
      return new ShimBuffer(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    }
    if (Array.isArray(input)) return new ShimBuffer(input);
    throw new TypeError("Buffer.from: unsupported input type");
  }

  static concat(list, totalLength) {
    const parts = list.map((p) => ShimBuffer.from(p));
    const total = totalLength ?? parts.reduce((acc, p) => acc + p.length, 0);
    const out = new ShimBuffer(total);
    let offset = 0;
    for (const part of parts) {
      if (offset >= total) break;
      const slice = part.subarray(0, Math.min(part.length, total - offset));
      out.set(slice, offset);
      offset += slice.length;
    }
    return out;
  }

  static alloc(size) {
    return new ShimBuffer(size);
  }

  static isBuffer(value) {
    return value instanceof ShimBuffer;
  }

  toString(encoding = "utf8") {
    const enc = String(encoding || "utf8").toLowerCase();
    if (enc === "base64") return base64FromBytes(this, false);
    if (enc === "base64url") return base64FromBytes(this, true);
    if (enc === "hex") return hexFromBytes(this);
    if (enc === "latin1" || enc === "binary" || enc === "ascii") {
      let s = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < this.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, this.subarray(i, i + CHUNK));
      }
      return s;
    }
    return textDecoder.decode(this);
  }
}

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = ShimBuffer;
}

export { base64FromBytes, bytesFromBase64, hexFromBytes, bytesFromHex, B64_ALPHABET };
