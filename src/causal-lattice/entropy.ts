import { chaskey12Mac128Into } from "./crypto.ts";
import {
  type BoundedIntFieldSpec,
  type CompiledWireFrame,
  type CrdtOpKind,
  type EnumFieldSpec,
  type FieldMutation,
  type FieldSpec,
  type LaplaceDeltaFieldSpec,
  type LatticeSchemaSpec,
  type PnCounterFieldSpec,
} from "./types.ts";

const ANS_PROB_BITS = 12;
const ANS_QUANTUM = 1 << ANS_PROB_BITS; // 4096
const ANS_LOWER_BOUND = 1 << 16; // 65536

export interface CompiledDistributionTable {
  readonly symbolCount: number;
  readonly freq: Uint16Array;
  readonly cumFreq: Uint16Array;
  readonly slotToSymbol: Uint16Array;
  readonly shannonBits: Float64Array;
}

/**
 * Normalizes arbitrary positive symbol weights into an exact sum of M = 4096
 * with every symbol guaranteed frequency >= 1 so no symbol is unencodable.
 */
export function compileDistributionTable(weights: readonly number[]): CompiledDistributionTable {
  const n = weights.length;
  if (n === 0 || n > ANS_QUANTUM) {
    throw new RangeError(`Symbol count must be in 1..${ANS_QUANTUM}, got ${n}`);
  }

  const cleanWeights = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 1e-6));
  const totalWeight = cleanWeights.reduce((acc, w) => acc + w, 0);

  const freq = new Uint16Array(n);
  const cumFreq = new Uint16Array(n);
  const slotToSymbol = new Uint16Array(ANS_QUANTUM);
  const shannonBits = new Float64Array(n);

  let assigned = 0;
  for (let i = 0; i < n; i++) {
    const w = cleanWeights[i] ?? 1e-6;
    const scaled = Math.max(1, Math.round((w / totalWeight) * ANS_QUANTUM));
    freq[i] = scaled;
    assigned += scaled;
  }

  // Rebalance largest-frequency buckets so sum(freq) === ANS_QUANTUM (4096) with all freq[i] >= 1.
  let diff = ANS_QUANTUM - assigned;
  while (diff !== 0) {
    let bestIdx = 0;
    for (let i = 1; i < n; i++) {
      const f = freq[i] ?? 1;
      const bestF = freq[bestIdx] ?? 1;
      if (diff < 0 ? f > bestF : f >= bestF) {
        bestIdx = i;
      }
    }
    const cur = freq[bestIdx] ?? 1;
    if (diff < 0 && cur <= 1) {
      // Find any bucket > 1
      let fallback = -1;
      for (let i = 0; i < n; i++) {
        if ((freq[i] ?? 1) > 1) {
          fallback = i;
          break;
        }
      }
      if (fallback === -1) break;
      bestIdx = fallback;
    }
    const step = diff > 0 ? 1 : -1;
    freq[bestIdx] = (freq[bestIdx] ?? 1) + step;
    diff -= step;
  }

  let running = 0;
  for (let i = 0; i < n; i++) {
    const f = freq[i] ?? 1;
    cumFreq[i] = running;
    for (let slot = running; slot < running + f; slot++) {
      slotToSymbol[slot] = i;
    }
    running += f;
    shannonBits[i] = -Math.log2(f / ANS_QUANTUM);
  }

  return {
    symbolCount: n,
    freq,
    cumFreq,
    slotToSymbol,
    shannonBits,
  };
}

export function zigzagEncode32(value: number): number {
  const v = value | 0;
  return ((v << 1) ^ (v >> 31)) >>> 0;
}

export function zigzagDecode32(zz: number): number {
  const u = zz >>> 0;
  return (u >>> 1) ^ -(u & 1);
}

export interface DecomposedMagnitude {
  /** Bucket 0..32: 0 means zz===0; bucket b>=1 covers [2^(b-1), 2^b - 1] with (b-1) mantissa bits. */
  readonly bucket: number;
  readonly mantissa: number;
  readonly mantissaBits: number;
}

export function decomposeUnsignedMagnitude(zz: number): DecomposedMagnitude {
  const u = zz >>> 0;
  if (u === 0) {
    return { bucket: 0, mantissa: 0, mantissaBits: 0 };
  }
  const bitLen = 32 - Math.clz32(u);
  const mantissaBits = bitLen - 1;
  const mantissa = mantissaBits === 0 ? 0 : u & ((1 << mantissaBits) - 1);
  return {
    bucket: bitLen,
    mantissa,
    mantissaBits,
  };
}

export function recomposeUnsignedMagnitude(bucket: number, mantissa: number): number {
  if (bucket === 0) return 0;
  const mantissaBits = bucket - 1;
  return (((1 << mantissaBits) | (mantissa & ((1 << mantissaBits) - 1))) >>> 0);
}

/**
 * Packed bit-buffer for residual mantissa bits alongside rANS symbol streams.
 */
export class BitPacker {
  private readonly buf = new Uint8Array(256);
  private byteLen = 0;
  private currentByte = 0;
  private bitOffset = 0;

  public reset(): void {
    this.byteLen = 0;
    this.currentByte = 0;
    this.bitOffset = 0;
  }

  public writeBits(value: number, bitCount: number): void {
    let v = value >>> 0;
    for (let i = 0; i < bitCount; i++) {
      const bit = v & 1;
      v >>>= 1;
      this.currentByte |= bit << this.bitOffset;
      this.bitOffset++;
      if (this.bitOffset === 8) {
        this.buf[this.byteLen++] = this.currentByte;
        this.currentByte = 0;
        this.bitOffset = 0;
      }
    }
  }

  public finishSubarray(): Uint8Array {
    if (this.bitOffset > 0) {
      this.buf[this.byteLen++] = this.currentByte;
      this.currentByte = 0;
      this.bitOffset = 0;
    }
    return this.buf.subarray(0, this.byteLen);
  }

  public finish(): Uint8Array {
    return this.finishSubarray().slice();
  }
}

export class BitReader {
  private readonly buf: Uint8Array;
  private byteIndex = 0;
  private bitOffset = 0;

  public constructor(buf: Uint8Array, startOffset = 0) {
    this.buf = buf;
    this.byteIndex = startOffset;
  }

  public readBits(bitCount: number): number {
    let result = 0;
    for (let i = 0; i < bitCount; i++) {
      const byte = this.buf[this.byteIndex] ?? 0;
      const bit = (byte >>> this.bitOffset) & 1;
      result |= bit << i;
      this.bitOffset++;
      if (this.bitOffset === 8) {
        this.bitOffset = 0;
        this.byteIndex++;
      }
    }
    return result >>> 0;
  }

  public bytesConsumed(startOffset = 0): number {
    return (this.byteIndex - startOffset) + (this.bitOffset > 0 ? 1 : 0);
  }
}

/**
 * 24-bit LIFO Range Asymmetric Numeral Systems (rANS) encoder & decoder.
 */
export class RansStreamEncoder {
  private state = ANS_LOWER_BOUND;
  private readonly reversedBuf = new Uint8Array(256);
  private reversedLen = 0;
  private readonly outBuf = new Uint8Array(260);

  public reset(): void {
    this.state = ANS_LOWER_BOUND;
    this.reversedLen = 0;
  }

  public encodeSymbol(table: CompiledDistributionTable, symbol: number): void {
    if (symbol < 0 || symbol >= table.symbolCount) {
      throw new RangeError(`Symbol ${symbol} out of range 0..${table.symbolCount - 1}`);
    }
    const f = table.freq[symbol] ?? 1;
    const b = table.cumFreq[symbol] ?? 0;
    const xMax = 4096 * f;

    while (this.state >= xMax) {
      this.reversedBuf[this.reversedLen++] = this.state & 0xff;
      this.state >>>= 8;
    }

    const q = Math.floor(this.state / f);
    const r = this.state - q * f;
    this.state = q * ANS_QUANTUM + r + b;
  }

  public flushSubarray(): Uint8Array {
    const tailLen = this.reversedLen;
    this.outBuf[0] = (this.state >>> 16) & 0xff;
    this.outBuf[1] = (this.state >>> 8) & 0xff;
    this.outBuf[2] = this.state & 0xff;
    for (let i = 0; i < tailLen; i++) {
      this.outBuf[3 + i] = this.reversedBuf[tailLen - 1 - i] ?? 0;
    }
    return this.outBuf.subarray(0, 3 + tailLen);
  }

  public flush(): Uint8Array {
    return this.flushSubarray().slice();
  }
}

export class RansStreamDecoder {
  private state: number;
  private readonly buf: Uint8Array;
  private offset: number;
  private readonly endOffset: number;

  public constructor(buf: Uint8Array, startOffset = 0, byteLength?: number) {
    const len = byteLength ?? (buf.length - startOffset);
    if (len < 3) {
      throw new RangeError(`rANS stream requires at least 3 state bytes, got ${len}`);
    }
    this.buf = buf;
    this.state =
      (((buf[startOffset] ?? 0) << 16) |
        ((buf[startOffset + 1] ?? 0) << 8) |
        (buf[startOffset + 2] ?? 0)) >>>
      0;
    this.offset = startOffset + 3;
    this.endOffset = startOffset + len;
  }

  public decodeSymbol(table: CompiledDistributionTable): number {
    const c = this.state & (ANS_QUANTUM - 1);
    const symbol = table.slotToSymbol[c] ?? 0;
    const f = table.freq[symbol] ?? 1;
    const b = table.cumFreq[symbol] ?? 0;

    this.state = f * (this.state >>> ANS_PROB_BITS) + (c - b);

    while (this.state < ANS_LOWER_BOUND && this.offset < this.endOffset) {
      this.state = ((this.state << 8) | (this.buf[this.offset] ?? 0)) >>> 0;
      this.offset++;
    }
    return symbol;
  }
}

interface CompiledFieldEntry {
  readonly spec: FieldSpec;
  readonly table: CompiledDistributionTable;
}

function buildFieldTable(spec: FieldSpec): CompiledDistributionTable {
  switch (spec.kind) {
    case "enum_ans":
      return compileDistributionTable(spec.weights);
    case "bounded_int_ans": {
      const count = spec.max - spec.min + 1;
      const mode = spec.mode ?? Math.floor((spec.min + spec.max) / 2);
      const scale = spec.scale ?? Math.max(1, count / 6);
      const weights: number[] = [];
      for (let v = spec.min; v <= spec.max; v++) {
        const dist = Math.abs(v - mode);
        weights.push(Math.exp(-dist / scale));
      }
      return compileDistributionTable(weights);
    }
    case "laplace_delta_ans":
    case "pn_counter_ans": {
      // 33 magnitude buckets (0..32) modeled with Laplace exponential decay around scaleBits.
      const weights: number[] = [];
      const center = Math.max(0, Math.min(32, spec.scaleBits));
      for (let bucket = 0; bucket <= 32; bucket++) {
        const dist = bucket === 0 ? Math.max(0.2, center * 0.35) : Math.abs(bucket - center);
        weights.push(Math.exp(-dist / 2.2));
      }
      return compileDistributionTable(weights);
    }
  }
}

export const HASH_LANES_SCRATCH = new Uint32Array(2);

/**
 * Ultra-fast, zero-allocation 64-bit dual-lane Murmur3/xorshift hash over UTF-16 code units
 * using V8 Smi `Math.imul` instructions. Writes (lo32, hi32) into `HASH_LANES_SCRATCH`.
 */
export function hashEntityKeyToScratch(entityKey: string): void {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x1b873593 | 0;
  const len = entityKey.length;
  for (let i = 0; i < len; i++) {
    const ch = entityKey.charCodeAt(i);
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
}

export function hashEntityKeyLanes(entityKey: string): { readonly lo: number; readonly hi: number } {
  hashEntityKeyToScratch(entityKey);
  return { lo: HASH_LANES_SCRATCH[0]!, hi: HASH_LANES_SCRATCH[1]! };
}

export function hashEntityKey64(entityKey: string): bigint {
  hashEntityKeyToScratch(entityKey);
  return (BigInt(HASH_LANES_SCRATCH[1]!) << 32n) | BigInt(HASH_LANES_SCRATCH[0]!);
}

const OP_ID_KEY = new Uint8Array([
  0x4c, 0x41, 0x54, 0x54, 0x49, 0x43, 0x45, 0x5f,
  0x4f, 0x50, 0x5f, 0x49, 0x44, 0x5f, 0x36, 0x34,
]);
const OP_ID_SCRATCH_BUF = new Uint8Array(256);
const OP_ID_SCRATCH_VIEW = new DataView(OP_ID_SCRATCH_BUF.buffer);
const OP_ID_OUT_SCRATCH = new Uint8Array(16);
const OP_ID_OUT_VIEW = new DataView(OP_ID_OUT_SCRATCH.buffer);

export function computeOpId64(params: {
  readonly schemaId: number;
  readonly entityKeyHash: bigint;
  readonly packedHlc: bigint;
  readonly nodeId: number;
  readonly parentFrontierHash: bigint;
  readonly ansPayload: Uint8Array;
}): bigint {
  const payloadLen = params.ansPayload.byteLength;
  const totalLen = 28 + payloadLen;
  if (totalLen <= OP_ID_SCRATCH_BUF.byteLength) {
    OP_ID_SCRATCH_VIEW.setUint16(0, params.schemaId & 0xffff, true);
    OP_ID_SCRATCH_VIEW.setUint16(2, params.nodeId & 0xffff, true);
    OP_ID_SCRATCH_VIEW.setBigUint64(4, params.entityKeyHash, true);
    OP_ID_SCRATCH_VIEW.setBigUint64(12, params.packedHlc, true);
    OP_ID_SCRATCH_VIEW.setBigUint64(20, params.parentFrontierHash, true);
    OP_ID_SCRATCH_BUF.set(params.ansPayload, 28);
    chaskey12Mac128Into(
      OP_ID_KEY,
      OP_ID_SCRATCH_BUF.subarray(0, totalLen),
      OP_ID_OUT_SCRATCH
    );
    return OP_ID_OUT_VIEW.getBigUint64(0, true);
  }
  const buf = new Uint8Array(totalLen);
  const view = new DataView(buf.buffer);
  view.setUint16(0, params.schemaId & 0xffff, true);
  view.setUint16(2, params.nodeId & 0xffff, true);
  view.setBigUint64(4, params.entityKeyHash, true);
  view.setBigUint64(12, params.packedHlc, true);
  view.setBigUint64(20, params.parentFrontierHash, true);
  buf.set(params.ansPayload, 28);
  chaskey12Mac128Into(OP_ID_KEY, buf, OP_ID_OUT_SCRATCH);
  return OP_ID_OUT_VIEW.getBigUint64(0, true);
}

function writeUnsignedVarintToBuf(buf: Uint8Array, offset: number, value: bigint): number {
  let v = value;
  let idx = offset;
  while (v >= 0x80n) {
    buf[idx++] = Number(v & 0x7fn) | 0x80;
    v >>= 7n;
  }
  buf[idx++] = Number(v);
  return idx;
}

function decodeUnsignedVarint(buf: Uint8Array, offset: number): { value: bigint; nextOffset: number } {
  let result = 0n;
  let shift = 0n;
  let idx = offset;
  while (idx < buf.length) {
    const byte = buf[idx] ?? 0;
    idx++;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: idx };
    }
    shift += 7n;
  }
  throw new RangeError("Truncated varint in wire frame");
}

export interface EncodeFrameRequest {
  readonly entityKey: string;
  readonly entityKeyHash?: bigint;
  /** When true, omits the UTF-8 entityKey string and sends only the 64-bit entityKeyHash (known entity fast-path). */
  readonly omitKeyString?: boolean;
  readonly packedHlc: bigint;
  readonly referenceWallMs?: bigint;
  readonly nodeId: number;
  readonly parentFrontierHash: bigint;
  readonly mutations: readonly FieldMutation[];
}

export interface DecodedWireFrame {
  readonly schemaId: number;
  readonly opId: bigint;
  readonly entityKeyHash: bigint;
  readonly entityKey: string | null;
  readonly packedHlc: bigint;
  readonly nodeId: number;
  readonly parentFrontierHash: bigint;
  readonly mutations: readonly FieldMutation[];
}

/**
 * Schema-Compiled ANS Codec: compiles an application schema into static O(1)
 * rANS lookup tables and packs causal mutations near the Shannon limit.
 */
export class CompiledSchemaCodec {
  public readonly schema: LatticeSchemaSpec;
  private readonly fieldEntries: CompiledFieldEntry[] = [];
  private readonly fieldLookup: Array<FieldMutation | undefined> = new Array(64);
  private readonly ansTablesScratch: CompiledDistributionTable[] = new Array(128);
  private readonly ansSymbolsScratch = new Uint16Array(128);
  private readonly reusablePacker = new BitPacker();
  private readonly reusableRans = new RansStreamEncoder();
  private readonly payloadScratch = new Uint8Array(512);
  private readonly presenceTable: CompiledDistributionTable;

  public constructor(schema: LatticeSchemaSpec) {
    this.schema = schema;
    for (const field of schema.fields) {
      this.fieldEntries.push({
        spec: field,
        table: buildFieldTable(field),
      });
    }
    // 2-symbol table for field presence bit when encoding sparse subsets
    this.presenceTable = compileDistributionTable([3, 5]);
  }

  public encodeMutationPayload(mutations: readonly FieldMutation[]): {
    readonly payloadBytes: Uint8Array;
    readonly theoreticalBits: number;
  } {
    this.fieldLookup.fill(undefined);
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i]!;
      this.fieldLookup[m.fieldId] = m;
    }

    let symCount = 0;
    const mantissaPacker = this.reusablePacker;
    mantissaPacker.reset();
    let theoreticalBits = 0;

    for (let fIdx = 0; fIdx < this.fieldEntries.length; fIdx++) {
      const entry = this.fieldEntries[fIdx]!;
      const mut = this.fieldLookup[entry.spec.id];
      const present = mut !== undefined ? 1 : 0;
      this.ansTablesScratch[symCount] = this.presenceTable;
      this.ansSymbolsScratch[symCount] = present;
      symCount++;
      theoreticalBits += this.presenceTable.shannonBits[present] ?? 1;

      if (!mut) continue;
      const spec = entry.spec;
      switch (spec.kind) {
        case "enum_ans": {
          const sym = Math.max(0, Math.min(entry.table.symbolCount - 1, mut.value | 0));
          this.ansTablesScratch[symCount] = entry.table;
          this.ansSymbolsScratch[symCount] = sym;
          symCount++;
          theoreticalBits += entry.table.shannonBits[sym] ?? 1;
          break;
        }
        case "bounded_int_ans": {
          const clamped = Math.max(spec.min, Math.min(spec.max, mut.value | 0));
          const sym = clamped - spec.min;
          this.ansTablesScratch[symCount] = entry.table;
          this.ansSymbolsScratch[symCount] = sym;
          symCount++;
          theoreticalBits += entry.table.shannonBits[sym] ?? 1;
          break;
        }
        case "laplace_delta_ans": {
          const step = spec.step ?? 1;
          const delta = Math.round((mut.value - (mut.baselineValue ?? 0)) / step);
          const zz = zigzagEncode32(delta);
          const dec = decomposeUnsignedMagnitude(zz);
          this.ansTablesScratch[symCount] = entry.table;
          this.ansSymbolsScratch[symCount] = dec.bucket;
          symCount++;
          theoreticalBits += (entry.table.shannonBits[dec.bucket] ?? 1) + dec.mantissaBits;
          if (dec.mantissaBits > 0) {
            mantissaPacker.writeBits(dec.mantissa, dec.mantissaBits);
          }
          break;
        }
        case "pn_counter_ans": {
          const zz = zigzagEncode32(mut.value | 0);
          const dec = decomposeUnsignedMagnitude(zz);
          this.ansTablesScratch[symCount] = entry.table;
          this.ansSymbolsScratch[symCount] = dec.bucket;
          symCount++;
          theoreticalBits += (entry.table.shannonBits[dec.bucket] ?? 1) + dec.mantissaBits;
          if (dec.mantissaBits > 0) {
            mantissaPacker.writeBits(dec.mantissa, dec.mantissaBits);
          }
          break;
        }
      }
    }

    // Encode symbols in reverse order so the LIFO rANS decoder reads field 0 -> field N-1 in a single forward pass.
    const rans = this.reusableRans;
    rans.reset();
    for (let i = symCount - 1; i >= 0; i--) {
      rans.encodeSymbol(this.ansTablesScratch[i]!, this.ansSymbolsScratch[i]!);
    }

    const ansBytes = rans.flushSubarray();
    const mantissaBytes = mantissaPacker.finishSubarray();

    const totalLen = 1 + ansBytes.length + mantissaBytes.length;
    this.payloadScratch[0] = ansBytes.length;
    this.payloadScratch.set(ansBytes, 1);
    this.payloadScratch.set(mantissaBytes, 1 + ansBytes.length);

    return {
      payloadBytes: this.payloadScratch.subarray(0, totalLen),
      theoreticalBits,
    };
  }

  public decodeMutationPayload(
    payloadBytes: Uint8Array,
    baselines?: ReadonlyMap<number, number>
  ): FieldMutation[] {
    const ansLen = payloadBytes[0] ?? 0;
    const ansDecoder = new RansStreamDecoder(payloadBytes, 1, ansLen);
    const mantissaReader = new BitReader(payloadBytes, 1 + ansLen);

    const mutations: FieldMutation[] = [];
    for (let fIdx = 0; fIdx < this.fieldEntries.length; fIdx++) {
      const entry = this.fieldEntries[fIdx]!;
      const field = entry.spec;
      const present = ansDecoder.decodeSymbol(this.presenceTable);
      if (present === 0) continue;

      const spec = entry.spec;
      let value = 0;
      let opKind: CrdtOpKind = "lww_set";

      switch (spec.kind) {
        case "enum_ans": {
          value = ansDecoder.decodeSymbol(entry.table);
          break;
        }
        case "bounded_int_ans": {
          const sym = ansDecoder.decodeSymbol(entry.table);
          value = spec.min + sym;
          break;
        }
        case "laplace_delta_ans": {
          const bucket = ansDecoder.decodeSymbol(entry.table);
          const mantissaBits = bucket > 0 ? bucket - 1 : 0;
          const mantissa = mantissaBits > 0 ? mantissaReader.readBits(mantissaBits) : 0;
          const zz = recomposeUnsignedMagnitude(bucket, mantissa);
          const delta = zigzagDecode32(zz) * (spec.step ?? 1);
          const base = baselines?.get(field.id) ?? 0;
          value = base + delta;
          break;
        }
        case "pn_counter_ans": {
          const bucket = ansDecoder.decodeSymbol(entry.table);
          const mantissaBits = bucket > 0 ? bucket - 1 : 0;
          const mantissa = mantissaBits > 0 ? mantissaReader.readBits(mantissaBits) : 0;
          const zz = recomposeUnsignedMagnitude(bucket, mantissa);
          value = zigzagDecode32(zz);
          opKind = "pn_add";
          break;
        }
      }

      const baselineValue = baselines?.get(field.id);
      mutations.push(
        baselineValue !== undefined
          ? { fieldId: field.id, opKind, value, baselineValue }
          : { fieldId: field.id, opKind, value }
      );
    }

    return mutations;
  }

  private readonly headerScratch = new Uint8Array(512);
  private readonly headerScratchView = new DataView(this.headerScratch.buffer);

  public encodeWireFrame(req: EncodeFrameRequest): CompiledWireFrame {
    const entityKeyHash = req.entityKeyHash ?? hashEntityKey64(req.entityKey);
    const { payloadBytes, theoreticalBits } = this.encodeMutationPayload(req.mutations);
    const opId = computeOpId64({
      schemaId: this.schema.schemaId,
      entityKeyHash,
      packedHlc: req.packedHlc,
      nodeId: req.nodeId,
      parentFrontierHash: req.parentFrontierHash,
      ansPayload: payloadBytes,
    });

    const hasKeyStr = !req.omitKeyString;
    const hasParent = req.parentFrontierHash !== 0n;
    const flags =
      ((this.schema.schemaId & 0x0f) << 4) |
      (hasKeyStr ? 0x01 : 0x00) |
      (hasParent ? 0x02 : 0x00);

    let offset = 0;
    this.headerScratch[offset++] = flags;
    offset = writeUnsignedVarintToBuf(
      this.headerScratch,
      offset,
      BigInt(req.nodeId & 0xffff)
    );
    offset = writeUnsignedVarintToBuf(this.headerScratch, offset, req.packedHlc);
    this.headerScratchView.setBigUint64(offset, entityKeyHash, true);
    offset += 8;

    if (hasParent) {
      this.headerScratchView.setBigUint64(offset, req.parentFrontierHash, true);
      offset += 8;
    }

    if (hasKeyStr) {
      const utf8Key = Buffer.from(req.entityKey, "utf8");
      offset = writeUnsignedVarintToBuf(
        this.headerScratch,
        offset,
        BigInt(utf8Key.length)
      );
      this.headerScratch.set(utf8Key, offset);
      offset += utf8Key.length;
    }

    const totalBytes = new Uint8Array(offset + payloadBytes.length);
    totalBytes.set(this.headerScratch.subarray(0, offset), 0);
    totalBytes.set(payloadBytes, offset);

    return {
      bytes: totalBytes,
      opId,
      theoreticalBits,
      actualPayloadBits: payloadBytes.length * 8,
    };
  }

  public decodeWireFrame(
    bytes: Uint8Array,
    baselines?: ReadonlyMap<number, number>
  ): DecodedWireFrame {
    const flags = bytes[0] ?? 0;
    const schemaId = (flags >>> 4) & 0x0f;
    const hasKeyStr = (flags & 0x01) !== 0;
    const hasParent = (flags & 0x02) !== 0;

    let offset = 1;
    const nodeVar = decodeUnsignedVarint(bytes, offset);
    const nodeId = Number(nodeVar.value);
    offset = nodeVar.nextOffset;

    const hlcVar = decodeUnsignedVarint(bytes, offset);
    const packedHlc = hlcVar.value;
    offset = hlcVar.nextOffset;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entityKeyHash = view.getBigUint64(offset, true);
    offset += 8;

    let parentFrontierHash = 0n;
    if (hasParent) {
      parentFrontierHash = view.getBigUint64(offset, true);
      offset += 8;
    }

    let entityKey: string | null = null;
    if (hasKeyStr) {
      const keyLenVar = decodeUnsignedVarint(bytes, offset);
      const keyLen = Number(keyLenVar.value);
      offset = keyLenVar.nextOffset;
      entityKey = Buffer.from(bytes.subarray(offset, offset + keyLen)).toString("utf8");
      offset += keyLen;
    }

    const payloadBytes = bytes.subarray(offset);
    const mutations = this.decodeMutationPayload(payloadBytes, baselines);
    const opId = computeOpId64({
      schemaId,
      entityKeyHash,
      packedHlc,
      nodeId,
      parentFrontierHash,
      ansPayload: payloadBytes,
    });

    return {
      schemaId,
      opId,
      entityKeyHash,
      entityKey,
      packedHlc,
      nodeId,
      parentFrontierHash,
      mutations,
    };
  }
}

export type { EnumFieldSpec, BoundedIntFieldSpec, LaplaceDeltaFieldSpec, PnCounterFieldSpec };
