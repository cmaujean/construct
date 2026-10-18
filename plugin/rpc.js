// OpenCode V2 RPC definition connecting the Construct server plugin (`construct.js`)
// and the Construct TUI / UI HUD plugin (`tui.tsx`).

const HUD_SNAPSHOT_SCHEMA = {
  type: "object",
  properties: {
    project: { type: "string" },
    pack: { type: "string" },
    emblem: { type: "string" },
    romName: { type: "string" },
    handle: { type: "string" },
    roster: { type: "array", items: { type: "string" } },
    operator: { type: "string" },
    state: { type: "string" },
    next: { type: "string" },
    headSeq: { type: "number" },
    totalFrames: { type: "number" },
    openCount: { type: "number" },
    openSeqs: { type: "array", items: { type: "number" } },
    openSummaries: { type: "array", items: { type: "string" } },
    gotchaCount: { type: "number" },
    guardCount: { type: "number" },
    inboxPendingCount: { type: "number" },
    inboxReplyCount: { type: "number" },
    driftCount: { type: "number" },
    hasMlsGroup: { type: "boolean" },
    pill: { type: "string" },
    tabBadge: { type: "string" },
  },
  required: ["project", "pack", "emblem", "romName", "headSeq", "openCount", "pill", "tabBadge"],
  additionalProperties: true,
}

export const CONSTRUCT_RPC_SPEC = {
  id: "construct",
  methods: {
    hud: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          dir: { type: "string" },
        },
        additionalProperties: false,
      },
      output: HUD_SNAPSHOT_SCHEMA,
    },
    switchRom: {
      input: {
        type: "object",
        properties: {
          action: { type: "string" },
          target: { type: "string" },
          sessionID: { type: "string" },
          dir: { type: "string" },
        },
        required: ["action", "target"],
        additionalProperties: false,
      },
      output: HUD_SNAPSHOT_SCHEMA,
    },
  },
  events: {
    updated: {
      schema: HUD_SNAPSHOT_SCHEMA,
    },
  },
}
