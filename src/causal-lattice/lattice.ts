import { CausalArena } from "./arena.ts";
import {
  type BlindRelayNode,
  computeBlindOpId,
  deriveEpochKeys,
  deserializeBlindEnvelope,
  openBlindEnvelope,
  sealBlindEnvelope,
  serializeBlindEnvelope,
  verifyCapability,
} from "./crypto.ts";
import {
  CompiledSchemaCodec,
  HASH_LANES_SCRATCH,
  hashEntityKey64,
  hashEntityKeyToScratch,
} from "./entropy.ts";
import { RibltSketch } from "./riblt.ts";
import {
  type AdvanceHlcRequest,
  type BlindEnvelope,
  type CapabilityToken,
  type CausalOp,
  type CompiledWireFrame,
  type FieldMutation,
  type HlcTimestamp,
  type LatticeSchemaSpec,
  type MergeHlcRequest,
  PermissionBit,
} from "./types.ts";

const LOGICAL_MASK = 0xffffn;
const WALL_MASK = 0xffffffffffffn;

export function packHlc(hlc: HlcTimestamp): bigint {
  return ((hlc.wallMs & WALL_MASK) << 16n) | (BigInt(hlc.logical) & LOGICAL_MASK);
}

export function unpackHlc(packed: bigint, nodeId = 0): HlcTimestamp {
  return {
    wallMs: (packed >> 16n) & WALL_MASK,
    logical: Number(packed & LOGICAL_MASK),
    nodeId,
  };
}

export function advanceHlc(req: AdvanceHlcRequest): HlcTimestamp {
  if (req.nowWallMs > req.current.wallMs) {
    return {
      wallMs: req.nowWallMs,
      logical: 0,
      nodeId: req.current.nodeId,
    };
  }
  return {
    wallMs: req.current.wallMs,
    logical: (req.current.logical + 1) & 0xffff,
    nodeId: req.current.nodeId,
  };
}

export function mergeHlc(req: MergeHlcRequest): HlcTimestamp {
  const maxWall =
    req.nowWallMs >= req.local.wallMs && req.nowWallMs >= req.remote.wallMs
      ? req.nowWallMs
      : req.local.wallMs >= req.remote.wallMs
        ? req.local.wallMs
        : req.remote.wallMs;

  let nextLogical = 0;
  if (maxWall === req.local.wallMs && maxWall === req.remote.wallMs) {
    nextLogical = Math.max(req.local.logical, req.remote.logical) + 1;
  } else if (maxWall === req.local.wallMs) {
    nextLogical = req.local.logical + 1;
  } else if (maxWall === req.remote.wallMs) {
    nextLogical = req.remote.logical + 1;
  }

  return {
    wallMs: maxWall,
    logical: nextLogical & 0xffff,
    nodeId: req.local.nodeId,
  };
}

export interface LatticeNodeOptions {
  readonly nodeId: number;
  readonly schema: LatticeSchemaSpec;
  readonly arenaSlotCapacity?: number;
  readonly capabilityRootSecret: Uint8Array;
  readonly epochRootKey: Uint8Array;
  readonly currentEpoch?: number;
}

export interface MutateEntityRequest {
  readonly entityKey: string;
  readonly mutations: readonly FieldMutation[];
  readonly capabilityToken: CapabilityToken;
  readonly nowWallMs?: bigint;
  readonly omitKeyStringOnWire?: boolean;
}

export interface MutateEntityResult {
  readonly op: CausalOp;
  readonly wireFrame: CompiledWireFrame;
  readonly blindEnvelope: BlindEnvelope;
}

class LatticeMutationOutcome implements MutateEntityResult {
  private readonly node: CausalLatticeNode;
  public readonly op: CausalOp;
  public readonly wireFrame: CompiledWireFrame;
  private cachedEnvelope: BlindEnvelope | undefined;

  public constructor(
    node: CausalLatticeNode,
    op: CausalOp,
    wireFrame: CompiledWireFrame
  ) {
    this.node = node;
    this.op = op;
    this.wireFrame = wireFrame;
  }

  public get blindEnvelope(): BlindEnvelope {
    if (!this.cachedEnvelope) {
      this.cachedEnvelope = this.node.sealOpForRelay(this.op.opId);
    }
    return this.cachedEnvelope;
  }
}

export interface CompactionReport {
  readonly totalOpsBefore: number;
  readonly activeOpsAfter: number;
  readonlyopsPruned: number;
  readonly merkleFrontierXorDigest: bigint;
}

/**
 * World-Track II Unified Engine (`CausalLatticeNode`):
 * Combines Schema-Compiled rANS Entropy Coding, 64B Cache-Line Binary Arena,
 * HLC Merkle-CRDT with Frontier-Preserving Compaction, Attenuated Capabilities,
 * and 1-RTT Rateless IBLT Synchronization over a Zero-Knowledge Blind Relay.
 */
export class CausalLatticeNode {
  public readonly nodeId: number;
  public readonly codec: CompiledSchemaCodec;
  public readonly arena: CausalArena;
  private readonly capabilityRootSecret: Uint8Array;
  private epochRootKey: Uint8Array;
  private currentEpoch: number;
  private hlc: HlcTimestamp;

  private readonly fieldIndexTable = new Int16Array(64).fill(-1);
  private readonly entityKeyByHash = new Map<bigint, string>();
  private readonly opsById = new Map<bigint, CausalOp>();
  private readonly wireFramesByOpId = new Map<bigint, Uint8Array>();
  private readonly capabilitiesByOpId = new Map<bigint, CapabilityToken>();
  private readonly blindEnvelopesByBlindId = new Map<bigint, BlindEnvelope>();
  private readonly blindIdByOpId = new Map<bigint, bigint>();
  /** Global rolling commutative Merkle-XOR digest across all applied operations (preserved across compactions). */
  private merkleFrontierDigest = 0n;

  public constructor(options: LatticeNodeOptions) {
    this.nodeId = options.nodeId & 0xffff;
    this.codec = new CompiledSchemaCodec(options.schema);
    this.arena = new CausalArena({
      slotCapacity: options.arenaSlotCapacity ?? 8192,
      inlineRegisters: Math.min(8, options.schema.fields.length),
    });
    this.capabilityRootSecret = options.capabilityRootSecret;
    this.epochRootKey = options.epochRootKey;
    this.currentEpoch = options.currentEpoch ?? 1;
    this.hlc = {
      wallMs: BigInt(Date.now()),
      logical: 0,
      nodeId: this.nodeId,
    };

    options.schema.fields.forEach((f, idx) => {
      if (f.id >= 0 && f.id < this.fieldIndexTable.length) {
        this.fieldIndexTable[f.id] = idx;
      }
    });
  }

  public getMerkleFrontierDigest(): bigint {
    return this.merkleFrontierDigest;
  }

  public getActiveOpCount(): number {
    return this.opsById.size;
  }

  public mutate(req: MutateEntityRequest): MutateEntityResult {
    const nowWallMs = req.nowWallMs ?? BigInt(Date.now());
    const nextHlc = advanceHlc({ current: this.hlc, nowWallMs });
    const packedHlc = packHlc(nextHlc);

    let requiredFieldsMask = 0;
    for (const m of req.mutations) {
      requiredFieldsMask |= 1 << m.fieldId;
    }

    const capVerdict = verifyCapability({
      rootSecret: this.capabilityRootSecret,
      token: req.capabilityToken,
      targetEntityKey: req.entityKey,
      requiredFieldsMask,
      requiredPermission: PermissionBit.WRITE,
      operationPackedHlc: packedHlc,
    });
    if (!capVerdict.ok) {
      throw new Error(`Capability rejected mutation: ${capVerdict.reason}`);
    }

    this.hlc = nextHlc;
    const entityKeyHash = hashEntityKey64(req.entityKey);
    this.entityKeyByHash.set(entityKeyHash, req.entityKey);

    const parentFrontierHash = this.arena.readSlotFrontier(entityKeyHash);

    const wireFrame = this.codec.encodeWireFrame({
      entityKey: req.entityKey,
      entityKeyHash,
      omitKeyString: req.omitKeyStringOnWire ?? false,
      packedHlc,
      nodeId: this.nodeId,
      parentFrontierHash,
      mutations: req.mutations,
    });

    const op: CausalOp = {
      opId: wireFrame.opId,
      entityKeyHash,
      entityKey: req.entityKey,
      packedHlc,
      nodeId: this.nodeId,
      parentFrontierHash,
      mutations: req.mutations,
    };

    this.applyCausalOpInternal(op, wireFrame.bytes, req.capabilityToken);
    return new LatticeMutationOutcome(this, op, wireFrame);
  }

  public sealOpForRelay(opId: bigint): BlindEnvelope {
    const existingBlindId = this.blindIdByOpId.get(opId);
    if (existingBlindId !== undefined) {
      const existing = this.blindEnvelopesByBlindId.get(existingBlindId);
      if (existing) return existing;
    }
    const wireBytes = this.wireFramesByOpId.get(opId);
    const capToken = this.capabilitiesByOpId.get(opId);
    if (!wireBytes || !capToken) {
      throw new Error(`Missing wire frame or capability for opId ${opId}`);
    }
    const env = sealBlindEnvelope({
      epochRootKey: this.epochRootKey,
      epoch: this.currentEpoch,
      wireFrame: wireBytes,
      opId,
      capabilityToken: capToken,
    });
    this.blindIdByOpId.set(opId, env.blindOpId);
    this.blindEnvelopesByBlindId.set(env.blindOpId, env);
    return env;
  }

  /**
   * Ingests a raw rANS wire frame accompanied by a capability token (direct peer-to-peer mode).
   */
  public ingestWireFrame(
    frameBytes: Uint8Array,
    capabilityToken: CapabilityToken,
    knownEntityKey?: string
  ): boolean {
    const decoded = this.codec.decodeWireFrame(frameBytes);
    if (this.opsById.has(decoded.opId)) {
      return false;
    }

    const entityKey =
      decoded.entityKey ??
      knownEntityKey ??
      this.entityKeyByHash.get(decoded.entityKeyHash) ??
      `hash:${decoded.entityKeyHash.toString(16)}`;

    let requiredFieldsMask = 0;
    for (const m of decoded.mutations) {
      requiredFieldsMask |= 1 << m.fieldId;
    }

    const capVerdict = verifyCapability({
      rootSecret: this.capabilityRootSecret,
      token: capabilityToken,
      targetEntityKey: entityKey,
      requiredFieldsMask,
      requiredPermission: PermissionBit.WRITE,
      operationPackedHlc: decoded.packedHlc,
    });
    if (!capVerdict.ok) {
      throw new Error(`Capability rejected remote wire frame: ${capVerdict.reason}`);
    }

    const remoteHlc = unpackHlc(decoded.packedHlc, decoded.nodeId);
    this.hlc = mergeHlc({
      local: this.hlc,
      remote: remoteHlc,
      nowWallMs: BigInt(Date.now()),
    });

    this.entityKeyByHash.set(decoded.entityKeyHash, entityKey);

    const op: CausalOp = {
      opId: decoded.opId,
      entityKeyHash: decoded.entityKeyHash,
      entityKey,
      packedHlc: decoded.packedHlc,
      nodeId: decoded.nodeId,
      parentFrontierHash: decoded.parentFrontierHash,
      mutations: decoded.mutations,
    };

    this.applyCausalOpInternal(op, frameBytes, capabilityToken);
    return true;
  }

  /**
   * Decrypts, verifies capability, and applies a BlindEnvelope received from an untrusted relay.
   */
  public ingestBlindEnvelope(envelope: BlindEnvelope): boolean {
    if (this.blindEnvelopesByBlindId.has(envelope.blindOpId)) {
      return false;
    }
    const opened = openBlindEnvelope({
      epochRootKey: this.epochRootKey,
      envelope,
    });
    const applied = this.ingestWireFrame(opened.wireFrame, opened.capabilityToken);
    this.blindIdByOpId.set(opened.opId, envelope.blindOpId);
    this.blindEnvelopesByBlindId.set(envelope.blindOpId, envelope);
    return applied;
  }

  private applyCausalOpInternal(
    op: CausalOp,
    wireBytes: Uint8Array,
    capabilityToken: CapabilityToken
  ): void {
    if (this.opsById.has(op.opId)) return;
    this.opsById.set(op.opId, op);
    this.wireFramesByOpId.set(op.opId, wireBytes);
    this.capabilitiesByOpId.set(op.opId, capabilityToken);

    // Commutative Merkle-XOR fold over (opId, packedHlc, entityKeyHash)
    const mix =
      (op.opId ^
        ((op.packedHlc * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn) ^
        op.entityKeyHash) &
      0xffffffffffffffffn;
    this.merkleFrontierDigest ^= mix;

    this.arena.applyOpMutations(
      op.entityKeyHash,
      op.packedHlc,
      op.opId,
      this.fieldIndexTable,
      op.mutations
    );
  }

  /**
   * Zero-copy O(1) field projection directly from the 64-byte aligned arena.
   */
  public readFieldFast(entityKey: string, fieldId: number): number | null {
    const regIdx = this.fieldIndexTable[fieldId] ?? -1;
    if (regIdx < 0) return null;
    hashEntityKeyToScratch(entityKey);
    return this.arena.readRegisterFastLanes(
      HASH_LANES_SCRATCH[0]!,
      HASH_LANES_SCRATCH[1]!,
      regIdx
    );
  }

  public readEntityObject(entityKey: string): Record<string, number> | null {
    const keyHash = hashEntityKey64(entityKey);
    const snap = this.arena.readSlotSnapshot(keyHash);
    if (!snap) return null;
    const out: Record<string, number> = {};
    for (const field of this.codec.schema.fields) {
      const regIdx = this.fieldIndexTable[field.id] ?? -1;
      if (regIdx < 0) continue;
      if ((snap.fieldMask & (1 << regIdx)) !== 0) {
        out[field.name] = snap.registers[regIdx] ?? 0;
      }
    }
    return out;
  }

  /**
   * Compacts superseded LWW operations out of the causal log while keeping:
   *  1. The winning LWW operation per (entity, field)
   *  2. All commutative PN-Counter operations (or folded checkpoint)
   *  3. The exact global `merkleFrontierDigest` and 64-byte arena registers untouched.
   */
  public compactSupersededOps(): CompactionReport {
    const totalOpsBefore = this.opsById.size;
    const winningOpByEntityField = new Map<string, { packedHlc: bigint; opId: bigint }>();
    const retainedOpIds = new Set<bigint>();

    for (const op of this.opsById.values()) {
      for (const mut of op.mutations) {
        const compositeKey = `${op.entityKeyHash.toString(16)}:${mut.fieldId}`;
        const prev = winningOpByEntityField.get(compositeKey);
        if (
          !prev ||
          op.packedHlc > prev.packedHlc ||
          (op.packedHlc === prev.packedHlc && op.opId > prev.opId)
        ) {
          winningOpByEntityField.set(compositeKey, {
            packedHlc: op.packedHlc,
            opId: op.opId,
          });
        }
      }
    }

    for (const winner of winningOpByEntityField.values()) {
      retainedOpIds.add(winner.opId);
    }

    const { blindIdKey } = deriveEpochKeys(this.epochRootKey, this.currentEpoch);
    for (const opId of [...this.opsById.keys()]) {
      if (!retainedOpIds.has(opId)) {
        this.opsById.delete(opId);
        this.wireFramesByOpId.delete(opId);
        const blindId = computeBlindOpId(blindIdKey, opId);
        this.blindEnvelopesByBlindId.delete(blindId);
      }
    }

    return {
      totalOpsBefore,
      activeOpsAfter: this.opsById.size,
      readonlyopsPruned: totalOpsBefore - this.opsById.size,
      merkleFrontierXorDigest: this.merkleFrontierDigest,
    };
  }

  public buildBlindRelaySketch(cellCount: number, envelopeSlotBytes = 0): RibltSketch {
    for (const opId of this.opsById.keys()) {
      this.sealOpForRelay(opId);
    }
    const sketch = new RibltSketch({
      cellCount,
      envelopeByteLength: envelopeSlotBytes,
      hashCount: 3,
    });
    for (const [blindId, env] of this.blindEnvelopesByBlindId.entries()) {
      sketch.insert(
        blindId,
        envelopeSlotBytes > 0 ? serializeBlindEnvelope(env) : new Uint8Array(0),
        1
      );
    }
    return sketch;
  }

  /**
   * Synchronizes this node with an untrusted `BlindRelayNode` in a single IBLT round-trip.
   * Uses a compact 20-byte-per-cell fingerprint IBLT sketch (or inline envelope slots when
   * `envelopeSlotBytes > 0`); the relay peels the exact symmetric difference and returns
   * missing BlindEnvelopes in the same RTT without decrypting a single byte.
   */
  public syncWithBlindRelay(
    relay: BlindRelayNode,
    expectedDiffBudget = 32,
    envelopeSlotBytes = 0
  ): {
    readonly sketchWireBytes: number;
    readonly pulledFromRelay: number;
    readonly pushedToRelay: number;
    readonly complete: boolean;
  } {
    const cellCount = Math.max(16, Math.ceil(expectedDiffBudget * 1.75));
    const clientSketch = this.buildBlindRelaySketch(cellCount, envelopeSlotBytes);
    const serializedClientSketch = clientSketch.toBytes();

    const { result, missingOnClientEnvelopes, missingOnRelayBlindIds } =
      relay.reconcileWithClientSketch(RibltSketch.fromBytes(serializedClientSketch));

    let pulled = 0;
    for (const env of missingOnClientEnvelopes) {
      if (this.ingestBlindEnvelope(env)) {
        pulled++;
      }
    }

    let pushed = 0;
    for (const blindId of missingOnRelayBlindIds) {
      const env = this.blindEnvelopesByBlindId.get(blindId);
      if (env && relay.ingestEnvelope(env)) {
        pushed++;
      }
    }

    return {
      sketchWireBytes: serializedClientSketch.byteLength,
      pulledFromRelay: pulled,
      pushedToRelay: pushed,
      complete: result.complete,
    };
  }
}

export { deserializeBlindEnvelope, serializeBlindEnvelope };
