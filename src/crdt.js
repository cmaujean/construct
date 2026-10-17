// Cryptographic Identity (`did:key`), DIDComm v2 Invitations, MLS-style Epoch
// Group Encryption (X25519 + HKDF-SHA256 + ChaCha20-Poly1305 + Ed25519),
// Hybrid Logical Clock (HLC) CRDT state convergence, and Construct-to-Construct
// Comms (e.g., Alice's Molly <-> Bob's Dixie).
//
// Zero external npm dependencies: built 100% on Node 24's native C++ `node:crypto`,
// `node:sqlite`, and built-in `WebSocket` (with neutral public store-and-forward
// WebSocket relays or file/stream transport).

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_IDENTITY_FILE = path.join(os.homedir(), '.config', 'opencode', 'identity.json');

// Default neutral, zero-signup store-and-forward WebSocket relays (overridable per group)
const DEFAULT_RELAYS = Object.freeze([
  'wss://nos.lol',
  'wss://relay.damus.io',
]);

function identityFilePath() {
  return process.env.CONSTRUCT_IDENTITY_FILE || DEFAULT_IDENTITY_FILE;
}

// --- Base58btc encoding for W3C `did:key:z6Mk...` ---
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf) {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  const size = Math.ceil((buf.length * Math.log(256)) / Math.log(58)) + 1;
  const b58 = new Uint8Array(size);
  for (let i = zeros; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = size - 1; j >= 0; j--) {
      carry += 256 * b58[j];
      b58[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
  }
  let it = 0;
  while (it < size && b58[it] === 0) it++;
  let str = BASE58_ALPHABET[0].repeat(zeros);
  for (; it < size; it++) str += BASE58_ALPHABET[b58[it]];
  return str;
}

// Extract raw 32-byte public key from SPKI DER (Ed25519 / X25519 SPKI DER is 44 bytes, last 32 are raw key)
function rawPublicKeyFromSpkiDer(derBuf) {
  return derBuf.subarray(derBuf.length - 32);
}

function makeDidKeyFromEd25519Spki(spkiDerBase64) {
  const der = Buffer.from(spkiDerBase64, 'base64');
  const rawPub = rawPublicKeyFromSpkiDer(der);
  // Multicodec ed25519-pub is 0xed 0x01
  const multicodec = Buffer.concat([Buffer.from([0xed, 0x01]), rawPub]);
  return `did:key:z${base58Encode(multicodec)}`;
}

// Load or generate local operator cryptographic identity (Ed25519 signing + X25519 key agreement)
function loadOrCreateIdentity(file = identityFilePath()) {
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const signKp = crypto.generateKeyPairSync('ed25519');
  const dhKp = crypto.generateKeyPairSync('x25519');

  const signPubSpki = signKp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const signPrivPkcs8 = signKp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const dhPubSpki = dhKp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const dhPrivPkcs8 = dhKp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

  const did = makeDidKeyFromEd25519Spki(signPubSpki);
  const identity = {
    version: 1,
    did,
    signPub: signPubSpki,
    signPriv: signPrivPkcs8,
    dhPub: dhPubSpki,
    dhPriv: dhPrivPkcs8,
    created: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(identity, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return identity;
}

// --- Hybrid Logical Clock (HLC) ---
// Format: `<13-digit-epoch-ms>-<4-digit-hex-counter>-<8-char-did-tail>`
// Guarantees strict lexical ordering (`a > b`), causality (`recv(remoteHlc)` advances local clock),
// and global uniqueness across concurrent offline nodes.

let lastWallMs = 0;
let hlcCounter = 0;

function parseHlc(hlcStr) {
  if (!hlcStr || typeof hlcStr !== 'string') return { wallMs: 0, counter: 0, node: '' };
  const [msStr, cntStr, ...nodeParts] = hlcStr.split('-');
  return {
    wallMs: Number(msStr) || 0,
    counter: parseInt(cntStr || '0', 16) || 0,
    node: nodeParts.join('-'),
  };
}

function nextHlc(did, remoteHlcStr = null, nowMs = Date.now()) {
  const nodeTail = String(did || 'local').slice(-8);
  const remote = remoteHlcStr ? parseHlc(remoteHlcStr) : { wallMs: 0, counter: 0 };

  if (nowMs > lastWallMs && nowMs > remote.wallMs) {
    lastWallMs = nowMs;
    hlcCounter = 0;
  } else if (remote.wallMs > lastWallMs) {
    lastWallMs = remote.wallMs;
    hlcCounter = remote.counter + 1;
  } else if (lastWallMs === remote.wallMs) {
    hlcCounter = Math.max(hlcCounter, remote.counter) + 1;
  } else {
    hlcCounter += 1;
  }

  const msPadded = String(lastWallMs).padStart(13, '0');
  const cntHex = hlcCounter.toString(16).padStart(4, '0');
  return `${msPadded}-${cntHex}-${nodeTail}`;
}

// --- MLS Epoch Secret Tree & DIDComm v2 Envelopes ---
//
// Each shared project has an MLS group record in `mls_groups`:
//   - `project`: project key (e.g. `acme/alpha_app`)
//   - `group_id`: random 128-bit hex ID
//   - `epoch`: integer epoch number (increments on member add/ratchet)
//   - `epoch_secret`: 256-bit group secret (base64), ratcheted via HKDF-SHA256
//   - `members`: JSON array of `{ did, userId, signPub, dhPub }`
//   - `relays`: JSON array of WebSocket relay URLs
//   - `last_sync_hlc`: highest HLC synced

function deriveEpochKeys(epochSecretBase64, groupId, epoch) {
  const secret = Buffer.from(epochSecretBase64, 'base64');
  const infoPrefix = `construct-mls-v1|${groupId}|epoch:${epoch}`;
  const aeadKey = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(32, 0), `${infoPrefix}|aead`, 32));
  const routeTag = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(32, 0), `${infoPrefix}|route`, 32)).toString('hex');
  return { aeadKey, routeTag };
}

function ratchetEpochSecret(currentSecretBase64, commitEntropyBase64) {
  const cur = Buffer.from(currentSecretBase64, 'base64');
  const salt = Buffer.from(commitEntropyBase64, 'base64');
  const next = Buffer.from(crypto.hkdfSync('sha256', cur, salt, 'construct-mls-v1|epoch-ratchet', 32));
  return next.toString('base64');
}

function signPayload(payloadBytes, signPrivBase64) {
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(signPrivBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.sign(null, payloadBytes, privKey).toString('base64');
}

function verifyPayloadSignature(payloadBytes, signatureBase64, signPubBase64) {
  const pubKey = crypto.createPublicKey({
    key: Buffer.from(signPubBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, payloadBytes, pubKey, Buffer.from(signatureBase64, 'base64'));
}

// Seal an MLS ApplicationMessage (ChaCha20-Poly1305 AEAD + Ed25519 sender signature over AAD + ciphertext)
function sealMlsApplicationMessage(group, identity, crdtOpsPayload) {
  const { aeadKey, routeTag } = deriveEpochKeys(group.epochSecret, group.groupId, group.epoch);
  const nonce = crypto.randomBytes(12);
  const aad = Buffer.from(
    JSON.stringify({
      v: 1,
      type: 'application/construct-mls+crdt',
      groupId: group.groupId,
      epoch: group.epoch,
      senderDid: identity.did,
    }),
    'utf8'
  );

  const plaintext = Buffer.from(JSON.stringify(crdtOpsPayload), 'utf8');
  const cipher = crypto.createCipheriv('chacha20-poly1305', aeadKey, nonce, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const toSign = Buffer.concat([aad, nonce, ciphertext, tag]);
  const signature = signPayload(toSign, identity.signPriv);

  return {
    v: 1,
    type: 'https://didcomm.org/construct-mls/1.0/application',
    routeTag,
    groupId: group.groupId,
    epoch: group.epoch,
    senderDid: identity.did,
    senderSignPub: identity.signPub,
    aad: aad.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
    signature,
  };
}

function openMlsApplicationMessage(group, envelope) {
  if (envelope.groupId !== group.groupId) {
    throw new Error(`groupId mismatch: expected ${group.groupId}, got ${envelope.groupId}`);
  }
  const { aeadKey } = deriveEpochKeys(group.epochSecret, group.groupId, envelope.epoch);
  const aad = Buffer.from(envelope.aad, 'base64');
  const nonce = Buffer.from(envelope.nonce, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');

  const toVerify = Buffer.concat([aad, nonce, ciphertext, tag]);
  const expectedDid = makeDidKeyFromEd25519Spki(envelope.senderSignPub);
  if (expectedDid !== envelope.senderDid) {
    throw new Error('sender DID does not match sender Ed25519 public key');
  }
  if (!verifyPayloadSignature(toVerify, envelope.signature, envelope.senderSignPub)) {
    throw new Error('invalid Ed25519 signature on MLS application message');
  }

  const decipher = crypto.createDecipheriv('chacha20-poly1305', aeadKey, nonce, { authTagLength: 16 });
  decipher.setAAD(aad, { plaintextLength: ciphertext.length });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

// Create a signed DIDComm v2 Out-of-Band (OOB) Invitation bundling the MLS group welcome credentials
// and repository bootstrap metadata (`gitUrl`, `branch`, `setupCommands`) so `construct join` can
// clone and stand up the project automatically when the invitee doesn't have it on disk yet.
function createDidCommInvite(group, identity, inviterUser, repoMeta = {}) {
  const payload = {
    type: 'https://didcomm.org/out-of-band/2.0/invitation',
    id: crypto.randomUUID(),
    from: identity.did,
    fromUser: inviterUser?.id || 'unknown',
    fromName: inviterUser?.name || 'Unknown',
    body: {
      goal_code: 'construct.mls.join',
      project: group.project,
      gitUrl: repoMeta.gitUrl || '',
      branch: repoMeta.branch || '',
      setupCommands: Array.isArray(repoMeta.setupCommands) ? repoMeta.setupCommands : [],
      groupId: group.groupId,
      epoch: group.epoch,
      epochSecret: group.epochSecret,
      relays: group.relays,
      inviterMember: {
        did: identity.did,
        userId: inviterUser?.id || 'unknown',
        signPub: identity.signPub,
        dhPub: identity.dhPub,
      },
    },
    created: new Date().toISOString(),
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = signPayload(payloadBytes, identity.signPriv);
  const tokenObj = {
    p: payloadBytes.toString('base64url'),
    s: Buffer.from(sig, 'base64').toString('base64url'),
    k: Buffer.from(identity.signPub, 'base64').toString('base64url'),
  };
  return `construct://invite/${Buffer.from(JSON.stringify(tokenObj), 'utf8').toString('base64url')}`;
}

function parseAndVerifyDidCommInvite(inviteUri) {
  const cleaned = String(inviteUri || '').trim().replace(/^construct:\/\/invite\//, '');
  let tokenObj;
  try {
    tokenObj = JSON.parse(Buffer.from(cleaned, 'base64url').toString('utf8'));
  } catch (_) {
    throw new Error('malformed construct invite token');
  }
  const payloadBytes = Buffer.from(tokenObj.p, 'base64url');
  const sigBase64 = Buffer.from(tokenObj.s, 'base64url').toString('base64');
  const signPubBase64 = Buffer.from(tokenObj.k, 'base64url').toString('base64');

  if (!verifyPayloadSignature(payloadBytes, sigBase64, signPubBase64)) {
    throw new Error('invite signature verification failed');
  }
  const payload = JSON.parse(payloadBytes.toString('utf8'));
  const expectedDid = makeDidKeyFromEd25519Spki(signPubBase64);
  if (payload.from !== expectedDid) {
    throw new Error('invite signer DID mismatch');
  }
  return payload;
}

// --- Database Schema for CRDT, MLS Groups & Construct-to-Construct Comms ---

function initCrdtAndCommsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mls_groups (
      project       TEXT PRIMARY KEY,
      group_id      TEXT NOT NULL,
      epoch         INTEGER NOT NULL DEFAULT 1,
      epoch_secret  TEXT NOT NULL,
      members       TEXT NOT NULL DEFAULT '[]',
      relays        TEXT NOT NULL DEFAULT '[]',
      last_sync_hlc TEXT NOT NULL DEFAULT '',
      updated       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crdt_log (
      op_id      TEXT PRIMARY KEY,
      hlc        TEXT NOT NULL,
      project    TEXT NOT NULL,
      author_did TEXT NOT NULL,
      entity     TEXT NOT NULL,
      record_uid TEXT NOT NULL,
      payload    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_crdt_log_project_hlc ON crdt_log(project, hlc ASC);

    CREATE TABLE IF NOT EXISTS messages (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      uid            TEXT NOT NULL UNIQUE,
      hlc            TEXT NOT NULL,
      project        TEXT NOT NULL,
      from_user      TEXT NOT NULL,
      from_rom       TEXT NOT NULL,
      from_did       TEXT NOT NULL,
      to_user        TEXT NOT NULL,
      body           TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',
      reply_body     TEXT NOT NULL DEFAULT '',
      reply_rom      TEXT NOT NULL DEFAULT '',
      reply_hlc      TEXT NOT NULL DEFAULT '',
      created        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_to_status ON messages(to_user, status, hlc ASC);
    CREATE INDEX IF NOT EXISTS idx_messages_project   ON messages(project, hlc ASC);
  `);

  // Ensure `uid` and `hlc` columns exist on `frames` and `gotchas` for CRDT deduplication
  const frameCols = db.prepare('PRAGMA table_info(frames)').all().map((c) => c.name);
  if (!frameCols.includes('uid')) {
    db.exec("ALTER TABLE frames ADD COLUMN uid TEXT NOT NULL DEFAULT '';");
    db.exec("ALTER TABLE frames ADD COLUMN hlc TEXT NOT NULL DEFAULT '';");
  }
  const gotchaCols = db.prepare('PRAGMA table_info(gotchas)').all().map((c) => c.name);
  if (!gotchaCols.includes('uid')) {
    db.exec("ALTER TABLE gotchas ADD COLUMN uid TEXT NOT NULL DEFAULT '';");
    db.exec("ALTER TABLE gotchas ADD COLUMN hlc TEXT NOT NULL DEFAULT '';");
  }
}

function hydrateMlsGroup(row) {
  if (!row) return null;
  return {
    project: row.project,
    groupId: row.group_id,
    epoch: Number(row.epoch),
    epochSecret: row.epoch_secret,
    members: JSON.parse(row.members || '[]'),
    relays: JSON.parse(row.relays || '[]'),
    lastSyncHlc: row.last_sync_hlc || '',
    updated: row.updated,
  };
}

function hydrateMessage(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    uid: row.uid,
    hlc: row.hlc,
    project: row.project,
    fromUser: row.from_user,
    fromRom: row.from_rom,
    fromDid: row.from_did,
    toUser: row.to_user,
    body: row.body,
    status: row.status,
    replyBody: row.reply_body || '',
    replyRom: row.reply_rom || '',
    replyHlc: row.reply_hlc || '',
    created: row.created,
  };
}

function appendCrdtOpInDb(db, { project, entity, recordUid, payload }, identityFile) {
  const identity = loadOrCreateIdentity(identityFile);
  const hlc = nextHlc(identity.did);
  const opId = `${hlc}:${entity}:${recordUid}`;
  db.prepare(
    `INSERT OR REPLACE INTO crdt_log (op_id, hlc, project, author_did, entity, record_uid, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(opId, hlc, project, identity.did, entity, recordUid, JSON.stringify(payload));
  return { opId, hlc, authorDid: identity.did };
}

// Backfill existing project gotchas, frames, and heads into crdt_log when a project group is initialized
function backfillProjectCrdtLogInDb(db, project, identityFile) {
  const identity = loadOrCreateIdentity(identityFile);

  const gotchas = db.prepare('SELECT * FROM gotchas WHERE scope = ? ORDER BY id ASC').all(project);
  for (const g of gotchas) {
    const uid = g.uid || `gotcha-${project}-${g.id}-${crypto.randomBytes(4).toString('hex')}`;
    const hlc = g.hlc || nextHlc(identity.did);
    if (!g.uid || !g.hlc) {
      db.prepare('UPDATE gotchas SET uid = ?, hlc = ? WHERE id = ?').run(uid, hlc, g.id);
    }
    const opId = `${hlc}:gotcha:${uid}`;
    db.prepare(
      `INSERT OR IGNORE INTO crdt_log (op_id, hlc, project, author_did, entity, record_uid, payload)
       VALUES (?, ?, ?, ?, 'gotcha', ?, ?)`
    ).run(
      opId,
      hlc,
      project,
      identity.did,
      uid,
      JSON.stringify({
        uid,
        hlc,
        scope: project,
        title: g.title,
        status: g.status,
        tags: JSON.parse(g.tags || '[]'),
        evidence: g.evidence,
        fix: g.fix,
        created: g.created,
      })
    );
  }

  const frames = db.prepare('SELECT * FROM frames WHERE project = ? ORDER BY seq ASC').all(project);
  for (const f of frames) {
    const uid = f.uid || `frame-${project}-${f.seq}-${crypto.randomBytes(4).toString('hex')}`;
    const hlc = f.hlc || nextHlc(identity.did);
    if (!f.uid || !f.hlc) {
      db.prepare('UPDATE frames SET uid = ?, hlc = ? WHERE seq = ?').run(uid, hlc, f.seq);
    }
    const opId = `${hlc}:frame:${uid}`;
    db.prepare(
      `INSERT OR IGNORE INTO crdt_log (op_id, hlc, project, author_did, entity, record_uid, payload)
       VALUES (?, ?, ?, ?, 'frame', ?, ?)`
    ).run(
      opId,
      hlc,
      project,
      identity.did,
      uid,
      JSON.stringify({
        uid,
        hlc,
        ts: f.ts,
        project: f.project,
        kind: f.kind,
        summary: f.summary,
        detail: f.detail,
        verified: f.verified,
        open: Boolean(f.open),
        refs: JSON.parse(f.refs || '[]'),
      })
    );
  }

  const head = db.prepare('SELECT * FROM heads WHERE project = ?').get(project);
  if (head) {
    const hlc = nextHlc(identity.did);
    const opId = `${hlc}:head:${project}`;
    db.prepare(
      `INSERT OR IGNORE INTO crdt_log (op_id, hlc, project, author_did, entity, record_uid, payload)
       VALUES (?, ?, ?, ?, 'head', ?, ?)`
    ).run(
      opId,
      hlc,
      project,
      identity.did,
      project,
      JSON.stringify({
        project,
        hlc,
        repo: head.repo,
        state: head.state,
        next: head.next,
        updated: head.updated,
      })
    );
  }
}

// Merge an array of incoming CRDT operations idempotently & deterministically (G-Set + LWW-Element-Map by HLC).
// When `allowedProject` is given (always set on MLS group packet import), any op targeting a different
// project or global scope is rejected at the boundary so cross-project bleed is impossible.
function applyCrdtOpsInDb(db, ops, identityFile, allowedProject = null) {
  const identity = loadOrCreateIdentity(identityFile);
  let applied = 0;

  for (const op of ops) {
    if (!op || !op.opId || !op.hlc || !op.entity || !op.payload) continue;
    if (allowedProject) {
      if (op.project !== allowedProject) continue;
      if (op.entity === 'gotcha' && op.payload.scope && op.payload.scope !== allowedProject) continue;
      if (op.entity === 'frame' && op.payload.project && op.payload.project !== allowedProject) continue;
      if (op.entity === 'message' && op.payload.project && op.payload.project !== allowedProject) continue;
    }
    // Advance local HLC past remote HLC so causal ordering holds
    nextHlc(identity.did, op.hlc);

    const seen = db.prepare('SELECT op_id FROM crdt_log WHERE op_id = ?').get(op.opId);
    if (seen) continue;

    db.prepare(
      `INSERT INTO crdt_log (op_id, hlc, project, author_did, entity, record_uid, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      op.opId,
      op.hlc,
      op.project,
      op.authorDid || 'remote',
      op.entity,
      op.recordUid,
      JSON.stringify(op.payload)
    );

    const p = op.payload;
    if (op.entity === 'gotcha') {
      const existing = db.prepare('SELECT * FROM gotchas WHERE uid = ?').get(p.uid);
      if (!existing) {
        db.prepare(
          `INSERT INTO gotchas (uid, hlc, scope, title, status, tags, evidence, fix, created)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          p.uid,
          p.hlc || op.hlc,
          p.scope || op.project,
          p.title,
          p.status || 'observed',
          JSON.stringify(p.tags || []),
          p.evidence || '',
          p.fix || '',
          p.created || ''
        );
        applied++;
      } else if ((p.hlc || op.hlc) > (existing.hlc || '')) {
        db.prepare(
          `UPDATE gotchas SET hlc = ?, title = ?, status = ?, tags = ?, evidence = ?, fix = ? WHERE uid = ?`
        ).run(
          p.hlc || op.hlc,
          p.title,
          p.status || existing.status,
          JSON.stringify(p.tags || []),
          p.evidence || '',
          p.fix || '',
          p.uid
        );
        applied++;
      }
    } else if (op.entity === 'frame') {
      const existing = db.prepare('SELECT * FROM frames WHERE uid = ?').get(p.uid);
      if (!existing) {
        db.prepare(
          `INSERT INTO frames (uid, hlc, ts, project, kind, summary, detail, verified, open, refs)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          p.uid,
          p.hlc || op.hlc,
          p.ts || new Date().toISOString(),
          p.project || op.project,
          p.kind || 'finding',
          p.summary,
          p.detail || '',
          p.verified || '',
          p.open ? 1 : 0,
          JSON.stringify(p.refs || [])
        );
        applied++;
      } else if ((p.hlc || op.hlc) > (existing.hlc || '')) {
        db.prepare(
          `UPDATE frames SET hlc = ?, summary = ?, detail = ?, verified = ?, open = ?, refs = ? WHERE uid = ?`
        ).run(
          p.hlc || op.hlc,
          p.summary ?? existing.summary,
          p.detail ?? existing.detail,
          p.verified ?? existing.verified,
          p.open !== undefined ? (p.open ? 1 : 0) : existing.open,
          JSON.stringify(p.refs || JSON.parse(existing.refs || '[]')),
          p.uid
        );
        applied++;
      }
    } else if (op.entity === 'head') {
      const existing = db.prepare('SELECT * FROM heads WHERE project = ?').get(op.project);
      if (!existing || (p.updated || '') >= (existing.updated || '')) {
        // Keep the local machine's checkout path (`existing.repo`) if already set, so syncing a head
        // between two operators with different disk layouts never overwrites local paths.
        const localRepo = existing && existing.repo ? existing.repo : p.repo || '';
        db.prepare(
          `INSERT INTO heads (project, repo, state, next, updated)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project) DO UPDATE SET
             state = excluded.state,
             next = excluded.next,
             updated = excluded.updated`
        ).run(op.project, localRepo, p.state || '', p.next || '', p.updated || new Date().toISOString());
        applied++;
      }
    } else if (op.entity === 'message') {
      const existing = db.prepare('SELECT * FROM messages WHERE uid = ?').get(p.uid);
      if (!existing) {
        db.prepare(
          `INSERT INTO messages (uid, hlc, project, from_user, from_rom, from_did, to_user, body, status, reply_body, reply_rom, reply_hlc, created)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          p.uid,
          p.hlc || op.hlc,
          p.project || op.project,
          p.fromUser,
          p.fromRom,
          p.fromDid,
          p.toUser,
          p.body,
          p.status || 'pending',
          p.replyBody || '',
          p.replyRom || '',
          p.replyHlc || '',
          p.created || new Date().toISOString()
        );
        applied++;
      } else if ((p.replyHlc || p.hlc || op.hlc) > (existing.reply_hlc || existing.hlc || '')) {
        db.prepare(
          `UPDATE messages
           SET status = ?, reply_body = ?, reply_rom = ?, reply_hlc = ?
           WHERE uid = ?`
        ).run(
          p.status || existing.status,
          p.replyBody ?? existing.reply_body,
          p.replyRom ?? existing.reply_rom,
          p.replyHlc || op.hlc,
          p.uid
        );
        applied++;
      }
    }
  }

  return applied;
}

module.exports = {
  DEFAULT_RELAYS,
  identityFilePath,
  loadOrCreateIdentity,
  makeDidKeyFromEd25519Spki,
  parseHlc,
  nextHlc,
  deriveEpochKeys,
  ratchetEpochSecret,
  sealMlsApplicationMessage,
  openMlsApplicationMessage,
  createDidCommInvite,
  parseAndVerifyDidCommInvite,
  initCrdtAndCommsSchema,
  hydrateMlsGroup,
  hydrateMessage,
  appendCrdtOpInDb,
  backfillProjectCrdtLogInDb,
  applyCrdtOpsInDb,
};
