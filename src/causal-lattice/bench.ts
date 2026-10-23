import { createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import {
  attenuateCapability,
  BlindRelayNode,
  mintCapability,
  serializeBlindEnvelope,
  verifyCapability,
} from "./crypto.ts";
import { CausalLatticeNode } from "./lattice.ts";
import { type LatticeSchemaSpec, PermissionBit } from "./types.ts";

export interface BenchmarkReport {
  readonly recordCount: number;
  readonly wireComparison: {
    readonly jsonHttpBytes: number;
    readonly jsonGzipBytes: number;
    readonly latticeAnsFrameBytes: number;
    readonly latticeBlindEnvelopeBytes: number;
    readonly theoreticalShannonBits: number;
    readonly actualAnsPayloadBits: number;
    readonly compressionRatioVsJsonHttp: number;
    readonly compressionRatioVsJsonGzip: number;
  };
  readonly writeLatencyUs: {
    readonly sqliteWalJsonUsPerOp: number;
    readonly latticeArenaAnsUsPerOp: number;
    readonly speedupFactor: number;
  };
  readonly readLatencyNs: {
    readonly sqliteSelectJsonParseNsPerOp: number;
    readonly latticeZeroCopyArenaNsPerOp: number;
    readonly speedupFactor: number;
  };
  readonly syncReconciliation: {
    readonly totalSharedOps: number;
    readonly divergentOps: number;
    readonly naiveCursorOrFullStateBytes: number;
    readonly latticeRibltSingleRttBytes: number;
    readonly wireSavingsFactor: number;
    readonly convergedIdentically: boolean;
  };
  readonly securityGateNs: {
    readonly jwtParseAndSqliteAclNsPerOp: number;
    readonly latticeChainedCapabilityNsPerOp: number;
    readonly speedupFactor: number;
  };
}

export const TELEMETRY_INVENTORY_SCHEMA: LatticeSchemaSpec = {
  schemaId: 1,
  name: "VehicleTelemetryAndState",
  version: 1,
  fields: [
    {
      id: 0,
      name: "status",
      kind: "enum_ans",
      // 92% normal cruise (0), 5% warning (1), 2% idle (2), 1% fault (3)
      weights: [920, 50, 20, 10],
    },
    {
      id: 1,
      name: "speedKph",
      kind: "bounded_int_ans",
      min: 0,
      max: 240,
      mode: 88,
      scale: 12,
    },
    {
      id: 2,
      name: "latMicroDegDelta",
      kind: "laplace_delta_ans",
      scaleBits: 5,
      step: 1,
    },
    {
      id: 3,
      name: "lonMicroDegDelta",
      kind: "laplace_delta_ans",
      scaleBits: 5,
      step: 1,
    },
    {
      id: 4,
      name: "headingDeg",
      kind: "bounded_int_ans",
      min: 0,
      max: 359,
      mode: 180,
      scale: 30,
    },
    {
      id: 5,
      name: "eventsCount",
      kind: "pn_counter_ans",
      scaleBits: 2,
    },
  ],
};

function createFakeHttpJwtMutationWire(entityKey: string, hlcMs: number): Buffer {
  const jwtHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url"
  );
  const jwtPayload = Buffer.from(
    JSON.stringify({
      sub: "operator:alice",
      scope: "telemetry:read telemetry:write",
      prefix: "vehicle:",
      exp: 1999999999,
      iat: 1760000000,
    })
  ).toString("base64url");
  const jwtSig = createHmac("sha256", "off-the-shelf-jwt-secret")
    .update(`${jwtHeader}.${jwtPayload}`)
    .digest("base64url");
  const token = `${jwtHeader}.${jwtPayload}.${jwtSig}`;

  const body = JSON.stringify({
    entityKey,
    timestampMs: hlcMs,
    nodeId: 1,
    mutations: {
      status: "cruise",
      speedKph: 88,
      latMicroDegDelta: 14,
      lonMicroDegDelta: -9,
      headingDeg: 182,
      eventsCountDelta: 1,
    },
  });

  const httpFrame =
    `POST /v1/entities/${encodeURIComponent(entityKey)}/mutate HTTP/1.1\r\n` +
    `Host: api.example.com\r\n` +
    `Content-Type: application/json\r\n` +
    `Authorization: Bearer ${token}\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
    body;

  return Buffer.from(httpFrame, "utf8");
}

/**
 * Executes an empirical head-to-head benchmark between the off-the-shelf human stack
 * (`node:sqlite` + UTF-8 JSON + REST/Bearer JWT + timestamp-cursor dump) and
 * World-Track II (`CausalLatticeNode`).
 */
export function runHeadToHeadBenchmark(recordCount = 2000): BenchmarkReport {
  const capSecret = new Uint8Array(randomBytes(32));
  const epochKey = new Uint8Array(randomBytes(32));

  const nodeA = new CausalLatticeNode({
    nodeId: 1,
    schema: TELEMETRY_INVENTORY_SCHEMA,
    arenaSlotCapacity: 8192,
    capabilityRootSecret: capSecret,
    epochRootKey: epochKey,
  });

  const rootCap = mintCapability({
    rootSecret: capSecret,
    rootId: 1,
    initialCaveat: {
      entityPrefix: "vehicle:",
      allowedFieldsMask: 0xffffffff,
      permissionsMask: PermissionBit.ALL,
      maxPackedHlc: 0xffffffffffffffffn,
    },
  });

  const attenuatedCap = attenuateCapability({
    parentToken: rootCap,
    newCaveat: {
      entityPrefix: "vehicle:fleet-",
      allowedFieldsMask: 0b00111111,
      permissionsMask: PermissionBit.READ | PermissionBit.WRITE | PermissionBit.SYNC,
      maxPackedHlc: 0x7fffffffffffffffn,
    },
  });

  // 1. Wire Comparison
  const sampleHttpJwt = createFakeHttpJwtMutationWire("vehicle:fleet-0042", 1761050000000);
  const sampleJsonBody = JSON.stringify({
    entityKey: "vehicle:fleet-0042",
    timestampMs: 1761050000000,
    nodeId: 1,
    mutations: {
      status: 0,
      speedKph: 88,
      latMicroDegDelta: 14,
      lonMicroDegDelta: -9,
      headingDeg: 182,
      eventsCountDelta: 1,
    },
  });
  const sampleGzip = gzipSync(Buffer.from(sampleJsonBody, "utf8"));

  const sampleMut = nodeA.mutate({
    entityKey: "vehicle:fleet-0042",
    omitKeyStringOnWire: true,
    capabilityToken: attenuatedCap,
    mutations: [
      { fieldId: 0, opKind: "lww_set", value: 0 },
      { fieldId: 1, opKind: "lww_set", value: 88 },
      { fieldId: 2, opKind: "lww_set", value: 37774914, baselineValue: 37774900 },
      { fieldId: 3, opKind: "lww_set", value: -122419409, baselineValue: -122419400 },
      { fieldId: 4, opKind: "lww_set", value: 182 },
      { fieldId: 5, opKind: "pn_add", value: 1 },
    ],
  });

  const blindBytes = serializeBlindEnvelope(sampleMut.blindEnvelope);

  // 2. Write Latency: SQLite + JSON vs CausalLattice (rANS + 64B Arena)
  const sqliteDb = new DatabaseSync(":memory:");
  sqliteDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE entities (
      entity_key TEXT PRIMARY KEY,
      hlc_ms INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE acl_tokens (
      token_id TEXT PRIMARY KEY,
      prefix TEXT NOT NULL,
      permissions INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  sqliteDb
    .prepare(
      `INSERT INTO acl_tokens (token_id, prefix, permissions, expires_at) VALUES (?, ?, ?, ?)`
    )
    .run("operator:alice", "vehicle:fleet-", 7, 1999999999);

  const insertStmt = sqliteDb.prepare(`
    INSERT INTO entities (entity_key, hlc_ms, payload_json)
    VALUES (?, ?, ?)
    ON CONFLICT(entity_key) DO UPDATE SET
      hlc_ms = excluded.hlc_ms,
      payload_json = excluded.payload_json
  `);

  const aclStmt = sqliteDb.prepare(
    `SELECT prefix, permissions, expires_at FROM acl_tokens WHERE token_id = ?`
  );
  const jwtHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url"
  );
  const jwtPayload = Buffer.from(
    JSON.stringify({ sub: "operator:chris", exp: 1999999999 })
  ).toString("base64url");
  const jwtSig = createHmac("sha256", capSecret)
    .update(`${jwtHeader}.${jwtPayload}`)
    .digest("base64url");
  const sampleJwt = `${jwtHeader}.${jwtPayload}.${jwtSig}`;

  const tSqliteWrite0 = process.hrtime.bigint();
  for (let i = 0; i < recordCount; i++) {
    const key = `vehicle:fleet-${i}`;
    // Standard authenticated REST write path: verify Bearer JWT + ACL lookup + JSON serialize + SQLite upsert
    const parts = sampleJwt.split(".");
    const expected = createHmac("sha256", capSecret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest("base64url");
    if (expected === parts[2]) {
      const acl = aclStmt.get("operator:alice") as { prefix: string } | undefined;
      if (!acl || !key.startsWith(acl.prefix)) {
        throw new Error("ACL failure");
      }
    }
    const json = JSON.stringify({
      status: i % 10 === 0 ? 1 : 0,
      speedKph: 85 + (i % 15),
      latMicroDegDelta: 37774900 + (i % 25),
      lonMicroDegDelta: -122419400 - (i % 25),
      headingDeg: 180 + (i % 10),
      eventsCount: 1,
    });
    insertStmt.run(key, 1761050000000 + i, json);
  }
  const tSqliteWrite1 = process.hrtime.bigint();
  const sqliteWriteUsPerOp = Number(tSqliteWrite1 - tSqliteWrite0) / 1000 / recordCount;

  const benchNode = new CausalLatticeNode({
    nodeId: 2,
    schema: TELEMETRY_INVENTORY_SCHEMA,
    arenaSlotCapacity: 8192,
    capabilityRootSecret: capSecret,
    epochRootKey: epochKey,
  });

  const tLatticeWrite0 = process.hrtime.bigint();
  for (let i = 0; i < recordCount; i++) {
    const key = `vehicle:fleet-${i}`;
    benchNode.mutate({
      entityKey: key,
      omitKeyStringOnWire: true,
      capabilityToken: attenuatedCap,
      mutations: [
        { fieldId: 0, opKind: "lww_set", value: i % 10 === 0 ? 1 : 0 },
        { fieldId: 1, opKind: "lww_set", value: 85 + (i % 15) },
        { fieldId: 2, opKind: "lww_set", value: 37774900 + (i % 25), baselineValue: 37774900 },
        {
          fieldId: 3,
          opKind: "lww_set",
          value: -122419400 - (i % 25),
          baselineValue: -122419400,
        },
        { fieldId: 4, opKind: "lww_set", value: 180 + (i % 10) },
        { fieldId: 5, opKind: "pn_add", value: 1 },
      ],
    });
  }
  const tLatticeWrite1 = process.hrtime.bigint();
  const latticeWriteUsPerOp = Number(tLatticeWrite1 - tLatticeWrite0) / 1000 / recordCount;

  // Pre-build entity keys so timing loops measure storage/projection rather than string formatting
  const entityKeys: string[] = [];
  for (let i = 0; i < recordCount; i++) {
    entityKeys.push(`vehicle:fleet-${i}`);
  }

  // 3. Read Latency: SQLite SELECT + JSON.parse vs Zero-Copy 64B Arena Projection
  const selectStmt = sqliteDb.prepare(
    `SELECT payload_json FROM entities WHERE entity_key = ?`
  );
  // Warm up V8 JIT on both paths before measuring
  for (let w = 0; w < 256; w++) {
    const k = entityKeys[w % recordCount]!;
    selectStmt.get(k);
    benchNode.readFieldFast(k, 1);
  }

  const readIterations = recordCount * 4;
  let checksumA = 0;
  const tSqliteRead0 = process.hrtime.bigint();
  for (let i = 0; i < readIterations; i++) {
    const key = entityKeys[i % recordCount]!;
    const row = selectStmt.get(key) as { payload_json: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.payload_json) as { speedKph: number };
      checksumA = (checksumA + parsed.speedKph) | 0;
    }
  }
  const tSqliteRead1 = process.hrtime.bigint();
  const sqliteReadNsPerOp = Number(tSqliteRead1 - tSqliteRead0) / readIterations;

  let checksumB = 0;
  const tLatticeRead0 = process.hrtime.bigint();
  for (let i = 0; i < readIterations; i++) {
    const key = entityKeys[i % recordCount]!;
    const speed = benchNode.readFieldFast(key, 1);
    if (speed !== null) {
      checksumB = (checksumB + speed) | 0;
    }
  }
  const tLatticeRead1 = process.hrtime.bigint();
  if (checksumA !== checksumB) {
    throw new Error(`Benchmark read verification mismatch: ${checksumA} !== ${checksumB}`);
  }
  const latticeReadNsPerOp = Number(tLatticeRead1 - tLatticeRead0) / readIterations;

  // 4. Multi-Master Partition Set Reconciliation (1000 shared ops, 12 divergent ops)
  const sharedCount = 1000;
  const divergentCount = 12;
  const relay = new BlindRelayNode();
  const peerAlpha = new CausalLatticeNode({
    nodeId: 10,
    schema: TELEMETRY_INVENTORY_SCHEMA,
    arenaSlotCapacity: 4096,
    capabilityRootSecret: capSecret,
    epochRootKey: epochKey,
  });
  const peerBeta = new CausalLatticeNode({
    nodeId: 20,
    schema: TELEMETRY_INVENTORY_SCHEMA,
    arenaSlotCapacity: 4096,
    capabilityRootSecret: capSecret,
    epochRootKey: epochKey,
  });

  let fullStateJsonBytes = 0;
  for (let i = 0; i < sharedCount; i++) {
    const res = peerAlpha.mutate({
      entityKey: `vehicle:fleet-${i}`,
      omitKeyStringOnWire: false,
      capabilityToken: attenuatedCap,
      mutations: [
        { fieldId: 0, opKind: "lww_set", value: 0 },
        { fieldId: 1, opKind: "lww_set", value: 90 },
      ],
    });
    peerBeta.ingestBlindEnvelope(res.blindEnvelope);
    relay.ingestEnvelope(res.blindEnvelope);
    fullStateJsonBytes += Buffer.byteLength(
      JSON.stringify({
        entityKey: `vehicle:fleet-${i}`,
        hlc: res.op.packedHlc.toString(),
        status: 0,
        speedKph: 90,
      })
    );
  }

  // While partitioned, peerAlpha writes 6 offline mutations (already pushed to relay)
  // and peerBeta writes 6 offline mutations locally.
  for (let d = 0; d < divergentCount / 2; d++) {
    const alphaMut = peerAlpha.mutate({
      entityKey: `vehicle:fleet-${d}`,
      omitKeyStringOnWire: false,
      capabilityToken: attenuatedCap,
      mutations: [{ fieldId: 1, opKind: "lww_set", value: 110 + d }],
    });
    relay.ingestEnvelope(alphaMut.blindEnvelope);

    peerBeta.mutate({
      entityKey: `vehicle:fleet-${500 + d}`,
      omitKeyStringOnWire: false,
      capabilityToken: attenuatedCap,
      mutations: [{ fieldId: 1, opKind: "lww_set", value: 70 + d }],
    });
  }

  const syncBeta = peerBeta.syncWithBlindRelay(relay, divergentCount, 0);
  const syncAlpha = peerAlpha.syncWithBlindRelay(relay, divergentCount, 0);

  const converged =
    peerAlpha.getMerkleFrontierDigest() === peerBeta.getMerkleFrontierDigest() &&
    syncBeta.complete &&
    syncAlpha.complete;

  // 5. Security Gate Latency: JWT Verify + SQLite ACL Lookup vs Chained Capability Verify
  const secIterations = 4000;
  const tJwt0 = process.hrtime.bigint();
  for (let i = 0; i < secIterations; i++) {
    const parts = sampleJwt.split(".");
    const expected = createHmac("sha256", capSecret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest("base64url");
    if (expected === parts[2]) {
      const payload = JSON.parse(
        Buffer.from(parts[1] ?? "", "base64url").toString("utf8")
      ) as { sub: string };
      const acl = aclStmt.get(payload.sub) as { prefix: string } | undefined;
      if (!acl || !"vehicle:fleet-42".startsWith(acl.prefix)) {
        throw new Error("Unexpected ACL failure");
      }
    }
  }
  const tJwt1 = process.hrtime.bigint();
  const jwtAclNsPerOp = Number(tJwt1 - tJwt0) / secIterations;

  const tCap0 = process.hrtime.bigint();
  for (let i = 0; i < secIterations; i++) {
    const verdict = verifyCapability({
      rootSecret: capSecret,
      token: attenuatedCap,
      targetEntityKey: "vehicle:fleet-42",
      requiredFieldsMask: 0b000011,
      requiredPermission: PermissionBit.WRITE,
      operationPackedHlc: 1000n,
    });
    if (!verdict.ok) {
      throw new Error("Unexpected capability failure");
    }
  }
  const tCap1 = process.hrtime.bigint();
  const capNsPerOp = Number(tCap1 - tCap0) / secIterations;

  sqliteDb.close();

  return {
    recordCount,
    wireComparison: {
      jsonHttpBytes: sampleHttpJwt.byteLength,
      jsonGzipBytes: sampleGzip.byteLength,
      latticeAnsFrameBytes: sampleMut.wireFrame.bytes.byteLength,
      latticeBlindEnvelopeBytes: blindBytes.byteLength,
      theoreticalShannonBits: Number(sampleMut.wireFrame.theoreticalBits.toFixed(2)),
      actualAnsPayloadBits: sampleMut.wireFrame.actualPayloadBits,
      compressionRatioVsJsonHttp: Number(
        (sampleHttpJwt.byteLength / sampleMut.wireFrame.bytes.byteLength).toFixed(2)
      ),
      compressionRatioVsJsonGzip: Number(
        (sampleGzip.byteLength / sampleMut.wireFrame.bytes.byteLength).toFixed(2)
      ),
    },
    writeLatencyUs: {
      sqliteWalJsonUsPerOp: Number(sqliteWriteUsPerOp.toFixed(2)),
      latticeArenaAnsUsPerOp: Number(latticeWriteUsPerOp.toFixed(2)),
      speedupFactor: Number((sqliteWriteUsPerOp / latticeWriteUsPerOp).toFixed(2)),
    },
    readLatencyNs: {
      sqliteSelectJsonParseNsPerOp: Math.round(sqliteReadNsPerOp),
      latticeZeroCopyArenaNsPerOp: Math.round(latticeReadNsPerOp),
      speedupFactor: Number((sqliteReadNsPerOp / latticeReadNsPerOp).toFixed(2)),
    },
    syncReconciliation: {
      totalSharedOps: sharedCount,
      divergentOps: divergentCount,
      naiveCursorOrFullStateBytes: fullStateJsonBytes,
      latticeRibltSingleRttBytes: syncBeta.sketchWireBytes,
      wireSavingsFactor: Number(
        (fullStateJsonBytes / syncBeta.sketchWireBytes).toFixed(2)
      ),
      convergedIdentically: converged,
    },
    securityGateNs: {
      jwtParseAndSqliteAclNsPerOp: Math.round(jwtAclNsPerOp),
      latticeChainedCapabilityNsPerOp: Math.round(capNsPerOp),
      speedupFactor: Number((jwtAclNsPerOp / capNsPerOp).toFixed(2)),
    },
  };
}
