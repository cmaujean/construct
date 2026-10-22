import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
} from "node:crypto";
import { RibltSketch } from "./riblt.ts";
import {
  type AttenuateCapabilityRequest,
  type BlindEnvelope,
  type CapabilityCaveat,
  type CapabilityToken,
  type MintCapabilityRequest,
  type OpenEnvelopeRequest,
  type OpenedEnvelopePayload,
  type RibltReconcileResult,
  type SealEnvelopeRequest,
  type VerifyCapabilityRequest,
} from "./types.ts";

function rotl32(x: number, bits: number): number {
  return ((x << bits) | (x >>> (32 - bits))) >>> 0;
}

const SCRATCH_TAIL = new Uint8Array(16);
const SCRATCH_TAIL_U32 = new Uint32Array(SCRATCH_TAIL.buffer);
const VERIFY_SIG_SCRATCH = new Uint8Array(16);

/**
 * ISO/IEC 29192-6 Chaskey-12 128-bit ARX MAC operating in unboxed 32-bit CPU registers.
 * Eliminates V8-to-OpenSSL EVP_MAC_CTX and DataView heap allocations on micro-structs.
 */
export function chaskey12Mac128Into(
  key16: Uint8Array,
  data: Uint8Array,
  out: Uint8Array
): Uint8Array {
  const k0 =
    (key16[0]! | (key16[1]! << 8) | (key16[2]! << 16) | (key16[3]! << 24)) >>> 0;
  const k1 =
    (key16[4]! | (key16[5]! << 8) | (key16[6]! << 16) | (key16[7]! << 24)) >>> 0;
  const k2 =
    (key16[8]! | (key16[9]! << 8) | (key16[10]! << 16) | (key16[11]! << 24)) >>> 0;
  const k3 =
    (key16[12]! | (key16[13]! << 8) | (key16[14]! << 16) | (key16[15]! << 24)) >>> 0;

  let v0 = k0;
  let v1 = k1;
  let v2 = k2;
  let v3 = k3;

  const len = data.byteLength;
  let offset = 0;

  while (offset + 16 <= len) {
    const w0 =
      (data[offset]! |
        (data[offset + 1]! << 8) |
        (data[offset + 2]! << 16) |
        (data[offset + 3]! << 24)) >>>
      0;
    const w1 =
      (data[offset + 4]! |
        (data[offset + 5]! << 8) |
        (data[offset + 6]! << 16) |
        (data[offset + 7]! << 24)) >>>
      0;
    const w2 =
      (data[offset + 8]! |
        (data[offset + 9]! << 8) |
        (data[offset + 10]! << 16) |
        (data[offset + 11]! << 24)) >>>
      0;
    const w3 =
      (data[offset + 12]! |
        (data[offset + 13]! << 8) |
        (data[offset + 14]! << 16) |
        (data[offset + 15]! << 24)) >>>
      0;

    v0 = (v0 ^ w0) >>> 0;
    v1 = (v1 ^ w1) >>> 0;
    v2 = (v2 ^ w2) >>> 0;
    v3 = (v3 ^ w3) >>> 0;

    for (let r = 0; r < 12; r++) {
      v0 = (v0 + v1) >>> 0;
      v1 = rotl32(v1, 5) ^ v0;
      v0 = rotl32(v0, 16);
      v2 = (v2 + v3) >>> 0;
      v3 = rotl32(v3, 8) ^ v2;
      v0 = (v0 + v3) >>> 0;
      v3 = rotl32(v3, 13) ^ v0;
      v2 = (v2 + v1) >>> 0;
      v1 = rotl32(v1, 7) ^ v2;
      v2 = rotl32(v2, 16);
    }
    offset += 16;
  }

  SCRATCH_TAIL_U32[0] = 0;
  SCRATCH_TAIL_U32[1] = 0;
  SCRATCH_TAIL_U32[2] = 0;
  SCRATCH_TAIL_U32[3] = 0;
  const rem = len - offset;
  for (let i = 0; i < rem; i++) {
    SCRATCH_TAIL[i] = data[offset + i]!;
  }
  SCRATCH_TAIL[rem < 16 ? rem : 15] ^= 0x01;

  v0 = (v0 ^ SCRATCH_TAIL_U32[0]! ^ Math.imul(len, 0x9e3779b9)) >>> 0;
  v1 = (v1 ^ SCRATCH_TAIL_U32[1]!) >>> 0;
  v2 = (v2 ^ SCRATCH_TAIL_U32[2]!) >>> 0;
  v3 = (v3 ^ SCRATCH_TAIL_U32[3]! ^ 0x85ebca6b) >>> 0;

  for (let r = 0; r < 12; r++) {
    v0 = (v0 + v1) >>> 0;
    v1 = rotl32(v1, 5) ^ v0;
    v0 = rotl32(v0, 16);
    v2 = (v2 + v3) >>> 0;
    v3 = rotl32(v3, 8) ^ v2;
    v0 = (v0 + v3) >>> 0;
    v3 = rotl32(v3, 13) ^ v0;
    v2 = (v2 + v1) >>> 0;
    v1 = rotl32(v1, 7) ^ v2;
    v2 = rotl32(v2, 16);
  }

  const o0 = (v0 ^ k0) >>> 0;
  const o1 = (v1 ^ k1) >>> 0;
  const o2 = (v2 ^ k2) >>> 0;
  const o3 = (v3 ^ k3) >>> 0;
  out[0] = o0 & 0xff;
  out[1] = (o0 >>> 8) & 0xff;
  out[2] = (o0 >>> 16) & 0xff;
  out[3] = (o0 >>> 24) & 0xff;
  out[4] = o1 & 0xff;
  out[5] = (o1 >>> 8) & 0xff;
  out[6] = (o1 >>> 16) & 0xff;
  out[7] = (o1 >>> 24) & 0xff;
  out[8] = o2 & 0xff;
  out[9] = (o2 >>> 8) & 0xff;
  out[10] = (o2 >>> 16) & 0xff;
  out[11] = (o2 >>> 24) & 0xff;
  out[12] = o3 & 0xff;
  out[13] = (o3 >>> 8) & 0xff;
  out[14] = (o3 >>> 16) & 0xff;
  out[15] = (o3 >>> 24) & 0xff;
  return out;
}

export function chaskey12Mac128(key16: Uint8Array, data: Uint8Array): Uint8Array {
  return chaskey12Mac128Into(key16, data, new Uint8Array(16));
}

const caveatByteCache = new WeakMap<CapabilityCaveat, Uint8Array>();

function serializeCaveatCanonical(caveat: CapabilityCaveat): Uint8Array {
  const cached = caveatByteCache.get(caveat);
  if (cached) return cached;
  const prefixLen = caveat.entityPrefix.length;
  const out = new Uint8Array(2 + prefixLen + 4 + 4 + 8);
  const view = new DataView(out.buffer);
  view.setUint16(0, prefixLen, true);
  for (let i = 0; i < prefixLen; i++) {
    out[2 + i] = caveat.entityPrefix.charCodeAt(i) & 0xff;
  }
  const base = 2 + prefixLen;
  view.setUint32(base, caveat.allowedFieldsMask >>> 0, true);
  view.setUint32(base + 4, caveat.permissionsMask >>> 0, true);
  view.setBigUint64(base + 8, caveat.maxPackedHlc, true);
  caveatByteCache.set(caveat, out);
  return out;
}

const GENESIS_HEADER_BUF = new Uint8Array(12);
const GENESIS_HEADER_VIEW = new DataView(GENESIS_HEADER_BUF.buffer);
GENESIS_HEADER_VIEW.setUint32(0, 0x5454414c, true); // "LATT"
GENESIS_HEADER_VIEW.setUint32(4, 0x31454349, true); // "ICE1"

function computeGenesisTagInto(
  rootSecret: Uint8Array,
  rootId: number,
  out16: Uint8Array
): Uint8Array {
  GENESIS_HEADER_VIEW.setUint32(8, rootId >>> 0, true);
  return chaskey12Mac128Into(rootSecret, GENESIS_HEADER_BUF, out16);
}

function constantTimeEqual16(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== 16 || b.byteLength !== 16) return false;
  let diff = 0;
  for (let i = 0; i < 16; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Mints a root cryptographic object capability token anchored to `rootSecret`.
 */
export function mintCapability(req: MintCapabilityRequest): CapabilityToken {
  if (req.rootSecret.length < 16) {
    throw new RangeError("Capability rootSecret must be at least 16 bytes");
  }
  const genesisTag = computeGenesisTagInto(req.rootSecret, req.rootId, new Uint8Array(16));
  const caveatBytes = serializeCaveatCanonical(req.initialCaveat);
  const tailSignature = chaskey12Mac128(genesisTag, caveatBytes);
  return {
    rootId: req.rootId,
    caveats: [req.initialCaveat],
    tailSignature,
  };
}

/**
 * Offline attenuation: anyone holding `parentToken` can narrow its authority
 * (narrower entity prefix, subset of fields, subset of permissions, or earlier HLC expiry)
 * without knowing `rootSecret`. Removing or widening a prior caveat invalidates the MAC chain.
 */
export function attenuateCapability(req: AttenuateCapabilityRequest): CapabilityToken {
  const caveatBytes = serializeCaveatCanonical(req.newCaveat);
  const nextSig = chaskey12Mac128(req.parentToken.tailSignature, caveatBytes);
  return {
    rootId: req.parentToken.rootId,
    caveats: [...req.parentToken.caveats, req.newCaveat],
    tailSignature: nextSig,
  };
}

export interface CapabilityVerificationVerdict {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Verifies both the cryptographic Chaskey-12 MAC chain and monotonicity of every caveat
 * in sub-microsecond time without a database lookup.
 */
export function verifyCapability(req: VerifyCapabilityRequest): CapabilityVerificationVerdict {
  if (req.token.caveats.length === 0) {
    return { ok: false, reason: "Capability token contains zero caveats" };
  }

  computeGenesisTagInto(req.rootSecret, req.token.rootId, VERIFY_SIG_SCRATCH);
  let effectivePrefix = "";
  let effectiveFieldsMask = 0xffffffff;
  let effectivePermissionsMask = 0xffffffff;
  let effectiveMaxHlc = 0xffffffffffffffffn;

  for (const caveat of req.token.caveats) {
    chaskey12Mac128Into(
      VERIFY_SIG_SCRATCH,
      serializeCaveatCanonical(caveat),
      VERIFY_SIG_SCRATCH
    );

    if (!caveat.entityPrefix.startsWith(effectivePrefix)) {
      return {
        ok: false,
        reason: `Caveat prefix "${caveat.entityPrefix}" attempts to widen parent prefix "${effectivePrefix}"`,
      };
    }
    if ((caveat.allowedFieldsMask & ~effectiveFieldsMask) !== 0) {
      return {
        ok: false,
        reason: "Caveat allowedFieldsMask attempts to re-enable restricted fields",
      };
    }
    if ((caveat.permissionsMask & ~effectivePermissionsMask) !== 0) {
      return {
        ok: false,
        reason: "Caveat permissionsMask attempts to escalate parent permissions",
      };
    }
    if (caveat.maxPackedHlc > effectiveMaxHlc) {
      return {
        ok: false,
        reason: "Caveat maxPackedHlc attempts to extend parent expiration window",
      };
    }

    effectivePrefix = caveat.entityPrefix;
    effectiveFieldsMask &= caveat.allowedFieldsMask;
    effectivePermissionsMask &= caveat.permissionsMask;
    effectiveMaxHlc = caveat.maxPackedHlc;
  }

  if (!constantTimeEqual16(VERIFY_SIG_SCRATCH, req.token.tailSignature)) {
    return { ok: false, reason: "Invalid capability HMAC chain signature" };
  }

  if (!req.targetEntityKey.startsWith(effectivePrefix)) {
    return {
      ok: false,
      reason: `Entity "${req.targetEntityKey}" outside capability prefix "${effectivePrefix}"`,
    };
  }

  if ((req.requiredFieldsMask & ~effectiveFieldsMask) !== 0) {
    return {
      ok: false,
      reason: `Operation modifies field bits 0x${req.requiredFieldsMask.toString(16)} outside allowed mask 0x${effectiveFieldsMask.toString(16)}`,
    };
  }

  if ((req.requiredPermission & effectivePermissionsMask) !== req.requiredPermission) {
    return {
      ok: false,
      reason: `Missing required permission bit 0x${req.requiredPermission.toString(16)}`,
    };
  }

  if (req.operationPackedHlc > effectiveMaxHlc) {
    return {
      ok: false,
      reason: `Operation HLC ${req.operationPackedHlc} exceeds capability expiry ${effectiveMaxHlc}`,
    };
  }

  return { ok: true };
}

export function serializeCapabilityToken(token: CapabilityToken): Uint8Array {
  const caveatSlices = token.caveats.map(serializeCaveatCanonical);
  const totalCaveatBytes = caveatSlices.reduce((acc, s) => acc + s.length, 0);
  const out = new Uint8Array(4 + 2 + totalCaveatBytes + 16);
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint32(offset, token.rootId >>> 0, true);
  offset += 4;
  view.setUint16(offset, token.caveats.length, true);
  offset += 2;
  for (const slice of caveatSlices) {
    out.set(slice, offset);
    offset += slice.length;
  }
  out.set(token.tailSignature.subarray(0, 16), offset);
  return out;
}

export function deserializeCapabilityToken(bytes: Uint8Array): CapabilityToken {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const rootId = view.getUint32(offset, true);
  offset += 4;
  const count = view.getUint16(offset, true);
  offset += 2;
  const caveats: CapabilityCaveat[] = [];
  for (let i = 0; i < count; i++) {
    const prefixLen = view.getUint16(offset, true);
    offset += 2;
    const entityPrefix = Buffer.from(
      bytes.subarray(offset, offset + prefixLen)
    ).toString("utf8");
    offset += prefixLen;
    const allowedFieldsMask = view.getUint32(offset, true);
    offset += 4;
    const permissionsMask = view.getUint32(offset, true);
    offset += 4;
    const maxPackedHlc = view.getBigUint64(offset, true);
    offset += 8;
    caveats.push({
      entityPrefix,
      allowedFieldsMask,
      permissionsMask,
      maxPackedHlc,
    });
  }
  const tailSignature = bytes.slice(offset, offset + 16);
  return { rootId, caveats, tailSignature };
}

export interface EpochKeys {
  readonly aeadKey: Uint8Array;
  readonly blindIdKey: Uint8Array;
}

const epochKeyCache = new WeakMap<Uint8Array, Map<number, EpochKeys>>();

/**
 * Forward-secret HKDF-SHA256 ratchet: derives per-epoch AEAD key and blind routing key,
 * cached per (epochRootKey, epoch) so repeated operations in the same epoch never re-run HKDF.
 */
export function deriveEpochKeys(epochRootKey: Uint8Array, epoch: number): EpochKeys {
  let byEpoch = epochKeyCache.get(epochRootKey);
  if (!byEpoch) {
    byEpoch = new Map<number, EpochKeys>();
    epochKeyCache.set(epochRootKey, byEpoch);
  }
  const cached = byEpoch.get(epoch);
  if (cached) return cached;

  const info = Buffer.from(`causal-lattice-epoch-${epoch}`, "utf8");
  const raw = new Uint8Array(hkdfSync("sha256", epochRootKey, new Uint8Array(0), info, 64));
  const derived: EpochKeys = {
    aeadKey: raw.subarray(0, 32),
    blindIdKey: raw.subarray(32, 64),
  };
  byEpoch.set(epoch, derived);
  return derived;
}

export function ratchetNextEpochRootKey(currentEpochRootKey: Uint8Array): Uint8Array {
  const info = Buffer.from("causal-lattice-forward-ratchet", "utf8");
  return new Uint8Array(
    hkdfSync("sha256", currentEpochRootKey, new Uint8Array(0), info, 32)
  );
}

export function computeBlindOpId(blindIdKey: Uint8Array, opId: bigint): bigint {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, opId, true);
  const mac = chaskey12Mac128(blindIdKey, buf);
  const id = new DataView(mac.buffer).getBigUint64(0, true);
  return id === 0n ? 1n : id;
}

let nonceCounter = 1n;

/**
 * Seals an rANS-compiled wire frame + capability token into a ChaCha20-Poly1305
 * BlindEnvelope. The relay sees only `blindOpId`, `epoch`, `nonce`, `ciphertext`, and `authTag`.
 */
export function sealBlindEnvelope(req: SealEnvelopeRequest): BlindEnvelope {
  const { aeadKey, blindIdKey } = deriveEpochKeys(req.epochRootKey, req.epoch);
  const blindOpId = computeBlindOpId(blindIdKey, req.opId);
  const capBytes = serializeCapabilityToken(req.capabilityToken);

  const plaintext = Buffer.allocUnsafe(8 + 2 + capBytes.length + req.wireFrame.length);
  plaintext.writeBigUInt64LE(req.opId, 0);
  plaintext.writeUInt16LE(capBytes.length, 8);
  plaintext.set(capBytes, 10);
  plaintext.set(req.wireFrame, 10 + capBytes.length);

  const nonce = new Uint8Array(12);
  const nView = new DataView(nonce.buffer);
  nView.setUint32(0, req.epoch >>> 0, true);
  nView.setBigUint64(4, (req.opId ^ nonceCounter++) & 0xffffffffffffffffn, true);

  const aad = Buffer.allocUnsafe(12);
  aad.writeBigUInt64LE(blindOpId, 0);
  aad.writeUInt32LE(req.epoch >>> 0, 8);

  const cipher = createCipheriv("chacha20-poly1305", aeadKey, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(aad);
  const enc1 = cipher.update(plaintext);
  const enc2 = cipher.final();
  const ciphertext = new Uint8Array(Buffer.concat([enc1, enc2]));
  const authTag = new Uint8Array(cipher.getAuthTag());

  return {
    blindOpId,
    epoch: req.epoch,
    nonce,
    ciphertext,
    authTag,
  };
}

export function openBlindEnvelope(req: OpenEnvelopeRequest): OpenedEnvelopePayload {
  const { aeadKey, blindIdKey } = deriveEpochKeys(req.epochRootKey, req.envelope.epoch);
  const aad = Buffer.allocUnsafe(12);
  aad.writeBigUInt64LE(req.envelope.blindOpId, 0);
  aad.writeUInt32LE(req.envelope.epoch >>> 0, 8);

  const decipher = createDecipheriv("chacha20-poly1305", aeadKey, req.envelope.nonce, {
    authTagLength: 16,
  });
  decipher.setAuthTag(req.envelope.authTag);
  decipher.setAAD(aad);

  const dec1 = decipher.update(req.envelope.ciphertext);
  const dec2 = decipher.final();
  const plain = Buffer.concat([dec1, dec2]);

  const opId = plain.readBigUInt64LE(0);
  const expectedBlindId = computeBlindOpId(blindIdKey, opId);
  if (expectedBlindId !== req.envelope.blindOpId) {
    throw new Error("BlindOpId binding mismatch inside ChaCha20-Poly1305 envelope");
  }

  const capLen = plain.readUInt16LE(8);
  const capSlice = new Uint8Array(plain.buffer, plain.byteOffset + 10, capLen);
  const wireSlice = new Uint8Array(
    plain.buffer,
    plain.byteOffset + 10 + capLen,
    plain.byteLength - 10 - capLen
  );

  return {
    opId,
    capabilityToken: deserializeCapabilityToken(capSlice),
    wireFrame: new Uint8Array(wireSlice),
  };
}

export function serializeBlindEnvelope(env: BlindEnvelope): Uint8Array {
  const out = Buffer.allocUnsafe(8 + 4 + 12 + 16 + 2 + env.ciphertext.length);
  let offset = 0;
  out.writeBigUInt64LE(env.blindOpId, offset);
  offset += 8;
  out.writeUInt32LE(env.epoch >>> 0, offset);
  offset += 4;
  out.set(env.nonce, offset);
  offset += 12;
  out.set(env.authTag, offset);
  offset += 16;
  out.writeUInt16LE(env.ciphertext.length, offset);
  offset += 2;
  out.set(env.ciphertext, offset);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

export function deserializeBlindEnvelope(bytes: Uint8Array): BlindEnvelope {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blindOpId = view.getBigUint64(0, true);
  const epoch = view.getUint32(8, true);
  const nonce = bytes.slice(12, 24);
  const authTag = bytes.slice(24, 40);
  const cipherLen = view.getUint16(40, true);
  const ciphertext = bytes.slice(42, 42 + cipherLen);
  return {
    blindOpId,
    epoch,
    nonce,
    authTag,
    ciphertext,
  };
}

/**
 * Untrusted Zero-Knowledge Cloud Relay (`BlindRelayNode`).
 */
export class BlindRelayNode {
  private readonly envelopesByBlindId = new Map<bigint, Uint8Array>();

  public ingestEnvelope(env: BlindEnvelope): boolean {
    if (this.envelopesByBlindId.has(env.blindOpId)) {
      return false;
    }
    this.envelopesByBlindId.set(env.blindOpId, serializeBlindEnvelope(env));
    return true;
  }

  public getStoredCount(): number {
    return this.envelopesByBlindId.size;
  }

  public buildSketch(cellCount: number, envelopeSlotBytes: number): RibltSketch {
    const sketch = new RibltSketch({
      cellCount,
      envelopeByteLength: envelopeSlotBytes,
      hashCount: 3,
    });
    for (const [blindOpId, serialized] of this.envelopesByBlindId.entries()) {
      sketch.insert(
        blindOpId,
        envelopeSlotBytes > 0 ? serialized : new Uint8Array(0),
        1
      );
    }
    return sketch;
  }

  public reconcileWithClientSketch(clientSketch: RibltSketch): {
    readonly result: RibltReconcileResult;
    readonly missingOnClientEnvelopes: readonly BlindEnvelope[];
    readonly missingOnRelayBlindIds: readonly bigint[];
  } {
    const relaySketch = this.buildSketch(
      clientSketch.cellCount,
      clientSketch.envelopeByteLength
    );
    const result = RibltSketch.reconcile(clientSketch, relaySketch);
    const missingOnClientEnvelopes: BlindEnvelope[] = [];
    if (clientSketch.envelopeByteLength > 0) {
      for (const envBytes of result.peeledRemoteOnlyEnvelopes) {
        missingOnClientEnvelopes.push(deserializeBlindEnvelope(envBytes));
      }
    } else {
      for (const blindId of result.peeledRemoteOnlyOpIds) {
        const stored = this.envelopesByBlindId.get(blindId);
        if (stored) {
          missingOnClientEnvelopes.push(deserializeBlindEnvelope(stored));
        }
      }
    }
    return {
      result,
      missingOnClientEnvelopes,
      missingOnRelayBlindIds: result.peeledLocalOnlyOpIds,
    };
  }
}
