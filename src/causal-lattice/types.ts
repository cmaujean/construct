/**
 * Strict, zero-any type contracts and request/options schemas for the
 * Causal Lattice Engine (World-Track II).
 */

export type FieldEncodingKind =
  | "enum_ans"
  | "bounded_int_ans"
  | "laplace_delta_ans"
  | "pn_counter_ans";

export interface EnumFieldSpec {
  readonly id: number;
  readonly name: string;
  readonly kind: "enum_ans";
  /** Relative symbol weights (automatically normalized to ANS quantum M = 4096). */
  readonly weights: readonly number[];
}

export interface BoundedIntFieldSpec {
  readonly id: number;
  readonly name: string;
  readonly kind: "bounded_int_ans";
  readonly min: number;
  readonly max: number;
  /** Optional center value and concentration scale for skewed integers; defaults to uniform if omitted. */
  readonly mode?: number;
  readonly scale?: number;
}

export interface LaplaceDeltaFieldSpec {
  readonly id: number;
  readonly name: string;
  readonly kind: "laplace_delta_ans";
  /** Expected typical magnitude of deltas (controls the ANS magnitude-bucket probability decay). */
  readonly scaleBits: number;
  /** Optional quantization step (default 1). */
  readonly step?: number;
}

export interface PnCounterFieldSpec {
  readonly id: number;
  readonly name: string;
  readonly kind: "pn_counter_ans";
  readonly scaleBits: number;
}

export type FieldSpec =
  | EnumFieldSpec
  | BoundedIntFieldSpec
  | LaplaceDeltaFieldSpec
  | PnCounterFieldSpec;

export interface LatticeSchemaSpec {
  readonly schemaId: number;
  readonly name: string;
  readonly version: number;
  readonly fields: readonly FieldSpec[];
}

export interface HlcTimestamp {
  /** 48-bit physical unix time in milliseconds. */
  readonly wallMs: bigint;
  /** 16-bit monotonic logical counter within the same millisecond. */
  readonly logical: number;
  /** 16-bit deterministic node identifier. */
  readonly nodeId: number;
}

export interface AdvanceHlcRequest {
  readonly current: HlcTimestamp;
  readonly nowWallMs: bigint;
}

export interface MergeHlcRequest {
  readonly local: HlcTimestamp;
  readonly remote: HlcTimestamp;
  readonly nowWallMs: bigint;
}

export type CrdtOpKind = "lww_set" | "pn_add";

export interface FieldMutation {
  readonly fieldId: number;
  readonly opKind: CrdtOpKind;
  /** Integer or quantized fixed-point value (or delta for pn_add). */
  readonly value: number;
  /** Optional prior value when encoding stateful/predictive deltas. */
  readonly baselineValue?: number;
}

export interface CausalOp {
  /** 64-bit truncated BLAKE2s/SHA-256 content-addressed digest of this operation. */
  readonly opId: bigint;
  /** 64-bit deterministic hash of the target entity key. */
  readonly entityKeyHash: bigint;
  /** Human-readable entity key (only carried when introducing a new entity or in local metadata). */
  readonly entityKey: string;
  /** Packed 64-bit Hybrid Logical Clock ((wallMs << 16n) | BigInt(logical)). */
  readonly packedHlc: bigint;
  /** Originating 16-bit node ID. */
  readonly nodeId: number;
  /** Parent frontier digest (0n for genesis op on an entity). */
  readonly parentFrontierHash: bigint;
  /** Field mutations carried in this atomic causal frame. */
  readonly mutations: readonly FieldMutation[];
}

export interface CompiledWireFrame {
  /** Compact binary frame produced by the Schema-Compiled rANS Encoder. */
  readonly bytes: Uint8Array;
  /** 64-bit content-addressed operation ID. */
  readonly opId: bigint;
  /** Shannon theoretical bit lower-bound for the encoded field values. */
  readonly theoreticalBits: number;
  /** Actual bits spent on the rANS-coded field payload. */
  readonly actualPayloadBits: number;
}

export interface ArenaConfig {
  /** Power-of-two slot capacity in the 64-byte cache-line-aligned arena. */
  readonly slotCapacity: number;
  /** Maximum number of inline 32-bit registers per 64-byte entity slot (up to 8). */
  readonly inlineRegisters: number;
}

export interface ArenaSlotSnapshot {
  readonly slotIndex: number;
  readonly entityKeyHash: bigint;
  readonly lastPackedHlc: bigint;
  readonly merkleFrontierHash: bigint;
  readonly fieldMask: number;
  readonly registers: readonly number[];
}

export interface ArenaStats {
  readonly slotCapacity: number;
  readonly occupiedSlots: number;
  readonly loadFactor: number;
  readonly arenaBytes: number;
  readonly maxProbeDistance: number;
}

export interface RibltCell {
  count: number;
  opIdXor: bigint;
  checksumXor: bigint;
  payloadXor: Uint8Array;
}

export interface RibltConfig {
  /** Number of cells in the IBLT sketch (scales with expected symmetric difference d, e.g. ~1.5 * d + 8). */
  readonly cellCount: number;
  /** Fixed envelope slot byte length for XOR payload peeling. */
  readonly envelopeByteLength: number;
  /** Number of independent hash functions k (default 4). */
  readonly hashCount?: number;
}

export interface RibltReconcileResult {
  readonly complete: boolean;
  readonly peeledLocalOnlyOpIds: readonly bigint[];
  readonly peeledRemoteOnlyOpIds: readonly bigint[];
  readonly peeledRemoteOnlyEnvelopes: readonly Uint8Array[];
  readonly peelingIterations: number;
  readonly sketchWireBytes: number;
}

export const PermissionBit = {
  READ: 1 << 0,
  WRITE: 1 << 1,
  SYNC: 1 << 2,
  COMPACT: 1 << 3,
  ALL: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3),
} as const;

export interface CapabilityCaveat {
  /** Required entity key prefix (empty string means all entities allowed). */
  readonly entityPrefix: string;
  /** Bitmask of allowed schema field IDs (0xffffffff means all fields). */
  readonly allowedFieldsMask: number;
  /** Bitmask of PermissionBit flags. */
  readonly permissionsMask: number;
  /** Maximum packed HLC timestamp at which this capability remains valid. */
  readonly maxPackedHlc: bigint;
}

export interface CapabilityToken {
  readonly rootId: number;
  readonly caveats: readonly CapabilityCaveat[];
  /** Chained 32-byte HMAC-SHA256 tail signature over rootSecret and all caveats in sequence. */
  readonly tailSignature: Uint8Array;
}

export interface MintCapabilityRequest {
  readonly rootSecret: Uint8Array;
  readonly rootId: number;
  readonly initialCaveat: CapabilityCaveat;
}

export interface AttenuateCapabilityRequest {
  readonly parentToken: CapabilityToken;
  readonly newCaveat: CapabilityCaveat;
}

export interface VerifyCapabilityRequest {
  readonly rootSecret: Uint8Array;
  readonly token: CapabilityToken;
  readonly targetEntityKey: string;
  readonly requiredFieldsMask: number;
  readonly requiredPermission: number;
  readonly operationPackedHlc: bigint;
}

export interface BlindEnvelope {
  /** 64-bit blinded operation ID: keyed SipHash/HMAC over opId so relay cannot correlate across epochs/tenants. */
  readonly blindOpId: bigint;
  /** Ratchet epoch index. */
  readonly epoch: number;
  /** 12-byte ChaCha20-Poly1305 nonce. */
  readonly nonce: Uint8Array;
  /** ChaCha20-Poly1305 encrypted rANS wire frame + capability proof. */
  readonly ciphertext: Uint8Array;
  /** 16-byte Poly1305 authentication tag. */
  readonly authTag: Uint8Array;
}

export interface SealEnvelopeRequest {
  readonly epochRootKey: Uint8Array;
  readonly epoch: number;
  readonly wireFrame: Uint8Array;
  readonly opId: bigint;
  readonly capabilityToken: CapabilityToken;
}

export interface OpenEnvelopeRequest {
  readonly epochRootKey: Uint8Array;
  readonly envelope: BlindEnvelope;
}

export interface OpenedEnvelopePayload {
  readonly opId: bigint;
  readonly wireFrame: Uint8Array;
  readonly capabilityToken: CapabilityToken;
}
