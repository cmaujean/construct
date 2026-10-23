// Cryptographic Identity (`W3C did:key`), Out-of-Band Invitations, Epoch-Keyed
// Group AEAD (X25519 + HKDF-SHA256 + ChaCha20-Poly1305 + Ed25519),
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
const lattice = require('./lattice.ts');
import type { DatabaseSync } from 'node:sqlite';
import type {
  CourierMessage,
  CrdtOperationsBatch,
  CryptographicIdentity,
  MlsGroupRecord,
  ProjectCapabilityToken,
  SealedMlsEnvelope,
} from './types.ts';

const DEFAULT_IDENTITY_FILE = path.join(os.homedir(), '.config', 'opencode', 'identity.json');

// Default neutral, zero-signup store-and-forward WebSocket relays (overridable per group)
const DEFAULT_RELAYS: readonly string[] = Object.freeze([
  'wss://nos.lol',
  'wss://relay.damus.io',
]);

function identityFilePath(): string {
  return process.env.CONSTRUCT_IDENTITY_FILE || DEFAULT_IDENTITY_FILE;
}

// --- Base58btc encoding for W3C `did:key:z6Mk...` ---
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf: Uint8Array): string {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  const size = Math.ceil((buf.length * Math.log(256)) / Math.log(58)) + 1;
  const b58 = new Uint8Array(size);
  for (let i = zeros; i < buf.length; i++) {
    let carry = buf[i]!;
    for (let j = size - 1; j >= 0; j--) {
      carry += 256 * b58[j]!;
      b58[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
  }
  let it = 0;
  while (it < size && b58[it] === 0) it++;
  let str = BASE58_ALPHABET[0]!.repeat(zeros);
  for (; it < size; it++) str += BASE58_ALPHABET[b58[it]!];
  return str;
}

// Extract raw 32-byte public key from SPKI DER (Ed25519 / X25519 SPKI DER is 44 bytes, last 32 are raw key)
function rawPublicKeyFromSpkiDer(derBuf: Buffer): Buffer {
  return derBuf.subarray(derBuf.length - 32);
}

function makeDidKeyFromEd25519Spki(spkiDerBase64: string): string {
  const der = Buffer.from(spkiDerBase64, 'base64');
  const rawPub = rawPublicKeyFromSpkiDer(der);
  // Multicodec ed25519-pub is 0xed 0x01
  const multicodec = Buffer.concat([Buffer.from([0xed, 0x01]), rawPub]);
  return `did:key:z${base58Encode(multicodec)}`;
}

// Load or generate local operator cryptographic identity (Ed25519 signing + X25519 key agreement)
function loadOrCreateIdentity(file: string = identityFilePath()): CryptographicIdentity {
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

const MAX_HLC_DRIFT_MS = 5 * 60 * 1000; // 5 minutes maximum tolerated remote clock drift

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

function isHlcWithinDrift(hlcStr, nowMs = Date.now()) {
  if (!hlcStr || typeof hlcStr !== 'string') return false;
  const parsed = parseHlc(hlcStr);
  if (! parsed.wallMs || parsed.wallMs <= 0) return false;
  return parsed.wallMs <= nowMs + MAX_HLC_DRIFT_MS;
}

function nextHlc(did, remoteHlcStr = null, nowMs = Date.now()) {
  const nodeTail = String(did || 'local').slice(-8);
  const rawRemote = remoteHlcStr ? parseHlc(remoteHlcStr) : { wallMs: 0, counter: 0 };
  // Clamp remote wall clock to prevent future-timestamp clock poisoning
  const remote =
    rawRemote.wallMs > nowMs + MAX_HLC_DRIFT_MS
      ? { wallMs: nowMs, counter: 0 }
      : rawRemote;

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

// Seal an MLS ApplicationMessage (rANS + String-Slab binary batch + Chaskey-12 Capability + ChaCha20-Poly1305 AEAD + Ed25519 signature)
function sealMlsApplicationMessage(
  group: MlsGroupRecord,
  identity: CryptographicIdentity,
  crdtOpsPayload: CrdtOperationsBatch,
  options: { readonly capability?: ProjectCapabilityToken; readonly legacyJson?: boolean } = {}
): SealedMlsEnvelope {
  const { aeadKey, routeTag } = deriveEpochKeys(group.epochSecret, group.groupId, group.epoch);
  const nonce = crypto.randomBytes(12);
  const isComms =
    group.project === '@comms' ||
    group.project === 'comms' ||
    String(group.project || '').toLowerCase().startsWith('@comms/');
  const capability =
    options.capability ||
    lattice.mintProjectCapability({
      epochSecret: group.epochSecret,
      projectPrefix: isComms ? '' : group.project,
      allowedEntitiesMask: isComms
        ? lattice.ENTITY_MASK.COMMS_ONLY
        : lattice.ENTITY_MASK.ALL_PROJECT,
      permissionsMask: lattice.PERMISSION_MASK.ALL,
    });

  const aad = Buffer.from(
    JSON.stringify({
      v: 2,
      type: 'application/construct-lattice+rans',
      groupId: group.groupId,
      epoch: group.epoch,
      senderDid: identity.did,
      cap: capability,
    }),
    'utf8'
  );

  const plaintext = options.legacyJson
    ? Buffer.from(JSON.stringify(crdtOpsPayload), 'utf8')
    : lattice.encodeConstructOpsBatch(crdtOpsPayload);
  const cipher = crypto.createCipheriv('chacha20-poly1305', aeadKey, nonce, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const toSign = Buffer.concat([aad, nonce, ciphertext, tag]);
  const signature = signPayload(toSign, identity.signPriv);
  const blindHash64 = lattice.hashString64(signature).toString(16).padStart(16, '0');

  return {
    v: 2,
    type: 'https://didcomm.org/construct-lattice/2.0/application',
    routeTag,
    blindHash64,
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

function openMlsApplicationMessage(
  group: MlsGroupRecord,
  envelope: SealedMlsEnvelope,
  options: { readonly strictMembers?: boolean } = {}
): CrdtOperationsBatch {
  if (envelope.groupId !== group.groupId) {
    throw new Error(`groupId mismatch: expected ${group.groupId}, got ${envelope.groupId}`);
  }
  if (Number(envelope.epoch) !== Number(group.epoch)) {
    throw new Error(`epoch mismatch: expected ${group.epoch}, got ${envelope.epoch}`);
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
  const members = Array.isArray(group.members) ? group.members : [];
  const knownMember = members.find((m) => m.did === envelope.senderDid);
  if (knownMember && knownMember.signPub && knownMember.signPub !== envelope.senderSignPub) {
    throw new Error('sender public key does not match pinned MLS group member key');
  }
  if (options.strictMembers && !knownMember) {
    throw new Error(`sender DID "${envelope.senderDid}" is not a registered member of MLS group "${group.groupId}"`);
  }
  if (!verifyPayloadSignature(toVerify, envelope.signature, envelope.senderSignPub)) {
    throw new Error('invalid Ed25519 signature on MLS application message');
  }

  const decipher = crypto.createDecipheriv('chacha20-poly1305', aeadKey, nonce, { authTagLength: 16 });
  decipher.setAAD(aad, { plaintextLength: ciphertext.length });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  let aadObj;
  try {
    aadObj = JSON.parse(aad.toString('utf8'));
  } catch (_) {
    throw new Error('malformed MLS AAD JSON');
  }
  if (
    aadObj.groupId !== group.groupId ||
    Number(aadObj.epoch) !== Number(group.epoch) ||
    aadObj.senderDid !== envelope.senderDid
  ) {
    throw new Error('MLS AAD metadata mismatch against outer envelope');
  }

  if (aadObj.cap) {
    const isComms =
      group.project === '@comms' ||
      group.project === 'comms' ||
      String(group.project || '').toLowerCase().startsWith('@comms/');
    const verdict = lattice.verifyProjectCapability({
      epochSecret: group.epochSecret,
      token: aadObj.cap,
      targetProject: isComms ? '' : group.project,
      requiredEntitiesMask: isComms
        ? lattice.ENTITY_MASK.MESSAGE
        : lattice.ENTITY_MASK.FRAME,
      requiredPermission: lattice.PERMISSION_MASK.WRITE,
    });
    if (!verdict.ok) {
      throw new Error(`Chaskey-12 capability verification failed: ${verdict.reason}`);
    }
  }

  return lattice.decodeConstructOpsBatch(plaintext);
}

function wrapInviteEpochSecret(epochSecretBase64, wrapSeedBytes, groupId) {
  const wrapKey = Buffer.from(
    crypto.hkdfSync('sha256', wrapSeedBytes, Buffer.from(groupId, 'utf8'), 'construct-invite-wrap-v1', 32)
  );
  const nonce = crypto.randomBytes(12);
  const aad = Buffer.from(`construct-invite-v1|${groupId}`, 'utf8');
  const plain = Buffer.from(epochSecretBase64, 'utf8');
  const cipher = crypto.createCipheriv('chacha20-poly1305', wrapKey, nonce, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plain.length });
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString('base64url'),
    ct: ct.toString('base64url'),
    tag: tag.toString('base64url'),
  };
}

function unwrapInviteEpochSecret(wrapped, wrapSeedBytes, groupId) {
  const wrapKey = Buffer.from(
    crypto.hkdfSync('sha256', wrapSeedBytes, Buffer.from(groupId, 'utf8'), 'construct-invite-wrap-v1', 32)
  );
  const nonce = Buffer.from(wrapped.nonce, 'base64url');
  const ct = Buffer.from(wrapped.ct, 'base64url');
  const tag = Buffer.from(wrapped.tag, 'base64url');
  const aad = Buffer.from(`construct-invite-v1|${groupId}`, 'utf8');
  const decipher = crypto.createDecipheriv('chacha20-poly1305', wrapKey, nonce, { authTagLength: 16 });
  decipher.setAAD(aad, { plaintextLength: ct.length });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Create a signed DIDComm v2 Out-of-Band (OOB) Invitation bundling the MLS group welcome credentials
// (with `epochSecret` AEAD-wrapped via X25519 ECDH or an out-of-band fragment key `#ik=...`) and
// repository bootstrap metadata (`gitUrl`, `branch`, `setupCommands`).
function createDidCommInvite(group, identity, inviterUser, repoMeta = {}) {
  let wrapSeedBytes;
  let fragmentSuffix = '';
  let wrapMode = 'fragment';

  if (repoMeta.recipientDhPub) {
    wrapMode = 'x25519';
    const privKey = crypto.createPrivateKey({
      key: Buffer.from(identity.dhPriv, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const pubKey = crypto.createPublicKey({
      key: Buffer.from(repoMeta.recipientDhPub, 'base64'),
      format: 'der',
      type: 'spki',
    });
    wrapSeedBytes = crypto.diffieHellman({ privateKey: privKey, publicKey: pubKey });
  } else {
    wrapSeedBytes = crypto.randomBytes(32);
    fragmentSuffix = `#${wrapSeedBytes.toString('base64url')}`;
  }

  const encryptedEpochSecret = wrapInviteEpochSecret(group.epochSecret, wrapSeedBytes, group.groupId);
  let encryptedCommsGroup = null;
  if (repoMeta.commsGroup && repoMeta.commsGroup.groupId && repoMeta.commsGroup.epochSecret) {
    encryptedCommsGroup = {
      groupId: repoMeta.commsGroup.groupId,
      epoch: repoMeta.commsGroup.epoch || 1,
      encryptedEpochSecret: wrapInviteEpochSecret(
        repoMeta.commsGroup.epochSecret,
        wrapSeedBytes,
        repoMeta.commsGroup.groupId
      ),
    };
  }

  const payload = {
    type: 'https://didcomm.org/out-of-band/2.0/invitation',
    id: crypto.randomUUID(),
    from: identity.did,
    fromUser: inviterUser?.id || 'unknown',
    fromName: inviterUser?.name || 'Unknown',
    body: {
      goal_code: 'construct.mls.join',
      project: group.project,
      commsOnly: Boolean(repoMeta.commsOnly),
      gitUrl: repoMeta.gitUrl || '',
      branch: repoMeta.branch || '',
      setupCommands: Array.isArray(repoMeta.setupCommands) ? repoMeta.setupCommands : [],
      groupId: group.groupId,
      epoch: group.epoch,
      wrapMode,
      encryptedEpochSecret,
      commsGroup: encryptedCommsGroup,
      relays: group.relays,
      inviterMember: {
        did: identity.did,
        userId: inviterUser?.id || 'unknown',
        signPub: identity.signPub,
        dhPub: identity.dhPub,
        latticeV2: true,
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
  return `construct://invite/${Buffer.from(JSON.stringify(tokenObj), 'utf8').toString('base64url')}${fragmentSuffix}`;
}

function parseAndVerifyDidCommInvite(inviteUri, recipientIdentity = null) {
  const raw = String(inviteUri || '').trim().replace(/^construct:\/\/invite\//, '');
  const [cleaned, fragmentKey] = raw.split('#');
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

  if (payload.body && payload.body.encryptedEpochSecret && !payload.body.epochSecret) {
    let wrapSeedBytes;
    if (payload.body.wrapMode === 'x25519') {
      const id = recipientIdentity || loadOrCreateIdentity();
      const privKey = crypto.createPrivateKey({
        key: Buffer.from(id.dhPriv, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
      const pubKey = crypto.createPublicKey({
        key: Buffer.from(payload.body.inviterMember.dhPub, 'base64'),
        format: 'der',
        type: 'spki',
      });
      wrapSeedBytes = crypto.diffieHellman({ privateKey: privKey, publicKey: pubKey });
    } else {
      if (!fragmentKey) {
        throw new Error('missing invite fragment key (#...) required to unwrap MLS epochSecret');
      }
      wrapSeedBytes = Buffer.from(fragmentKey, 'base64url');
    }
    payload.body.epochSecret = unwrapInviteEpochSecret(
      payload.body.encryptedEpochSecret,
      wrapSeedBytes,
      payload.body.groupId
    );
    if (payload.body.commsGroup && payload.body.commsGroup.encryptedEpochSecret) {
      payload.body.commsGroup.epochSecret = unwrapInviteEpochSecret(
        payload.body.commsGroup.encryptedEpochSecret,
        wrapSeedBytes,
        payload.body.commsGroup.groupId
      );
    }
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

function hydrateMlsGroup(row: Record<string, unknown> | null | undefined): MlsGroupRecord | null {
  if (!row) return null;
  return {
    project: String(row.project),
    groupId: String(row.group_id),
    epoch: Number(row.epoch),
    epochSecret: String(row.epoch_secret),
    members: JSON.parse(String(row.members || '[]')),
    relays: JSON.parse(String(row.relays || '[]')),
    lastSyncHlc: String(row.last_sync_hlc || ''),
    updated: String(row.updated),
  };
}

function hydrateMessage(row: Record<string, unknown> | null | undefined): CourierMessage | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    uid: String(row.uid),
    hlc: String(row.hlc),
    project: String(row.project),
    fromUser: String(row.from_user),
    fromRom: String(row.from_rom),
    fromDid: String(row.from_did),
    toUser: String(row.to_user),
    body: String(row.body),
    status: String(row.status) as CourierMessage['status'],
    replyBody: String(row.reply_body || ''),
    replyRom: String(row.reply_rom || ''),
    replyHlc: String(row.reply_hlc || ''),
    created: String(row.created),
  };
}

function selectInboxForBootInDb(
  db: DatabaseSync,
  {
    sessionId,
    user,
    detectedLogin,
    buildCourierProfileInDb,
    options = {},
  }: {
    readonly sessionId: string;
    readonly user: { readonly id?: string; readonly name?: string; readonly osUsers?: readonly string[] } | null;
    readonly detectedLogin: string;
    readonly buildCourierProfileInDb: (db: DatabaseSync, rom: string, sender: string, role: string) => unknown;
    readonly options?: { readonly isSubagent?: boolean };
  }
) {
  const isSubagentSession =
    Boolean(options?.isSubagent) ||
    sessionId.includes(':') ||
    sessionId.startsWith('pending_subagent:');
  if (isSubagentSession) {
    return { inboxPending: [], inboxReplies: [] };
  }

  const activeUserId = user?.id || detectedLogin;
  const localIdentity = loadOrCreateIdentity();
  const recipientAliases = new Set(
    [activeUserId, user?.id, user?.name, detectedLogin, ...(user?.osUsers || []), 'all', 'team']
      .filter(Boolean)
      .map((s) => String(s).trim().toLowerCase())
  );

  let claimsMap: Record<string, string> = {};
  if (sessionId) {
    try {
      const claimRow = db.prepare("SELECT value FROM meta WHERE key = 'courier_tab_claims'").get() as { value?: string } | undefined;
      if (claimRow?.value) claimsMap = JSON.parse(claimRow.value);
    } catch (_) {}
  }
  let claimsDirty = false;
  const claimForTab = (uid: string): boolean => {
    if (!sessionId) return true;
    const existingOwner = claimsMap[uid];
    if (!existingOwner) {
      claimsMap[uid] = sessionId;
      claimsDirty = true;
      return true;
    }
    return existingOwner === sessionId;
  };

  const allPendingRows = db
    .prepare("SELECT * FROM messages WHERE status = 'pending' ORDER BY hlc ASC")
    .all() as Array<Record<string, unknown>>;
  const inboxPending = allPendingRows
    .filter((row) => {
      const toLower = String(row.to_user || '').trim().toLowerCase();
      const isForMe =
        recipientAliases.has(toLower) ||
        Boolean(row.from_did && localIdentity?.did && row.from_did !== localIdentity.did);
      if (!isForMe) return false;
      return claimForTab(`pending:${String(row.uid)}`);
    })
    .map((row) => {
      const m = hydrateMessage(row) as CourierMessage & { courier?: unknown };
      m.courier = buildCourierProfileInDb(db, m.fromRom, m.fromUser, 'COURIER');
      return m;
    });

  const inboxReplies = (
    db
      .prepare("SELECT * FROM messages WHERE status = 'replied' ORDER BY reply_hlc ASC")
      .all() as Array<Record<string, unknown>>
  )
    .filter((row) => {
      const fromLower = String(row.from_user || '').trim().toLowerCase();
      const isMine =
        recipientAliases.has(fromLower) ||
        Boolean(row.from_did && localIdentity?.did && row.from_did === localIdentity.did);
      if (!isMine) return false;
      return claimForTab(`reply:${String(row.uid)}:${String(row.reply_hlc || '')}`);
    })
    .map((row) => {
      const m = hydrateMessage(row) as CourierMessage & { courier?: unknown };
      m.courier = buildCourierProfileInDb(db, m.replyRom || m.fromRom, m.toUser, 'RETURN COURIER');
      return m;
    });

  if (claimsDirty) {
    try {
      db.prepare(
        `INSERT INTO meta (key, value, updated)
         VALUES ('courier_tab_claims', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated`
      ).run(JSON.stringify(claimsMap), new Date().toISOString());
    } catch (_) {}
  }

  return { inboxPending, inboxReplies };
}

function emitFrameCrdtUpdateInDb(db: DatabaseSync, seq: number): void {
  const row = db.prepare('SELECT * FROM frames WHERE seq = ?').get(seq) as Record<string, unknown> | undefined;
  if (!row) return;
  const identity = loadOrCreateIdentity();
  const project = String(row.project);
  const uid = String(row.uid || '') || `frame-${project}-${seq}-${crypto.randomBytes(4).toString('hex')}`;
  const hlc = nextHlc(identity.did, row.hlc ? String(row.hlc) : null);
  db.prepare('UPDATE frames SET uid = ?, hlc = ? WHERE seq = ?').run(uid, hlc, seq);
  let refs: string[] = [];
  try {
    refs = JSON.parse(String(row.refs || '[]'));
  } catch (_) {}
  appendCrdtOpInDb(db, {
    project,
    entity: 'frame',
    recordUid: uid,
    payload: {
      uid,
      hlc,
      ts: String(row.ts),
      project,
      kind: String(row.kind),
      summary: String(row.summary),
      detail: String(row.detail || ''),
      verified: String(row.verified || ''),
      open: Boolean(row.open),
      refs,
    },
  });
}

function appendCrdtOpInDb(
  db: DatabaseSync,
  {
    project,
    entity,
    recordUid,
    payload,
  }: {
    readonly project: string;
    readonly entity: string;
    readonly recordUid: string;
    readonly payload: unknown;
  },
  identityFile?: string
) {
  const identity = loadOrCreateIdentity(identityFile);
  const hlc = nextHlc(identity.did);
  const opId = `${hlc}:${entity}:${recordUid}`;
  db.prepare(
    `INSERT OR REPLACE INTO crdt_log (op_id, hlc, project, author_did, entity, record_uid, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(opId, hlc, project, identity.did, entity, recordUid, JSON.stringify(payload));
  const opHash64 = lattice.computeOpHash64(opId, hlc);
  const packedHlc64 = lattice.hlcStringToPacked64(hlc);
  lattice.globalHotArena.foldProjectOp(project, opHash64, packedHlc64);
  return { opId, hlc, authorDid: identity.did, opHash64 };
}

/**
 * Compacts superseded LWW operations in `crdt_log` for `project`, retaining only the
 * winning causal operation per `(entity, record_uid)` while preserving the 64-bit
 * Merkle-XOR frontier in `ConstructHotArena`.
 */
function compactProjectCrdtLogInDb(db, project) {
  const rows = db
    .prepare('SELECT op_id, hlc, entity, record_uid FROM crdt_log WHERE project = ? ORDER BY hlc ASC')
    .all(project);
  const winnerByKey = new Map();
  for (const r of rows) {
    winnerByKey.set(`${r.entity}:${r.record_uid}`, r.op_id);
  }
  const keepSet = new Set(winnerByKey.values());
  const delStmt = db.prepare('DELETE FROM crdt_log WHERE op_id = ?');
  let pruned = 0;
  for (const r of rows) {
    if (!keepSet.has(r.op_id)) {
      delStmt.run(r.op_id);
      pruned++;
    }
  }
  return {
    totalBefore: rows.length,
    retainedAfter: keepSet.size,
    pruned,
    merkleFrontier64: lattice.globalHotArena.readProjectFrontierFast(project),
  };
}

// Backfill existing project gotchas, frames, heads, and (when requested or on `@comms`) messages into crdt_log
function backfillProjectCrdtLogInDb(db, project, identityFile, options = {}) {
  const identity = loadOrCreateIdentity(identityFile);
  const isComms =
    project === '@comms' ||
    project === 'comms' ||
    String(project || '').toLowerCase().startsWith('@comms/');

  if (isComms || options.bridgeMessages) {
    const msgs = db.prepare("SELECT * FROM messages WHERE status != 'hidden' ORDER BY id ASC").all();
    const checkMsgOpStmt = db.prepare(
      "SELECT op_id, hlc, payload FROM crdt_log WHERE project = ? AND entity = 'message' AND record_uid = ? ORDER BY hlc DESC LIMIT 1"
    );
    const insertMsgOpStmt = db.prepare(
      `INSERT OR REPLACE INTO crdt_log (op_id, hlc, project, author_did, entity, record_uid, payload)
       VALUES (?, ?, ?, ?, 'message', ?, ?)`
    );
    const pairedProjects = new Set(
      db
        .prepare("SELECT project FROM mls_groups WHERE project NOT LIKE '@comms%'")
        .all()
        .map((r) => String(r.project || '').toLowerCase())
    );
    const sameOrRelatedProject = (msgProj, targetProj) => {
      if (!msgProj || msgProj === 'global' || msgProj === '@comms' || msgProj === 'comms') return true;
      if (msgProj === targetProj) return true;
      const mLower = String(msgProj).toLowerCase();
      const tLower = String(targetProj).toLowerCase();
      if (pairedProjects.has(mLower) && pairedProjects.has(tLower)) return true;
      const mParts = mLower.split('/');
      const tParts = tLower.split('/');
      return mParts.length === 2 && tParts.length === 2 && mParts[1] === tParts[1];
    };

    for (const m of msgs) {
      if (!isComms && !sameOrRelatedProject(m.project, project)) continue;
      const isLocalSender = !m.from_did || m.from_did === identity.did;
      const isLocalReplier =
        (m.status === 'seen' || m.status === 'replied' || m.status === 'delivered') &&
        m.from_did &&
        m.from_did !== identity.did;
      if (!isLocalSender && !isLocalReplier) continue;

      const existingOp = checkMsgOpStmt.get(project, m.uid);
      let existingStatus = '';
      let existingReplyHlc = '';
      if (existingOp && existingOp.payload) {
        try {
          const p = JSON.parse(existingOp.payload);
          existingStatus = p.status || '';
          existingReplyHlc = p.replyHlc || '';
        } catch (_) {}
      }
      if (
        existingOp &&
        !options.forceRequeue &&
        existingStatus === (m.status || 'pending') &&
        existingReplyHlc === (m.reply_hlc || '')
      ) {
        continue;
      }

      const baseHlc = m.reply_hlc || m.hlc || nextHlc(identity.did);
      const opHlc = options.freshHlc ? nextHlc(identity.did, baseHlc) : baseHlc;
      const payloadProject = isComms ? m.project || 'global' : project;
      const opId = `${opHlc}:message:${m.uid}`;
      insertMsgOpStmt.run(
        opId,
        opHlc,
        project,
        identity.did,
        m.uid,
        JSON.stringify({
          uid: m.uid,
          hlc: m.hlc || opHlc,
          project: payloadProject,
          originalProject: m.project || 'global',
          fromUser: m.from_user,
          fromRom: m.from_rom,
          fromDid: m.from_did || identity.did,
          toUser: m.to_user,
          body: m.body,
          status: m.status || 'pending',
          replyBody: m.reply_body || '',
          replyRom: m.reply_rom || '',
          replyHlc: m.reply_hlc || '',
          created: m.created,
        })
      );
    }
    if (isComms) return;
  }

  const updateGotchaStmt = db.prepare('UPDATE gotchas SET uid = ?, hlc = ? WHERE id = ?');
  const insertGotchaOpStmt = db.prepare(
    `INSERT OR IGNORE INTO crdt_log (op_id, hlc, project, author_did, entity, record_uid, payload)
     VALUES (?, ?, ?, ?, 'gotcha', ?, ?)`
  );
  const updateFrameStmt = db.prepare('UPDATE frames SET uid = ?, hlc = ? WHERE seq = ?');
  const insertFrameOpStmt = db.prepare(
    `INSERT OR IGNORE INTO crdt_log (op_id, hlc, project, author_did, entity, record_uid, payload)
     VALUES (?, ?, ?, ?, 'frame', ?, ?)`
  );

  const gotchas = db.prepare('SELECT * FROM gotchas WHERE scope = ? ORDER BY id ASC').all(project);
  for (const g of gotchas) {
    const uid = g.uid || `gotcha-${project}-${g.id}-${crypto.randomBytes(4).toString('hex')}`;
    const hlc = g.hlc || nextHlc(identity.did);
    if (!g.uid || !g.hlc) {
      updateGotchaStmt.run(uid, hlc, g.id);
    }
    const opId = `${hlc}:gotcha:${uid}`;
    insertGotchaOpStmt.run(
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
        guardRegex: g.guard_regex || '',
        guardPlatform: g.guard_platform || 'all',
        created: g.created,
      })
    );
  }

  const frames = db.prepare('SELECT * FROM frames WHERE project = ? ORDER BY seq ASC').all(project);
  for (const f of frames) {
    const uid = f.uid || `frame-${project}-${f.seq}-${crypto.randomBytes(4).toString('hex')}`;
    const hlc = f.hlc || nextHlc(identity.did);
    if (!f.uid || !f.hlc) {
      updateFrameStmt.run(uid, hlc, f.seq);
    }
    const opId = `${hlc}:frame:${uid}`;
    insertFrameOpStmt.run(
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
    const existingHeadOp = db
      .prepare("SELECT op_id FROM crdt_log WHERE project = ? AND entity = 'head' AND record_uid = ?")
      .get(project, `${project}:${head.updated || ''}`);
    if (!existingHeadOp) {
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
        `${project}:${head.updated || ''}`,
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
}

// Merge an array of incoming CRDT operations idempotently & deterministically (G-Set + LWW-Element-Map by HLC).
// When `allowedProject` is given (always set on MLS group packet import), any op targeting a different
// project or global scope, or carrying a future-poisoned HLC timestamp (`> now + 5m`), is rejected at the boundary.
function applyCrdtOpsInDb(db, ops, identityFile, allowedProject = null) {
  if (!Array.isArray(ops) || !ops.length) return 0;
  const identity = loadOrCreateIdentity(identityFile);
  const nowMs = Date.now();
  let applied = 0;

  const seenOpStmt = db.prepare('SELECT op_id FROM crdt_log WHERE op_id = ?');
  const insertOpStmt = db.prepare(
    `INSERT INTO crdt_log (op_id, hlc, project, author_did, entity, record_uid, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const selectGotchaStmt = db.prepare('SELECT * FROM gotchas WHERE uid = ?');
  const selectGotchaByTitleStmt = db.prepare('SELECT * FROM gotchas WHERE scope = ? AND lower(title) = lower(?) LIMIT 1');
  const insertGotchaStmt = db.prepare(
    `INSERT INTO gotchas (uid, hlc, scope, title, status, tags, evidence, fix, guard_regex, guard_platform, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateGotchaStmt = db.prepare(
    `UPDATE gotchas SET hlc = ?, title = ?, status = ?, tags = ?, evidence = ?, fix = ?, guard_regex = ?, guard_platform = ? WHERE id = ?`
  );
  const selectFrameStmt = db.prepare('SELECT * FROM frames WHERE uid = ?');
  const selectFrameBySummaryStmt = db.prepare('SELECT * FROM frames WHERE project = ? AND kind = ? AND summary = ? LIMIT 1');
  const insertFrameStmt = db.prepare(
    `INSERT INTO frames (uid, hlc, ts, project, kind, summary, detail, verified, open, refs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateFrameStmt = db.prepare(
    `UPDATE frames SET hlc = ?, summary = ?, detail = ?, verified = ?, open = ?, refs = ? WHERE seq = ?`
  );
  const selectHeadStmt = db.prepare('SELECT * FROM heads WHERE project = ?');
  const upsertHeadStmt = db.prepare(
    `INSERT INTO heads (project, repo, state, next, updated)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project) DO UPDATE SET
       state = excluded.state,
       next = excluded.next,
       updated = excluded.updated`
  );
  const selectMsgStmt = db.prepare('SELECT * FROM messages WHERE uid = ?');
  const selectMsgTombstoneStmt = db.prepare(
    "SELECT 1 FROM crdt_log WHERE entity = 'message_tombstone' AND record_uid = ? LIMIT 1"
  );
  const deleteMsgByUidStmt = db.prepare('DELETE FROM messages WHERE uid = ?');
  const insertMsgStmt = db.prepare(
    `INSERT INTO messages (uid, hlc, project, from_user, from_rom, from_did, to_user, body, status, reply_body, reply_rom, reply_hlc, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateMsgStmt = db.prepare(
    `UPDATE messages
     SET status = ?, reply_body = ?, reply_rom = ?, reply_hlc = ?
     WHERE uid = ?`
  );

  for (const op of ops) {
    if (!op || !op.opId || !op.hlc || !op.entity || !op.payload) continue;
    // Reject future-timestamp HLC poisoning (> 5 minutes ahead of wall clock)
    if (!isHlcWithinDrift(op.hlc, nowMs)) continue;
    if (op.payload.hlc && !isHlcWithinDrift(op.payload.hlc, nowMs)) continue;
    if (op.payload.replyHlc && !isHlcWithinDrift(op.payload.replyHlc, nowMs)) continue;

    if (allowedProject) {
      const isCommsOnly =
        allowedProject === '@comms' ||
        allowedProject === 'comms' ||
        String(allowedProject).toLowerCase().startsWith('@comms/');
      if (isCommsOnly) {
        if (op.entity !== 'message' && op.entity !== 'message_tombstone') continue;
      } else {
        const sameProjectOrRenamedOwner = (candidate, target) => {
          if (!candidate || candidate === 'global') return false;
          if (candidate === target) return true;
          const cParts = String(candidate).toLowerCase().split('/');
          const tParts = String(target).toLowerCase().split('/');
          if (cParts.length === 2 && tParts.length === 2 && cParts[1] === tParts[1]) {
            return true;
          }
          return false;
        };
        if (!sameProjectOrRenamedOwner(op.project, allowedProject)) continue;
        if (op.entity === 'gotcha' && op.payload.scope && !sameProjectOrRenamedOwner(op.payload.scope, allowedProject)) continue;
        if (op.entity === 'frame' && op.payload.project && !sameProjectOrRenamedOwner(op.payload.project, allowedProject)) continue;
        if (op.entity === 'message' && op.payload.project && !sameProjectOrRenamedOwner(op.payload.project, allowedProject)) continue;
        op.project = allowedProject;
        if (op.payload && typeof op.payload === 'object') {
          if (typeof op.payload.project === 'string') op.payload.project = allowedProject;
          if (typeof op.payload.scope === 'string') op.payload.scope = allowedProject;
        }
      }
    }
    // Advance local HLC past remote HLC so causal ordering holds
    nextHlc(identity.did, op.hlc, nowMs);

    const seen = seenOpStmt.get(op.opId);
    if (seen) continue;

    insertOpStmt.run(
      op.opId,
      op.hlc,
      op.project,
      op.authorDid || 'remote',
      op.entity,
      op.recordUid,
      JSON.stringify(op.payload)
    );
    lattice.globalHotArena.foldProjectOp(
      op.project,
      lattice.computeOpHash64(op.opId, op.hlc),
      lattice.hlcStringToPacked64(op.hlc)
    );

    const p = op.payload;
    if (op.entity === 'gotcha') {
      const scope = p.scope || op.project;
      const existing = selectGotchaStmt.get(p.uid) || selectGotchaByTitleStmt.get(scope, p.title || '');
      if (!existing) {
        insertGotchaStmt.run(
          p.uid,
          p.hlc || op.hlc,
          scope,
          p.title,
          p.status || 'observed',
          JSON.stringify(p.tags || []),
          p.evidence || '',
          p.fix || '',
          p.guardRegex || '',
          p.guardPlatform || 'all',
          p.created || ''
        );
        applied++;
      } else if ((p.hlc || op.hlc) > (existing.hlc || '')) {
        updateGotchaStmt.run(
          p.hlc || op.hlc,
          p.title,
          p.status || existing.status,
          JSON.stringify(p.tags || []),
          p.evidence || existing.evidence || '',
          p.fix && !/^Found\s+\d{4}-\d{2}-\d{2}\b/i.test(p.fix) ? p.fix : existing.fix || p.fix || '',
          p.guardRegex !== undefined ? p.guardRegex : existing.guard_regex || '',
          p.guardPlatform !== undefined ? p.guardPlatform : existing.guard_platform || 'all',
          existing.id
        );
        applied++;
      }
    } else if (op.entity === 'frame') {
      const proj = p.project || op.project;
      const kind = p.kind || 'finding';
      const existing =
        selectFrameStmt.get(p.uid) ||
        (kind === 'thread' && /^\[(?:GH|PR) #\d+\]/i.test(p.summary || '')
          ? selectFrameBySummaryStmt.get(proj, kind, p.summary)
          : null);
      if (!existing) {
        insertFrameStmt.run(
          p.uid,
          p.hlc || op.hlc,
          p.ts || new Date().toISOString(),
          proj,
          kind,
          p.summary,
          p.detail || '',
          p.verified || '',
          p.open ? 1 : 0,
          JSON.stringify(p.refs || [])
        );
        applied++;
      } else if ((p.hlc || op.hlc) > (existing.hlc || '')) {
        updateFrameStmt.run(
          p.hlc || op.hlc,
          p.summary ?? existing.summary,
          p.detail ?? existing.detail,
          p.verified ?? existing.verified,
          p.open !== undefined ? (p.open ? 1 : 0) : existing.open,
          JSON.stringify(p.refs || JSON.parse(existing.refs || '[]')),
          existing.seq
        );
        applied++;
      }
    } else if (op.entity === 'head') {
      const existing = selectHeadStmt.get(op.project);
      if (!existing || (p.updated || '') >= (existing.updated || '')) {
        const localRepo = existing && existing.repo ? existing.repo : p.repo || '';
        upsertHeadStmt.run(op.project, localRepo, p.state || '', p.next || '', p.updated || new Date().toISOString());
        applied++;
      }
    } else if (op.entity === 'message_tombstone') {
      const targetUid = p.uid || op.recordUid;
      if (targetUid) {
        deleteMsgByUidStmt.run(targetUid);
        applied++;
      }
    } else if (op.entity === 'message') {
      if (selectMsgTombstoneStmt.get(p.uid)) continue;
      const existing = selectMsgStmt.get(p.uid);
      if (!existing) {
        insertMsgStmt.run(
          p.uid,
          p.hlc || op.hlc,
          p.originalProject || p.project || op.project,
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
        const rankMap = { pending: 1, seen: 2, replied: 3, delivered: 4, hidden: 5 };
        const curRank = rankMap[existing.status] || 1;
        const incRank = rankMap[p.status] || 1;
        const nextStatus = incRank >= curRank ? p.status || existing.status : existing.status;
        updateMsgStmt.run(
          nextStatus,
          p.replyBody || existing.reply_body,
          p.replyRom || existing.reply_rom,
          p.replyHlc || op.hlc,
          p.uid
        );
        applied++;
      }
    }
  }

  return applied;
}

function reconcileCommsGroupInDb(db, group, envelope, commsGroup) {
  if (!commsGroup || !commsGroup.groupId || !commsGroup.epochSecret) return;
  const cg = commsGroup;
  const localCommsRow = db.prepare("SELECT * FROM mls_groups WHERE project = '@comms'").get();
  const localComms = localCommsRow ? hydrateMlsGroup(localCommsRow) : null;
  const mergedMembers = [...(localComms?.members || []), ...(group.members || [])];
  const senderIsV2 = Number(envelope?.v) >= 2;
  if (!mergedMembers.some((m) => m.did === envelope.senderDid)) {
    mergedMembers.push({
      did: envelope.senderDid,
      userId: 'peer',
      signPub: envelope.senderSignPub,
      dhPub: '',
      latticeV2: senderIsV2,
    });
  }
  const dedupMembers = [];
  const seenDids = new Set();
  for (const m of mergedMembers) {
    if (m && m.did && !seenDids.has(m.did)) {
      seenDids.add(m.did);
      if (m.did === envelope.senderDid && senderIsV2) {
        dedupMembers.push({ ...m, latticeV2: true });
      } else {
        dedupMembers.push(m);
      }
    }
  }
  const mergedRelays = Array.from(
    new Set([...(localComms?.relays || []), ...(Array.isArray(cg.relays) ? cg.relays : []), ...(group.relays || [])])
  );
  const now = new Date().toISOString();
  if (!localComms) {
    db.prepare(
      `INSERT INTO mls_groups (project, group_id, epoch, epoch_secret, members, relays, last_sync_hlc, updated)
       VALUES ('@comms', ?, ?, ?, ?, ?, '', ?)`
    ).run(cg.groupId, Number(cg.epoch || 1), cg.epochSecret, JSON.stringify(dedupMembers), JSON.stringify(mergedRelays), now);
    backfillProjectCrdtLogInDb(db, '@comms', undefined, { freshHlc: true, forceRequeue: true });
    return;
  }
  if (localComms.groupId === cg.groupId) {
    db.prepare("UPDATE mls_groups SET members = ?, relays = ?, updated = ? WHERE project = '@comms'").run(
      JSON.stringify(dedupMembers),
      JSON.stringify(mergedRelays),
      now
    );
    return;
  }
  const remoteEpoch = Number(cg.epoch || 1);
  const localEpoch = Number(localComms.epoch || 1);
  const remoteWins =
    remoteEpoch > localEpoch || (remoteEpoch === localEpoch && String(cg.groupId) > String(localComms.groupId));
  const loser = remoteWins
    ? { groupId: localComms.groupId, epoch: localEpoch, epochSecret: localComms.epochSecret }
    : { groupId: cg.groupId, epoch: remoteEpoch, epochSecret: cg.epochSecret };
  const winner = remoteWins
    ? { groupId: cg.groupId, epoch: remoteEpoch, epochSecret: cg.epochSecret }
    : { groupId: localComms.groupId, epoch: localEpoch, epochSecret: localComms.epochSecret };

  db.prepare(
    `INSERT INTO mls_groups (project, group_id, epoch, epoch_secret, members, relays, last_sync_hlc, updated)
     VALUES (?, ?, ?, ?, ?, ?, '', ?)
     ON CONFLICT(project) DO UPDATE SET
       group_id = excluded.group_id,
       epoch = excluded.epoch,
       epoch_secret = excluded.epoch_secret,
       members = excluded.members,
       relays = excluded.relays,
       updated = excluded.updated`
  ).run(
    `@comms/peer/${loser.groupId}`,
    loser.groupId,
    loser.epoch,
    loser.epochSecret,
    JSON.stringify(dedupMembers),
    JSON.stringify(mergedRelays),
    now
  );

  if (remoteWins) {
    db.prepare(
      `UPDATE mls_groups
       SET group_id = ?, epoch = ?, epoch_secret = ?, members = ?, relays = ?, last_sync_hlc = '', updated = ?
       WHERE project = '@comms'`
    ).run(winner.groupId, winner.epoch, winner.epochSecret, JSON.stringify(dedupMembers), JSON.stringify(mergedRelays), now);
    backfillProjectCrdtLogInDb(db, '@comms', undefined, { freshHlc: true, forceRequeue: true });
  } else {
    db.prepare("UPDATE mls_groups SET members = ?, relays = ?, updated = ? WHERE project = '@comms'").run(
      JSON.stringify(dedupMembers),
      JSON.stringify(mergedRelays),
      now
    );
  }
}

module.exports = {
  DEFAULT_RELAYS,
  MAX_HLC_DRIFT_MS,
  identityFilePath,
  loadOrCreateIdentity,
  makeDidKeyFromEd25519Spki,
  parseHlc,
  isHlcWithinDrift,
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
  selectInboxForBootInDb,
  emitFrameCrdtUpdateInDb,
  appendCrdtOpInDb,
  compactProjectCrdtLogInDb,
  backfillProjectCrdtLogInDb,
  reconcileCommsGroupInDb,
  applyCrdtOpsInDb,
  lattice,
};
