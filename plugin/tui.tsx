// OpenCode V2 TUI / UI HUD Plugin for Construct (`@opencode/plugin/tui`).
//
// Mounts reactive HUD telemetry into:
//   - `prompt.footer.status` (bottom-right corner of the active session prompt bar)
//   - `home.footer.status`   (bottom-right corner of the home screen)
//   - `sidebar.footer`       (persistent Construct Crew & Open Threads card in the sidebar)
//   - `session.composer.top` (alert strip above composer when unread Construct Comms or repo drift exist)
//   - `session.panel`        (full Construct HUD panel via `/construct` or `Ctrl+G`)

import { Plugin } from "@opencode/plugin/tui"
import { Rpc } from "@opencode/plugin/rpc"

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

const ConstructRpc = Rpc.define({
  id: "construct",
  methods: {
    hud: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, dir: { type: "string" } },
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
    updated: { schema: HUD_SNAPSHOT_SCHEMA },
  },
})

const CREW_OPTIONS = [
  { title: "🌃 sprawl — The Sprawl Crew (Gibson)", value: "use:sprawl", category: "Crew Banks", description: "Colin · Dixie · Wintermute · Molly · Finn · Case · Lupus · Angie · Continuity" },
  { title: "🦾 nightcity — The Afterlife Crew (Cyberpunk 2077)", value: "use:nightcity", category: "Crew Banks", description: "Judy · Vik · T-Bug · V · Mitch · Songbird · Johnny · Evelyn · Rogue" },
  { title: "🏛️ anathem — The Concent of Saunt Edhar (Stephenson)", value: "use:anathem", category: "Crew Banks", description: "Erasmas · Sammann · Jad · Cord · Orolo · Jesry · Lio · Tulia · Ala" },
  { title: "🔐 cryptonomicon — Detachment 2702 & Epiphyte Corp", value: "use:cryptonomicon", category: "Crew Banks", description: "Lawrence · Goto · Enoch · Randy · Doug · Avi · Cantrell · Amy · Golgotha" },
  { title: "🐉 shadowrun — Seattle 2050s Shadowland Team", value: "use:shadowrun", category: "Crew Banks", description: "Talon · StreetDoc · FastJack · Hatchetman · Rigger · Dodger · Harlequin · Siren · CaptainChaos" },
  { title: "🕯️ dresden — The Chicago Paranet & White Council Crew", value: "use:dresden", category: "Crew Banks", description: "Bob · Butters · Mab · Harry · Murphy · Thomas · Marcone · Grasshopper · Ivy" },
  { title: "🦄 amber — The Royal House of Amber (Zelazny)", value: "use:amber", category: "Crew Banks", description: "Corwin · Merlin · Fiona · Benedict · Julian · Random · Brand · Dworkin · Ghostwheel" },
  { title: "⚙️ generic — Zero-Fiction Engineering Pipeline", value: "use:generic", category: "Crew Banks", description: "Guide · Trace · Arch · Strike · Audit · Pulse · RedTeam · UX · Ledger" },
  { title: "🟠 Sub Prince Caine (Fleet Admiral of the Golden Circle)", value: "sub:caine", category: "Bench / Seconds", description: "Substitutes into Seat 1B (Diagnostics)" },
  { title: "⚡ Sub Major General Toot-Toot (Za-Lord's Guard Swarm Scout)", value: "sub:toot", category: "Bench / Seconds", description: "Substitutes into Seat 4B (Velocity)" },
  { title: "🟣 Sub Ebenezar McCoy (The Blackstaff / Senior Council)", value: "sub:ebenezar", category: "Bench / Seconds", description: "Substitutes into Seat 2 (Architect)" },
  { title: "🛡️ Sub Michael Carpenter (Knight of the Cross & Master Builder)", value: "sub:michael", category: "Bench / Seconds", description: "Substitutes into Seat 4C (Red-Team)" },
  { title: "🟣 Sub Lodoghir (Procian Rhetor / Legal & Test Inquisitor)", value: "sub:lodoghir", category: "Bench / Seconds", description: "Substitutes into Seat 2 (Architect)" },
  { title: "🟣 Sub Takemura (Arasaka Structural Discipline)", value: "sub:takemura", category: "Bench / Seconds", description: "Substitutes into Seat 2 (Architect)" },
  { title: "🟣 Sub Alan Turing (Universal State-Machine Invariants)", value: "sub:turing", category: "Bench / Seconds", description: "Substitutes into Seat 2 (Architect)" },
  { title: "🟣 Sub Mr. Johnson (Corporate Contract & Scope)", value: "sub:johnson", category: "Bench / Seconds", description: "Substitutes into Seat 2 (Architect)" },
  { title: "⚡ Sub Jules Verne Durand (Rapid Live A/B Field Probes)", value: "sub:jules", category: "Bench / Seconds", description: "Substitutes into Seat 4B (Velocity)" },
  { title: "🛡️ Sub Solomon Reed (FIA Tradecraft & OpSec)", value: "sub:reed", category: "Bench / Seconds", description: "Substitutes into Seat 4C (Red-Team)" },
  { title: "🎨 Sub Marly Krushkhova (Composition & Typography)", value: "sub:marly", category: "Bench / Seconds", description: "Substitutes into Seat 4D (Ergonomics)" },
]

export default Plugin.define({
  id: "construct.tui",
  async setup(context) {
    const rpc = context.client.rpc(ConstructRpc)
    const [hud, updateHud] = context.storage.memory("construct.hud", {
      initial: {
        project: "construct",
        pack: "sprawl",
        emblem: "🦾",
        romName: "crew",
        handle: "Construct Crew",
        roster: [],
        headSeq: 0,
        totalFrames: 0,
        openCount: 0,
        openSeqs: [],
        openSummaries: [],
        gotchaCount: 0,
        guardCount: 4,
        inboxPendingCount: 0,
        inboxReplyCount: 0,
        driftCount: 0,
        hasMlsGroup: false,
        pill: "🦾 construct · ready",
        tabBadge: "🦾 [construct]",
      },
    })

    const refreshHud = async (sessionID = "") => {
      try {
        const snap = await rpc.hud({
          sessionID: String(sessionID || ""),
          dir: String(context.location?.directory || ""),
        })
        if (snap && snap.pill) {
          updateHud((draft) => {
            Object.assign(draft, snap)
          })
        }
      } catch (_) {}
    }

    await refreshHud()

    const unsubRpc = rpc.events.on("updated", (ev) => {
      if (ev?.data?.pill) {
        updateHud((draft) => {
          Object.assign(draft, ev.data)
        })
      }
    })

    const stopEvents = context.data.listen(({ details }) => {
      const t = String(details?.type || "")
      if (t.includes("session") || t.includes("message") || t.includes("tool")) {
        const sid = details?.data?.sessionID || details?.data?.id || ""
        void refreshHud(sid)
      }
    })

    // 1. Corner Status Indicator in Session Prompt Footer (`prompt.footer.status`)
    const unslotPromptStatus = context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <text
          fg={
            hud.inboxPendingCount > 0 || hud.driftCount > 0
              ? context.theme.text.warning
              : hud.openCount > 0
                ? context.theme.text.base
                : context.theme.text.success
          }
        >
          {hud.pill}
        </text>
      ),
    })

    // 2. Corner Status Indicator on Home Footer (`home.footer.status`)
    const unslotHomeStatus = context.ui.slot({
      append: "home.footer.status",
      render: () => <text fg={context.theme.text.base}>{hud.pill}</text>,
    })

    // 3. Sidebar Footer HUD Card (`sidebar.footer`)
    const unslotSidebar = context.ui.slot({
      append: "sidebar.footer",
      render: () => (
        <box flexDirection="column" paddingTop={1}>
          <text fg={context.theme.text.base}>{hud.pill}</text>
          <text fg={context.theme.text.muted}>
            {hud.openSeqs?.length
              ? `Open: ${hud.openSeqs.map((s) => `#${s}`).join(", ")}`
              : "Open threads: 0 (all verified)"}
          </text>
        </box>
      ),
    })

    // 4. Composer Alert Bar (`session.composer.top`) when unread Construct Comms or repo drift exist
    const unslotComposerAlert = context.ui.slot({
      prepend: "session.composer.top",
      render: () =>
        hud.inboxPendingCount + hud.inboxReplyCount > 0 || hud.driftCount > 0 ? (
          <text fg={context.theme.text.warning}>
            {hud.inboxPendingCount + hud.inboxReplyCount > 0
              ? `📬 Construct Comms: ${hud.inboxPendingCount} pending, ${hud.inboxReplyCount} reply `
              : ""}
            {hud.driftCount > 0 ? `⚠️ ${hud.driftCount} repo instruction file(s) drifted on disk` : ""}
          </text>
        ) : null,
    })

    // 5. Interactive `/construct` & `Ctrl+G` Crew Switcher Dialog
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "construct.hud",
          title: "Construct HUD: Switch Crew Bank or Bench Specialist",
          group: "Construct",
          bind: "ctrl+shift+g",
          palette: true,
          slash: { name: "construct", aliases: ["crew", "hud"], arguments: false },
          enabled: () => true,
          suggested: true,
          run: async () => {
            await refreshHud()
            const choice = await context.ui.dialog.select({
              title: `Construct HUD — ${hud.pill}`,
              current: `use:${hud.pack}`,
              options: CREW_OPTIONS,
            })
            if (!choice) return
            const [action, target] = String(choice).split(":")
            if (action && target) {
              const snap = await rpc.switchRom({
                action,
                target,
                dir: String(context.location?.directory || ""),
              })
              if (snap && snap.pill) {
                updateHud((draft) => {
                  Object.assign(draft, snap)
                })
                context.ui.toast.show({
                  title: "Construct Crew Updated",
                  message: snap.pill,
                  variant: "success",
                  duration: 3000,
                })
              }
            }
          },
        },
      ],
      bindings: ["construct.hud"],
    }))

    return () => {
      unsubRpc()
      stopEvents()
      unslotPromptStatus()
      unslotHomeStatus()
      unslotSidebar()
      unslotComposerAlert()
    }
  },
})
