/**
 * Construct Causal Lattice Integration Layer (`src/lattice.ts`).
 *
 * Consumes `causal-lattice` (World-Track II + World-Track III Evolved) directly as an
 * external library dependency—zero duplicated rANS, Chaskey-12, IBLT, or Arena implementations.
 */

import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  attenuateProjectCapability,
  CompactRibltSketch,
  CompiledSchemaCodec,
  computeMerkleMix64,
  computeOpHash64,
  chaskey12Mac128,
  chaskey12Mac128Into,
  decodeLatticeCrdtBatch,
  EvolvedConstructArena,
  EvolvedCrossFieldCodec,
  EvolvedDirectArena,
  encodeLatticeCrdtBatch,
  evolveCrossFieldGenome,
  evolvePerfectLookupCircuit,
  generateCorrelatedTrajectories,
  hashString64,
  hlcStringToPacked64,
  LatticeEntityMask,
  LatticePermissionMask,
  mintProjectCapability,
  packed64ToHlcString,
  runEvolutionaryBenchmark,
  splitMix64,
  TELEMETRY_INVENTORY_SCHEMA,
  verifyProjectCapability,
} from "./causal-lattice/index.ts";
import type { CryptographicIdentity, MlsGroupRecord } from "./types.ts";

export const ENTITY_MASK = LatticeEntityMask;
export const PERMISSION_MASK = LatticePermissionMask;
export const globalHotArena = new EvolvedConstructArena();

export interface ConstructBenchmarkDeps {
  readonly crdt: {
    makeDidKeyFromEd25519Spki(spkiBase64: string): string;
    sealMlsApplicationMessage(
      group: MlsGroupRecord,
      identity: CryptographicIdentity,
      payload: unknown,
      options?: { readonly legacyJson?: boolean }
    ): unknown;
  };
  readonly romMod: {
    initRomSchema(db: DatabaseSync): void;
    hydrateRom(row: unknown): { readonly name: string; readonly dials: Record<string, number> };
  };
}

export function runLatticeBenchmark(
  options: { readonly ops?: number } = {},
  deps: ConstructBenchmarkDeps
) {
  const { crdt, romMod } = deps;
  const opCount = Number(options.ops ?? 40);
  const signKp = crypto.generateKeyPairSync("ed25519");
  const dhKp = crypto.generateKeyPairSync("x25519");
  const signPub = signKp.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const signPriv = signKp.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const dhPub = dhKp.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const dhPriv = dhKp.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const did = crdt.makeDidKeyFromEd25519Spki(signPub);
  const identity: CryptographicIdentity = {
    version: 1,
    did,
    signPub,
    signPriv,
    dhPub,
    dhPriv,
    created: new Date().toISOString(),
  };
  const group: MlsGroupRecord = {
    project: "acme/alpha_app",
    groupId: crypto.randomBytes(16).toString("hex"),
    epoch: 1,
    epochSecret: crypto.randomBytes(32).toString("base64"),
    members: [{ did, userId: "chris", signPub, dhPub }],
    relays: [],
    lastSyncHlc: "",
    updated: new Date().toISOString(),
  };

  const sampleOps = [];
  for (let i = 1; i <= opCount; i++) {
    const hlc = `${String(1761050000000 + i * 25).padStart(13, "0")}-0000-${did.slice(-8)}`;
    const uid = `frame-acme/alpha_app-${i}`;
    sampleOps.push({
      opId: `${hlc}:frame:${uid}`,
      hlc,
      project: "acme/alpha_app",
      authorDid: did,
      entity: "frame",
      recordUid: uid,
      payload: {
        uid,
        hlc,
        ts: "2026-10-21T12:00:00.000Z",
        project: "acme/alpha_app",
        kind: i % 3 === 0 ? "change" : i % 2 === 0 ? "finding" : "intent",
        summary: `Refactored storage module #${i} onto 64-byte aligned arena`,
        detail: `Verified zero-allocation read projection and rANS table lookup for batch item ${i}.`,
        verified: "npm test (10/10 passing)",
        open: i % 5 === 0,
        refs: [`#${i}`, "commit:41fbd61"],
      },
    });
  }

  const batchPayload = {
    project: "acme/alpha_app",
    opCount: sampleOps.length,
    ops: sampleOps,
  };

  const rawJsonBytes = Buffer.byteLength(JSON.stringify(batchPayload), "utf8");
  const latticeBatchBytes = encodeLatticeCrdtBatch(batchPayload).byteLength;
  const legacyEnv = crdt.sealMlsApplicationMessage(group, identity, batchPayload, {
    legacyJson: true,
  });
  const latticeEnv = crdt.sealMlsApplicationMessage(group, identity, batchPayload, {
    legacyJson: false,
  });
  const legacyWireBytes = Buffer.byteLength(JSON.stringify(legacyEnv), "utf8");
  const latticeWireBytes = Buffer.byteLength(JSON.stringify(latticeEnv), "utf8");

  // World-Track III Evolved Branchless Circuit over all 179 seeded ROMs vs SQLite + JSON.parse
  const tempDb = new DatabaseSync(":memory:");
  romMod.initRomSchema(tempDb);
  const allRoms = tempDb
    .prepare("SELECT * FROM roms")
    .all()
    .map((r) => romMod.hydrateRom(r));
  const romCircuit = globalHotArena.evolveAndCacheRomDials(allRoms);

  const selectRomStmt = tempDb.prepare("SELECT dials FROM roms WHERE name = 'erasmus'");
  const readIters = 10000;
  for (let w = 0; w < 2000; w++) {
    JSON.parse((selectRomStmt.get() as { dials: string }).dials);
    globalHotArena.readRomDialBranchless("erasmus", 5);
  }
  const tSql0 = process.hrtime.bigint();
  for (let i = 0; i < readIters; i++) {
    const r = selectRomStmt.get() as { dials: string };
    const d = JSON.parse(r.dials) as { rigor: number };
    if (d.rigor < 0) throw new Error("unreachable");
  }
  const tSql1 = process.hrtime.bigint();
  const sqliteDialNs = Math.round(Number(tSql1 - tSql0) / readIters);

  const tArena0 = process.hrtime.bigint();
  for (let i = 0; i < readIters; i++) {
    const rigor = globalHotArena.readRomDialBranchless("erasmus", 5);
    if (rigor === null) throw new Error("unreachable");
  }
  const tArena1 = process.hrtime.bigint();
  const arenaDialNs = Math.round(Number(tArena1 - tArena0) / readIters);
  tempDb.close();

  // Chaskey-12 Capability Verification vs Ed25519 Signature Verification
  const cap = mintProjectCapability({
    epochSecret: group.epochSecret,
    projectPrefix: "acme/",
    allowedEntitiesMask: ENTITY_MASK.ALL_PROJECT,
    permissionsMask: PERMISSION_MASK.ALL,
  });
  const attenuatedCap = attenuateProjectCapability(cap, {
    projectPrefix: "acme/alpha_app",
    allowedEntitiesMask: ENTITY_MASK.FRAME | ENTITY_MASK.HEAD,
    permissionsMask: PERMISSION_MASK.WRITE,
  });
  const sampleMsgBytes = Buffer.from("sample-envelope-header-to-verify", "utf8");
  const pubKeyObj = crypto.createPublicKey({
    key: Buffer.from(signPub, "base64"),
    format: "der",
    type: "spki",
  });
  const privKeyObj = crypto.createPrivateKey({
    key: Buffer.from(signPriv, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const sampleEdSig = crypto.sign(null, sampleMsgBytes, privKeyObj);

  const secIters = 2000;
  const tEd0 = process.hrtime.bigint();
  for (let i = 0; i < secIters; i++) {
    crypto.verify(null, sampleMsgBytes, pubKeyObj, sampleEdSig);
  }
  const tEd1 = process.hrtime.bigint();
  const edVerifyNs = Math.round(Number(tEd1 - tEd0) / secIters);

  const tCap0 = process.hrtime.bigint();
  for (let i = 0; i < secIters; i++) {
    const v = verifyProjectCapability({
      epochSecret: group.epochSecret,
      token: attenuatedCap,
      targetProject: "acme/alpha_app",
      requiredEntitiesMask: ENTITY_MASK.FRAME,
      requiredPermission: PERMISSION_MASK.WRITE,
    });
    if (!v.ok) throw new Error("unexpected capability failure");
  }
  const tCap1 = process.hrtime.bigint();
  const capVerifyNs = Math.round(Number(tCap1 - tCap0) / secIters);

  // 1-RTT IBLT Relay Reconciliation vs Legacy Blind 50-Envelope REQ Fetch
  const sketchA = new CompactRibltSketch(48, 3);
  const sketchB = new CompactRibltSketch(48, 3);
  for (let i = 1; i <= 50; i++) {
    const h = BigInt(i) * 0x517cc1b727220a95n;
    sketchA.insert(h, 1);
    sketchB.insert(h, 1);
  }
  sketchB.insert(999999n, 1);
  const ibltWireBytes = Buffer.byteLength(sketchA.toBase64(), "utf8");
  const legacy50EnvelopesBytes = legacyWireBytes * 50;
  const reconciled = CompactRibltSketch.reconcile(sketchA, sketchB);

  // World-Track III Evolved Cross-Field Predictor on sequential telemetry/tape metrics
  const staticCodec = new CompiledSchemaCodec(TELEMETRY_INVENTORY_SCHEMA);
  const evoReport = runEvolutionaryBenchmark(
    TELEMETRY_INVENTORY_SCHEMA,
    staticCodec,
    (k) => {
      const idx = Number.parseInt(k.slice(k.lastIndexOf("-") + 1), 10);
      return 85 + (idx % 15);
    }
  );

  return {
    opCount,
    wire: {
      rawJsonBytes,
      latticeBatchBytes,
      batchCompressionRatio: Number((rawJsonBytes / latticeBatchBytes).toFixed(2)),
      legacyEnvelopeBytes: legacyWireBytes,
      latticeEnvelopeBytes: latticeWireBytes,
      envelopeCompressionRatio: Number((legacyWireBytes / latticeWireBytes).toFixed(2)),
    },
    hotArenaReadNs: {
      romCount: allRoms.length,
      circuitCollisions: romCircuit.collisions,
      sqliteSelectAndJsonParseNs: sqliteDialNs,
      evolvedBranchlessArenaReadNs: arenaDialNs,
      speedupFactor: Number((sqliteDialNs / Math.max(1, arenaDialNs)).toFixed(2)),
    },
    evolvedPredictor: {
      trajectorySteps: evoReport.trajectorySteps,
      worldTrack2Bytes: evoReport.evolvedPredictor.worldTrack2StaticRansBytes,
      worldTrack3EvolvedBytes: evoReport.evolvedPredictor.worldTrack3EvolvedStreamBytes,
      bitsPer6FieldState: evoReport.evolvedPredictor.readonlyworldTrack3BitsPer6FieldStep,
      gainVsWorldTrack2: evoReport.evolvedPredictor.gainVsWorldTrack2Stream,
      gainVsJsonRaw: evoReport.evolvedPredictor.gainVsJsonRaw,
      losslessVerified: evoReport.evolvedPredictor.losslessVerified,
    },
    capabilityGateNs: {
      ed25519VerifyNs: edVerifyNs,
      chaskey12CapabilityVerifyNs: capVerifyNs,
      speedupFactor: Number((edVerifyNs / Math.max(1, capVerifyNs)).toFixed(2)),
    },
    relaySync: {
      sharedEnvelopes: 50,
      divergentEnvelopes: 1,
      legacyFetchAllBytes: legacy50EnvelopesBytes,
      ibltSingleRttSketchBytes: ibltWireBytes,
      wireSavingsFactor: Number((legacy50EnvelopesBytes / ibltWireBytes).toFixed(2)),
      peeledIdentically: reconciled.complete && reconciled.remoteOnlyHashes.length === 1,
    },
  };
}

export {
  attenuateProjectCapability,
  CompactRibltSketch as ConstructRibltSketch,
  chaskey12Mac128,
  chaskey12Mac128Into,
  computeMerkleMix64,
  computeOpHash64,
  decodeLatticeCrdtBatch as decodeConstructOpsBatch,
  EvolvedConstructArena,
  EvolvedCrossFieldCodec,
  EvolvedDirectArena,
  encodeLatticeCrdtBatch as encodeConstructOpsBatch,
  evolveCrossFieldGenome,
  evolvePerfectLookupCircuit,
  generateCorrelatedTrajectories,
  hashString64,
  hlcStringToPacked64,
  mintProjectCapability,
  packed64ToHlcString,
  splitMix64,
  verifyProjectCapability,
};
