import type {
  CrdtOperationRecord,
  CrdtOperationsBatch,
  ProjectCapabilityCaveat,
  ProjectCapabilityToken,
  SynthesizedLookupCircuit,
} from "./causal-lattice/index.ts";

export type FrameKind =
  | "intent"
  | "probe"
  | "finding"
  | "dead_end"
  | "decision"
  | "change"
  | "commit"
  | "release"
  | "thread";

export interface FrameRecord {
  readonly seq: number;
  readonly uid?: string;
  readonly hlc?: string;
  readonly ts: string;
  readonly project: string;
  readonly kind: FrameKind;
  readonly summary: string;
  readonly detail: string;
  readonly verified: string;
  readonly parentSeq: number | null;
  readonly open: boolean;
  readonly resolvedBy: number | null;
  readonly refs: readonly string[];
}

export interface RecordFrameRequest {
  readonly project: string;
  readonly kind: FrameKind;
  readonly summary: string;
  readonly detail?: string;
  readonly verified?: string;
  readonly parentSeq?: number | string | null;
  readonly resolves?: string | readonly (number | string)[];
  readonly open?: boolean;
  readonly refs?: string | readonly string[];
  readonly ts?: string;
  readonly uid?: string;
  readonly hlc?: string;
}

export interface EditFrameRequest {
  readonly summary?: string;
  readonly detail?: string;
  readonly verified?: string;
  readonly kind?: FrameKind;
  readonly parentSeq?: number | string | null;
  readonly refs?: string | readonly string[];
}

export interface ResolveFramesOptions {
  readonly by?: number | string;
  readonly reason?: string;
  readonly detail?: string;
  readonly verified?: string;
  readonly kind?: FrameKind;
  readonly ts?: string;
  readonly closeGh?: boolean;
  readonly repoDir?: string;
}

export interface HeadRecord {
  readonly project: string;
  readonly repo: string;
  readonly state: string;
  readonly next: string;
  readonly ghSynced?: string;
  readonly updated: string;
}

export interface SetHeadRequest {
  readonly repo?: string;
  readonly state?: string;
  readonly next?: string;
  readonly ts?: string;
}

export interface RomDials {
  readonly terseness: number;
  readonly warmth: number;
  readonly edge: number;
  readonly wit: number;
  readonly proactivity: number;
  readonly rigor: number;
  readonly [key: string]: number;
}

export type RomSeat =
  | "recon"
  | "diagnostics"
  | "architect"
  | "blitz"
  | "forensics"
  | "velocity"
  | "redteam"
  | "ergonomics"
  | "archivist"
  | "instrument";

export interface RomRecord {
  readonly name: string;
  readonly pack: string;
  readonly seat: RomSeat;
  readonly tier: "primary" | "backup";
  readonly handle: string;
  readonly tagline: string;
  readonly voice: string;
  readonly dials: RomDials;
  readonly directives: readonly string[];
  readonly active: boolean;
  readonly updated: string;
  readonly isCrew?: boolean;
  readonly roster?: readonly string[];
}

export interface UserAgreement {
  readonly id: string;
  readonly name: string;
  readonly osUsers: readonly string[];
  readonly experience: string;
  readonly platform: string;
  readonly workspaceRoot: string;
  readonly calibration: string;
  readonly defaultRom: string;
  readonly active: boolean;
  readonly updated: string;
}

export interface SetUserRequest {
  readonly name?: string;
  readonly osUsers?: string | readonly string[];
  readonly experience?: string;
  readonly platform?: string;
  readonly workspaceRoot?: string;
  readonly calibration?: string;
  readonly defaultRom?: string;
  readonly active?: boolean;
}

export type GotchaStatus = "observed" | "from_source" | "reported";
export type GuardPlatform = "all" | "win32" | "linux" | "darwin";

export interface GotchaRecord {
  readonly id: number;
  readonly uid?: string;
  readonly hlc?: string;
  readonly scope: string;
  readonly title: string;
  readonly status: GotchaStatus;
  readonly tags: readonly string[];
  readonly evidence: string;
  readonly fix: string;
  readonly guardRegex: string;
  readonly guardPlatform: GuardPlatform;
  readonly created: string;
}

export interface AddGotchaRequest {
  readonly uid?: string;
  readonly scope?: string;
  readonly project?: string;
  readonly title: string;
  readonly status?: GotchaStatus;
  readonly tags?: string | readonly string[];
  readonly evidence?: string;
  readonly fix?: string;
  readonly guardRegex?: string;
  readonly guard?: string;
  readonly guardPlatform?: string;
  readonly guardOs?: string;
  readonly created?: string;
}

export type MessageStatus = "pending" | "seen" | "replied" | "delivered" | "hidden";

export interface CourierMessage {
  readonly id: number;
  readonly uid: string;
  readonly hlc: string;
  readonly project: string;
  readonly fromUser: string;
  readonly fromRom: string;
  readonly fromDid: string;
  readonly toUser: string;
  readonly body: string;
  readonly status: MessageStatus;
  readonly replyBody: string;
  readonly replyRom: string;
  readonly replyHlc: string;
  readonly created: string;
}

export interface SendMessageRequest {
  readonly uid?: string;
  readonly project?: string;
  readonly fromUser?: string;
  readonly fromRom?: string;
  readonly via?: string;
  readonly to?: string;
  readonly toUser?: string;
  readonly body: string;
  readonly sessionId?: string;
  readonly created?: string;
}

export interface CryptographicIdentity {
  readonly version: number;
  readonly did: string;
  readonly signPub: string;
  readonly signPriv: string;
  readonly dhPub: string;
  readonly dhPriv: string;
  readonly created: string;
}

export interface MlsMember {
  readonly did: string;
  readonly userId: string;
  readonly signPub: string;
  readonly dhPub: string;
  readonly latticeV2?: boolean;
}

export interface MlsGroupRecord {
  readonly project: string;
  readonly groupId: string;
  readonly epoch: number;
  readonly epochSecret: string;
  readonly members: readonly MlsMember[];
  readonly relays: readonly string[];
  readonly lastSyncHlc: string;
  readonly updated: string;
}

export interface SealedMlsEnvelope {
  readonly v: number;
  readonly type: string;
  readonly routeTag: string;
  readonly blindHash64: string;
  readonly groupId: string;
  readonly epoch: number;
  readonly senderDid: string;
  readonly senderSignPub: string;
  readonly aad: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
  readonly signature: string;
}

export type {
  CrdtOperationRecord,
  CrdtOperationsBatch,
  ProjectCapabilityCaveat,
  ProjectCapabilityToken,
  SynthesizedLookupCircuit,
};
