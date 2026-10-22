import { type RibltCell, type RibltConfig, type RibltReconcileResult } from "./types.ts";

const MASK_64 = 0xffffffffffffffffn;

/**
 * SplitMix64 deterministic 64-bit mixer for fast, collision-free IBLT verification hashes
 * and independent k-bucket placement.
 */
export function splitMix64(seed: bigint): bigint {
  let z = (seed + 0x9e3779b97f4a7c15n) & MASK_64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
  return (z ^ (z >> 31n)) & MASK_64;
}

export function computeRibltChecksum(opId: bigint): bigint {
  const c = splitMix64(opId ^ 0x4cf5ad432745937fn);
  return c === 0n ? 1n : c;
}

/**
 * Computes k distinct cell indices in [0, cellCount) for a given 64-bit opId.
 * Guarantees all k indices for a single opId are distinct so self-cancellation never occurs.
 */
export function deriveCellIndices(
  opId: bigint,
  cellCount: number,
  hashCount: number
): number[] {
  const indices: number[] = [];
  let state = opId;
  let attempt = 0;
  while (indices.length < hashCount && attempt < 64) {
    state = splitMix64(state + BigInt(attempt) * 0x517cc1b727220a95n);
    const idx = Number(state % BigInt(cellCount));
    if (!indices.includes(idx)) {
      indices.push(idx);
    }
    attempt++;
  }
  return indices;
}

/**
 * Packs a variable-length wire envelope into a fixed-length XOR-able slot
 * (`2-byte little-endian length prefix + payload bytes + zero padding`).
 */
export function padEnvelopeToSlot(envelope: Uint8Array, slotBytes: number): Uint8Array {
  if (envelope.length + 2 > slotBytes) {
    throw new RangeError(
      `Envelope length ${envelope.length} exceeds Riblt slot capacity ${slotBytes - 2}`
    );
  }
  const out = new Uint8Array(slotBytes);
  out[0] = envelope.length & 0xff;
  out[1] = (envelope.length >>> 8) & 0xff;
  out.set(envelope, 2);
  return out;
}

export function unpadEnvelopeFromSlot(slot: Uint8Array): Uint8Array {
  const len = (slot[0] ?? 0) | ((slot[1] ?? 0) << 8);
  if (len <= 0 || len + 2 > slot.length) {
    throw new RangeError(`Invalid unpadded envelope length ${len} in slot of ${slot.length}B`);
  }
  return slot.slice(2, 2 + len);
}

function xorBytesInPlace(target: Uint8Array, source: Uint8Array): void {
  const len = Math.min(target.length, source.length);
  for (let i = 0; i < len; i++) {
    target[i] = (target[i] ?? 0) ^ (source[i] ?? 0);
  }
}

/**
 * Invertible Bloom Lookup Table (IBLT) for Single-Round-Trip Set Reconciliation.
 *
 * Wire complexity scales strictly with the symmetric difference O(|A Δ B|),
 * independent of total database size O(|A ∪ B|).
 */
export class RibltSketch {
  public readonly cellCount: number;
  public readonly envelopeByteLength: number;
  public readonly hashCount: number;
  public readonly cells: readonly RibltCell[];

  public constructor(config: RibltConfig) {
    this.cellCount = config.cellCount;
    this.envelopeByteLength = config.envelopeByteLength;
    this.hashCount = config.hashCount ?? 3;
    const cells: RibltCell[] = [];
    for (let i = 0; i < this.cellCount; i++) {
      cells.push({
        count: 0,
        opIdXor: 0n,
        checksumXor: 0n,
        payloadXor: new Uint8Array(this.envelopeByteLength),
      });
    }
    this.cells = cells;
  }

  public insert(rawOpId: bigint, wireEnvelope: Uint8Array, sign: 1 | -1 = 1): void {
    const opId = rawOpId & MASK_64;
    const checksum = computeRibltChecksum(opId);
    const padded =
      this.envelopeByteLength > 0
        ? padEnvelopeToSlot(wireEnvelope, this.envelopeByteLength)
        : new Uint8Array(0);
    const indices = deriveCellIndices(opId, this.cellCount, this.hashCount);
    for (const idx of indices) {
      const cell = this.cells[idx];
      if (!cell) continue;
      cell.count += sign;
      cell.opIdXor ^= opId;
      cell.checksumXor ^= checksum;
      if (this.envelopeByteLength > 0) {
        xorBytesInPlace(cell.payloadXor, padded);
      }
    }
  }

  /**
   * Serializes the IBLT sketch into a compact binary datagram for 1-RTT network exchange.
   */
  public toBytes(): Uint8Array {
    const cellStride = 4 + 8 + 8 + this.envelopeByteLength;
    const out = new Uint8Array(8 + this.cellCount * cellStride);
    const view = new DataView(out.buffer);
    view.setUint16(0, this.cellCount, true);
    view.setUint16(2, this.envelopeByteLength, true);
    view.setUint16(4, this.hashCount, true);
    view.setUint16(6, 0, true);

    let offset = 8;
    for (const cell of this.cells) {
      view.setInt32(offset, cell.count, true);
      view.setBigUint64(offset + 4, cell.opIdXor, true);
      view.setBigUint64(offset + 12, cell.checksumXor, true);
      out.set(cell.payloadXor, offset + 20);
      offset += cellStride;
    }
    return out;
  }

  public static fromBytes(bytes: Uint8Array): RibltSketch {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cellCount = view.getUint16(0, true);
    const envelopeByteLength = view.getUint16(2, true);
    const hashCount = view.getUint16(4, true);

    const sketch = new RibltSketch({
      cellCount,
      envelopeByteLength,
      hashCount,
    });
    const cellStride = 20 + envelopeByteLength;
    let offset = 8;
    for (let i = 0; i < cellCount; i++) {
      const cell = sketch.cells[i];
      if (!cell) continue;
      cell.count = view.getInt32(offset, true);
      cell.opIdXor = view.getBigUint64(offset + 4, true);
      cell.checksumXor = view.getBigUint64(offset + 12, true);
      cell.payloadXor.set(bytes.subarray(offset + 20, offset + 20 + envelopeByteLength));
      offset += cellStride;
    }
    return sketch;
  }

  /**
   * Peels the symmetric difference between `remoteSketch` (received over the wire)
   * and `localSketch` (computed locally).
   *
   * - Cells with count === +1 yield envelopes present on Remote but missing Locally.
   * - Cells with count === -1 yield opIds present Locally but missing on Remote.
   */
  public static reconcile(
    localSketch: RibltSketch,
    remoteSketch: RibltSketch
  ): RibltReconcileResult {
    if (
      localSketch.cellCount !== remoteSketch.cellCount ||
      localSketch.envelopeByteLength !== remoteSketch.envelopeByteLength
    ) {
      throw new Error("IBLT sketch geometry mismatch between local and remote nodes");
    }

    const n = localSketch.cellCount;
    const slotLen = localSketch.envelopeByteLength;
    const hashCount = localSketch.hashCount;

    const diffCells: RibltCell[] = [];
    for (let i = 0; i < n; i++) {
      const loc = localSketch.cells[i]!;
      const rem = remoteSketch.cells[i]!;
      const payloadXor = new Uint8Array(slotLen);
      for (let b = 0; b < slotLen; b++) {
        payloadXor[b] = (rem.payloadXor[b] ?? 0) ^ (loc.payloadXor[b] ?? 0);
      }
      diffCells.push({
        count: rem.count - loc.count,
        opIdXor: rem.opIdXor ^ loc.opIdXor,
        checksumXor: rem.checksumXor ^ loc.checksumXor,
        payloadXor,
      });
    }

    const peeledLocalOnlyOpIds = new Set<bigint>();
    const peeledRemoteByOpId = new Map<bigint, Uint8Array>();
    let iterations = 0;

    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < n; i++) {
        const cell = diffCells[i]!;
        if (cell.count !== 1 && cell.count !== -1) continue;
        const candidateOpId = cell.opIdXor;
        if (candidateOpId === 0n) continue;
        const expectedCheck = computeRibltChecksum(candidateOpId);
        if (cell.checksumXor !== expectedCheck) {
          // Collision of multiple items whose count happened to sum to +/- 1; wait for neighbors to peel first.
          continue;
        }

        const sign = cell.count; // +1 means remote-only, -1 means local-only
        const extractedSlot = cell.payloadXor.slice(0);
        if (sign === 1) {
          if (!peeledRemoteByOpId.has(candidateOpId)) {
            peeledRemoteByOpId.set(
              candidateOpId,
              slotLen > 0 ? unpadEnvelopeFromSlot(extractedSlot) : new Uint8Array(0)
            );
          }
        } else {
          peeledLocalOnlyOpIds.add(candidateOpId);
        }

        // Subtract this peeled operation from all k cells it hashes into.
        const indices = deriveCellIndices(candidateOpId, n, hashCount);
        for (const idx of indices) {
          const target = diffCells[idx]!;
          target.count -= sign;
          target.opIdXor ^= candidateOpId;
          target.checksumXor ^= expectedCheck;
          xorBytesInPlace(target.payloadXor, extractedSlot);
        }

        iterations++;
        progress = true;
      }
    }

    const complete = diffCells.every(
      (c) => c.count === 0 && c.opIdXor === 0n && c.checksumXor === 0n
    );

    return {
      complete,
      peeledLocalOnlyOpIds: [...peeledLocalOnlyOpIds],
      peeledRemoteOnlyOpIds: [...peeledRemoteByOpId.keys()],
      peeledRemoteOnlyEnvelopes: [...peeledRemoteByOpId.values()],
      peelingIterations: iterations,
      sketchWireBytes: 8 + n * (20 + slotLen),
    };
  }
}
