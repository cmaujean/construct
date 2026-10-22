import { type ArenaConfig, type ArenaSlotSnapshot, type ArenaStats } from "./types.ts";

/**
 * 64-Byte Cache-Line-Aligned Zero-Copy Binary Arena (`CausalArena`).
 *
 * Each 64-byte slot matches a single CPU L1/L2 cache line:
 *   Bytes 00..07: entityKeyHash      (BigUint64LE, 0n === unoccupied slot)
 *   Bytes 08..15: lastPackedHlc      (BigUint64LE, highest causal HLC applied)
 *   Bytes 16..23: merkleFrontierHash (BigUint64LE, rolling causal Merkle digest)
 *   Bytes 24..27: fieldMask          (Uint32LE, bitmask of populated registers)
 *   Bytes 28..31: probeAndFlags      (Uint16LE probeDistance + Uint16LE flags)
 *   Bytes 32..63: 8 x Int32LE inline schema registers (zero-parse field projection)
 */
const SLOT_STRIDE_BYTES = 64;
const INLINE_REGISTERS_MAX = 8;

const SCRATCH_CUR_REGS = new Int32Array(INLINE_REGISTERS_MAX);
const SCRATCH_CUR_WM = new BigUint64Array(INLINE_REGISTERS_MAX);
const SCRATCH_DISP_REGS = new Int32Array(INLINE_REGISTERS_MAX);
const SCRATCH_DISP_WM = new BigUint64Array(INLINE_REGISTERS_MAX);

export interface ApplyCellMutationRequest {
  readonly entityKeyHash: bigint;
  readonly packedHlc: bigint;
  readonly opId: bigint;
  readonly registerIndex: number;
  readonly opKind: "lww_set" | "pn_add";
  readonly value: number;
}

export class CausalArena {
  public readonly slotCapacity: number;
  public readonly inlineRegisters: number;
  private readonly mask: number;
  private readonly buffer: ArrayBuffer;
  private readonly view: DataView;
  private readonly u32View: Uint32Array;
  private readonly i32View: Int32Array;
  /** Per-slot per-register HLC watermarks for fine-grained field-level LWW resolution. */
  private readonly fieldHlcWatermarks: BigUint64Array;
  private occupiedCount = 0;
  private maxProbe = 0;

  public constructor(config: ArenaConfig) {
    if (
      config.slotCapacity < 16 ||
      (config.slotCapacity & (config.slotCapacity - 1)) !== 0
    ) {
      throw new RangeError(
        `Arena slotCapacity must be a power of two >= 16, got ${config.slotCapacity}`
      );
    }
    if (config.inlineRegisters < 1 || config.inlineRegisters > INLINE_REGISTERS_MAX) {
      throw new RangeError(
        `inlineRegisters must be in 1..${INLINE_REGISTERS_MAX}, got ${config.inlineRegisters}`
      );
    }
    this.slotCapacity = config.slotCapacity;
    this.inlineRegisters = config.inlineRegisters;
    this.mask = config.slotCapacity - 1;
    this.buffer = new ArrayBuffer(config.slotCapacity * SLOT_STRIDE_BYTES);
    this.view = new DataView(this.buffer);
    this.u32View = new Uint32Array(this.buffer);
    this.i32View = new Int32Array(this.buffer);
    this.fieldHlcWatermarks = new BigUint64Array(
      config.slotCapacity * INLINE_REGISTERS_MAX
    );
  }

  private initialBucketLanes(keyLo: number, keyHi: number): number {
    const mixed = Math.imul(keyLo ^ keyHi, 0x9e3779b9) >>> 0;
    return ((mixed ^ (mixed >>> 16)) & this.mask) >>> 0;
  }

  private initialBucket(keyHash: bigint): number {
    const lo = Number(keyHash & 0xffffffffn) >>> 0;
    const hi = Number((keyHash >> 32n) & 0xffffffffn) >>> 0;
    return this.initialBucketLanes(lo, hi);
  }

  /**
   * Unboxed, zero-allocation slot lookup using 32-bit key lanes (`keyLo`, `keyHi`).
   */
  public findSlotIndexLanes(keyLo: number, keyHi: number): number {
    if (keyLo === 0 && keyHi === 0) return -1;
    let bucket = this.initialBucketLanes(keyLo, keyHi);
    let dist = 0;
    while (dist < this.slotCapacity) {
      const u32Base = bucket << 4; // 64 bytes = 16 x uint32
      const existingLo = this.u32View[u32Base] ?? 0;
      const existingHi = this.u32View[u32Base + 1] ?? 0;
      if (existingLo === 0 && existingHi === 0) {
        return -1;
      }
      if (existingLo === keyLo && existingHi === keyHi) {
        return bucket;
      }
      const existingProbe = (this.u32View[u32Base + 7] ?? 0) & 0xffff;
      if (existingProbe < dist) {
        return -1;
      }
      bucket = (bucket + 1) & this.mask;
      dist++;
    }
    return -1;
  }

  public findSlotIndex(rawKeyHash: bigint): number {
    const entityKeyHash = rawKeyHash & 0xffffffffffffffffn;
    const lo = Number(entityKeyHash & 0xffffffffn) >>> 0;
    const hi = Number((entityKeyHash >> 32n) & 0xffffffffn) >>> 0;
    return this.findSlotIndexLanes(lo, hi);
  }

  private ensureSlot(rawKeyHash: bigint): number {
    const entityKeyHash = rawKeyHash & 0xffffffffffffffffn;
    const existing = this.findSlotIndex(entityKeyHash);
    if (existing !== -1) return existing;

    if (this.occupiedCount >= this.slotCapacity * 0.9) {
      throw new Error(
        `CausalArena capacity threshold reached (${this.occupiedCount}/${this.slotCapacity})`
      );
    }

    let bucket = this.initialBucket(entityKeyHash);
    let dist = 0;

    let curKey = entityKeyHash;
    let curHlc = 0n;
    let curMerkle = 0n;
    let curMask = 0;
    let curFlags = 0;
    SCRATCH_CUR_REGS.fill(0);
    SCRATCH_CUR_WM.fill(0n);
    let insertedSlot = -1;

    while (dist < this.slotCapacity) {
      const byteOffset = bucket * SLOT_STRIDE_BYTES;
      const slotKey = this.view.getBigUint64(byteOffset, true);

      if (slotKey === 0n) {
        this.writeCompleteSlot(
          bucket,
          curKey,
          curHlc,
          curMerkle,
          curMask,
          dist,
          curFlags,
          SCRATCH_CUR_REGS,
          SCRATCH_CUR_WM
        );
        this.occupiedCount++;
        if (dist > this.maxProbe) this.maxProbe = dist;
        return insertedSlot !== -1 ? insertedSlot : bucket;
      }

      const slotProbe = this.view.getUint16(byteOffset + 28, true);
      if (slotProbe < dist) {
        // Displace the rich slot and continue Robin Hood cascading
        const displacedHlc = this.view.getBigUint64(byteOffset + 8, true);
        const displacedMerkle = this.view.getBigUint64(byteOffset + 16, true);
        const displacedMask = this.view.getUint32(byteOffset + 24, true);
        const displacedFlags = this.view.getUint16(byteOffset + 30, true);
        const i32Base = (byteOffset + 32) >> 2;
        const wmBase = bucket * INLINE_REGISTERS_MAX;
        for (let r = 0; r < INLINE_REGISTERS_MAX; r++) {
          SCRATCH_DISP_REGS[r] = this.i32View[i32Base + r] ?? 0;
          SCRATCH_DISP_WM[r] = this.fieldHlcWatermarks[wmBase + r] ?? 0n;
        }

        this.writeCompleteSlot(
          bucket,
          curKey,
          curHlc,
          curMerkle,
          curMask,
          dist,
          curFlags,
          SCRATCH_CUR_REGS,
          SCRATCH_CUR_WM
        );
        if (insertedSlot === -1) {
          insertedSlot = bucket;
        }
        if (dist > this.maxProbe) this.maxProbe = dist;

        curKey = slotKey;
        curHlc = displacedHlc;
        curMerkle = displacedMerkle;
        curMask = displacedMask;
        curFlags = displacedFlags;
        SCRATCH_CUR_REGS.set(SCRATCH_DISP_REGS);
        SCRATCH_CUR_WM.set(SCRATCH_DISP_WM);
        dist = slotProbe;
      }

      bucket = (bucket + 1) & this.mask;
      dist++;
    }

    throw new Error("CausalArena full");
  }

  private writeCompleteSlot(
    slotIndex: number,
    keyHash: bigint,
    hlc: bigint,
    merkle: bigint,
    fieldMask: number,
    probeDist: number,
    flags: number,
    regs: Int32Array,
    watermarks: BigUint64Array
  ): void {
    const byteOffset = slotIndex * SLOT_STRIDE_BYTES;
    this.view.setBigUint64(byteOffset, keyHash, true);
    this.view.setBigUint64(byteOffset + 8, hlc, true);
    this.view.setBigUint64(byteOffset + 16, merkle, true);
    this.view.setUint32(byteOffset + 24, fieldMask >>> 0, true);
    this.view.setUint16(byteOffset + 28, probeDist & 0xffff, true);
    this.view.setUint16(byteOffset + 30, flags & 0xffff, true);

    const i32Base = (byteOffset + 32) >> 2;
    const wmBase = slotIndex * INLINE_REGISTERS_MAX;
    for (let r = 0; r < INLINE_REGISTERS_MAX; r++) {
      this.i32View[i32Base + r] = regs[r] ?? 0;
      this.fieldHlcWatermarks[wmBase + r] = watermarks[r] ?? 0n;
    }
  }

  /**
   * Applies an atomic field mutation directly to the 64-byte cache-line slot.
   * Returns true if the register state changed (was not superseded by a newer HLC).
   */
  public applyMutation(req: ApplyCellMutationRequest): boolean {
    if (req.registerIndex < 0 || req.registerIndex >= this.inlineRegisters) {
      throw new RangeError(`Register index ${req.registerIndex} out of bounds`);
    }
    const slot = this.ensureSlot(req.entityKeyHash);
    const byteOffset = slot * SLOT_STRIDE_BYTES;
    const wmIndex = slot * INLINE_REGISTERS_MAX + req.registerIndex;
    const currentFieldHlc = this.fieldHlcWatermarks[wmIndex] ?? 0n;
    const i32Index = ((byteOffset + 32) >> 2) + req.registerIndex;

    // Commutative XOR-mix into the entity's Merkle frontier regardless of arrival order
    const oldFrontier = this.view.getBigUint64(byteOffset + 16, true);
    const mixedOp =
      ((req.opId ^ (req.packedHlc * 0x9e3779b97f4a7c15n)) & 0xffffffffffffffffn);
    this.view.setBigUint64(byteOffset + 16, oldFrontier ^ mixedOp, true);

    const slotLastHlc = this.view.getBigUint64(byteOffset + 8, true);
    if (req.packedHlc > slotLastHlc) {
      this.view.setBigUint64(byteOffset + 8, req.packedHlc, true);
    }

    const mask = this.view.getUint32(byteOffset + 24, true);
    this.view.setUint32(byteOffset + 24, (mask | (1 << req.registerIndex)) >>> 0, true);

    if (req.opKind === "pn_add") {
      // Commutative PN-Counter addition directly in the Int32 register
      this.i32View[i32Index] = ((this.i32View[i32Index] ?? 0) + (req.value | 0)) | 0;
      if (req.packedHlc > currentFieldHlc) {
        this.fieldHlcWatermarks[wmIndex] = req.packedHlc;
      }
      return true;
    }

    // LWW Register: higher packedHlc wins; on exact HLC tie, higher opId wins deterministically.
    if (req.packedHlc < currentFieldHlc) {
      return false;
    }
    this.fieldHlcWatermarks[wmIndex] = req.packedHlc;
    this.i32View[i32Index] = req.value | 0;
    return true;
  }

  /**
   * Fast O(1) read of an entity's 64-bit Merkle frontier without allocating a snapshot object.
   */
  public readSlotFrontier(entityKeyHash: bigint): bigint {
    const slot = this.findSlotIndex(entityKeyHash);
    if (slot === -1) return 0n;
    return this.view.getBigUint64(slot * SLOT_STRIDE_BYTES + 16, true);
  }

  /**
   * Applies all field mutations of a CausalOp in a single slot lookup.
   */
  public applyOpMutations(
    entityKeyHash: bigint,
    packedHlc: bigint,
    opId: bigint,
    fieldIndexTable: Int16Array,
    mutations: readonly { readonly fieldId: number; readonly opKind: "lww_set" | "pn_add"; readonly value: number }[]
  ): void {
    const slot = this.ensureSlot(entityKeyHash);
    const byteOffset = slot * SLOT_STRIDE_BYTES;
    const u32Base = slot << 4;
    const wmBase = slot * INLINE_REGISTERS_MAX;

    const oldFrontier = this.view.getBigUint64(byteOffset + 16, true);
    const mixedOp = (opId ^ (packedHlc * 0x9e3779b97f4a7c15n)) & 0xffffffffffffffffn;
    this.view.setBigUint64(byteOffset + 16, oldFrontier ^ mixedOp, true);

    const slotLastHlc = this.view.getBigUint64(byteOffset + 8, true);
    if (packedHlc > slotLastHlc) {
      this.view.setBigUint64(byteOffset + 8, packedHlc, true);
    }

    let mask = this.u32View[u32Base + 6] ?? 0;
    for (let i = 0; i < mutations.length; i++) {
      const mut = mutations[i]!;
      const regIdx = fieldIndexTable[mut.fieldId] ?? -1;
      if (regIdx < 0 || regIdx >= this.inlineRegisters) continue;
      mask |= 1 << regIdx;
      const i32Index = u32Base + 8 + regIdx;
      const wmIndex = wmBase + regIdx;
      const currentFieldHlc = this.fieldHlcWatermarks[wmIndex] ?? 0n;

      if (mut.opKind === "pn_add") {
        this.i32View[i32Index] = ((this.i32View[i32Index] ?? 0) + (mut.value | 0)) | 0;
        if (packedHlc > currentFieldHlc) {
          this.fieldHlcWatermarks[wmIndex] = packedHlc;
        }
      } else if (packedHlc >= currentFieldHlc) {
        this.fieldHlcWatermarks[wmIndex] = packedHlc;
        this.i32View[i32Index] = mut.value | 0;
      }
    }
    this.u32View[u32Base + 6] = mask >>> 0;
  }
  public readRegisterFastLanes(
    keyLo: number,
    keyHi: number,
    registerIndex: number
  ): number | null {
    const slot = this.findSlotIndexLanes(keyLo, keyHi);
    if (slot === -1) return null;
    const u32Base = slot << 4;
    const mask = this.u32View[u32Base + 6] ?? 0;
    if ((mask & (1 << registerIndex)) === 0) return null;
    return this.i32View[u32Base + 8 + registerIndex] ?? 0;
  }

  /**
   * Zero-allocation O(1) direct register read from the 64-byte aligned arena.
   */
  public readRegisterFast(entityKeyHash: bigint, registerIndex: number): number | null {
    const k = entityKeyHash & 0xffffffffffffffffn;
    const lo = Number(k & 0xffffffffn) >>> 0;
    const hi = Number((k >> 32n) & 0xffffffffn) >>> 0;
    return this.readRegisterFastLanes(lo, hi, registerIndex);
  }

  public readSlotSnapshot(entityKeyHash: bigint): ArenaSlotSnapshot | null {
    const slot = this.findSlotIndex(entityKeyHash);
    if (slot === -1) return null;
    const byteOffset = slot * SLOT_STRIDE_BYTES;
    const lastPackedHlc = this.view.getBigUint64(byteOffset + 8, true);
    const merkleFrontierHash = this.view.getBigUint64(byteOffset + 16, true);
    const fieldMask = this.view.getUint32(byteOffset + 24, true);
    const i32Base = (byteOffset + 32) >> 2;
    const registers: number[] = [];
    for (let r = 0; r < this.inlineRegisters; r++) {
      registers.push(this.i32View[i32Base + r] ?? 0);
    }
    return {
      slotIndex: slot,
      entityKeyHash,
      lastPackedHlc,
      merkleFrontierHash,
      fieldMask,
      registers,
    };
  }

  /**
   * Exports the raw 64-byte-aligned memory image (zero-parse disk snapshot).
   */
  public exportBinaryImage(): Uint8Array {
    return new Uint8Array(this.buffer.slice(0));
  }

  public stats(): ArenaStats {
    return {
      slotCapacity: this.slotCapacity,
      occupiedSlots: this.occupiedCount,
      loadFactor: this.occupiedCount / this.slotCapacity,
      arenaBytes: this.buffer.byteLength,
      maxProbeDistance: this.maxProbe,
    };
  }
}
