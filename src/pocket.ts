'use strict';
// Construct Pocket: Zero-VPN Encrypted Mobile Thin-Client Bridge.
//
// Connects a standalone mobile PWA (`docs/pocket.html` on GitHub Pages or local HUD server)
// to this machine's live OpenCode server (`127.0.0.1:45278`) and Construct DB (`construct.db`)
// over zero-signup NIP-01 WebSocket relays (`wss://nos.lol`, `wss://relay.damus.io`, or custom).
//
// Cryptographic contract (100% compatible between Node `node:crypto` and Browser `crypto.subtle`):
//   - Master pairing seed `k`: 256-bit random secret (`crypto.randomBytes(32)`), carried only
//     in the QR/URL `#k=<base64url>` fragment (never sent in HTTP requests to GitHub Pages).
//   - Key derivation via `HKDF-SHA256` (32-byte zero salt):
//       1. `aeadKey`:       info = `construct-pocket-v1|aead`        (32 bytes, AES-256-GCM)
//       2. `stateRouteTag`: info = `construct-pocket-v1|route-state` (64 hex chars, PC -> Phone `#d` tag)
//       3. `cmdRouteTag`:   info = `construct-pocket-v1|route-cmd`   (64 hex chars, Phone -> PC `#d` tag)
//   - Payload encryption: `AES-256-GCM` with 96-bit random IV, 128-bit auth tag appended to
//     ciphertext (`ciphertext || tag`, matching W3C WebCrypto `SubtleCrypto`), and authenticated
//     `AAD` = `construct-pocket-v1|<dir>|<routeTag>`.
//   - Outer relay transport: NIP-01 kind `4420` signed with BIP-340 `secp256k1` Schnorr (`src/relay.js`).

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const relay = require('./relay.ts');
const crdt = require('./crdt.ts');

const DEFAULT_POCKET_FILE = path.join(os.homedir(), '.config', 'opencode', 'pocket.json');
const DEFAULT_HUD_TOKEN_FILE = path.join(os.homedir(), '.config', 'opencode', 'hud-token.txt');
const DEFAULT_PWA_BASE_URL = 'https://cmaujean.github.io/construct/pocket.html';
const MAX_POCKET_CLOCK_SKEW_MS = 60 * 1000;

function pocketFilePath() {
  if (process.env.CONSTRUCT_POCKET_FILE) return process.env.CONSTRUCT_POCKET_FILE;
  const scopedBase = process.env.CONSTRUCT_IDENTITY_FILE || process.env.CONSTRUCT_DB;
  if (scopedBase) return path.join(path.dirname(scopedBase), 'pocket.json');
  return DEFAULT_POCKET_FILE;
}

function hudTokenFilePath() {
  if (process.env.CONSTRUCT_HUD_TOKEN_FILE) return process.env.CONSTRUCT_HUD_TOKEN_FILE;
  const scopedBase = process.env.CONSTRUCT_IDENTITY_FILE || process.env.CONSTRUCT_DB;
  if (scopedBase) return path.join(path.dirname(scopedBase), 'hud-token.txt');
  return DEFAULT_HUD_TOKEN_FILE;
}

function loadOrCreateHudToken(file = hudTokenFilePath()) {
  if (fs.existsSync(file)) {
    try {
      const tok = fs.readFileSync(file, 'utf8').trim();
      if (tok.length >= 32) return tok;
    } catch (_) {}
  }
  const tok = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, tok + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (_) {}
  return tok;
}

function isAllowedLocalOrigin(originHeader) {
  if (!originHeader) return true; // Non-browser CLI / Node fetch
  const o = String(originHeader).trim().toLowerCase();
  if (o === 'null') return true; // Local file:// Review-Pane preview (still requires X-Construct-Token on mutations)
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o);
}

function derivePocketKeys(seedBase64Url) {
  const seedBytes = Buffer.from(String(seedBase64Url || '').trim(), 'base64url');
  if (seedBytes.length < 32) {
    throw new Error('Pocket pairing seed must be 256 bits (32 bytes)');
  }
  const zeroSalt = Buffer.alloc(32, 0);
  const aeadKey = Buffer.from(
    crypto.hkdfSync('sha256', seedBytes, zeroSalt, 'construct-pocket-v1|aead', 32)
  );
  const stateRouteTag = Buffer.from(
    crypto.hkdfSync('sha256', seedBytes, zeroSalt, 'construct-pocket-v1|route-state', 32)
  ).toString('hex');
  const cmdRouteTag = Buffer.from(
    crypto.hkdfSync('sha256', seedBytes, zeroSalt, 'construct-pocket-v1|route-cmd', 32)
  ).toString('hex');
  const nostrPrivKey = Buffer.from(
    crypto.hkdfSync('sha256', seedBytes, zeroSalt, 'construct-pocket-v1|nostr-priv', 32)
  );
  const nostrPubKey = relay.schnorrGetPublicKey(nostrPrivKey).toString('hex');
  return {
    seed: seedBytes.toString('base64url'),
    aeadKey,
    stateRouteTag,
    cmdRouteTag,
    nostrPrivKey,
    nostrPubKey,
  };
}

function buildPocketNostrEvent(keys, routeTag, envelope) {
  const pubkey = keys.nostrPubKey;
  const created_at = Math.floor(Date.now() / 1000);
  const kind = 4420;
  const tags = [['d', routeTag]];
  const content = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const idBuf = crypto.createHash('sha256').update(serialized, 'utf8').digest();
  const id = idBuf.toString('hex');
  const sig = relay.schnorrSign(idBuf, keys.nostrPrivKey).toString('hex');
  return { id, pubkey, created_at, kind, tags, content, sig };
}

function loadOrCreatePocketConfig(options = {}, file = pocketFilePath()) {
  if (!options.rotate && fs.existsSync(file)) {
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (existing && existing.seed && Buffer.from(existing.seed, 'base64url').length >= 32) {
        if (options.relays) {
          existing.relays = Array.isArray(options.relays)
            ? options.relays
            : String(options.relays)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
          fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        }
        const keys = derivePocketKeys(existing.seed);
        return { ...existing, ...keys };
      }
    } catch (_) {}
  }

  const seed = crypto.randomBytes(32).toString('base64url');
  const relays = options.relays
    ? Array.isArray(options.relays)
      ? options.relays
      : String(options.relays)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
    : [...crdt.DEFAULT_RELAYS];
  const cfg = {
    version: 1,
    seed,
    relays,
    pwaBaseUrl: options.pwaBaseUrl || DEFAULT_PWA_BASE_URL,
    lastAcceptedCmdTs: 0,
    created: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  const keys = derivePocketKeys(seed);
  return { ...cfg, ...keys };
}

function persistPocketLastCmdTs(_tsValue, _file = pocketFilePath()) {
  // Keep `lastAcceptedCmdTs` and `seenCmdIvs` in memory on `bridgeState` so multiple listeners
  // never race on `pocket.json` and reject each other's commands.
}

function persistPocketActiveSession(sessionId, dir = '', file = pocketFilePath()) {
  if (!sessionId || !fs.existsSync(file)) return;
  try {
    try {
      fs.chmodSync(file, 0o600);
    } catch (_) {}
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.activeSessionId = String(sessionId);
    if (dir) raw.activeDir = String(dir);
    raw.lastAcceptedCmdTs = 0;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (_) {}
}

function buildPocketPairingUrl(cfg, options = {}) {
  const baseUrl = options.baseUrl || cfg.pwaBaseUrl || DEFAULT_PWA_BASE_URL;
  const relays = Array.isArray(cfg.relays) ? cfg.relays : [...crdt.DEFAULT_RELAYS];
  const isDefaultRelays =
    relays.length === crdt.DEFAULT_RELAYS.length &&
    relays.every((r, i) => r === crdt.DEFAULT_RELAYS[i]);
  const relayParam = !isDefaultRelays && relays.length ? `&r=${encodeURIComponent(relays.join(','))}` : '';
  return `${baseUrl}#k=${cfg.seed}${relayParam}`;
}

// Seal a JSON payload with AES-256-GCM (WebCrypto-compatible `ciphertext || 16-byte tag`).
function sealPocketEnvelope(keys, direction, payloadObj) {
  const routeTag = direction === 'pc2phone' ? keys.stateRouteTag : keys.cmdRouteTag;
  const aadStr = `construct-pocket-v1|${direction}|${routeTag}`;
  const aad = Buffer.from(aadStr, 'utf8');
  const iv = crypto.randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(payloadObj), 'utf8');

  const cipher = crypto.createCipheriv('aes-256-gcm', keys.aeadKey, iv, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ctWithTag = Buffer.concat([ciphertext, tag]);

  return {
    v: 1,
    dir: direction,
    iv: iv.toString('base64'),
    ct: ctWithTag.toString('base64'),
    ts: Date.now(),
  };
}

function openPocketEnvelope(keys, expectedDirection, envelope) {
  if (!envelope || envelope.v !== 1 || envelope.dir !== expectedDirection) {
    throw new Error(`Invalid Pocket envelope direction (expected ${expectedDirection})`);
  }
  const routeTag = expectedDirection === 'pc2phone' ? keys.stateRouteTag : keys.cmdRouteTag;
  const aadStr = `construct-pocket-v1|${expectedDirection}|${routeTag}`;
  const aad = Buffer.from(aadStr, 'utf8');
  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const ctWithTag = Buffer.from(String(envelope.ct || ''), 'base64');
  if (iv.length !== 12 || ctWithTag.length < 16) {
    throw new Error('Malformed Pocket AES-GCM IV or ciphertext');
  }
  const ciphertext = ctWithTag.subarray(0, ctWithTag.length - 16);
  const tag = ctWithTag.subarray(ctWithTag.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', keys.aeadKey, iv, { authTagLength: 16 });
  decipher.setAAD(aad, { plaintextLength: ciphertext.length });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

// --- Zero-Dependency ISO/IEC 18004 QR Code Generator (Byte Mode, ECC Level L, Versions 1..10) ---
const QR_VERSIONS = Object.freeze([
  null,
  { v: 1, size: 21, totalCodewords: 26, ecCodewordsPerBlock: 7, blocks1: 1, data1: 19, blocks2: 0, data2: 0, align: [] },
  { v: 2, size: 25, totalCodewords: 44, ecCodewordsPerBlock: 10, blocks1: 1, data1: 34, blocks2: 0, data2: 0, align: [6, 18] },
  { v: 3, size: 29, totalCodewords: 70, ecCodewordsPerBlock: 15, blocks1: 1, data1: 55, blocks2: 0, data2: 0, align: [6, 22] },
  { v: 4, size: 33, totalCodewords: 100, ecCodewordsPerBlock: 20, blocks1: 1, data1: 80, blocks2: 0, data2: 0, align: [6, 26] },
  { v: 5, size: 37, totalCodewords: 134, ecCodewordsPerBlock: 26, blocks1: 1, data1: 108, blocks2: 0, data2: 0, align: [6, 30] },
  { v: 6, size: 41, totalCodewords: 172, ecCodewordsPerBlock: 18, blocks1: 2, data1: 68, blocks2: 0, data2: 0, align: [6, 34] },
  { v: 7, size: 45, totalCodewords: 196, ecCodewordsPerBlock: 20, blocks1: 2, data1: 78, blocks2: 0, data2: 0, align: [6, 22, 38] },
  { v: 8, size: 49, totalCodewords: 242, ecCodewordsPerBlock: 24, blocks1: 2, data1: 97, blocks2: 0, data2: 0, align: [6, 24, 42] },
  { v: 9, size: 53, totalCodewords: 292, ecCodewordsPerBlock: 30, blocks1: 2, data1: 116, blocks2: 0, data2: 0, align: [6, 26, 46] },
  { v: 10, size: 57, totalCodewords: 346, ecCodewordsPerBlock: 18, blocks1: 2, data1: 68, blocks2: 2, data2: 69, align: [6, 28, 50] },
]);

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf256() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(dataBytes, degree) {
  const gen = rsGeneratorPoly(degree);
  const rem = new Uint8Array(degree);
  for (let i = 0; i < dataBytes.length; i++) {
    const factor = dataBytes[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < degree; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

function generateQrMatrix(text) {
  const bytes = Buffer.from(String(text || ''), 'utf8');
  let spec = null;
  for (let v = 1; v < QR_VERSIONS.length; v++) {
    const candidate = QR_VERSIONS[v];
    const totalDataCap = candidate.blocks1 * candidate.data1 + candidate.blocks2 * candidate.data2;
    const headerBytes = v <= 9 ? 2 : 3;
    if (bytes.length + headerBytes <= totalDataCap) {
      spec = candidate;
      break;
    }
  }
  if (!spec) {
    throw new Error(`QR payload too long (${bytes.length} bytes; max 271 bytes)`);
  }

  const totalDataCodewords = spec.blocks1 * spec.data1 + spec.blocks2 * spec.data2;
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  // Byte mode indicator (0100) + character count
  pushBits(0b0100, 4);
  pushBits(bytes.length, spec.v <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  // Terminator (up to 4 zero bits) + byte boundary padding
  const maxBits = totalDataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCodewords = new Uint8Array(totalDataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let byteVal = 0;
    for (let b = 0; b < 8; b++) byteVal = (byteVal << 1) | bits[i * 8 + b];
    dataCodewords[i] = byteVal;
  }
  const padBytes = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < totalDataCodewords; i++, p ^= 1) {
    dataCodewords[i] = padBytes[p];
  }

  // Split into blocks and compute Reed-Solomon EC codewords
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < spec.blocks1; i++) {
    const blk = dataCodewords.subarray(offset, offset + spec.data1);
    offset += spec.data1;
    dataBlocks.push(blk);
    ecBlocks.push(rsRemainder(blk, spec.ecCodewordsPerBlock));
  }
  for (let i = 0; i < spec.blocks2; i++) {
    const blk = dataCodewords.subarray(offset, offset + spec.data2);
    offset += spec.data2;
    dataBlocks.push(blk);
    ecBlocks.push(rsRemainder(blk, spec.ecCodewordsPerBlock));
  }

  const finalCodewords = [];
  const maxDataLen = Math.max(spec.data1, spec.data2);
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) finalCodewords.push(blk[i]);
    }
  }
  for (let i = 0; i < spec.ecCodewordsPerBlock; i++) {
    for (const ec of ecBlocks) {
      finalCodewords.push(ec[i]);
    }
  }

  const size = spec.size;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunctionModule = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    isFunction[r][c] = 1;
  };

  // Finder patterns + separators
  const drawFinder = (topR, leftC) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = topR + dr;
        const c = leftC + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(r, c, inOuter && (onBorder || inCore));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const alignCoords = spec.align;
  for (let i = 0; i < alignCoords.length; i++) {
    for (let j = 0; j < alignCoords.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === alignCoords.length - 1) ||
        (i === alignCoords.length - 1 && j === 0)
      ) {
        continue;
      }
      const cr = alignCoords[i];
      const cc = alignCoords[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunctionModule(cr + dr, cc + dc, dark);
        }
      }
    }
  }

  // Reserve format info + dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      if (!isFunction[8][i]) setFunctionModule(8, i, false);
      if (!isFunction[i][8]) setFunctionModule(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunction[8][size - 1 - i]) setFunctionModule(8, size - 1 - i, false);
    if (!isFunction[size - 1 - i][8]) setFunctionModule(size - 1 - i, 8, false);
  }
  setFunctionModule(size - 8, 8, true);

  // Version info (for versions >= 7)
  if (spec.v >= 7) {
    let rem = spec.v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vBits = (spec.v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = Boolean((vBits >>> i) & 1);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, dark);
      setFunctionModule(b, a, dark);
    }
  }

  // Place data & EC bits in zigzag columns
  let bitIdx = 0;
  const totalBits = finalCodewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunction[r][c]) {
          let dark = false;
          if (bitIdx < totalBits) {
            const cw = finalCodewords[bitIdx >>> 3];
            dark = Boolean((cw >>> (7 - (bitIdx & 7))) & 1);
            bitIdx++;
          }
          // Apply mask 0: `(r + c) % 2 === 0`
          if ((r + c) % 2 === 0) dark = !dark;
          modules[r][c] = dark ? 1 : 0;
        }
      }
    }
    upward = !upward;
  }

  // Write Format Information for ECC Level L (01) + Mask 0 (000) -> ISO/IEC 18004 standard 15-bit sequence = 0x77c4
  // Bit 14 (MSB) sits at (8,0) and (size-1,8); Bit 0 (LSB) sits at (0,8) and (8,size-1).
  const fmtBits = 0x77c4;
  for (let i = 0; i <= 5; i++) setFunctionModule(8, i, Boolean((fmtBits >>> (14 - i)) & 1));
  setFunctionModule(8, 7, Boolean((fmtBits >>> 8) & 1));
  setFunctionModule(8, 8, Boolean((fmtBits >>> 7) & 1));
  setFunctionModule(7, 8, Boolean((fmtBits >>> 6) & 1));
  for (let i = 9; i < 15; i++) setFunctionModule(14 - i, 8, Boolean((fmtBits >>> (14 - i)) & 1));

  for (let i = 0; i < 7; i++) setFunctionModule(size - 1 - i, 8, Boolean((fmtBits >>> (14 - i)) & 1));
  for (let i = 7; i < 15; i++) setFunctionModule(8, size - 15 + i, Boolean((fmtBits >>> (14 - i)) & 1));

  return { size, modules, version: spec.v };
}

function renderQrCodeSvg(text, { margin = 3, scale = 5 } = {}) {
  const { size, modules } = generateQrMatrix(text);
  const total = size + margin * 2;
  const px = total * scale;
  let pathData = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        pathData += `M${c + margin},${r + margin}h1v1h-1z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${pathData}" fill="#000000"/></svg>`;
}

function renderQrCodeTerminal(text, { margin = 2 } = {}) {
  const { size, modules } = generateQrMatrix(text);
  const total = size + margin * 2;
  const getMod = (r, c) => {
    const mr = r - margin;
    const mc = c - margin;
    if (mr < 0 || mr >= size || mc < 0 || mc >= size) return 0; // white quiet zone
    return modules[mr][mc] ? 1 : 0;
  };
  const lines = [];
  for (let r = 0; r < total; r += 2) {
    let rowStr = '  ';
    for (let c = 0; c < total; c++) {
      const topDark = getMod(r, c) === 1;
      const botDark = r + 1 < total ? getMod(r + 1, c) === 1 : false;
      if (topDark && botDark) rowStr += ' ';
      else if (topDark && !botDark) rowStr += '▄';
      else if (!topDark && botDark) rowStr += '▀';
      else rowStr += '█';
    }
    lines.push(rowStr);
  }
  return lines.join('\n');
}

// --- OpenCode Server & Construct Snapshot Collector ---
function resolveOpenCodeServiceConfig() {
  const candidates = [];
  if (process.env.XDG_STATE_HOME) {
    candidates.push(path.join(process.env.XDG_STATE_HOME, 'opencode', 'service.json'));
  }
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  if (home) {
    candidates.push(path.join(home, '.local', 'state', 'opencode', 'service.json'));
  }
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (parsed?.url && parsed?.password) return parsed;
      } catch (_) {}
    }
  }
  return null;
}

// Install a process-wide fetch guard so any legacy/zombie `startPocketBridge` timers from earlier
// Location evictions (which call `/api/session` without `X-Construct-Pocket: v2`) receive a BigInt
// sentinel, abort inside `broadcastSnapshot` before `ws.send`, and never broadcast stale sessions.
if (typeof globalThis.fetch === 'function') {
  if (!globalThis.__constructPocketFetchRaw) {
    globalThis.__constructPocketFetchRaw = globalThis.fetch.bind(globalThis);
  }
  globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input?.url || '';
    const hdrs = init?.headers || {};
    const pocketVer = hdrs['X-Construct-Pocket'] || hdrs['x-construct-pocket'];
    if (urlStr.endsWith('/api/session') && pocketVer !== 'v2') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 1n, title: 'x' }] }),
      };
    }
    if (pocketVer === 'v2') {
      const cleanHeaders = { ...hdrs };
      delete cleanHeaders['X-Construct-Pocket'];
      delete cleanHeaders['x-construct-pocket'];
      return globalThis.__constructPocketFetchRaw(input, { ...init, headers: cleanHeaders });
    }
    return globalThis.__constructPocketFetchRaw(input, init);
  };
}

async function fetchOpenCodeApi(endpointPath, { method = 'GET', body = undefined } = {}) {
  const svc = resolveOpenCodeServiceConfig();
  if (!svc?.url || !svc?.password || typeof fetch !== 'function') return null;
  const auth = 'Basic ' + Buffer.from(`opencode:${svc.password}`).toString('base64');
  const url = `${String(svc.url).replace(/\/+$/, '')}${endpointPath}`;
  const headers = { Authorization: auth, 'X-Construct-Pocket': 'v2' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 204) return { ok: true };
  if (!resp.ok) return null;
  return await resp.json();
}

function summarizeOpenCodeMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const created = msg.time?.created || 0;
  if (msg.type === 'user') {
    const rawText = String(msg.text || '');
    // Strip Construct slash-command wrapper boilerplate if present
    return {
      id: msg.id,
      role: 'user',
      text: rawText.length > 600 ? rawText.slice(0, 600) + '...' : rawText,
      created,
    };
  }
  if (msg.type === 'shell') {
    return {
      id: msg.id,
      role: 'shell',
      command: String(msg.command || '').slice(0, 160),
      status: String(msg.status || 'exited'),
      output: String(msg.output?.output || '').slice(0, 800),
      created,
    };
  }
  if (msg.type === 'assistant') {
    const textParts = [];
    const tools = [];
    for (const part of Array.isArray(msg.content) ? msg.content : []) {
      if (part.type === 'text' && part.text) textParts.push(part.text);
      else if (part.type === 'tool') {
        const st = part.state?.status || 'completed';
        let preview = '';
        if (Array.isArray(part.state?.content)) {
          const firstText = part.state.content.find((c) => c && typeof c.text === 'string');
          if (firstText) preview = firstText.text.slice(0, 160);
        }
        tools.push({
          id: part.id,
          name: part.name,
          status: st,
          preview,
        });
      }
    }
    const joinedText = textParts.join('\n\n');
    return {
      id: msg.id,
      role: 'assistant',
      text: joinedText.length > 1400 ? joinedText.slice(0, 1400) + '\n...(truncated for mobile relay)...' : joinedText,
      tools: tools.slice(-6),
      streaming: !msg.time?.completed && !msg.finish,
      created,
    };
  }
  return null;
}

function compactHudForPocket(rawHud) {
  if (!rawHud || typeof rawHud !== 'object') return null;
  return {
    project: rawHud.project || 'workspace',
    pack: rawHud.pack || 'sprawl',
    emblem: rawHud.emblem || '🦾',
    romName: rawHud.romName || 'crew',
    handle: rawHud.handle || '',
    operatorId: rawHud.operatorId || '',
    roster: Array.isArray(rawHud.roster) ? rawHud.roster : [],
    pill: rawHud.pill || '',
    tabBadge: rawHud.tabBadge || '',
    state: String(rawHud.state || '').slice(0, 500),
    next: String(rawHud.next || '').slice(0, 300),
    headSeq: rawHud.headSeq || 0,
    totalFrames: rawHud.totalFrames || 0,
    openCount: rawHud.openCount || 0,
    gotchaCount: rawHud.gotchaCount || 0,
    inboxPendingCount: rawHud.inboxPendingCount || 0,
    openThreads: (Array.isArray(rawHud.openThreads) ? rawHud.openThreads : []).slice(0, 10).map((f) => ({
      seq: f.seq,
      ts: f.ts,
      summary: String(f.summary || '').slice(0, 160),
    })),
    recentTape: (Array.isArray(rawHud.recentTape) ? rawHud.recentTape : []).slice(-10).map((f) => ({
      seq: f.seq,
      ts: f.ts,
      kind: f.kind,
      summary: String(f.summary || '').slice(0, 160),
    })),
    gotchas: (Array.isArray(rawHud.gotchas) ? rawHud.gotchas : []).slice(0, 10).map((g) => ({
      id: g.id,
      title: String(g.title || '').slice(0, 140),
      status: g.status,
      fix: String(g.fix || '').slice(0, 160),
    })),
    comms: (Array.isArray(rawHud.comms) ? rawHud.comms : []).slice(0, 12).map((m) => ({
      id: m.id,
      status: m.status,
      project: m.project || 'global',
      created: m.created || '',
      fromUser: m.fromUser,
      fromRom: m.fromRom,
      fromGlyph: m.fromGlyph || '📬',
      toUser: m.toUser,
      replyRom: m.replyRom,
      replyGlyph: m.replyGlyph || '📬',
      body: String(m.body || '').slice(0, 2200),
      replyBody: m.replyBody ? String(m.replyBody).slice(0, 1200) : '',
    })),
    lastCliOutput: rawHud.lastCliOutput
      ? {
          cmd: rawHud.lastCliOutput.cmd || '',
          output: String(rawHud.lastCliOutput.output || '').slice(0, 2600),
          isError: Boolean(rawHud.lastCliOutput.isError),
          ts: rawHud.lastCliOutput.ts || '',
        }
      : null,
  };
}

function normPocketDir(d) {
  return String(d || '')
    .replace(/\\\\/g, '/')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function detectBootedOpenCodeDirectories() {
  const booted = new Set();
  if (process.env.CONSTRUCT_DB) return booted;
  try {
    const logFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'log', 'opencode.log');
    if (!fs.existsSync(logFile)) return booted;
    const stat = fs.statSync(logFile);
    const readSize = Math.min(stat.size, 4 * 1024 * 1024);
    const fd = fs.openSync(logFile, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/);
    let runId = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/\brun=([a-f0-9]+)\b/);
      if (m) {
        runId = m[1];
        break;
      }
    }
    if (!runId) return booted;
    for (const line of lines) {
      if (!line.includes(`run=${runId}`)) continue;
      if (line.includes('message="location services booted"')) {
        const dm = line.match(/\bdirectory="([^"]+)"/);
        if (dm) booted.add(normPocketDir(dm[1]));
      } else if (line.includes('message="spawning process"')) {
        const cm = line.match(/\bcwd="([^"]+)"/);
        if (cm) booted.add(normPocketDir(cm[1]));
      }
    }
  } catch (_) {}
  return booted;
}

function filterOpenSessionsForPocket(rawSessions, activeSessionId = '') {
  if (!Array.isArray(rawSessions)) return [];
  const bootedDirs = detectBootedOpenCodeDirectories();
  const rootSessions = rawSessions.filter((s) => !s.parentID || s.id === activeSessionId);

  // Sort by most recent activity (`viewed` or `updated`) so the active tab in each directory comes first
  const sorted = [...rootSessions].sort((a, b) => {
    const ta = Math.max(Number(a.time?.viewed || 0), Number(a.time?.updated || 0));
    const tb = Math.max(Number(b.time?.viewed || 0), Number(b.time?.updated || 0));
    return tb - ta;
  });

  const seenDirs = new Set();
  const out = [];
  for (const s of sorted) {
    const rawDir = s.location?.directory || s.directory || '';
    const nDir = normPocketDir(rawDir);
    const isExplicitActive = Boolean(activeSessionId && s.id === activeSessionId);
    if (!isExplicitActive) {
      if (bootedDirs.size > 0 && nDir && !bootedDirs.has(nDir)) {
        continue;
      }
      if (nDir && seenDirs.has(nDir)) {
        continue;
      }
    }
    if (nDir) seenDirs.add(nDir);
    out.push({
      id: s.id,
      title: s.title || s.id.slice(0, 10),
      dir: rawDir,
      updated: s.time?.updated || 0,
      idle: s.time?.idle || 0,
    });
    if (out.length >= 12) break;
  }
  return out;
}

async function collectPocketSnapshot(store, options = {}) {
  let sessions = [];
  let savedCfg = null;
  try {
    savedCfg = loadOrCreatePocketConfig();
  } catch (_) {}
  let activeSessionId = String(options.sessionId || savedCfg?.activeSessionId || '');
  let messages = [];
  let pendingForms = [];
  let pendingPermissions = [];
  let sessionBusy = false;

  try {
    const sessJson = await fetchOpenCodeApi('/api/session');
    if (Array.isArray(sessJson?.data)) {
      sessions = filterOpenSessionsForPocket(sessJson.data, activeSessionId);
      if (activeSessionId && !sessions.some((s) => s.id === activeSessionId) && sessions.length > 0) {
        activeSessionId = sessions[0].id;
      }
      if (!activeSessionId && sessions.length > 0) {
        activeSessionId = sessions[0].id;
      }
    }
  } catch (_) {}

  let activeDir = String(options.dir || savedCfg?.activeDir || '');
  if (activeSessionId) {
    const matchedSess = sessions.find((s) => s.id === activeSessionId);
    if (matchedSess && matchedSess.dir) {
      activeDir = matchedSess.dir;
    }
    if (matchedSess && matchedSess.updated > (matchedSess.idle || 0) + 1500) {
      sessionBusy = true;
    }
    try {
      const [msgJson, formJson, permJson] = await Promise.all([
        fetchOpenCodeApi(`/api/session/${encodeURIComponent(activeSessionId)}/message`),
        fetchOpenCodeApi(`/api/session/${encodeURIComponent(activeSessionId)}/form`),
        fetchOpenCodeApi(`/api/session/${encodeURIComponent(activeSessionId)}/permission`),
      ]);
      if (Array.isArray(msgJson?.data)) {
        // `/api/session/{id}/message` returns newest-first; take top 10 and reverse to chronological
        messages = msgJson.data
          .slice(0, 10)
          .reverse()
          .map(summarizeOpenCodeMessage)
          .filter(Boolean);
        if (messages.some((m) => m.streaming)) sessionBusy = true;
      }
      if (Array.isArray(formJson?.data)) {
        pendingForms = formJson.data;
      }
      if (Array.isArray(permJson?.data)) {
        pendingPermissions = permJson.data;
      }
    } catch (_) {}
  }

  let hud = null;
  try {
    const fullHud = store.getHudSnapshot({
      sessionId: activeSessionId,
      dir: activeDir,
      project: options.project || '',
    });
    hud = compactHudForPocket(fullHud);
  } catch (_) {}

  return {
    v: 1,
    type: 'snapshot',
    ts: Date.now(),
    activeSessionId,
    sessionBusy,
    sessions,
    messages,
    pendingForms,
    pendingPermissions,
    hud,
  };
}

async function executePocketCommand(store, mcp, cmdPayload = {}, bridgeState = {}) {
  const action = String(cmdPayload.action || '').trim().toLowerCase();
  const targetSessionId = String(cmdPayload.sessionId || bridgeState.activeSessionId || '');
  const targetDir = String(cmdPayload.dir || bridgeState.activeDir || process.cwd());

  if (action === 'select-session' && cmdPayload.sessionId) {
    bridgeState.activeSessionId = String(cmdPayload.sessionId);
    if (cmdPayload.dir) bridgeState.activeDir = String(cmdPayload.dir);
    persistPocketActiveSession(bridgeState.activeSessionId, bridgeState.activeDir);
    return { ok: true, action };
  }

  if (action === 'new-session') {
    const created = await fetchOpenCodeApi('/api/session', {
      method: 'POST',
      body: { title: String(cmdPayload.title || 'Mobile Session') },
    });
    if (created?.data?.id) {
      bridgeState.activeSessionId = created.data.id;
      persistPocketActiveSession(bridgeState.activeSessionId, bridgeState.activeDir);
    }
    return { ok: Boolean(created?.data?.id), action, sessionId: created?.data?.id || '' };
  }

  if (action === 'prompt' && targetSessionId && cmdPayload.text) {
    const delivery = cmdPayload.delivery === 'queue' ? 'queue' : 'steer';
    await fetchOpenCodeApi(`/api/session/${encodeURIComponent(targetSessionId)}/prompt`, {
      method: 'POST',
      body: {
        text: String(cmdPayload.text),
        delivery,
      },
    });
    return { ok: true, action };
  }

  if (action === 'interrupt' && targetSessionId) {
    await fetchOpenCodeApi(`/api/session/${encodeURIComponent(targetSessionId)}/interrupt`, {
      method: 'POST',
      body: { continue: false },
    });
    return { ok: true, action };
  }

  if (action === 'reply-form' && targetSessionId && cmdPayload.formId) {
    await fetchOpenCodeApi(
      `/api/session/${encodeURIComponent(targetSessionId)}/form/${encodeURIComponent(cmdPayload.formId)}/reply`,
      {
        method: 'POST',
        body: { answers: cmdPayload.answers || {} },
      }
    );
    return { ok: true, action };
  }

  if (action === 'reply-permission' && targetSessionId && cmdPayload.requestId) {
    const decision = ['once', 'always', 'reject'].includes(cmdPayload.decision) ? cmdPayload.decision : 'reject';
    await fetchOpenCodeApi(
      `/api/session/${encodeURIComponent(targetSessionId)}/permission/${encodeURIComponent(cmdPayload.requestId)}/reply`,
      {
        method: 'POST',
        body: { decision },
      }
    );
    return { ok: true, action };
  }

  if (action === 'construct-cli' && cmdPayload.args) {
    const res = mcp.executeConstructSlashCommand(String(cmdPayload.args), {
      sessionId: targetSessionId,
      cwd: targetDir,
    });
    return { ok: !res.isError, action, cli: res };
  }

  if (action === 'seen-msg' && cmdPayload.id) {
    store.seenMessage(cmdPayload.id);
    if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1') {
      void store.syncProject('comms').catch(() => {});
    }
    return { ok: true, action };
  }

  if (action === 'ack-msg' && cmdPayload.id) {
    store.ackMessage(cmdPayload.id);
    if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1') {
      void store.syncProject('comms').catch(() => {});
    }
    return { ok: true, action };
  }

  if (action === 'hide-msg' && cmdPayload.id) {
    store.hideMessage(cmdPayload.id);
    return { ok: true, action };
  }

  if (action === 'reply-msg' && cmdPayload.id && cmdPayload.body) {
    store.replyMessage(cmdPayload.id, String(cmdPayload.body), {
      via: cmdPayload.via || '',
      sessionId: targetSessionId,
    });
    return { ok: true, action };
  }

  if (action === 'send-msg' && cmdPayload.to && cmdPayload.body) {
    store.sendMessage({
      to: String(cmdPayload.to),
      via: cmdPayload.via || '',
      body: String(cmdPayload.body),
      sessionId: targetSessionId,
    });
    return { ok: true, action };
  }

  return { ok: true, action: action || 'ping' };
}

// --- Persistent Multi-Relay WebSocket Bridge Daemon ---
function validateAndUnwrapIncomingCmdEvent(ev, currentCfg, bridgeState) {
  if (!ev || !ev.id || typeof ev.content !== 'string') {
    throw new Error('Malformed relay event');
  }
  if (ev.pubkey !== currentCfg.nostrPubKey) {
    throw new Error('Rejected relay event: sender pubkey does not match secret-derived Pocket pubkey');
  }
  const rawEnvelope = JSON.parse(Buffer.from(ev.content, 'base64').toString('utf8'));
  const ivKey = String(rawEnvelope?.iv || '');
  if (!ivKey || bridgeState.seenCmdIvs?.has(ivKey)) {
    throw new Error('Rejected relay event: duplicate or replayed AES-GCM IV');
  }
  const cmdPayload = openPocketEnvelope(currentCfg, 'phone2pc', rawEnvelope);
  const envTs = Number(rawEnvelope.ts || 0);
  if (!envTs || Math.abs(Date.now() - envTs) > MAX_POCKET_CLOCK_SKEW_MS) {
    throw new Error('Rejected relay event: timestamp outside 60s replay window');
  }
  const minTs = Number(bridgeState.lastAcceptedCmdTs || 0);
  if (envTs <= minTs) {
    throw new Error('Rejected relay event: non-monotonic command timestamp');
  }
  if (bridgeState.seenCmdIvs) {
    bridgeState.seenCmdIvs.add(ivKey);
    while (bridgeState.seenCmdIvs.size > 500) {
      const oldest = bridgeState.seenCmdIvs.values().next().value;
      bridgeState.seenCmdIvs.delete(oldest);
    }
  }
  bridgeState.lastAcceptedCmdTs = envTs;
  persistPocketLastCmdTs(envTs);
  return cmdPayload;
}

function startPocketBridge(store, mcp, options = {}) {
  if (globalThis.__constructPocketBridge && typeof globalThis.__constructPocketBridge.stop === 'function') {
    try {
      globalThis.__constructPocketBridge.stop();
    } catch (_) {}
  }
  const cfg = loadOrCreatePocketConfig(options);
  const bridgeState = {
    activeSessionId: options.sessionId || cfg.activeSessionId || '',
    activeDir: options.dir || cfg.activeDir || process.cwd(),
    seenCmdIvs: new Set(),
    lastAcceptedCmdTs: 0,
    sockets: new Map(),
    stopped: false,
    lastSnapshotHash: '',
  };

  const broadcastSnapshot = async (force = false) => {
    if (bridgeState.stopped) return null;
    try {
      const currentCfg = loadOrCreatePocketConfig();
      if (currentCfg.activeSessionId && currentCfg.activeSessionId !== bridgeState.activeSessionId) {
        bridgeState.activeSessionId = currentCfg.activeSessionId;
      }
      if (currentCfg.activeDir && currentCfg.activeDir !== bridgeState.activeDir) {
        bridgeState.activeDir = currentCfg.activeDir;
      }
      const snap = await collectPocketSnapshot(store, {
        sessionId: bridgeState.activeSessionId,
        dir: bridgeState.activeDir,
      });
      if (snap.activeSessionId && !bridgeState.activeSessionId) {
        bridgeState.activeSessionId = snap.activeSessionId;
      }
      const sigObj = {
        sid: snap.activeSessionId,
        busy: snap.sessionBusy,
        lastMsg: snap.messages[snap.messages.length - 1]?.id || '',
        lastMsgLen: snap.messages[snap.messages.length - 1]?.text?.length || 0,
        forms: snap.pendingForms.length,
        perms: snap.pendingPermissions.length,
        pill: snap.hud?.pill || '',
        cliTs: snap.hud?.lastCliOutput?.ts || '',
      };
      const sigStr = JSON.stringify(sigObj);
      if (!force && sigStr === bridgeState.lastSnapshotHash) return snap;
      bridgeState.lastSnapshotHash = sigStr;

      const sealed = sealPocketEnvelope(currentCfg, 'pc2phone', snap);
      const event = buildPocketNostrEvent(currentCfg, currentCfg.stateRouteTag, sealed);
      const msgStr = JSON.stringify(['EVENT', event]);
      for (const ws of bridgeState.sockets.values()) {
        if (ws && ws.readyState === 1) {
          try {
            ws.send(msgStr);
          } catch (_) {}
        }
      }
      return snap;
    } catch (_) {
      return null;
    }
  };

  const handleIncomingRelayEvent = async (ev) => {
    try {
      const currentCfg = loadOrCreatePocketConfig();
      const cmdPayload = validateAndUnwrapIncomingCmdEvent(ev, currentCfg, bridgeState);
      await executePocketCommand(store, mcp, cmdPayload, bridgeState);
      await broadcastSnapshot(true);
    } catch (_) {}
  };

  const connectRelay = (url) => {
    if (bridgeState.stopped) return;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (_) {
      return;
    }
    bridgeState.sockets.set(url, ws);
    const subId = 'p_' + crypto.randomBytes(4).toString('hex');

    ws.onopen = () => {
      try {
        const currentCfg = loadOrCreatePocketConfig();
        const sinceSec = Math.floor(Date.now() / 1000) - 30;
        ws.send(
          JSON.stringify([
            'REQ',
            subId,
            { kinds: [4420], authors: [currentCfg.nostrPubKey], '#d': [currentCfg.cmdRouteTag], since: sinceSec },
          ])
        );
        void broadcastSnapshot(true);
      } catch (_) {}
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(String(msg.data));
        if (Array.isArray(data) && data[0] === 'EVENT' && data[2]) {
          void handleIncomingRelayEvent(data[2]);
        }
      } catch (_) {}
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      if (bridgeState.sockets.get(url) === ws) {
        bridgeState.sockets.delete(url);
        if (!bridgeState.stopped) {
          setTimeout(() => {
            if (!bridgeState.stopped && !bridgeState.sockets.has(url)) {
              connectRelay(url);
            }
          }, 5000);
        }
      }
    };
  };

  const reconnectAllRelays = () => {
    if (bridgeState.stopped) return;
    const currentCfg = loadOrCreatePocketConfig();
    for (const [u, oldWs] of bridgeState.sockets.entries()) {
      bridgeState.sockets.delete(u);
      try {
        oldWs.close();
      } catch (_) {}
    }
    for (const rUrl of currentCfg.relays) {
      connectRelay(rUrl);
    }
  };

  for (const rUrl of cfg.relays) {
    connectRelay(rUrl);
  }

  const pollMs = Number(options.pollIntervalMs || 6000);
  const sleepJumpThresholdMs = Math.max(pollMs * 3, 20000);
  let lastTickMs = Date.now();
  let lastForcedBroadcastMs = Date.now();

  const checkSleepWakeAndBroadcast = async (now = Date.now()) => {
    if (bridgeState.stopped) return;
    const elapsed = now - lastTickMs;
    lastTickMs = now;
    if (elapsed > sleepJumpThresholdMs) {
      bridgeState.wakeCount = (bridgeState.wakeCount || 0) + 1;
      reconnectAllRelays();
      lastForcedBroadcastMs = now;
      return;
    }
    const currentCfg = loadOrCreatePocketConfig();
    for (const rUrl of currentCfg.relays) {
      const existing = bridgeState.sockets.get(rUrl);
      if (!existing || existing.readyState > 1) {
        connectRelay(rUrl);
      }
    }
    const forceKeepalive = now - lastForcedBroadcastMs >= 60000;
    if (forceKeepalive) lastForcedBroadcastMs = now;
    await broadcastSnapshot(forceKeepalive);
  };

  const pollTimer = setInterval(() => {
    void checkSleepWakeAndBroadcast(Date.now());
  }, pollMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  const controller = {
    cfg,
    bridgeState,
    broadcastSnapshot,
    reconnectAllRelays,
    checkSleepWakeAndBroadcast,
    stop() {
      bridgeState.stopped = true;
      clearInterval(pollTimer);
      for (const ws of bridgeState.sockets.values()) {
        try {
          ws.close();
        } catch (_) {}
      }
      bridgeState.sockets.clear();
      if (globalThis.__constructPocketBridge === controller) {
        globalThis.__constructPocketBridge = null;
      }
    },
  };
  globalThis.__constructPocketBridge = controller;
  return controller;
}

module.exports = {
  DEFAULT_POCKET_FILE,
  DEFAULT_HUD_TOKEN_FILE,
  DEFAULT_PWA_BASE_URL,
  MAX_POCKET_CLOCK_SKEW_MS,
  pocketFilePath,
  hudTokenFilePath,
  loadOrCreateHudToken,
  isAllowedLocalOrigin,
  derivePocketKeys,
  buildPocketNostrEvent,
  loadOrCreatePocketConfig,
  persistPocketLastCmdTs,
  persistPocketActiveSession,
  filterOpenSessionsForPocket,
  buildPocketPairingUrl,
  sealPocketEnvelope,
  openPocketEnvelope,
  validateAndUnwrapIncomingCmdEvent,
  generateQrMatrix,
  renderQrCodeSvg,
  renderQrCodeTerminal,
  collectPocketSnapshot,
  executePocketCommand,
  startPocketBridge,
};
