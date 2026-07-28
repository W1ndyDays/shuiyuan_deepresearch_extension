// shims/crypto.mjs — the node:crypto subset the core copy uses, for the
// browser runtime. Three hard pieces:
//
//   1. RSA-2048 key generation. The core calls generateKeyPairSync()
//      synchronously, but WebCrypto keygen is async — so sw.js pre-generates
//      a key via __rsaPool.ensure() and this module's sync API consumes it.
//      WebCrypto gives us the full JWK (n/e/d/p/q/dp/dq/qi); we re-encode the
//      public half as a plain rsaEncryption SPKI PEM (what Discourse expects)
//      and stash the private half as a JSON string in place of a PEM.
//
//   2. RSA PKCS#1 v1.5 decryption. Discourse encrypts the auth payload with
//      PKCS1 v1.5 padding, which WebCrypto deliberately does not support.
//      Implemented directly with BigInt (CRT + unpad) — the key is our own,
//      generated moments earlier, so no foreign-key edge cases apply.
//
//   3. Synchronous SHA-256 (createHash). WebCrypto digest() is async; only the
//      image command uses createHash, but a real implementation is provided.

import { ShimBuffer, bytesFromBase64, base64FromBytes, hexFromBytes } from "./buffer.mjs";

export const constants = { RSA_PKCS1_PADDING: 1 };

// ---------------------------------------------------------------- random ----

export function randomBytes(size) {
  const out = new ShimBuffer(size);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function randomUUID() {
  return globalThis.crypto.randomUUID();
}

// ---------------------------------------------------------------- SHA-256 ---

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Digest(bytes) {
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);

  const bitLenHi = Math.floor((bytes.length * 8) / 4294967296);
  const bitLenLo = (bytes.length * 8) >>> 0;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(paddedLen - 8, bitLenHi >>> 0, false);
  dv.setUint32(paddedLen - 4, bitLenLo, false);

  for (let block = 0; block < paddedLen; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (s1 + w[i - 7] + s0 + w[i - 16]) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) odv.setUint32(i * 4, h[i] >>> 0, false);
  return out;
}

class Sha256Hash {
  constructor() {
    this.chunks = [];
    this.total = 0;
    this.used = false;
  }
  update(data) {
    if (this.used) throw new Error("sha256: digest already computed");
    const bytes = typeof data === "string" ? ShimBuffer.from(data, "utf8") : ShimBuffer.from(data);
    this.chunks.push(bytes);
    this.total += bytes.length;
    return this;
  }
  digest(encoding) {
    if (this.used) throw new Error("sha256: digest already computed");
    this.used = true;
    const merged = ShimBuffer.concat(this.chunks, this.total);
    const digest = sha256Digest(merged);
    if (encoding === "hex") return hexFromBytes(digest);
    if (encoding === "base64") return base64FromBytes(digest, false);
    return ShimBuffer.from(digest);
  }
}

export function createHash(algorithm) {
  if (String(algorithm).toLowerCase() !== "sha256") {
    throw new Error(`createHash: only sha256 is supported in the browser runtime (got ${algorithm})`);
  }
  return new Sha256Hash();
}

// ------------------------------------------------------- base64url helpers ---

function b64urlToBytes(s) {
  return new Uint8Array(bytesFromBase64(String(s), true));
}

function bytesToBigInt(bytes) {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex === "" ? 0n : BigInt(`0x${hex}`);
}

function bigIntToBytes(n, length) {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = bytesFromHexCompat(hex);
  if (length != null) {
    if (bytes.length > length) bytes = bytes.slice(bytes.length - length);
    else if (bytes.length < length) {
      const padded = new Uint8Array(length);
      padded.set(bytes, length - bytes.length);
      bytes = padded;
    }
  }
  return bytes;
}

function bytesFromHexCompat(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ------------------------------------------------------------- RSA keygen ---

const RSA_JWK_FIELDS = ["n", "e", "d", "p", "q", "dp", "dq", "qi"];

let pooledJwk = null;
let pendingGeneration = null;

async function generateRsaJwk() {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", keyPair.privateKey);
  for (const field of RSA_JWK_FIELDS) {
    if (typeof jwk[field] !== "string" || !jwk[field]) {
      throw new Error(`WebCrypto JWK export missing field: ${field}`);
    }
  }
  return jwk;
}

// sw.js awaits __rsaPool.ensure() before dispatching auth:init so the sync
// generateKeyPairSync below always has a key to consume.
export const __rsaPool = {
  ensure() {
    if (pooledJwk) return Promise.resolve();
    if (!pendingGeneration) {
      pendingGeneration = generateRsaJwk()
        .then((jwk) => {
          pooledJwk = jwk;
          pendingGeneration = null;
        })
        .catch((err) => {
          pendingGeneration = null;
          throw err;
        });
    }
    return pendingGeneration;
  },
};

// ------------------------------------------------------------ DER / PEM -----

function derLength(len) {
  if (len < 0x80) return [len];
  const bytes = [];
  let l = len;
  while (l > 0) {
    bytes.unshift(l & 0xff);
    l >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derTlv(tag, content) {
  return [tag, ...derLength(content.length), ...content];
}

function derInteger(unsignedBytes) {
  let b = Array.from(unsignedBytes);
  while (b.length > 1 && b[0] === 0x00 && !(b[1] & 0x80)) b.shift();
  if (b[0] & 0x80) b.unshift(0x00);
  return derTlv(0x02, b);
}

// SubjectPublicKeyInfo for a plain RSA key (rsaEncryption OID + NULL params) —
// the exact shape Discourse feeds to OpenSSL::PKey::RSA.new.
function encodeRsaSpkiDer(nBytes, eBytes) {
  const rsaOid = derTlv(0x06, [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  const algId = derTlv(0x30, [...rsaOid, ...derTlv(0x05, [])]);
  const pubKeySeq = derTlv(0x30, [...derInteger(nBytes), ...derInteger(eBytes)]);
  const bitString = derTlv(0x03, [0x00, ...pubKeySeq]);
  return new Uint8Array(derTlv(0x30, [...algId, ...bitString]));
}

function pemFromDer(label, derBytes) {
  const b64 = base64FromBytes(derBytes, false);
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// ----------------------------------------------------- node:crypto facades ---

export function generateKeyPairSync(type, options) {
  if (type !== "rsa") {
    throw new Error(`generateKeyPairSync: only "rsa" is supported in the browser runtime (got ${type})`);
  }
  if (!pooledJwk) {
    throw new Error("generateKeyPairSync: RSA key pool is empty; await __rsaPool.ensure() first");
  }
  const jwk = pooledJwk;
  pooledJwk = null;
  pendingGeneration = null;

  const nBytes = b64urlToBytes(jwk.n);
  const eBytes = b64urlToBytes(jwk.e);
  const spkiPem = pemFromDer("PUBLIC KEY", encodeRsaSpkiDer(nBytes, eBytes));

  // The core stores `private_key_pem` opaquely and hands it back to our own
  // privateDecrypt below, so a JSON JWK stands in for a PKCS#8 PEM.
  const privateKey = JSON.stringify({
    kty: "SY-RSA-JWK",
    n: jwk.n,
    e: jwk.e,
    d: jwk.d,
    p: jwk.p,
    q: jwk.q,
    dp: jwk.dp,
    dq: jwk.dq,
    qi: jwk.qi,
  });
  void options;
  return { publicKey: spkiPem, privateKey };
}

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function rsaCrtDecrypt(cipherBytes, jwk) {
  const p = bytesToBigInt(b64urlToBytes(jwk.p));
  const q = bytesToBigInt(b64urlToBytes(jwk.q));
  const dp = bytesToBigInt(b64urlToBytes(jwk.dp));
  const dq = bytesToBigInt(b64urlToBytes(jwk.dq));
  const qi = bytesToBigInt(b64urlToBytes(jwk.qi)); // q^{-1} mod p
  const n = bytesToBigInt(b64urlToBytes(jwk.n));
  const c = bytesToBigInt(cipherBytes);

  const m1 = modPow(c, dp, p);
  const m2 = modPow(c, dq, q);
  const h = (((m1 - m2) % p + p) % p * qi) % p;
  const m = m2 + h * q;
  return bigIntToBytes(m, (n.toString(2).length + 7) >> 3);
}

export function privateDecrypt(keyOptions, data) {
  const padding = keyOptions && keyOptions.padding;
  if (padding !== constants.RSA_PKCS1_PADDING) {
    throw new Error(`privateDecrypt: only RSA_PKCS1_PADDING is supported (got ${padding})`);
  }
  let jwk;
  try {
    jwk = JSON.parse(String(keyOptions && keyOptions.key));
  } catch {
    throw new Error("privateDecrypt: unsupported private key format in the browser runtime");
  }
  if (!jwk || jwk.kty !== "SY-RSA-JWK") {
    throw new Error("privateDecrypt: unsupported private key format in the browser runtime");
  }

  const em = rsaCrtDecrypt(new Uint8Array(ShimBuffer.from(data)), jwk);
  // PKCS#1 v1.5 type-2 block: 0x00 || 0x02 || PS (>= 8 nonzero bytes) || 0x00 || M
  if (em.length < 11 || em[0] !== 0x00 || em[1] !== 0x02) {
    throw new Error("privateDecrypt: PKCS#1 v1.5 padding check failed");
  }
  let sep = 2;
  while (sep < em.length && em[sep] !== 0x00) sep += 1;
  if (sep < 10 || sep >= em.length) {
    throw new Error("privateDecrypt: PKCS#1 v1.5 padding check failed");
  }
  return ShimBuffer.from(em.slice(sep + 1));
}
