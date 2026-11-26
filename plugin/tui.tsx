// OpenCode V2 TUI HUD Plugin for Construct (`@opencode/plugin/tui`).
// Talks directly to Construct's live loopback HUD server (`http://127.0.0.1:47420`).

import { Plugin } from "@opencode/plugin/tui"

const HUD_BASE = "http://127.0.0.1:47420"

const CREW_OPTIONS = [
  { title: "📬 inbox: View, Reply, Ack & Hide Construct Comms", value: "ui:inbox", category: "Construct Tools", description: "Read reminders or messages, send replies, ack, or hide" },
  { title: "💻 cli: Run Construct CLI Command", value: "ui:cli", category: "Construct Tools", description: "Run tape, projects, boot, gotcha search, or any construct command" },
  { title: "🛡️ gotchas: Browse Project Gotchas & Fixes", value: "ui:gotchas", category: "Construct Tools", description: "Inspect recorded pitfalls and fixes for this project" },
  { title: "🧵 threads: Inspect All Open Threads", value: "ui:threads", category: "Construct Tools", description: "Browse and zoom into open #seq threads" },
  { title: "🧭 state: View Full State & Next Step", value: "ui:state", category: "Construct Tools", description: "Read untruncated WHERE IT STANDS and NEXT" },
  { title: "⚡ upgrade: Check / Upgrade Construct", value: "ui:upgrade", category: "Construct Tools", description: "Run construct upgrade against upstream origin/main" },
  { title: "🌃 sprawl: The Sprawl Crew (Gibson)", value: "use:sprawl", category: "Crew Banks", description: "Colin · Dixie · Wintermute · Molly · Finn · Case · Lupus · Angie · Continuity" },
  { title: "🦾 nightcity: The Afterlife Crew (Cyberpunk 2077)", value: "use:nightcity", category: "Crew Banks", description: "Judy · Vik · T-Bug · V · Mitch · Songbird · Johnny · Evelyn · Rogue" },
  { title: "🏛️ anathem: The Concent of Saunt Edhar (Stephenson)", value: "use:anathem", category: "Crew Banks", description: "Erasmas · Sammann · Jad · Cord · Orolo · Jesry · Lio · Tulia · Ala" },
  { title: "🔐 cryptonomicon: Detachment 2702 & Epiphyte Corp", value: "use:cryptonomicon", category: "Crew Banks", description: "Lawrence · Goto · Enoch · Randy · Doug · Avi · Cantrell · Amy · Golgotha" },
  { title: "🐉 shadowrun: Seattle 2050s Shadowland Team", value: "use:shadowrun", category: "Crew Banks", description: "Talon · StreetDoc · FastJack · Hatchetman · Rigger · Dodger · Harlequin · Siren · CaptainChaos" },
  { title: "🕯️ dresden: The Chicago Paranet & White Council Crew", value: "use:dresden", category: "Crew Banks", description: "Bob · Butters · Mab · Harry · Murphy · Thomas · Marcone · Grasshopper · Ivy" },
  { title: "🦄 amber: The Royal House of Amber (Zelazny)", value: "use:amber", category: "Crew Banks", description: "Corwin · Merlin · Fiona · Benedict · Julian · Random · Brand · Dworkin · Ghostwheel" },
  { title: "🐙 laundry: SOE 'Q' Division // The Laundry Files (Stross)", value: "use:laundry", category: "Crew Banks", description: "BobHoward · Pinky · Angleton · Mo · Brain · Persephone · Mhari · Holly · Stacks" },
  { title: "💍 tolkien: The Council of Elrond & Fellowship Crew (Tolkien)", value: "use:tolkien", category: "Crew Banks", description: "Gandalf · Aragorn · Galadriel · Gimli · Faramir · Legolas · Eowyn · Samwise · Elrond" },
  { title: "🐢 discworld: Ankh-Morpork City Watch & Grand Trunk Clacks (Pratchett)", value: "use:discworld", category: "Crew Banks", description: "Ponder · Vimes · Vetinari · Detritus · Cheery · Moist · Adora Belle · Carrot · Librarian" },
  { title: "🏔️ reamde: Corporation 9592, T'Rain & Tactical Overwatch (Stephenson)", value: "use:reamde", category: "Crew Banks", description: "Richard · Zula · D-Squared · Sokolov · Csongor · Yuxia · Olivia · Pluto · Skraelin" },
  { title: "🐺 irondruid: Third Eye Books, Tempe Pack & The World Tree (Hearne)", value: "use:irondruid", category: "Crew Banks", description: "Atticus · Oberon · Morrigan · Owen · Hal · Granuaile · Leif · Brighid · Ogma" },
  { title: "⚔️ prydain: Caer Dallben, Caer Dathyl & The Free Commots (Alexander)", value: "use:prydain", category: "Crew Banks", description: "Dallben · Taran · Gwydion · Coll · Fflewddur · Gurgi · Doli · Eilonwy · Taliesin" },
  { title: "🥛 clockwork: The Korova Milkbar & Ludovico Center (Burgess)", value: "use:clockwork", category: "Crew Banks", description: "Alex · Pete · Georgie · Dim · Brodsky · Branom · Deltoid · F. Alexander · Chaplain" },
  { title: "⚙️ generic: Zero-Fiction Engineering Pipeline", value: "use:generic", category: "Crew Banks", description: "Guide · Trace · Arch · Strike · Audit · Pulse · RedTeam · UX · Ledger" },
  { title: "🟣 Sub Minister of the Interior (Ruthless State-Systems Architect)", value: "sub:minister", category: "Bench / Seconds", description: "Substitutes into Seat 2 (Architect)" },
  { title: "🛡️ Sub Miss Weathers / The Cat Lady (Woodmere Perimeter Defender)", value: "sub:catlady", category: "Bench / Seconds", description: "Substitutes into Seat 4C (Red-Team)" },
  { title: "🟠 Sub Chief Guard Barnes (Staja 84F Protocol Enforcer)", value: "sub:barnes", category: "Bench / Seconds", description: "Substitutes into Seat 1B (Diagnostics)" },
  { title: "🟣 Sub Wallace ('Alkali' // T'Rain Chief Economist)", value: "sub:wallace", category: "Bench / Seconds", description: "Substitutes into Seat 2 (Architect)" },
  { title: "🛡️ Sub Coyote (Desert Trickster & Chaos Edge-Case Breaker)", value: "sub:coyote", category: "Bench / Seconds", description: "Substitutes into Seat 4C (Red-Team)" },
  { title: "🔴 Sub Hevydd the Smith (Master Iron-Forger of the Free Commots)", value: "sub:hevydd", category: "Bench / Seconds", description: "Substitutes into Seat 3 (Blitz)" },
  { title: "⚡ Sub Kaw the Crow (Taran's Winged Aerial Courier)", value: "sub:kaw", category: "Bench / Seconds", description: "Substitutes into Seat 4B (Velocity)" },
  { title: "🟣 Sub Granny Weatherwax (Lancre Headology & Edge-Case Invariants)", value: "sub:weatherwax", category: "Bench / Seconds", description: "Substitutes into Seat 2 (Architect)" },
  { title: "🟠 Sub Sergeant Angua (City Watch Scent-Tracker)", value: "sub:angua", category: "Bench / Seconds", description: "Substitutes into Seat 1B (Diagnostics)" },
  { title: "🛡️ Sub DEATH (Anthropomorphic Personification & Finality Auditor)", value: "sub:death", category: "Bench / Seconds", description: "Substitutes into Seat 4C (Red-Team)" },
  { title: "🛡️ Sub Boromir (High Warden of the White Tower)", value: "sub:boromir", category: "Bench / Seconds", description: "Substitutes into Seat 4C (Red-Team)" },
  { title: "🟣 Sub Celebrimbor (Master Smith of Eregion)", value: "sub:celebrimbor", category: "Bench / Seconds", description: "Substitutes into Seat 2 (Architect)" },
  { title: "🟠 Sub Frodo Baggins (Ring-Bearer & Unseen-World Tracer)", value: "sub:frodo", category: "Bench / Seconds", description: "Substitutes into Seat 1B (Diagnostics)" },
  { title: "🟠 Sub Prince Caine (Fleet Admiral of the Golden Circle)", value: "sub:caine", category: "Bench / Seconds", description: "Substitutes into Seat 1B (Diagnostics)" },
  { title: "🔴 Sub Fred (Residual Human Resources / Zombie Accounting)", value: "sub:fred", category: "Bench / Seconds", description: "Substitutes into Seat 3 (Blitz)" },
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

function cleanText(raw: unknown): string {
  return String(raw || "").replace(/\s+/g, " ").trim()
}

function clipText(raw: unknown, maxLen: number): string {
  const clean = cleanText(raw)
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 3)}...` : clean
}

function estimateWrappedRows(body: string, colWidth = 100): number {
  const lines = String(body || "").split("\n")
  let rows = 0
  for (const line of lines) {
    rows += Math.max(1, Math.ceil(line.length / colWidth))
  }
  return Math.min(22, Math.max(6, rows + 1))
}

export default Plugin.define({
  id: "construct.tui",
  async setup(context) {
    const [hud, updateHud] = context.storage.memory("construct.hud", {
      initial: {
        project: "construct",
        pack: "sprawl",
        emblem: "🦾",
        romName: "crew",
        operatorId: "operator",
        handle: "Construct Crew",
        headSeq: 0,
        totalFrames: 0,
        openCount: 0,
        openSeqs: [] as number[],
        openSummaries: [] as string[],
        openThreads: [] as any[],
        recentTape: [] as any[],
        gotchas: [] as any[],
        gotchaCount: 0,
        guardCount: 4,
        state: "",
        next: "",
        comms: [] as any[],
        upstreamUpdate: null as any,
        inboxPendingCount: 0,
        inboxReplyCount: 0,
        driftCount: 0,
        connected: false,
        pill: "🦾 construct · connecting...",
      },
    })

    const pickHex = (v: unknown, fallback: string) =>
      typeof v === "string" && v.trim() ? v : fallback
    const AMBER = pickHex((context.theme as any)?.hue?.orange?.[300] ?? (context.theme as any)?.hue?.yellow?.[300], "#F59E0B")
    const AMBER_BRIGHT = pickHex((context.theme as any)?.hue?.yellow?.[200], "#FBBF24")
    const GREEN = pickHex((context.theme as any)?.hue?.green?.[300], "#34D399")
    const TEXT_BASE = (context.theme as any)?.text?.base ?? "#F3F4F6"
    const TEXT_MUTED = (context.theme as any)?.text?.muted ?? "#9CA3AF"

    let initialized = false
    let lastAlertTotal = 0
    let refreshInFlight = false
    let dialogOpen = false

    const withDialogLock = async (fn: () => Promise<void>) => {
      if (dialogOpen) return
      dialogOpen = true
      try {
        await fn()
      } catch (err: any) {
        context.ui.toast.show({
          title: "Construct Error",
          message: String(err?.message || "HUD server unavailable on 127.0.0.1:47420"),
          variant: "error",
          duration: 4000,
        })
      } finally {
        dialogOpen = false
      }
    }

    const showActionModal = (opts: {
      title: string
      body: string
      highlight?: boolean
      actions: Array<{ id: string; label: string; bind?: string; accent?: string }>
    }) =>
      new Promise<string | null>((resolve) => {
        let settled = false
        const finish = (actionId: string | null) => {
          if (settled) return
          settled = true
          context.ui.dialog.clear()
          resolve(actionId)
        }

        const scrollRows = estimateWrappedRows(opts.body, 100)

        context.ui.dialog.show(
          () => {
            context.keymap.layer(() => ({
              mode: "global",
              priority: 100,
              commands: [
                ...opts.actions
                  .filter((a) => a.bind)
                  .map((a) => ({
                    id: `construct.modal.${a.id}`,
                    bind: a.bind,
                    run: () => {
                      finish(a.id)
                    },
                  })),
                {
                  id: "construct.modal.close",
                  bind: "escape",
                  run: () => {
                    finish(null)
                  },
                },
              ],
              bindings: [
                ...opts.actions.filter((a) => a.bind).map((a) => `construct.modal.${a.id}`),
                "construct.modal.close",
              ],
            }))

            return (
              <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text wrapMode="word" fg={opts.highlight ? AMBER_BRIGHT : TEXT_BASE}>
                    {opts.title}
                  </text>
                  <box
                    onMouseUp={(ev: any) => {
                      if (ev?.button === 0 || ev?.button === undefined) finish(null)
                    }}
                  >
                    <text fg={TEXT_MUTED}>{"[ esc ]"}</text>
                  </box>
                </box>
                <scrollbox height={scrollRows} focused>
                  <text wrapMode="word" fg={TEXT_BASE}>
                    {opts.body}
                  </text>
                </scrollbox>
                <box flexDirection="row" gap={2} paddingTop={1}>
                  {opts.actions.map((act) => (
                    <box
                      border
                      borderColor={act.accent || TEXT_MUTED}
                      paddingLeft={1}
                      paddingRight={1}
                      onMouseUp={(ev: any) => {
                        if (ev?.button === 0 || ev?.button === undefined) finish(act.id)
                      }}
                    >
                      <text fg={act.accent || TEXT_MUTED}>{act.label}</text>
                    </box>
                  ))}
                  <box
                    border
                    borderColor={TEXT_MUTED}
                    paddingLeft={1}
                    paddingRight={1}
                    onMouseUp={(ev: any) => {
                      if (ev?.button === 0 || ev?.button === undefined) finish(null)
                    }}
                  >
                    <text fg={TEXT_MUTED}>{"Close [Esc]"}</text>
                  </box>
                </box>
              </box>
            )
          },
          () => {
            if (!settled) {
              settled = true
              resolve(null)
            }
          },
        )
        context.ui.dialog.set({ size: "xlarge", centered: true })
      })

    const showWideAlert = async (title: string, body: string, highlight = false) => {
      await showActionModal({ title, body, highlight, actions: [] })
    }

    const selectWide = async <T extends string>(opts: {
      title: string
      options: Array<{ title: string; value: T; category?: string; description?: string }>
    }) => {
      queueMicrotask(() => {
        try {
          context.ui.dialog.set({ size: "xlarge", centered: true })
        } catch (_) {}
      })
      return await context.ui.dialog.select(opts)
    }

    const getDir = () => {
      try {
        return String(context.location?.directory || context.data.location.default()?.directory || "")
      } catch (_) {
        return ""
      }
    }

    const getSessionId = (explicitSid = "") => {
      if (explicitSid) return explicitSid
      try {
        const cur = context.ui.router.current()
        if (cur && cur.type === "session" && "sessionID" in cur) {
          return String(cur.sessionID || "")
        }
      } catch (_) {}
      return ""
    }

    const getUnread = (commsList: any[], operatorId: string) => {
      const op = String(operatorId || "").toLowerCase()
      return (Array.isArray(commsList) ? commsList : []).filter(
        (m: any) =>
          ((m.status === "pending" || m.status === "seen") && (!op || String(m.toUser || "").toLowerCase() === op)) ||
          (m.status === "replied" && (!op || String(m.fromUser || "").toLowerCase() === op)),
      )
    }

    const getAlertCount = (snap: any) => {
      const unread = getUnread(snap?.comms, snap?.operatorId || "")
      const serverCount = Number(snap?.inboxPendingCount || 0) + Number(snap?.inboxReplyCount || 0)
      return Math.max(unread.length, serverCount)
    }

    const applySnap = (snap: any) => {
      if (!snap || !snap.pill) return
      const nextTotal = getAlertCount(snap)
      if (initialized && nextTotal > lastAlertTotal) {
        const unread = getUnread(snap.comms, snap.operatorId)
        const newest = unread[0]
        const preview = newest
          ? clipText(newest.body, 110)
          : `${nextTotal} unread reminder(s) waiting in Construct Inbox`
        context.ui.toast.show({
          title: `📬 Construct Inbox (${nextTotal} pending)`,
          message: preview,
          variant: "warning",
          duration: 10000,
        })
      }
      initialized = true
      lastAlertTotal = nextTotal
      updateHud((draft: any) => {
        Object.assign(draft, snap, { connected: true })
      })
    }

    const refreshHud = async (explicitSid = "") => {
      if (refreshInFlight) return
      refreshInFlight = true
      try {
        const dir = getDir()
        const sid = getSessionId(explicitSid)
        const url = new URL(`${HUD_BASE}/hud`)
        if (dir) url.searchParams.set("dir", dir)
        if (sid) url.searchParams.set("sessionID", sid)
        const res = await fetch(url.toString())
        if (!res.ok) {
          updateHud((draft: any) => {
            draft.connected = false
          })
          return
        }
        const data = (await res.json()) as any
        applySnap(data?.hud)
      } catch (_) {
        updateHud((draft: any) => {
          draft.connected = false
        })
      } finally {
        refreshInFlight = false
      }
    }

    const postAction = async (payload: Record<string, unknown>) => {
      const res = await fetch(`${HUD_BASE}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dir: getDir(),
          sessionID: getSessionId(),
          ...payload,
        }),
      })
      if (!res.ok) {
        throw new Error(`Construct HUD HTTP ${res.status}`)
      }
      const data = (await res.json()) as any
      applySnap(data?.hud)
      return data
    }

    const showMessageDetail = async (msg: any) => {
      const op = String(hud.operatorId || "").toLowerCase()
      const isReplyNotification = msg.status === "replied" && (!op || String(msg.fromUser || "").toLowerCase() === op)
      const isPending =
        ((msg.status === "pending" || msg.status === "seen") && (!op || String(msg.toUser || "").toLowerCase() === op)) ||
        isReplyNotification
      const replySection = msg.replyBody
        ? `\n\n--- RETURN COURIER (${msg.replyRom || msg.toUser}) ---\n${msg.replyBody}`
        : ""
      const fullBody = `${String(msg.body || "")}${replySection}`
      const canReply = (!op || String(msg.toUser || "").toLowerCase() === op) && msg.status !== "replied"

      const actions: Array<{ id: string; label: string; bind?: string; accent?: string }> = []
      if (isPending) {
        actions.push({ id: "ack", label: "✓ Ack [Enter]", bind: "return", accent: AMBER_BRIGHT })
      }
      if (canReply) {
        actions.push({ id: "reply", label: "↩ Reply [r]", bind: "r", accent: GREEN })
      }
      actions.push({ id: "hide", label: "Hide [h]", bind: "h", accent: TEXT_MUTED })

      const choice = await showActionModal({
        title: `${isPending ? "📬" : "✓"} [M#${msg.id}] ${msg.fromRom || msg.fromUser} -> ${msg.toUser} (${msg.project || "global"})`,
        body: fullBody,
        highlight: isPending,
        actions,
      })

      if (choice === "ack") {
        await postAction({ action: "ack", id: msg.id })
        context.ui.toast.show({
          title: "Reminder Marked Done",
          message: `Acked M#${msg.id}`,
          variant: "success",
          duration: 2500,
        })
      } else if (choice === "reply") {
        queueMicrotask(() => {
          try {
            context.ui.dialog.set({ size: "xlarge", centered: true })
          } catch (_) {}
        })
        const replyText = await context.ui.dialog.prompt({
          title: `Reply to [M#${msg.id}] (${msg.fromUser})`,
          placeholder: "Type your reply...",
        })
        if (replyText && replyText.trim()) {
          await postAction({ action: "reply", id: msg.id, body: replyText.trim() })
          context.ui.toast.show({
            title: "Reply Sent",
            message: `Replied to M#${msg.id}`,
            variant: "success",
            duration: 3000,
          })
        }
      } else if (choice === "hide") {
        await postAction({ action: "cli", args: `hide-msg ${msg.id}` })
        context.ui.toast.show({
          title: "Message Hidden",
          message: `Archived M#${msg.id} (searchable via construct inbox --all)`,
          variant: "info",
          duration: 2500,
        })
      }
    }

    const openInboxDialog = async () => {
      await refreshHud()
      const allComms = Array.isArray(hud.comms) ? hud.comms : []
      const pending = getUnread(allComms, hud.operatorId)
      const list = pending.length > 0 ? pending : allComms.slice(0, 15)
      if (list.length === 0) {
        await showWideAlert("Construct Inbox", "No pending or recent Construct Comms messages.")
        return
      }

      const op = String(hud.operatorId || "").toLowerCase()
      const options = list.map((m: any) => {
        const isPending =
          ((m.status === "pending" || m.status === "seen") && (!op || String(m.toUser || "").toLowerCase() === op)) ||
          (m.status === "replied" && (!op || String(m.fromUser || "").toLowerCase() === op))
        const rawText = m.status === "replied" && m.replyBody ? m.replyBody : m.body
        return {
          title: `${isPending ? "📬" : "✓"} [M#${m.id}] ${m.fromRom || m.fromUser} (${m.project || "global"})`,
          value: String(m.id),
          category: isPending ? "Unread Reminders & Comms" : "Recent History",
          description: clipText(rawText, 105),
        }
      })

      const selectedId = await selectWide({
        title: `Construct Inbox (${pending.length} pending)`,
        options,
      })
      if (!selectedId) return
      const msg = list.find((m: any) => String(m.id) === String(selectedId))
      if (!msg) return
      await showMessageDetail(msg)
    }

    const openZoomDialog = async (seq: number) => {
      const data = await postAction({ action: "cli", args: `zoom ${seq}` })
      await showWideAlert(
        `Construct Frame #${seq}`,
        String(data?.cli?.output || `(frame #${seq} empty)`),
      )
    }

    const openThreadsDialog = async () => {
      await refreshHud()
      const threads = Array.isArray(hud.openThreads) ? [...hud.openThreads].reverse() : []
      if (threads.length === 0) {
        await showWideAlert("Open Threads", "0 open threads.")
        return
      }
      const selectedSeq = await selectWide({
        title: `Open Threads (${threads.length})`,
        options: threads.map((t: any) => ({
          title: `#${t.seq} (${t.ts || ""})`,
          value: String(t.seq),
          description: clipText(t.summary, 105),
        })),
      })
      if (!selectedSeq) return
      await openZoomDialog(Number(selectedSeq))
    }

    const openGotchasDialog = async () => {
      await refreshHud()
      const gotchas = Array.isArray(hud.gotchas) ? hud.gotchas : []
      if (gotchas.length === 0) {
        await showWideAlert("Project Gotchas", `No gotchas recorded for ${hud.project}.`)
        return
      }
      const selectedId = await selectWide({
        title: `Project Gotchas (${hud.gotchaCount} total, showing ${gotchas.length})`,
        options: gotchas.map((g: any) => ({
          title: `[G#${g.id}] ${clipText(g.title, 72)}`,
          value: String(g.id),
          category: g.status || "observed",
          description: g.fix ? clipText(g.fix, 105) : "(no fix note recorded)",
        })),
      })
      if (!selectedId) return
      const g = gotchas.find((item: any) => String(item.id) === String(selectedId))
      if (!g) return
      const body = [
        `GOTCHA #${g.id} (${g.status || "observed"})`,
        "",
        String(g.title || ""),
        "",
        "DO INSTEAD / FIX:",
        String(g.fix || "(none recorded)"),
      ].join("\n")
      await showWideAlert(`Gotcha #${g.id}`, body)
    }

    const openStateDialog = async () => {
      await refreshHud()
      const parts = [
        `PROJECT: ${hud.project}`,
        `CREW: ${hud.emblem} ${hud.pack} (${hud.handle})`,
        `HEAD: #${hud.headSeq} (${hud.totalFrames} frames, ${hud.gotchaCount} gotchas, ${hud.openCount} open)`,
        "",
        "WHERE IT STANDS:",
        String(hud.state || "(none)"),
        "",
        "NEXT:",
        String(hud.next || "(none)"),
      ]
      await showWideAlert(`Construct State: ${hud.project}`, parts.join("\n"))
    }

    const openCliPromptDialog = async () => {
      queueMicrotask(() => {
        try {
          context.ui.dialog.set({ size: "xlarge", centered: true })
        } catch (_) {}
      })
      const cmd = await context.ui.dialog.prompt({
        title: "Run Construct CLI Command",
        placeholder: "e.g. tape -n 15, projects, gotcha search auth, help",
      })
      if (!cmd || !cmd.trim()) return
      const data = await postAction({ action: "cli", args: cmd.trim() })
      await showWideAlert(
        `Construct: /construct ${cmd.trim()}`,
        String(data?.cli?.output || "(done)"),
      )
    }

    const openUpgradeDialog = async () => {
      await refreshHud()
      const up = hud.upstreamUpdate
      const behind = Number(up?.behindCount || 0)
      const commits = Array.isArray(up?.commits) && up.commits.length
        ? `\n\nIncoming commits:\n${up.commits.map((c: string) => `- ${c}`).join("\n")}`
        : ""
      const body = behind > 0
        ? `Construct is ${behind} commit(s) behind origin/main (${up.localSha || "local"} -> ${up.remoteSha || "origin/main"}).${commits}`
        : "Check upstream origin/main and run `construct upgrade` if updates are available?"
      const action = await showActionModal({
        title: behind > 0 ? `⚡ Construct Update Available (${behind} behind)` : "Construct Upgrade",
        body,
        highlight: behind > 0,
        actions: [{ id: "upgrade", label: "⚡ Upgrade Now [Enter]", bind: "return", accent: AMBER_BRIGHT }],
      })
      if (action === "upgrade") {
        const data = await postAction({ action: "upgrade" })
        await showWideAlert("Construct Upgrade Result", String(data?.upgraded || "Upgrade complete."))
      }
    }

    const openCrewDialog = async () => {
      await refreshHud()
      const choice = await selectWide({
        title: `Construct HUD: ${hud.pill}`,
        options: CREW_OPTIONS,
      })
      if (!choice) return
      if (choice === "ui:inbox") {
        await openInboxDialog()
        return
      }
      if (choice === "ui:cli") {
        await openCliPromptDialog()
        return
      }
      if (choice === "ui:gotchas") {
        await openGotchasDialog()
        return
      }
      if (choice === "ui:threads") {
        await openThreadsDialog()
        return
      }
      if (choice === "ui:state") {
        await openStateDialog()
        return
      }
      if (choice === "ui:upgrade") {
        await openUpgradeDialog()
        return
      }
      const idx = String(choice).indexOf(":")
      const action = idx > 0 ? String(choice).slice(0, idx) : ""
      const target = idx > 0 ? String(choice).slice(idx + 1) : ""
      if (!action || !target) return

      const data = await postAction({ action, target })
      if (data?.hud?.pill) {
        context.ui.toast.show({
          title: "Construct Crew Updated",
          message: data.hud.pill,
          variant: "success",
          duration: 3000,
        })
      }
    }

    await refreshHud()

    const pollTimer = setInterval(() => {
      void refreshHud()
    }, 5000)

    const stopEvents = context.data.listen(({ details }) => {
      const t = String(details?.type || "")
      if (t.includes("session") || t.includes("message") || t.includes("tool")) {
        const sid = String((details as any)?.data?.sessionID || (details as any)?.data?.id || "")
        void refreshHud(sid)
      }
    })

    // 1. Session Prompt Footer (`prompt.footer.status`)
    const unslotPromptStatus = context.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        const totalAlerts = getAlertCount(hud)
        const label = totalAlerts > 0 ? `📬${totalAlerts} · ${hud.pill}` : hud.pill
        return (
          <text
            fg={
              totalAlerts > 0 || hud.driftCount > 0
                ? AMBER_BRIGHT
                : hud.openCount > 0
                  ? TEXT_BASE
                  : GREEN
            }
          >
            {label}
          </text>
        )
      },
    })

    // 2. Home Screen Footer (`home.footer.status`)
    const unslotHomeStatus = context.ui.slot({
      append: "home.footer.status",
      render: () => {
        const totalAlerts = getAlertCount(hud)
        const label = totalAlerts > 0 ? `📬${totalAlerts} · ${hud.pill}` : hud.pill
        return (
          <text
            fg={
              totalAlerts > 0 || hud.driftCount > 0
                ? AMBER_BRIGHT
                : TEXT_BASE
            }
          >
            {label}
          </text>
        )
      },
    })

    // 3. Structured Clickable Sidebar Sections (`sidebar.content`)
    const unslotSidebarTop = context.ui.slot({
      prepend: "sidebar.content",
      render: () => {
        const unread = getUnread(hud.comms, hud.operatorId)
        const totalAlerts = getAlertCount(hud)
        const hasAlerts = totalAlerts > 0
        const behindCount = Number(hud.upstreamUpdate?.behindCount || 0)
        const nextText = cleanText(hud.next)
        const nextTruncated = nextText.length > 130
        const displayNext = nextTruncated ? `${nextText.slice(0, 127)}...` : nextText
        const newestThreads = Array.isArray(hud.openThreads)
          ? hud.openThreads.slice(-3).reverse()
          : []
        const latestFrames = Array.isArray(hud.recentTape)
          ? hud.recentTape.slice(0, 2)
          : []

        return (
          <box flexDirection="column" gap={1} paddingBottom={1}>
            {/* Section 1: Clickable Construct Header + Upstream Update Notice */}
            <box flexDirection="column">
              <box
                flexDirection="column"
                onMouseUp={(ev: any) => {
                  if (ev?.button === 0 || ev?.button === undefined) {
                    void withDialogLock(openCrewDialog)
                  }
                }}
              >
                <text fg={TEXT_BASE}>
                  {`${hud.emblem} ${hud.pack} · ${hud.project}`}
                </text>
                <text fg={TEXT_MUTED}>
                  {hud.connected
                    ? `Head #${hud.headSeq} · ${hud.totalFrames} frames · ${hud.guardCount} guards`
                    : "HUD offline (retrying 127.0.0.1:47420...)"}
                </text>
              </box>
              {behindCount > 0 ? (
                <box
                  onMouseUp={(ev: any) => {
                    if (ev?.button === 0 || ev?.button === undefined) {
                      void withDialogLock(openUpgradeDialog)
                    }
                  }}
                >
                  <text fg={AMBER_BRIGHT}>
                    {`⚡ Construct update: ${behindCount} behind [upgrade]`}
                  </text>
                </box>
              ) : null}
            </box>

            {/* Section 2: Inbox & Reminders (gold/orange highlight when unread > 0, zero white box) */}
            <box flexDirection="column">
              <box
                onMouseUp={(ev: any) => {
                  if (ev?.button === 0 || ev?.button === undefined) {
                    void withDialogLock(openInboxDialog)
                  }
                }}
              >
                <text fg={hasAlerts ? AMBER_BRIGHT : TEXT_BASE}>
                  {hasAlerts ? `📬 Inbox (${totalAlerts} pending) [open]` : "Inbox [open]"}
                </text>
              </box>
              {hasAlerts ? (
                <>
                  {unread.slice(0, 4).map((m: any) => {
                    const raw = m.status === "replied" && m.replyBody ? m.replyBody : m.body
                    return (
                      <box
                        onMouseUp={(ev: any) => {
                          if (ev?.button === 0 || ev?.button === undefined) {
                            void withDialogLock(() => showMessageDetail(m))
                          }
                        }}
                      >
                        <text wrapMode="word" fg={AMBER_BRIGHT}>
                          {`┃ [M#${m.id}] ${clipText(raw, 110)}`}
                        </text>
                      </box>
                    )
                  })}
                  <text fg={AMBER}>
                    {"┃ Click item or Ctrl+Shift+I to ack/reply"}
                  </text>
                </>
              ) : (
                <text fg={GREEN}>{"✓ 0 pending (Ctrl+Shift+I)"}</text>
              )}
            </box>

            {/* Section 3: Next Milestone (word-wrapped, click for full State + Next) */}
            {displayNext ? (
              <box
                flexDirection="column"
                onMouseUp={(ev: any) => {
                  if (ev?.button === 0 || ev?.button === undefined) {
                    void withDialogLock(openStateDialog)
                  }
                }}
              >
                <text fg={TEXT_BASE}>
                  {nextTruncated ? "Next [full]" : "Next"}
                </text>
                <text wrapMode="word" fg={TEXT_MUTED}>
                  {displayNext}
                </text>
              </box>
            ) : null}

            {/* Section 4: Open Threads (top 3 newest, bright #seq demarcation) */}
            <box flexDirection="column">
              <box
                onMouseUp={(ev: any) => {
                  if (ev?.button === 0 || ev?.button === undefined) {
                    void withDialogLock(openThreadsDialog)
                  }
                }}
              >
                <text fg={TEXT_BASE}>{`Open Threads (${hud.openCount}) [all]`}</text>
              </box>
              {newestThreads.length > 0 ? (
                <>
                  {newestThreads.map((t: any) => (
                    <box
                      flexDirection="row"
                      gap={1}
                      onMouseUp={(ev: any) => {
                        if (ev?.button === 0 || ev?.button === undefined) {
                          void withDialogLock(() => openZoomDialog(Number(t.seq)))
                        }
                      }}
                    >
                      <text flexShrink={0} fg={TEXT_BASE}>{`#${t.seq}`}</text>
                      <text wrapMode="word" fg={TEXT_MUTED}>
                        {clipText(t.summary, 72)}
                      </text>
                    </box>
                  ))}
                  {hud.openCount > newestThreads.length ? (
                    <box
                      onMouseUp={(ev: any) => {
                        if (ev?.button === 0 || ev?.button === undefined) {
                          void withDialogLock(openThreadsDialog)
                        }
                      }}
                    >
                      <text fg={TEXT_MUTED}>
                        {`+${hud.openCount - newestThreads.length} more [all]`}
                      </text>
                    </box>
                  ) : null}
                </>
              ) : (
                <text fg={GREEN}>{"✓ 0 open threads"}</text>
              )}
            </box>

            {/* Section 5: Gotchas (single clickable line) */}
            <box
              onMouseUp={(ev: any) => {
                if (ev?.button === 0 || ev?.button === undefined) {
                  void withDialogLock(openGotchasDialog)
                }
              }}
            >
              <text fg={TEXT_BASE}>{`Gotchas (${hud.gotchaCount}) [browse]`}</text>
            </box>

            {/* Section 6: Recent Tape (clickable frames, bright #seq demarcation) */}
            {latestFrames.length > 0 ? (
              <box flexDirection="column">
                <text fg={TEXT_BASE}>{"Recent Tape"}</text>
                {latestFrames.map((f: any) => (
                  <box
                    flexDirection="row"
                    gap={1}
                    onMouseUp={(ev: any) => {
                      if (ev?.button === 0 || ev?.button === undefined) {
                        void withDialogLock(() => openZoomDialog(Number(f.seq)))
                      }
                    }}
                  >
                    <text flexShrink={0} fg={TEXT_BASE}>{`#${f.seq}`}</text>
                    <text wrapMode="word" fg={TEXT_MUTED}>
                      {`[${f.kind}] ${clipText(f.summary, 68)}`}
                    </text>
                  </box>
                ))}
              </box>
            ) : null}
          </box>
        )
      },
    })

    // 4. Sidebar Footer (`sidebar.footer`) with Web HUD link + CLI trigger + shortcuts
    const unslotSidebarFooter = context.ui.slot({
      append: "sidebar.footer",
      render: () => (
        <box flexDirection="column" paddingTop={1}>
          {hud.driftCount > 0 ? (
            <text fg={AMBER_BRIGHT}>
              {`⚠️ ${hud.driftCount} repo instruction file(s) drifted`}
            </text>
          ) : null}
          <text fg={TEXT_MUTED}>
            {"Web HUD: "}
            <a href="http://127.0.0.1:47420/">http://127.0.0.1:47420/</a>
          </text>
          <box
            onMouseUp={(ev: any) => {
              if (ev?.button === 0 || ev?.button === undefined) {
                void withDialogLock(openCliPromptDialog)
              }
            }}
          >
            <text fg={TEXT_MUTED}>{"💻 Run Construct CLI [open]"}</text>
          </box>
          <text fg={TEXT_MUTED}>
            {"Ctrl+Shift+G HUD · Ctrl+Shift+I Inbox"}
          </text>
        </box>
      ),
    })

    // 5. Composer Alert Bar (`session.composer.top`)
    const unslotComposerAlert = context.ui.slot({
      prepend: "session.composer.top",
      render: () => {
        const totalAlerts = getAlertCount(hud)
        return totalAlerts > 0 || hud.driftCount > 0 ? (
          <box
            onMouseUp={(ev: any) => {
              if (ev?.button === 0 || ev?.button === undefined) {
                void withDialogLock(openInboxDialog)
              }
            }}
          >
            <text fg={AMBER_BRIGHT}>
              {totalAlerts > 0
                ? `📬 REMINDER (${totalAlerts} pending): Click here or press Ctrl+Shift+I to read & ack `
                : ""}
              {hud.driftCount > 0 ? `⚠️ ${hud.driftCount} repo instruction file(s) drifted on disk` : ""}
            </text>
          </box>
        ) : null
      },
    })

    // 6. Interactive `/construct`, `/inbox`, `Ctrl+Shift+G`, and `Ctrl+Shift+I`
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "construct.inbox",
          title: "Construct Inbox: View, Reply, Ack & Hide Comms",
          group: "Construct",
          bind: "ctrl+shift+i",
          palette: true,
          slash: { name: "inbox", aliases: ["comms"], arguments: false },
          enabled: () => true,
          suggested: true,
          run: async () => {
            await withDialogLock(openInboxDialog)
          },
        },
        {
          id: "construct.hud",
          title: "Construct HUD: Crew Switcher, Tools, or Command",
          group: "Construct",
          bind: "ctrl+shift+g",
          palette: true,
          slash: { name: "construct", aliases: ["crew", "hud"], arguments: true },
          enabled: () => true,
          suggested: true,
          run: async (input) => {
            const rawArg = String(input || "").trim()
            if (rawArg === "inbox") {
              await withDialogLock(openInboxDialog)
              return
            }
            if (rawArg === "open" || rawArg === "threads") {
              await withDialogLock(openThreadsDialog)
              return
            }
            if (rawArg === "gotchas") {
              await withDialogLock(openGotchasDialog)
              return
            }
            if (rawArg === "cli") {
              await withDialogLock(openCliPromptDialog)
              return
            }
            if (rawArg) {
              await withDialogLock(async () => {
                const data = await postAction({ action: "cli", args: rawArg })
                await showWideAlert(
                  `Construct: /construct ${rawArg}`,
                  String(data?.cli?.output || "(done)"),
                )
              })
              return
            }
            await withDialogLock(openCrewDialog)
          },
        },
      ],
      bindings: ["construct.inbox", "construct.hud"],
    }))

    return () => {
      clearInterval(pollTimer)
      stopEvents()
      unslotPromptStatus()
      unslotHomeStatus()
      unslotSidebarTop()
      unslotSidebarFooter()
      unslotComposerAlert()
    }
  },
})
