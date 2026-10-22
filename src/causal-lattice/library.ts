import { deflateRawSync, inflateRawSync } from "node:zlib";
import { chaskey12Mac128, chaskey12Mac128Into } from "./crypto.ts";
import {
  type CompiledDistributionTable,
  compileDistributionTable,
  RansStreamDecoder,
  RansStreamEncoder,
} from "./entropy.ts";
import {
  EvolvedCrossFieldCodec,
  EvolvedDirectArena,
  evolveCrossFieldGenome,
  evolvePerfectLookupCircuit,
  type SynthesizedLookupCircuit,
} from "./evolve.ts";
import { RibltSketch, splitMix64 } from "./riblt.ts";

const MASK_64 = 0xffffffffffffffffn;

export const LatticeEntityMask = {
  FRAME: 1 << 0,
  HEAD: 1 << 1,
  GOTCHA: 1 << 2,
  MESSAGE: 1 << 3,
  MESSAGE_TOMBSTONE: 1 << 4,
  ALL_PROJECT: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4),
  COMMS_ONLY: (1 << 3) | (1 << 4),
} as const;

export const LatticePermissionMask = {
  READ: 1 << 0,
  WRITE: 1 << 1,
  SYNC: 1 << 2,
  COMPACT: 1 << 3,
  ALL: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3),
} as const;

export interface ProjectCapabilityCaveat {
  readonly projectPrefix: string;
  readonly allowedEntitiesMask: number;
  readonly permissionsMask: number;
  readonly maxPackedHlc: string;
}

export interface ProjectCapabilityToken {
  readonly rootId: number;
  readonly caveats: readonly ProjectCapabilityCaveat[];
  readonly tailSignature: string;
}

export interface MintProjectCapabilityRequest {
  readonly epochSecret: string;
  readonly rootId?: number;
  readonly projectPrefix?: string;
  readonly allowedEntitiesMask?: number;
  readonly permissionsMask?: number;
  readonly maxPackedHlc?: bigint | number | string;
}

export interface VerifyProjectCapabilityRequest {
  readonly epochSecret: string;
  readonly token: ProjectCapabilityToken;
  readonly targetProject?: string;
  readonly requiredEntitiesMask?: number;
  readonly requiredPermission?: number;
  readonly operationPackedHlc?: bigint | number;
}

export interface CrdtOperationRecord {
  readonly opId: string;
  readonly hlc: string;
  readonly project: string;
  readonly authorDid: string;
  readonly entity: string;
  readonly recordUid: string;
  readonly payload: Record<string, unknown>;
}

export interface CommsGroupMetadata {
  readonly groupId: string;
  readonly epoch: number;
  readonly epochSecret: string;
  readonly relays: readonly string[];
}

export interface CrdtOperationsBatch {
  readonly project: string;
  readonly opCount: number;
  readonly ops: readonly CrdtOperationRecord[];
  readonly commsGroup?: CommsGroupMetadata;
}

const HASH_LANES_SCRATCH = new Uint32Array(2);

export function hashString64(str: string): bigint {
  const s = String(str || "");
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x1b873593 | 0;
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ ((ch << 7) | (ch >>> 9)), 0x85ebca6b);
  }
  h1 ^= len;
  h2 ^= len;
  h1 = (h1 + h2) | 0;
  h2 = (h2 + h1) | 0;

  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;

  h2 ^= h2 >>> 16;
  h2 = Math.imul(h2, 0x85ebca6b);
  h2 ^= h2 >>> 13;
  h2 = Math.imul(h2, 0xc2b2ae35);
  h2 ^= h2 >>> 16;

  HASH_LANES_SCRATCH[0] = h1 >>> 0;
  HASH_LANES_SCRATCH[1] = (h2 >>> 0) || 1;
  return (BigInt(HASH_LANES_SCRATCH[1]!) << 32n) | BigInt(HASH_LANES_SCRATCH[0]!);
}

export function hlcStringToPacked64(hlcStr: string): bigint {
  if (!hlcStr || typeof hlcStr !== "string") return 0n;
  const parts = hlcStr.split("-");
  const wallMs = BigInt(Number(parts[0]) || 0) & 0xffffffffffffn;
  const counter = BigInt( Number.parseInt(parts[1] || "0", 16) || 0) & 0xffffn;
  return (wallMs << 16n) | counter;
}

export function packed64ToHlcString(packed: bigint, nodeTail = "local000"): string {
  const p = BigInt(packed) & MASK_64;
  const wallMs = Number((p >> 16n) & 0xffffffffffffn);
  const counter = Number(p & 0xffffn);
  const tail = String(nodeTail || "local000").slice(-8).padStart(8, "0");
  return `${String(wallMs).padStart(13, "0")}-${counter.toString(16).padStart(4, "0")}-${tail}`;
}

export function computeOpHash64(opId: string, hlcStr = ""): bigint {
  const h1 = hashString64(opId);
  const h2 = hlcStr ? hlcStringToPacked64(hlcStr) : 0n;
  const mixed = splitMix64(h1 ^ ((h2 * 0x517cc1b727220a95n) & MASK_64));
  return mixed === 0n ? 1n : mixed;
}

export function computeMerkleMix64(opHash64: bigint, packedHlc64: bigint): bigint {
  return splitMix64(
    (BigInt(opHash64) ^ ((BigInt(packedHlc64) * 0x9e3779b97f4a7c15n) & MASK_64)) & MASK_64
  );
}

function toBigInt64(val: bigint | number | string | undefined, fallback = MASK_64): bigint {
  if (val === undefined || val === null || val === "") return fallback;
  if (typeof val === "bigint") return val & MASK_64;
  if (typeof val === "number") return BigInt(Math.trunc(val)) & MASK_64;
  return BigInt(String(val).trim()) & MASK_64;
}

const caveatByteCache = new WeakMap<ProjectCapabilityCaveat, Uint8Array>();
const rootKeyCache = new Map<string, Uint8Array>();
const tokenTailCache = new WeakMap<ProjectCapabilityToken, Uint8Array>();
const VERIFY_SIG_SCRATCH = new Uint8Array(16);

const GENESIS_HEADER_BUF = new Uint8Array(12);
const GENESIS_HEADER_VIEW = new DataView(GENESIS_HEADER_BUF.buffer);
GENESIS_HEADER_VIEW.setUint32(0, 0x5454414c, true);
GENESIS_HEADER_VIEW.setUint32(4, 0x31454349, true);

function serializeProjectCaveat(caveat: ProjectCapabilityCaveat): Uint8Array {
  const cached = caveatByteCache.get(caveat);
  if (cached) return cached;
  const prefixBytes = Buffer.from(String(caveat.projectPrefix || ""), "utf8");
  const out = new Uint8Array(2 + prefixBytes.length + 4 + 4 + 8);
  const view = new DataView(out.buffer);
  view.setUint16(0, prefixBytes.length, true);
  out.set(prefixBytes, 2);
  const base = 2 + prefixBytes.length;
  view.setUint32(base, (caveat.allowedEntitiesMask ?? 0xffffffff) >>> 0, true);
  view.setUint32(base + 4, (caveat.permissionsMask ?? 0xffffffff) >>> 0, true);
  view.setBigUint64(base + 8, toBigInt64(caveat.maxPackedHlc), true);
  caveatByteCache.set(caveat, out);
  return out;
}

function deriveCapabilityKey16(epochSecretBase64: string): Uint8Array {
  const key = String(epochSecretBase64 || "");
  const cached = rootKeyCache.get(key);
  if (cached) return cached;
  const raw = Buffer.from(key, "base64");
  const out = new Uint8Array(16);
  out.set(raw.subarray(0, Math.min(16, raw.length)));
  rootKeyCache.set(key, out);
  return out;
}

export function mintProjectCapability(req: MintProjectCapabilityRequest): ProjectCapabilityToken {
  const rootId = req.rootId ?? 1;
  const rootKey16 = deriveCapabilityKey16(req.epochSecret);
  GENESIS_HEADER_VIEW.setUint32(8, rootId >>> 0, true);
  const genesisTag = chaskey12Mac128(rootKey16, GENESIS_HEADER_BUF);
  const initialCaveat: ProjectCapabilityCaveat = {
    projectPrefix: String(req.projectPrefix ?? ""),
    allowedEntitiesMask: (req.allowedEntitiesMask ?? LatticeEntityMask.ALL_PROJECT) >>> 0,
    permissionsMask: (req.permissionsMask ?? LatticePermissionMask.ALL) >>> 0,
    maxPackedHlc: "0x" + toBigInt64(req.maxPackedHlc).toString(16),
  };
  const tailSig = chaskey12Mac128(genesisTag, serializeProjectCaveat(initialCaveat));
  return {
    rootId,
    caveats: [initialCaveat],
    tailSignature: Buffer.from(tailSig).toString("base64url"),
  };
}

export function attenuateProjectCapability(
  parentToken: ProjectCapabilityToken,
  newCaveat: {
    readonly projectPrefix?: string;
    readonly allowedEntitiesMask?: number;
    readonly permissionsMask?: number;
    readonly maxPackedHlc?: bigint | number | string;
  }
): ProjectCapabilityToken {
  const parentSigBytes = Buffer.from(parentToken.tailSignature, "base64url");
  const normalizedCaveat: ProjectCapabilityCaveat = {
    projectPrefix: String(newCaveat.projectPrefix ?? ""),
    allowedEntitiesMask: (newCaveat.allowedEntitiesMask ?? LatticeEntityMask.ALL_PROJECT) >>> 0,
    permissionsMask: (newCaveat.permissionsMask ?? LatticePermissionMask.ALL) >>> 0,
    maxPackedHlc: "0x" + toBigInt64(newCaveat.maxPackedHlc).toString(16),
  };
  const nextSig = chaskey12Mac128(
    new Uint8Array(parentSigBytes.buffer, parentSigBytes.byteOffset, 16),
    serializeProjectCaveat(normalizedCaveat)
  );
  return {
    rootId: parentToken.rootId || 1,
    caveats: [...parentToken.caveats, normalizedCaveat],
    tailSignature: Buffer.from(nextSig).toString("base64url"),
  };
}

function sameOrRenamedOwnerPrefix(targetProject: string, allowedPrefix: string): boolean {
  if (!allowedPrefix) return true;
  if (targetProject === allowedPrefix || targetProject.startsWith(allowedPrefix)) return true;
  const cParts = String(targetProject || "").toLowerCase().split("/");
  const tParts = String(allowedPrefix || "").toLowerCase().split("/");
  return cParts.length === 2 && tParts.length === 2 && cParts[1] === tParts[1];
}

export function verifyProjectCapability(
  req: VerifyProjectCapabilityRequest
): { readonly ok: boolean; readonly reason?: string } {
  const { token } = req;
  if (!token || !Array.isArray(token.caveats) || token.caveats.length === 0) {
    return { ok: false, reason: "Capability token contains zero caveats" };
  }
  const rootKey16 = deriveCapabilityKey16(req.epochSecret);
  GENESIS_HEADER_VIEW.setUint32(8, (token.rootId || 1) >>> 0, true);
  chaskey12Mac128Into(rootKey16, GENESIS_HEADER_BUF, VERIFY_SIG_SCRATCH);

  let effectivePrefix = "";
  let effectiveEntitiesMask = 0xffffffff;
  let effectivePermsMask = 0xffffffff;
  let effectiveMaxHlc = MASK_64;

  for (let i = 0; i < token.caveats.length; i++) {
    const rawCaveat = token.caveats[i]!;
    const caveatMaxHlc = toBigInt64(rawCaveat.maxPackedHlc);
    chaskey12Mac128Into(
      VERIFY_SIG_SCRATCH,
      serializeProjectCaveat(rawCaveat),
      VERIFY_SIG_SCRATCH
    );

    const cPrefix = String(rawCaveat.projectPrefix || "");
    const cEntities = (rawCaveat.allowedEntitiesMask ?? 0xffffffff) >>> 0;
    const cPerms = (rawCaveat.permissionsMask ?? 0xffffffff) >>> 0;

    if (effectivePrefix && !sameOrRenamedOwnerPrefix(cPrefix, effectivePrefix)) {
      return {
        ok: false,
        reason: `Caveat prefix "${cPrefix}" widens parent prefix "${effectivePrefix}"`,
      };
    }
    if ((cEntities & ~effectiveEntitiesMask) !== 0) {
      return { ok: false, reason: "Caveat attempts to re-enable restricted entity types" };
    }
    if ((cPerms & ~effectivePermsMask) !== 0) {
      return { ok: false, reason: "Caveat attempts to escalate permissions" };
    }
    if (caveatMaxHlc > effectiveMaxHlc) {
      return { ok: false, reason: "Caveat attempts to extend parent HLC expiration" };
    }

    if (cPrefix) effectivePrefix = cPrefix;
    effectiveEntitiesMask &= cEntities;
    effectivePermsMask &= cPerms;
    effectiveMaxHlc = caveatMaxHlc;
  }

  let expectedTail = tokenTailCache.get(token);
  if (!expectedTail) {
    expectedTail = Buffer.from(String(token.tailSignature || ""), "base64url");
    tokenTailCache.set(token, expectedTail);
  }
  if (expectedTail.length !== 16) {
    return { ok: false, reason: "Malformed capability signature length" };
  }
  let diff = 0;
  for (let i = 0; i < 16; i++) {
    diff |= VERIFY_SIG_SCRATCH[i]! ^ expectedTail[i]!;
  }
  if (diff !== 0) {
    return { ok: false, reason: "Invalid Chaskey-12 capability signature" };
  }

  const targetProject = req.targetProject ?? "";
  if (targetProject && !sameOrRenamedOwnerPrefix(targetProject, effectivePrefix)) {
    return {
      ok: false,
      reason: `Project "${targetProject}" outside capability prefix "${effectivePrefix}"`,
    };
  }
  const reqEntities = req.requiredEntitiesMask ?? LatticeEntityMask.FRAME;
  if ((reqEntities & ~effectiveEntitiesMask) !== 0) {
    return {
      ok: false,
      reason: `Entity mask 0x${reqEntities.toString(16)} outside allowed mask 0x${effectiveEntitiesMask.toString(16)}`,
    };
  }
  const reqPerm = req.requiredPermission ?? LatticePermissionMask.WRITE;
  if ((reqPerm & effectivePermsMask) !== reqPerm) {
    return { ok: false, reason: "Missing required capability permission bit" };
  }
  if (toBigInt64(req.operationPackedHlc ?? 0n, 0n) > effectiveMaxHlc) {
    return { ok: false, reason: "Operation HLC exceeds capability expiration" };
  }

  return { ok: true };
}

// --- Schema-Compiled 24-bit rANS + Binary String-Slab CRDT Batch Codec ---

const ENTITY_KINDS = ["frame", "head", "gotcha", "message", "message_tombstone"] as const;
const FRAME_KINDS = [
  "intent",
  "probe",
  "finding",
  "dead_end",
  "decision",
  "change",
  "commit",
  "release",
  "thread",
] as const;
const GOTCHA_STATUSES = ["observed", "from_source", "reported"] as const;
const GUARD_PLATFORMS = ["all", "win32", "linux", "darwin"] as const;
const MESSAGE_STATUSES = ["pending", "seen", "replied", "delivered", "hidden"] as const;

const TABLE_ENTITY = compileDistributionTable([600, 150, 80, 160, 10]);
const TABLE_FRAME_KIND = compileDistributionTable([180, 90, 220, 40, 110, 200, 180, 30, 150]);
const TABLE_BOOL = compileDistributionTable([750, 250]);
const TABLE_GOTCHA_STATUS = compileDistributionTable([800, 150, 50]);
const TABLE_GUARD_PLAT = compileDistributionTable([700, 200, 60, 40]);
const TABLE_MSG_STATUS = compileDistributionTable([350, 200, 300, 100, 50]);

function writeVarint(outArr: number[], val: bigint | number): void {
  let v = BigInt(val);
  while (v >= 0x80n) {
    outArr.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  outArr.push(Number(v));
}

function readVarint(buf: Uint8Array, offset: number): { value: bigint; nextOffset: number } {
  let result = 0n;
  let shift = 0n;
  let idx = offset;
  while (idx < buf.length) {
    const byte = buf[idx++]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, nextOffset: idx };
    shift += 7n;
  }
  throw new Error("Truncated varint in Lattice CRDT frame");
}

function zigzagEncodeBig(delta: bigint): bigint {
  return delta >= 0n ? delta << 1n : ((-delta) << 1n) - 1n;
}

function zigzagDecodeBig(zz: bigint): bigint {
  return (zz & 1n) === 0n ? zz >> 1n : -((zz + 1n) >> 1n);
}

export function encodeLatticeCrdtBatch(batchObj: CrdtOperationsBatch): Buffer {
  const ops = Array.isArray(batchObj.ops) ? batchObj.ops : [];
  const project = String(batchObj.project || "");
  const commsGroup = batchObj.commsGroup ?? null;

  const stringToIdx = new Map<string, number>();
  const stringPool: string[] = [];

  const intern = (str: unknown): number => {
    const s = String(str ?? "");
    let idx = stringToIdx.get(s);
    if (idx === undefined) {
      idx = stringPool.length;
      stringToIdx.set(s, idx);
      stringPool.push(s);
    }
    return idx;
  };

  intern(project);
  if (commsGroup) {
    intern(commsGroup.groupId || "");
    intern(commsGroup.epochSecret || "");
    for (const r of commsGroup.relays || []) intern(r);
  }

  const ansSymbols: Array<{ table: CompiledDistributionTable; sym: number }> = [];
  const bodyStream: number[] = [];
  let prevWallMs = 0n;

  for (const op of ops) {
    const entityIdx = Math.max(
      0,
      ENTITY_KINDS.indexOf(op.entity as (typeof ENTITY_KINDS)[number])
    );
    ansSymbols.push({ table: TABLE_ENTITY, sym: entityIdx });

    const parsedHlc = hlcStringToPacked64(op.hlc);
    const wallMs = (parsedHlc >> 16n) & 0xffffffffffffn;
    const counter = Number(parsedHlc & 0xffffn);
    const nodeTail = String(op.hlc || "").split("-").slice(2).join("-");
    const reconstructedHlc = packed64ToHlcString(parsedHlc, nodeTail);

    const wallDeltaZz = zigzagEncodeBig(wallMs - prevWallMs);
    prevWallMs = wallMs;

    const canonicalOpId = `${reconstructedHlc}:${op.entity}:${op.recordUid}`;
    const isCanonicalOpId = op.opId === canonicalOpId && op.hlc === reconstructedHlc;
    ansSymbols.push({ table: TABLE_BOOL, sym: isCanonicalOpId ? 1 : 0 });

    writeVarint(bodyStream, wallDeltaZz);
    writeVarint(bodyStream, counter);
    writeVarint(bodyStream, intern(nodeTail));
    if (!isCanonicalOpId) {
      writeVarint(bodyStream, intern(op.opId));
      writeVarint(bodyStream, intern(op.hlc || ""));
    }
    writeVarint(bodyStream, intern(op.project || project));
    writeVarint(bodyStream, intern(op.authorDid || ""));
    writeVarint(bodyStream, intern(op.recordUid || ""));

    const p = (op.payload || {}) as Record<string, unknown>;
    if (entityIdx === 0) {
      const kindIdx = Math.max(
        0,
        FRAME_KINDS.indexOf(String(p.kind || "finding") as (typeof FRAME_KINDS)[number])
      );
      ansSymbols.push({ table: TABLE_FRAME_KIND, sym: kindIdx });
      ansSymbols.push({ table: TABLE_BOOL, sym: p.open ? 1 : 0 });
      const sameUidAndHlc =
        String(p.uid || op.recordUid) === op.recordUid &&
        String(p.hlc || op.hlc) === op.hlc;
      ansSymbols.push({ table: TABLE_BOOL, sym: sameUidAndHlc ? 1 : 0 });
      if (!sameUidAndHlc) {
        writeVarint(bodyStream, intern(p.uid || op.recordUid || ""));
        writeVarint(bodyStream, intern(p.hlc || op.hlc || ""));
      }
      writeVarint(bodyStream, intern(p.ts || ""));
      writeVarint(bodyStream, intern(p.project || op.project || project));
      writeVarint(bodyStream, intern(p.summary || ""));
      writeVarint(bodyStream, intern(p.detail || ""));
      writeVarint(bodyStream, intern(p.verified || ""));
      const refs = Array.isArray(p.refs) ? p.refs : [];
      writeVarint(bodyStream, refs.length);
      for (const r of refs) writeVarint(bodyStream, intern(r));
    } else if (entityIdx === 1) {
      writeVarint(bodyStream, intern(p.project || op.project || project));
      writeVarint(bodyStream, intern(p.hlc || op.hlc || ""));
      writeVarint(bodyStream, intern(p.repo || ""));
      writeVarint(bodyStream, intern(p.state || ""));
      writeVarint(bodyStream, intern(p.next || ""));
      writeVarint(bodyStream, intern(p.updated || ""));
    } else if (entityIdx === 2) {
      const statusIdx = Math.max(
        0,
        GOTCHA_STATUSES.indexOf(
          String(p.status || "observed") as (typeof GOTCHA_STATUSES)[number]
        )
      );
      const platIdx = Math.max(
        0,
        GUARD_PLATFORMS.indexOf(
          String(p.guardPlatform || "all") as (typeof GUARD_PLATFORMS)[number]
        )
      );
      ansSymbols.push({ table: TABLE_GOTCHA_STATUS, sym: statusIdx });
      ansSymbols.push({ table: TABLE_GUARD_PLAT, sym: platIdx });

      writeVarint(bodyStream, intern(p.uid || op.recordUid || ""));
      writeVarint(bodyStream, intern(p.hlc || op.hlc || ""));
      writeVarint(bodyStream, intern(p.scope || op.project || project));
      writeVarint(bodyStream, intern(p.title || ""));
      writeVarint(bodyStream, intern(p.evidence || ""));
      writeVarint(bodyStream, intern(p.fix || ""));
      writeVarint(bodyStream, intern(p.guardRegex || ""));
      writeVarint(bodyStream, intern(p.created || ""));
      const tags = Array.isArray(p.tags) ? p.tags : [];
      writeVarint(bodyStream, tags.length);
      for (const t of tags) writeVarint(bodyStream, intern(t));
    } else if (entityIdx === 3) {
      const msgStatusIdx = Math.max(
        0,
        MESSAGE_STATUSES.indexOf(
          String(p.status || "pending") as (typeof MESSAGE_STATUSES)[number]
        )
      );
      ansSymbols.push({ table: TABLE_MSG_STATUS, sym: msgStatusIdx });

      writeVarint(bodyStream, intern(p.uid || op.recordUid || ""));
      writeVarint(bodyStream, intern(p.hlc || op.hlc || ""));
      writeVarint(bodyStream, intern(p.project || op.project || project));
      writeVarint(bodyStream, intern(p.originalProject || p.project || "global"));
      writeVarint(bodyStream, intern(p.fromUser || ""));
      writeVarint(bodyStream, intern(p.fromRom || ""));
      writeVarint(bodyStream, intern(p.fromDid || ""));
      writeVarint(bodyStream, intern(p.toUser || ""));
      writeVarint(bodyStream, intern(p.body || ""));
      writeVarint(bodyStream, intern(p.replyBody || ""));
      writeVarint(bodyStream, intern(p.replyRom || ""));
      writeVarint(bodyStream, intern(p.replyHlc || ""));
      writeVarint(bodyStream, intern(p.created || ""));
    } else {
      writeVarint(bodyStream, intern(p.uid || op.recordUid || ""));
      writeVarint(bodyStream, intern(p.hlc || op.hlc || ""));
    }
  }

  const rans = new RansStreamEncoder();
  for (let i = ansSymbols.length - 1; i >= 0; i--) {
    rans.encodeSymbol(ansSymbols[i]!.table, ansSymbols[i]!.sym);
  }
  const ansBytes = rans.flush();

  const header: number[] = [];
  writeVarint(header, ops.length);
  writeVarint(header, intern(project));
  header.push(commsGroup ? 1 : 0);
  if (commsGroup) {
    writeVarint(header, intern(commsGroup.groupId || ""));
    writeVarint(header, Number(commsGroup.epoch || 1));
    writeVarint(header, intern(commsGroup.epochSecret || ""));
    const cRelays = Array.isArray(commsGroup.relays) ? commsGroup.relays : [];
    writeVarint(header, cRelays.length);
    for (const r of cRelays) writeVarint(header, intern(r));
  }

  writeVarint(header, stringPool.length);
  const slabBuffers: Buffer[] = [];
  for (const s of stringPool) {
    const b = Buffer.from(s, "utf8");
    const lenVar: number[] = [];
    writeVarint(lenVar, b.length);
    slabBuffers.push(Buffer.from(lenVar), b);
  }
  const slabBytes = Buffer.concat(slabBuffers);

  const ansLenVar: number[] = [];
  writeVarint(ansLenVar, ansBytes.length);

  const rawFrame = Buffer.concat([
    Buffer.from(header),
    slabBytes,
    Buffer.from(ansLenVar),
    Buffer.from(ansBytes),
    Buffer.from(bodyStream),
  ]);
  const compressed = deflateRawSync(rawFrame, { level: 6 });
  return Buffer.concat([Buffer.from([0x4c, 0x02]), compressed]);
}

export function decodeLatticeCrdtBatch(bufInput: Buffer | Uint8Array): CrdtOperationsBatch {
  const outer = Buffer.isBuffer(bufInput) ? bufInput : Buffer.from(bufInput);
  if (outer.length < 4 || outer[0] !== 0x4c || (outer[1] !== 0x01 && outer[1] !== 0x02)) {
    return JSON.parse(outer.toString("utf8")) as CrdtOperationsBatch;
  }

  const buf = outer[1] === 0x02 ? inflateRawSync(outer.subarray(2)) : outer.subarray(2);
  let offset = 0;
  const opCountVar = readVarint(buf, offset);
  const opCount = Number(opCountVar.value);
  offset = opCountVar.nextOffset;

  const projIdxVar = readVarint(buf, offset);
  const projIdx = Number(projIdxVar.value);
  offset = projIdxVar.nextOffset;

  const hasComms = buf[offset++] === 1;
  let commsIndices: {
    groupIdIdx: number;
    epoch: number;
    secretIdx: number;
    relayIdxs: number[];
  } | null = null;
  if (hasComms) {
    const gIdVar = readVarint(buf, offset);
    offset = gIdVar.nextOffset;
    const epVar = readVarint(buf, offset);
    offset = epVar.nextOffset;
    const secVar = readVarint(buf, offset);
    offset = secVar.nextOffset;
    const rLenVar = readVarint(buf, offset);
    offset = rLenVar.nextOffset;
    const rIdxs: number[] = [];
    for (let i = 0; i < Number(rLenVar.value); i++) {
      const rv = readVarint(buf, offset);
      offset = rv.nextOffset;
      rIdxs.push(Number(rv.value));
    }
    commsIndices = {
      groupIdIdx: Number(gIdVar.value),
      epoch: Number(epVar.value),
      secretIdx: Number(secVar.value),
      relayIdxs: rIdxs,
    };
  }

  const poolLenVar = readVarint(buf, offset);
  const poolLen = Number(poolLenVar.value);
  offset = poolLenVar.nextOffset;

  const stringPool = new Array<string>(poolLen);
  for (let i = 0; i < poolLen; i++) {
    const sLenVar = readVarint(buf, offset);
    const sLen = Number(sLenVar.value);
    offset = sLenVar.nextOffset;
    stringPool[i] = buf.subarray(offset, offset + sLen).toString("utf8");
    offset += sLen;
  }

  const ansLenVar = readVarint(buf, offset);
  const ansLen = Number(ansLenVar.value);
  offset = ansLenVar.nextOffset;

  const ansDecoder = new RansStreamDecoder(buf, offset, ansLen);
  offset += ansLen;

  const readStr = (): string => {
    const v = readVarint(buf, offset);
    offset = v.nextOffset;
    return stringPool[Number(v.value)] ?? "";
  };

  const project = stringPool[projIdx] ?? "";
  let commsGroup: CommsGroupMetadata | undefined;
  if (commsIndices) {
    commsGroup = {
      groupId: stringPool[commsIndices.groupIdIdx] ?? "",
      epoch: commsIndices.epoch,
      epochSecret: stringPool[commsIndices.secretIdx] ?? "",
      relays: commsIndices.relayIdxs.map((idx) => stringPool[idx] ?? ""),
    };
  }

  const ops: CrdtOperationRecord[] = [];
  let prevWallMs = 0n;

  for (let i = 0; i < opCount; i++) {
    const entityIdx = ansDecoder.decodeSymbol(TABLE_ENTITY);
    const entity = ENTITY_KINDS[entityIdx] ?? "frame";
    const isCanonicalOpId = ansDecoder.decodeSymbol(TABLE_BOOL) === 1;

    const wallDeltaVar = readVarint(buf, offset);
    offset = wallDeltaVar.nextOffset;
    const counterVar = readVarint(buf, offset);
    offset = counterVar.nextOffset;
    const nodeTail = readStr();

    const wallMs = prevWallMs + zigzagDecodeBig(wallDeltaVar.value);
    prevWallMs = wallMs;
    const packedHlc = (wallMs << 16n) | (counterVar.value & 0xffffn);
    const reconstructedHlc = packed64ToHlcString(packedHlc, nodeTail);

    let opId = "";
    let opHlc = reconstructedHlc;
    if (!isCanonicalOpId) {
      opId = readStr();
      opHlc = readStr() || reconstructedHlc;
    }
    const opProject = readStr();
    const authorDid = readStr();
    const recordUid = readStr();
    if (isCanonicalOpId) {
      opId = `${reconstructedHlc}:${entity}:${recordUid}`;
    }

    let payload: Record<string, unknown> = {};
    if (entityIdx === 0) {
      const kindIdx = ansDecoder.decodeSymbol(TABLE_FRAME_KIND);
      const openBit = ansDecoder.decodeSymbol(TABLE_BOOL);
      const sameUidAndHlc = ansDecoder.decodeSymbol(TABLE_BOOL) === 1;
      const uid = sameUidAndHlc ? recordUid : readStr();
      const hlc = sameUidAndHlc ? opHlc : readStr() || opHlc;
      const ts = readStr();
      const fProj = readStr();
      const summary = readStr();
      const detail = readStr();
      const verified = readStr();
      const refsLenVar = readVarint(buf, offset);
      offset = refsLenVar.nextOffset;
      const refs: string[] = [];
      for (let r = 0; r < Number(refsLenVar.value); r++) refs.push(readStr());
      payload = {
        uid,
        hlc,
        ts,
        project: fProj,
        kind: FRAME_KINDS[kindIdx] ?? "finding",
        summary,
        detail,
        verified,
        open: openBit === 1,
        refs,
      };
    } else if (entityIdx === 1) {
      payload = {
        project: readStr(),
        hlc: readStr() || reconstructedHlc,
        repo: readStr(),
        state: readStr(),
        next: readStr(),
        updated: readStr(),
      };
    } else if (entityIdx === 2) {
      const statusIdx = ansDecoder.decodeSymbol(TABLE_GOTCHA_STATUS);
      const platIdx = ansDecoder.decodeSymbol(TABLE_GUARD_PLAT);
      const uid = readStr();
      const hlc = readStr() || reconstructedHlc;
      const scope = readStr();
      const title = readStr();
      const evidence = readStr();
      const fix = readStr();
      const guardRegex = readStr();
      const created = readStr();
      const tagsLenVar = readVarint(buf, offset);
      offset = tagsLenVar.nextOffset;
      const tags: string[] = [];
      for (let t = 0; t < Number(tagsLenVar.value); t++) tags.push(readStr());
      payload = {
        uid,
        hlc,
        scope,
        title,
        status: GOTCHA_STATUSES[statusIdx] ?? "observed",
        tags,
        evidence,
        fix,
        guardRegex,
        guardPlatform: GUARD_PLATFORMS[platIdx] ?? "all",
        created,
      };
    } else if (entityIdx === 3) {
      const msgStatusIdx = ansDecoder.decodeSymbol(TABLE_MSG_STATUS);
      payload = {
        uid: readStr(),
        hlc: readStr() || reconstructedHlc,
        project: readStr(),
        originalProject: readStr(),
        fromUser: readStr(),
        fromRom: readStr(),
        fromDid: readStr(),
        toUser: readStr(),
        body: readStr(),
        status: MESSAGE_STATUSES[msgStatusIdx] ?? "pending",
        replyBody: readStr(),
        replyRom: readStr(),
        replyHlc: readStr(),
        created: readStr(),
      };
    } else {
      payload = {
        uid: readStr(),
        hlc: readStr() || reconstructedHlc,
      };
    }

    ops.push({
      opId,
      hlc: opHlc,
      project: opProject,
      authorDid,
      entity,
      recordUid,
      payload,
    });
  }

  return {
    project,
    opCount: ops.length,
    ops,
    ...(commsGroup ? { commsGroup } : {}),
  };
}

/**
 * Evolved Hot Arena combining World-Track II 64-byte cache-line slots for dynamic projects
 * and World-Track III `EvolvedDirectArena` (59ns branchless lookup circuit) for known ROM/entity sets.
 */
export class EvolvedConstructArena {
  private readonly projectFrontiers = new Map<string, bigint>();
  private readonly projectLastHlc = new Map<string, bigint>();
  private romCircuit: SynthesizedLookupCircuit | null = null;
  private romDirectArena: EvolvedDirectArena | null = null;

  public foldProjectOp(project: string, opHash64: bigint, packedHlc64: bigint): bigint {
    const prev = this.projectFrontiers.get(project) ?? 0n;
    const next = (prev ^ computeMerkleMix64(opHash64, packedHlc64)) & MASK_64;
    this.projectFrontiers.set(project, next);
    const prevHlc = this.projectLastHlc.get(project) ?? 0n;
    if (packedHlc64 > prevHlc) {
      this.projectLastHlc.set(project, packedHlc64);
    }
    return next;
  }

  public readProjectFrontierFast(project: string): bigint {
    return this.projectFrontiers.get(project) ?? 0n;
  }

  /**
   * Evolves a zero-collision branchless lookup circuit over all known ROM names
   * and populates their 6 behavioral dials into 64-byte cache-line registers.
   */
  public evolveAndCacheRomDials(
    roms: ReadonlyArray<{ readonly name: string; readonly dials: Record<string, number> }>
  ): SynthesizedLookupCircuit {
    const keys = roms.map((r) => `rom:${r.name}`);
    const slotCap = Math.max(512, 1 << Math.ceil(Math.log2(keys.length * 4)));
    const circuit = evolvePerfectLookupCircuit(keys, slotCap, 8192);
    const arena = new EvolvedDirectArena(circuit);
    const dialNames = ["terseness", "warmth", "edge", "wit", "proactivity", "rigor"];
    for (const r of roms) {
      const vals = dialNames.map((k) => Math.round(Number(r.dials?.[k] ?? 0.5) * 1000));
      arena.writeRegisters(`rom:${r.name}`, vals);
    }
    this.romCircuit = circuit;
    this.romDirectArena = arena;
    return circuit;
  }

  public cacheSingleRomDials(romName: string, dials: Record<string, number>): void {
    if (!this.romDirectArena) {
      this.evolveAndCacheRomDials([{ name: romName, dials }]);
      return;
    }
    const dialNames = ["terseness", "warmth", "edge", "wit", "proactivity", "rigor"];
    const vals = dialNames.map((k) => Math.round(Number(dials?.[k] ?? 0.5) * 1000));
    this.romDirectArena.writeRegisters(`rom:${romName}`, vals);
  }

  public readRomDialBranchless(romName: string, dialIndex: number): number | null {
    if (!this.romDirectArena) return null;
    return this.romDirectArena.readRegisterBranchless(`rom:${romName}`, dialIndex) / 1000;
  }

  public getRomCircuit(): SynthesizedLookupCircuit | null {
    return this.romCircuit;
  }
}

/**
 * Compact 20-byte-per-cell Rateless IBLT Sketch wrapper for Base64 WebSocket transport,
 * backed directly by `causal-lattice`'s `RibltSketch`.
 */
export class CompactRibltSketch {
  public readonly inner: RibltSketch;

  public constructor(cellCount = 48, hashCount = 3) {
    this.inner = new RibltSketch({
      cellCount,
      envelopeByteLength: 0,
      hashCount,
    });
  }

  public get cellCount(): number {
    return this.inner.cellCount;
  }

  public get hashCount(): number {
    return this.inner.hashCount;
  }

  public insert(opHash64: bigint, sign: 1 | -1 = 1): void {
    this.inner.insert(opHash64, new Uint8Array(0), sign);
  }

  public toBase64(): string {
    return Buffer.from(this.inner.toBytes()).toString("base64");
  }

  public static fromBase64(b64: string): CompactRibltSketch {
    const parsed = RibltSketch.fromBytes(new Uint8Array(Buffer.from(b64, "base64")));
    const wrapper = new CompactRibltSketch(parsed.cellCount, parsed.hashCount);
    for (let i = 0; i < parsed.cellCount; i++) {
      wrapper.inner.cells[i]!.count = parsed.cells[i]!.count;
      wrapper.inner.cells[i]!.opIdXor = parsed.cells[i]!.opIdXor;
      wrapper.inner.cells[i]!.checksumXor = parsed.cells[i]!.checksumXor;
    }
    return wrapper;
  }

  public static reconcile(
    localSketch: CompactRibltSketch,
    remoteSketch: CompactRibltSketch
  ): {
    readonly complete: boolean;
    readonly localOnlyHashes: readonly bigint[];
    readonly remoteOnlyHashes: readonly bigint[];
  } {
    const res = RibltSketch.reconcile(localSketch.inner, remoteSketch.inner);
    return {
      complete: res.complete,
      localOnlyHashes: res.peeledLocalOnlyOpIds,
      remoteOnlyHashes: res.peeledRemoteOnlyOpIds,
    };
  }
}

export {
  EvolvedCrossFieldCodec,
  EvolvedDirectArena,
  evolveCrossFieldGenome,
  evolvePerfectLookupCircuit,
};
