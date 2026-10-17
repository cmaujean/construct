// Zero-signup, zero-knowledge store-and-forward WebSocket relay transport.
//
// How it stays 100% plug-and-play with zero account creation:
//   - Any standard NIP-01 WebSocket relay (e.g. `wss://nos.lol`, `wss://relay.damus.io`)
//     or a self-hosted `construct relay --port 8787` instance stores events keyed
//     by a blinded routing tag (`#d = routeTag`).
//   - The outer NIP-01 wrapper is signed with an ephemeral BIP-340 secp256k1 key
//     derived via HKDF from the MLS group's current `routeTag`, so the relay sees
//     only an anonymous pubkey, a random hex tag, and opaque MLS ChaCha20-Poly1305
//     ciphertext.
//   - Zero external dependencies: BIP-340 secp256k1 Schnorr math is implemented
//     directly on Node's built-in `BigInt` and `node:crypto` SHA-256.

'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

// --- secp256k1 BIP-340 Schnorr (Pure BigInt, zero external deps) ---
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

function mod(a, m = P) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function modPow(base, exp, m = P) {
  let res = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) res = (res * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return res;
}

function modInv(a, m = P) {
  return modPow(a, m - 2n, m);
}

// Jacobian point coordinates [X, Y, Z] for fast scalar multiplication
function pointDouble(pt) {
  if (!pt) return null;
  const [X1, Y1, Z1] = pt;
  if (Y1 === 0n || Z1 === 0n) return null;
  const S = mod(4n * X1 * Y1 * Y1);
  const M = mod(3n * X1 * X1);
  const X3 = mod(M * M - 2n * S);
  const Y2 = mod(Y1 * Y1);
  const Y3 = mod(M * (S - X3) - 8n * Y2 * Y2);
  const Z3 = mod(2n * Y1 * Z1);
  return [X3, Y3, Z3];
}

function pointAdd(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [X1, Y1, Z1] = p1;
  const [X2, Y2, Z2] = p2;
  const Z1Z1 = mod(Z1 * Z1);
  const Z2Z2 = mod(Z2 * Z2);
  const U1 = mod(X1 * Z2Z2);
  const U2 = mod(X2 * Z1Z1);
  const S1 = mod(Y1 * Z2 * Z2Z2);
  const S2 = mod(Y2 * Z1 * Z1Z1);
  if (U1 === U2) {
    return S1 === S2 ? pointDouble(p1) : null;
  }
  const H = mod(U2 - U1);
  const I = mod(4n * H * H);
  const J = mod(H * I);
  const r = mod(2n * (S2 - S1));
  const V = mod(U1 * I);
  const X3 = mod(r * r - J - 2n * V);
  const Y3 = mod(r * (V - X3) - 2n * S1 * J);
  const Z3 = mod(((Z1 + Z2) * (Z1 + Z2) - Z1Z1 - Z2Z2) * H);
  return [X3, Y3, Z3];
}

function toAffine(pt) {
  if (!pt || pt[2] === 0n) return null;
  const invZ = modInv(pt[2], P);
  const invZ2 = mod(invZ * invZ);
  const invZ3 = mod(invZ2 * invZ);
  return [mod(pt[0] * invZ2), mod(pt[1] * invZ3)];
}

function pointMul(kScalar, basePt = [GX, GY, 1n]) {
  let k = mod(kScalar, N);
  if (k === 0n) return null;
  let res = null;
  let addend = basePt;
  while (k > 0n) {
    if (k & 1n) res = pointAdd(res, addend);
    addend = pointDouble(addend);
    k >>= 1n;
  }
  return toAffine(res);
}

function bigIntTo32Bytes(n) {
  const hex = n.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

function bytesToBigInt(buf) {
  return BigInt('0x' + buf.toString('hex'));
}

function taggedHash(tag, ...buffers) {
  const tagHash = crypto.createHash('sha256').update(tag, 'utf8').digest();
  const h = crypto.createHash('sha256').update(tagHash).update(tagHash);
  for (const b of buffers) h.update(b);
  return h.digest();
}

function schnorrGetPublicKey(privKeyBytes) {
  const d0 = bytesToBigInt(privKeyBytes);
  if (d0 <= 0n || d0 >= N) throw new Error('invalid secp256k1 private key scalar');
  const Ppt = pointMul(d0);
  return bigIntTo32Bytes(Ppt[0]);
}

function schnorrSign(msg32Bytes, privKeyBytes, auxRand32 = crypto.randomBytes(32)) {
  const d0 = bytesToBigInt(privKeyBytes);
  const Ppt = pointMul(d0);
  const d = (Ppt[1] & 1n) === 0n ? d0 : N - d0;
  const pxBytes = bigIntTo32Bytes(Ppt[0]);
  const dBytes = bigIntTo32Bytes(d);
  const auxHash = taggedHash('BIP0340/aux', auxRand32);
  const t = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) t[i] = dBytes[i] ^ auxHash[i];
  const rand = taggedHash('BIP0340/nonce', t, pxBytes, msg32Bytes);
  const k0 = mod(bytesToBigInt(rand), N);
  if (k0 === 0n) throw new Error('zero nonce in schnorrSign');
  const R = pointMul(k0);
  const k = (R[1] & 1n) === 0n ? k0 : N - k0;
  const rxBytes = bigIntTo32Bytes(R[0]);
  const e = mod(bytesToBigInt(taggedHash('BIP0340/challenge', rxBytes, pxBytes, msg32Bytes)), N);
  const s = mod(k + e * d, N);
  return Buffer.concat([rxBytes, bigIntTo32Bytes(s)]);
}

function buildNostrWrapperEvent(routeTag, envelope) {
  // Derive an anonymous transport keypair from the blinded routeTag
  const privKey = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(routeTag, 'hex'), Buffer.alloc(32, 0), 'construct-nostr-transport-v1', 32)
  );
  const pubkey = schnorrGetPublicKey(privKey).toString('hex');
  const created_at = Math.floor(Date.now() / 1000);
  const kind = 4420;
  const tags = [['d', routeTag]];
  const content = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');

  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const idBuf = crypto.createHash('sha256').update(serialized, 'utf8').digest();
  const id = idBuf.toString('hex');
  const sig = schnorrSign(idBuf, privKey).toString('hex');

  return { id, pubkey, created_at, kind, tags, content, sig };
}

function publishToOneRelay(url, event, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch (_) {}
      resolve(res);
    };

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      return resolve({ url, ok: false, error: err.message });
    }

    const timer = setTimeout(() => finish({ url, ok: false, error: 'timeout' }), timeoutMs);

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify(['EVENT', event]));
      } catch (err) {
        finish({ url, ok: false, error: err.message });
      }
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(String(msg.data));
        if (Array.isArray(data) && data[0] === 'OK' && data[1] === event.id) {
          finish({ url, ok: Boolean(data[2]), info: data[3] || '' });
        }
      } catch (_) {}
    };

    ws.onerror = () => finish({ url, ok: false, error: 'websocket error' });
    ws.onclose = () => finish({ url, ok: false, error: 'closed before OK' });
  });
}

function fetchFromOneRelay(url, routeTag, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const envelopes = [];
    const subId = 'c_' + crypto.randomBytes(4).toString('hex');
    let settled = false;

    const finish = (ok, error = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.send(JSON.stringify(['CLOSE', subId]));
        ws.close();
      } catch (_) {}
      resolve({ url, ok, envelopes, error });
    };

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      return resolve({ url, ok: false, envelopes: [], error: err.message });
    }

    const timer = setTimeout(() => finish(envelopes.length > 0, 'timeout'), timeoutMs);

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify(['REQ', subId, { kinds: [4420], '#d': [routeTag], limit: 200 }]));
      } catch (err) {
        finish(false, err.message);
      }
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(String(msg.data));
        if (!Array.isArray(data)) return;
        if (data[0] === 'EVENT' && data[1] === subId && data[2]?.content) {
          const env = JSON.parse(Buffer.from(data[2].content, 'base64').toString('utf8'));
          envelopes.push(env);
        } else if (data[0] === 'EOSE' && data[1] === subId) {
          finish(true);
        }
      } catch (_) {}
    };

    ws.onerror = () => finish(false, 'websocket error');
    ws.onclose = () => finish(envelopes.length > 0, 'closed');
  });
}

async function publishEnvelopeToRelays(relays, routeTag, envelope, timeoutMs = 4000) {
  const event = buildNostrWrapperEvent(routeTag, envelope);
  const results = await Promise.all(relays.map((r) => publishToOneRelay(r, event, timeoutMs)));
  return { eventId: event.id, results };
}

async function fetchEnvelopesFromRelays(relays, routeTag, timeoutMs = 4000) {
  const results = await Promise.all(relays.map((r) => fetchFromOneRelay(r, routeTag, timeoutMs)));
  const seen = new Set();
  const envelopes = [];
  for (const res of results) {
    for (const env of res.envelopes || []) {
      const key = env.signature || JSON.stringify(env);
      if (!seen.has(key)) {
        seen.add(key);
        envelopes.push(env);
      }
    }
  }
  return { envelopes, results };
}

// --- Built-in Minimal Zero-Knowledge NIP-01 WebSocket Relay (for tests, LAN, or self-hosting) ---
// Uses RFC 6455 WebSocket framing directly on Node's `node:http` upgrade socket—zero dependencies!

function encodeWsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const byte0 = buffer[offset];
    const byte1 = buffer[offset + 1];
    const opcode = byte0 & 0x0f;
    const masked = (byte1 & 0x80) !== 0;
    let payloadLen = byte1 & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    const maskLen = masked ? 4 : 0;
    const totalFrameLen = headerLen + maskLen + payloadLen;
    if (offset + totalFrameLen > buffer.length) break;

    const payload = Buffer.from(buffer.subarray(offset + headerLen + maskLen, offset + totalFrameLen));
    if (masked) {
      const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i & 3];
      }
    }
    if (opcode === 0x1) {
      messages.push(payload.toString('utf8'));
    } else if (opcode === 0x8) {
      messages.push(null); // close
    }
    offset += totalFrameLen;
  }
  return { messages, remaining: buffer.subarray(offset) };
}

function startLocalRelayServer(port = 0) {
  const eventsById = new Map();

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'construct-zero-knowledge-relay', events: eventsById.size }));
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n')
    );

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const decoded = decodeWsFrames(buf);
      buf = decoded.remaining;
      for (const msg of decoded.messages) {
        if (msg === null) {
          socket.end();
          return;
        }
        try {
          const parsed = JSON.parse(msg);
          if (!Array.isArray(parsed)) continue;
          if (parsed[0] === 'EVENT' && parsed[1]?.id) {
            const ev = parsed[1];
            eventsById.set(ev.id, ev);
            socket.write(encodeWsFrame(JSON.stringify(['OK', ev.id, true, ''])));
          } else if (parsed[0] === 'REQ' && parsed[1]) {
            const subId = parsed[1];
            const filter = parsed[2] || {};
            const wantTags = filter['#d'] || [];
            for (const ev of eventsById.values()) {
              if (wantTags.length) {
                const dTags = (ev.tags || []).filter((t) => t[0] === 'd').map((t) => t[1]);
                if (!wantTags.some((w) => dTags.includes(w))) continue;
              }
              socket.write(encodeWsFrame(JSON.stringify(['EVENT', subId, ev])));
            }
            socket.write(encodeWsFrame(JSON.stringify(['EOSE', subId])));
          }
        } catch (_) {}
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `ws://127.0.0.1:${addr.port}`,
        port: addr.port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

module.exports = {
  schnorrGetPublicKey,
  schnorrSign,
  buildNostrWrapperEvent,
  publishEnvelopeToRelays,
  fetchEnvelopesFromRelays,
  startLocalRelayServer,
};
