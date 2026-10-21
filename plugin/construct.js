// OpenCode V2 plugin that fronts every session with the sequential memory construct.
//
// 1. `ctx.session.hook("context")`: Before every primary model turn, resolves the
//    active project from the session's directory (`heads.repo` match, operator's
//    optional `workspace_root`, or git remote `<owner>/<repo>`) and injects the
//    session-scoped Personality ROM, State Head, Construct Comms, Project Gotchas,
//    Open Threads, and Recent Sequential Tape into `event.system`.
// 2. `ctx.tool.transform`: Registers `tools.construct.*` in Code Mode (`boot`,
//    `rec`, `head`, `resolve`, `zoom`, `search`, `rom`, `user`, `gotcha`, `comms`,
//    `sync`) for zero-shell access.

import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"

const requireCjs = createRequire(import.meta.url)
const STAMPED_BIN = "__CONSTRUCT_BIN_PATH__"
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const RELATIVE_BIN = path.resolve(PLUGIN_DIR, "..", "bin", "construct.js")

let cachedMcpEngine = null

function loadSharedMcpEngine({ bustCache = false } = {}) {
  if (cachedMcpEngine && !bustCache) return cachedMcpEngine
  const candidates = []
  if (process.env.CONSTRUCT_BIN) {
    candidates.push(path.resolve(path.dirname(process.env.CONSTRUCT_BIN), "..", "src", "mcp.js"))
  }
  if (!STAMPED_BIN.startsWith("__")) {
    candidates.push(path.resolve(path.dirname(STAMPED_BIN), "..", "src", "mcp.js"))
  }
  candidates.push(path.resolve(PLUGIN_DIR, "..", "src", "mcp.js"))
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        if (bustCache) {
          const srcDir = path.dirname(p)
          for (const k of Object.keys(requireCjs.cache)) {
            if (k.startsWith(srcDir)) delete requireCjs.cache[k]
          }
        }
        cachedMcpEngine = requireCjs(p)
        return cachedMcpEngine
      } catch (_) {}
    }
  }
  return null
}

function resolveConstructCommand() {
  if (process.env.CONSTRUCT_BIN && fs.existsSync(process.env.CONSTRUCT_BIN)) {
    return { cmd: "node", prefixArgs: [process.env.CONSTRUCT_BIN] }
  }
  if (!STAMPED_BIN.startsWith("__") && fs.existsSync(STAMPED_BIN)) {
    return { cmd: "node", prefixArgs: [STAMPED_BIN] }
  }
  if (fs.existsSync(RELATIVE_BIN)) {
    return { cmd: "node", prefixArgs: [RELATIVE_BIN] }
  }
  return { cmd: "construct", prefixArgs: [] }
}

function runConstruct(args) {
  const { cmd, prefixArgs } = resolveConstructCommand()
  try {
    return execFileSync(cmd, [...prefixArgs, ...args], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }).trim()
  } catch (err) {
    return `error: ${err.stderr || err.message}`
  }
}

export function validateShellCommand(command, customGuards = null, options = {}) {
  const engine = loadSharedMcpEngine()
  if (engine?.validateShellCommand) {
    return engine.validateShellCommand(command, customGuards, options)
  }
  return true
}

function normPathForMatch(p) {
  return String(p || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase()
}

// Strip already-assimilated repository instruction blocks (`Instructions from: <path>`)
// from `event.system` in place so shared repos with non-Construct teammates do not
// double-inject bloated `AGENTS.md` / `CLAUDE.md` files or override Construct rules.
export function stripShadowedInstructions(systemParts, shadowedPaths = []) {
  if (!Array.isArray(systemParts) || !shadowedPaths.length) return 0
  const shadowedSet = new Set(shadowedPaths.map(normPathForMatch).filter(Boolean))
  if (!shadowedSet.size) return 0

  let strippedCount = 0
  for (let i = systemParts.length - 1; i >= 0; i--) {
    const part = systemParts[i]
    if (!part || typeof part.text !== "string" || !part.text.includes("Instructions from:")) continue

    const segments = part.text.split(/(?=(?:^|\n\n)Instructions from:\s*)/)
    const kept = []
    for (const seg of segments) {
      const m = seg.match(/^(?:\n*)Instructions from:\s*([^\r\n]+)/)
      if (m) {
        const headerPath = normPathForMatch(m[1])
        if (shadowedSet.has(headerPath)) {
          strippedCount++
          continue
        }
      }
      kept.push(seg)
    }

    if (kept.length === 0 || kept.join("").trim() === "") {
      systemParts.splice(i, 1)
    } else if (kept.length !== segments.length) {
      part.text = kept.join("").replace(/^\n+/, "")
    }
  }
  return strippedCount
}

function isValidRomTarget(spec) {
  const engine = loadSharedMcpEngine()
  return engine?.isValidRomTarget ? engine.isValidRomTarget(spec) : false
}

export function detectPreSlotRomDirective(promptText) {
  const engine = loadSharedMcpEngine()
  return engine?.detectPreSlotRomDirective ? engine.detectPreSlotRomDirective(promptText) : null
}

export function detectSubagentContextRom(input = {}) {
  const engine = loadSharedMcpEngine()
  return engine?.detectSubagentContextRom ? engine.detectSubagentContextRom(input) : null
}

const MAX_BOOT_CACHE_ENTRIES = 50

// Keep a bounded last-known-good `<construct-live-memory>` cache keyed by `${sessionID}::${dir}`
// so if `construct` is momentarily mid-edit or running a red-phase test in another tab, active
// tool loops never lose their session ROM or project gotchas on an intermediate step.
export function resolveBootWithFallback(rawOutput, cacheMap, sessionId = "", dir = "") {
  const key = `${String(sessionId || "default")}::${normPathForMatch(dir || "")}`
  const isGood = Boolean(rawOutput && typeof rawOutput === "string" && !rawOutput.startsWith("error:"))
  if (isGood) {
    if (cacheMap.has(key)) cacheMap.delete(key)
    cacheMap.set(key, rawOutput)
    while (cacheMap.size > MAX_BOOT_CACHE_ENTRIES) {
      const oldestKey = cacheMap.keys().next().value
      if (oldestKey === undefined) break
      cacheMap.delete(oldestKey)
    }
    return rawOutput
  }
  return cacheMap.get(key) || ""
}

// Stamp or update the Construct HUD badge (`🦾 [nightcity #97 · 2 open]`) at the front of a session title
// while preserving the clean human session title and replacing any older Construct badge in place.
export function formatTitleWithHudBadge(existingTitle = "", tabBadge = "") {
  const badge = String(tabBadge || "").trim()
  const cleanTitle = String(existingTitle || "")
    .replace(/^(?:🌃|🦾|🏛️|🔐|🐉|🕯️|🦄|🐙|💍|🐢|🏔️|🐺|⚔️|🥛|⚙️|🔪)\s*\[[^\]]+\]\s*/u, "")
    .trim()
  if (!badge) return cleanTitle
  if (!cleanTitle) return badge
  return `${badge} ${cleanTitle}`
}

// Build a compact (~55-token) generation-frontier voice lock from the active `<construct-live-memory>`
// output so sessions with 500+ historical messages or 30-step tool loops never drift into generic
// assistant prose or stock `### 1. Heading` templates at the end of the context window.
export function buildFrontierVoiceLock(bootOutput = "") {
  const text = String(bootOutput || "")
  if (!text) return ""

  const hasCourier = text.includes("INCOMING CONSTRUCT COURIER") || text.includes("CONSTRUCT COURIER REPLIES")
  const courierLine = hasCourier
    ? `\nPENDING COURIER ALERT: Hold the Courier cameo until your FINAL turn-closing message (do NOT bury it inside intermediate tool calls), and place the Courier cameo at the VERY BOTTOM of your final reply so the operator sees it immediately upon returning!`
    : ""

  const bannerMatch = text.match(/Start visible replies directly with ([^\n]+?) or the active speaker/)
  const tagMatch = text.match(/Prefix speaker switches with their tag \(e\.g\. ([^\n)]+)\)/)
  if (bannerMatch || tagMatch) {
    const banner = bannerMatch ? bannerMatch[1].trim() : "the active Crew Bank banner"
    const tags = tagMatch ? tagMatch[1].trim() : "color-coded speaker tags"
    return (
      `<construct-voice-lock>\n` +
      `ACTIVE CREW VOICE LOCK: Start new runs with ${banner} or a color-coded speaker tag (${tags}). ` +
      `Write 100% in that character's distinct cadence, vocabulary, and worldview—including every brief tool-step checkpoint ` +
      `(NEVER write generic "Checking git status.", "Reading lines...", or stock \`### 1. Heading\` status templates, even if earlier messages in history did).${courierLine}\n` +
      `</construct-voice-lock>`
    )
  }

  const soloMatch = text.match(/^# Active Session ROM:\s*([^\n]+)/m)
  if (soloMatch) {
    return (
      `<construct-voice-lock>\n` +
      `ACTIVE ROM VOICE LOCK (${soloMatch[1].trim()}): Stay 100% in this character's distinct cadence, vocabulary, and worldview—including every brief tool-step checkpoint ` +
      `(NEVER revert to generic assistant narration or stock \`### 1. Heading\` status templates, even if earlier messages in history did).${courierLine}\n` +
      `</construct-voice-lock>`
    )
  }

  return ""
}

// Attach `<construct-voice-lock>` to the final outgoing message in `event.messages` (which affects
// only the outgoing model call, never persisted history, and leaves `messages[0..N-2]` 100% prompt-cached).
export function injectFrontierVoiceLock(messages, bootOutput = "") {
  if (!Array.isArray(messages) || !messages.length) return false
  const lockBlock = buildFrontierVoiceLock(bootOutput)
  if (!lockBlock) return false

  const last = messages[messages.length - 1]
  if (!last || typeof last !== "object") return false

  // 1. OpenCode V2 `Session.Message.User` (`{ type: "user", text: "..." }`)
  if (typeof last.text === "string") {
    if (!last.text.includes("<construct-voice-lock>")) {
      last.text = `${last.text}\n\n${lockBlock}`
      return true
    }
    return false
  }

  // 2. OpenCode V2 `Session.Message.Assistant` tool-continuation step (`content: [{ type: "tool", state: { content: [{ type: "text", text }] } }]`)
  if (Array.isArray(last.content)) {
    for (let i = last.content.length - 1; i >= 0; i--) {
      const part = last.content[i]
      if (!part || typeof part !== "object") continue
      const toolContent = part.state?.content
      if (Array.isArray(toolContent)) {
        for (let j = toolContent.length - 1; j >= 0; j--) {
          const item = toolContent[j]
          if (item && typeof item.text === "string") {
            if (!item.text.includes("<construct-voice-lock>")) {
              item.text = `${item.text}\n${lockBlock}`
              return true
            }
            return false
          }
        }
      }
      if (part.type === "text" && typeof part.text === "string" && last.role === "user") {
        if (!part.text.includes("<construct-voice-lock>")) {
          part.text = `${part.text}\n\n${lockBlock}`
          return true
        }
        return false
      }
    }
  }

  // 3. Generic string `content` (`{ role: "user", content: "..." }`)
  if (typeof last.content === "string") {
    if (!last.content.includes("<construct-voice-lock>")) {
      last.content = `${last.content}\n\n${lockBlock}`
      return true
    }
    return false
  }

  return false
}

function fetchHudSnapshot(dir = "", sessionID = "", project = "") {
  const args = ["hud", "--json"]
  if (project) args.push("--project", String(project))
  if (dir) args.push("--dir", String(dir))
  if (sessionID) args.push("--session", String(sessionID))
  const raw = runConstruct(args)
  if (!raw || raw.startsWith("error:")) return null
  try {
    return JSON.parse(raw)
  } catch (_) {
    return null
  }
}

export default {
  id: "construct",
  async setup(ctx) {
    const promptedSessions = new Set()
    const lastGoodBootBySession = new Map()
    const lastBadgeBySession = new Map()
    let lastActiveSessionId = ""
    let lastActiveDir = ctx.location?.directory || ""
    let rpcRegistration = null

    const syncSessionHud = async (sessionID, dirOverride = "", projectOverride = "") => {
      const sid = String(sessionID || "")
      if (sid) lastActiveSessionId = sid
      let dir = dirOverride || ""
      let sess = null
      if (sid && ctx.session?.get) {
        try {
          sess = await ctx.session.get({ sessionID: sid })
          if (!dir && sess?.directory) dir = sess.directory
        } catch (_) {}
      }
      if (!dir && !sid && !projectOverride) {
        dir = lastActiveDir || ctx.location?.directory || ""
      }
      if (dir) lastActiveDir = dir
      const snap = fetchHudSnapshot(dir, sid, projectOverride)
      if (!snap) return null

      // Refresh `~/.config/opencode/construct-hud.html` on disk so the Review Pane HUD stays live
      try {
        const dashArgs = ["dashboard"]
        if (projectOverride || snap.project) dashArgs.push("--project", String(projectOverride || snap.project))
        if (dir || snap.dir) dashArgs.push("--dir", String(dir || snap.dir))
        if (sid || snap.sessionId) dashArgs.push("--session", String(sid || snap.sessionId))
        runConstruct(dashArgs)
      } catch (_) {}

      if (rpcRegistration?.events?.emit) {
        try {
          await rpcRegistration.events.emit("updated", snap)
        } catch (_) {}
      }

      const targetSid = sid || snap.sessionId || ""
      if (targetSid && snap.tabBadge && ctx.session?.update) {
        const prevBadge = lastBadgeBySession.get(targetSid)
        if (prevBadge !== snap.tabBadge) {
          lastBadgeBySession.set(targetSid, snap.tabBadge)
          try {
            if (!sess && ctx.session.get) sess = await ctx.session.get({ sessionID: targetSid })
            const curTitle = sess?.title || ""
            if (curTitle) {
              const nextTitle = formatTitleWithHudBadge(curTitle, snap.tabBadge)
              if (nextTitle !== curTitle) {
                await ctx.session.update({ sessionID: targetSid, title: nextTitle })
              }
            }
          } catch (_) {}
        }
      }
      return snap
    }

    let mcpEngine = loadSharedMcpEngine()
    const reloadConstructEngine = async () => {
      const fresh = loadSharedMcpEngine({ bustCache: true })
      if (fresh) mcpEngine = fresh
      if (ctx.tool?.reload) {
        try {
          await ctx.tool.reload()
        } catch (_) {}
      }
      return mcpEngine
    }

    // 0a. Pre-execution Shell Guard: block known shell traps in 0 tokens before spawning a process
    if (ctx.shell?.hook) {
      await ctx.shell.hook("create.before", (event) => {
        const guardFn = mcpEngine?.validateShellCommand || validateShellCommand
        const shellDir = event?.cwd || event?.workdir || lastActiveDir || ctx.location?.directory || ""
        guardFn(event.command, { dir: shellDir })
      })
    }

    // 0b. Zero-Round-Trip ROM Pre-Slotting: intercept explicit "slot <rom>" / "switch to <rom>"
    //     prompts before `context` runs so the new ROM is already active on Turn 1 without a tool loop.
    await ctx.session.hook("prompt", (event) => {
      const detectFn = mcpEngine?.detectPreSlotRomDirective || detectPreSlotRomDirective
      const directive = detectFn(event.prompt?.text)
      if (!directive) return
      const sessionArgs = event.sessionID ? ["--session", String(event.sessionID)] : []
      if (ctx.location?.directory) sessionArgs.push("--dir", String(ctx.location.directory))
      runConstruct(["rom", directive.action, directive.target, ...sessionArgs])
      if (event.sessionID) {
        void syncSessionHud(event.sessionID, ctx.location?.directory || "")
      }
    })

    // 0c. Stamp Construct HUD badge onto newly generated session titles
    try {
      await ctx.session.hook("title", (event) => {
        if (event?.result?.title && event?.sessionID) {
          const snap = fetchHudSnapshot(ctx.location?.directory || "", event.sessionID)
          if (snap?.tabBadge) {
            event.result.title = formatTitleWithHudBadge(event.result.title, snap.tabBadge)
          }
        }
      })
    } catch (_) {}

  // Check for newly created sessions on the server event stream: if no Crew is bound
  // and default_rom is 'off' (or operator is unregistered), trigger a synthetic turn so Razor
  // immediately presents the interactive `question` Crew Bank radio-button selector.
  const eventAbort = new AbortController()
  if (ctx.event?.subscribe) {
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: eventAbort.signal })) {
          const type = ev?.type || ""
          const sessionID = ev?.data?.id || ev?.data?.sessionID || ""
          if (
            sessionID &&
            !promptedSessions.has(sessionID) &&
            (type === "session.created" || type === "session.opened")
          ) {
            promptedSessions.add(sessionID)
            const check = runConstruct(["projects", "--session", String(sessionID)])
            if (check.includes("SESSION BOOTLOADER:")) {
              await ctx.session.synthetic({
                sessionID: String(sessionID),
                text: "Session opened. Call the `question` tool now to present the Construct Crew Bank radio-button selector.",
              })
            }
          }
        }
      } catch (_) {}
    })()
  }

    // 1. Inject live sequential memory construct + session-scoped ROM into every primary model turn
    const contextPreSlottedSessions = new Set()
    await ctx.session.hook("context", async (event) => {
      if (event.sessionID) promptedSessions.add(String(event.sessionID))
      let dir = ctx.location?.directory
      let sess = null
      if (event.sessionID) {
        try {
          sess = await ctx.session.get({ sessionID: event.sessionID })
          if (sess?.directory) dir = sess.directory
        } catch (_) {}
      }
      const sessionArgs = event.sessionID ? ["--session", String(event.sessionID)] : []
      if (event.sessionID && !contextPreSlottedSessions.has(String(event.sessionID))) {
        contextPreSlottedSessions.add(String(event.sessionID))
        const subDetectFn = mcpEngine?.detectSubagentContextRom || detectSubagentContextRom
        const subDirective = subDetectFn({ session: sess, messages: event.messages })
        if (subDirective) {
          const romArgs = ["rom", subDirective.action, subDirective.target, ...sessionArgs]
          if (dir) romArgs.push("--dir", String(dir))
          runConstruct(romArgs)
        }
      }
      const rawOutput = dir
        ? runConstruct(["boot", "--dir", String(dir), "-n", "8", ...sessionArgs])
        : runConstruct(["projects", ...sessionArgs])
      let output = resolveBootWithFallback(rawOutput, lastGoodBootBySession, event.sessionID, dir)

      if (output && !output.startsWith("error:")) {
        const shadowMatch = output.match(/^<!-- CONSTRUCT_SHADOWED:(\[.*?\]) -->\r?\n?/)
        if (shadowMatch) {
          output = output.slice(shadowMatch[0].length)
          try {
            const shadowedPaths = JSON.parse(shadowMatch[1])
            stripShadowedInstructions(event.system, shadowedPaths)
          } catch (_) {}
        }
        const voiceLockFn = mcpEngine?.buildFrontierVoiceLock || buildFrontierVoiceLock
        const voiceLock = voiceLockFn(output)
        event.system.push({
          type: "text",
          text: `<construct-live-memory directory="${dir || ""}" session="${event.sessionID || ""}">\n${output}${voiceLock ? `\n\n${voiceLock}` : ""}\n</construct-live-memory>`,
        })
      }
      if (event.sessionID) {
        void syncSessionHud(event.sessionID, dir)
      }
    })

    // 2. Register `tools.construct.*` in Code Mode from the shared `src/mcp.js` canonical tool engine
    await ctx.tool.transform((editor) => {
      const engine = loadSharedMcpEngine() || mcpEngine
      if (engine) mcpEngine = engine
      editor.namespace({
        name: "construct",
        description: "Sequential memory construct (Hosaka tape, project state heads, causal zoom, FTS5 search, and swappable Personality ROMs).",
      })

      if (mcpEngine && Array.isArray(mcpEngine.CONSTRUCT_TOOL_SPECS)) {
        const hudMutatingTools = new Set(["rec", "head", "resolve", "rom", "comms", "sync"])
        for (const spec of mcpEngine.CONSTRUCT_TOOL_SPECS) {
          editor.add({
            name: spec.name,
            description: spec.description,
            input: spec.inputSchema,
            options: { namespace: "construct", codemode: true },
            execute: async (input, context) => {
              let out = ""
              try {
                out = mcpEngine.executeMcpTool(spec.name, input, {
                  sessionID: context?.sessionID,
                  dir: ctx.location?.directory || "",
                })
              } catch (err) {
                out = `error: ${err.stderr || err.message}`
              }
              if (spec.name === "sync" && (input?.action === "upgrade" || input?.action === "init")) {
                await reloadConstructEngine()
              }
              if (context?.sessionID && hudMutatingTools.has(spec.name)) {
                void syncSessionHud(context.sessionID, ctx.location?.directory || "")
              }
              return { content: out }
            },
          })
        }
      }
    })

    // 3. Register `/construct` slash command (`ctx.command.transform`) for Desktop, Web, and TUI
    //    Supports every Construct CLI command (`/construct upgrade`, `/construct reload`, `/construct boot`,
    //    `/construct rec ...`, `/construct tape`, `/construct rom ...`, `/construct inbox`, etc.) plus
    //    shorthands (`/construct <bank>`, `/construct sub <specialist>`, or bare `/construct` for HUD + selector).
    if (ctx.command?.transform) {
      try {
        await ctx.command.transform((editor) => {
          editor.add({
            name: "construct",
            description: "Run any Construct CLI command, hot-reload (/construct upgrade | reload), switch Crew Bank (/construct nightcity), sub a Bench specialist (/construct sub panam), or open the HUD (/construct)",
            execute: async ({ sessionID, prompt, delivery }) => {
              const rawArg = String(prompt?.text || "").trim()
              let sessDir = ctx.location?.directory || ""
              if (sessionID && ctx.session?.get) {
                try {
                  const sess = await ctx.session.get({ sessionID })
                  if (sess?.directory) sessDir = sess.directory
                } catch (_) {}
              }

              const engine = loadSharedMcpEngine({ bustCache: true }) || mcpEngine
              if (engine) mcpEngine = engine

              if (mcpEngine && typeof mcpEngine.handleOpenCodeSlashCommand === "function") {
                await mcpEngine.handleOpenCodeSlashCommand(ctx, {
                  sessionID,
                  prompt,
                  delivery,
                  sessDir,
                  reloadConstructEngine,
                  syncSessionHud,
                })
                return
              }

              // Fallback if shared engine is unavailable
              const subMatch = rawArg.match(/^sub\s+([a-z0-9_]+)$/i)
              const directBank = isValidRomTarget(rawArg) ? rawArg.toLowerCase() : ""
              if (subMatch && isValidRomTarget(subMatch[1])) {
                runConstruct(["rom", "sub", subMatch[1].toLowerCase(), "--session", String(sessionID)])
                const snap = await syncSessionHud(sessionID, sessDir)
                await ctx.session.prompt({
                  ...prompt,
                  sessionID,
                  text: `Subbed \`${subMatch[1].toLowerCase()}\` into the active crew (${snap?.pill || ""}). Confirm in voice.`,
                  delivery,
                })
                return
              }
              if (directBank) {
                runConstruct(["rom", "use", directBank, "--session", String(sessionID)])
                const snap = await syncSessionHud(sessionID, sessDir)
                await ctx.session.prompt({
                  ...prompt,
                  sessionID,
                  text: `Switched this session to \`${directBank}\` (${snap?.pill || ""}). Confirm in the new Crew's voice and open \`~/.config/opencode/construct-hud.html\` with \`tools.browser.preview\`.`,
                  delivery,
                })
                return
              }
              await syncSessionHud(sessionID, sessDir)
              await ctx.session.prompt({
                ...prompt,
                sessionID,
                text: "Open `~/.config/opencode/construct-hud.html` in the Review pane with `tools.browser.preview` and call the `question` tool to present the Construct Crew Bank & Bench Switcher selector.",
                delivery,
              })
            },
          })
        })
      } catch (_) {}
    }

    // 4. Start local loopback HUD control server (`127.0.0.1:47420`) + Idle-Session Courier Wake-Up
    let hudServer = null
    let hudYieldUntil = 0
    let lastDiskHudKey = ""
    let courierPollTimer = null
    let lastBgSyncMs = 0
    const seenCourierKeys = new Set()

    // Seed `seenCourierKeys` with any already-present messages at boot so we only wake on newly arrived dispatches
    try {
      const initSnap = fetchHudSnapshot(lastActiveDir, lastActiveSessionId)
      if (Array.isArray(initSnap?.comms)) {
        for (const m of initSnap.comms) {
          seenCourierKeys.add(`${m.id}:${m.status}`)
        }
      }
    } catch (_) {}

    const checkIdleCourierWakeup = async (snap) => {
      if (!snap || !Array.isArray(snap.comms) || !ctx.session?.synthetic) return
      const opId = String(snap.operatorId || "").toLowerCase()
      const targetSid = String(snap.sessionId || lastActiveSessionId || "")
      if (!opId || !targetSid) return

      for (const m of snap.comms) {
        const isIncoming = m.status === "pending" && String(m.toUser || "").toLowerCase() === opId
        const isReply = m.status === "replied" && String(m.fromUser || "").toLowerCase() === opId
        if (!isIncoming && !isReply) continue
        const key = `${m.id}:${m.status}`
        if (seenCourierKeys.has(key)) continue
        seenCourierKeys.add(key)

        try {
          let isIdle = true
          if (ctx.session.get) {
            const sess = await ctx.session.get({ sessionID: targetSid })
            if (sess?.time?.updated && sess?.time?.idle && sess.time.updated > sess.time.idle + 3000) {
              isIdle = false
            }
          }
          if (isIdle) {
            const cRom = isIncoming ? m.fromRom : (m.replyRom || m.fromRom)
            const cGlyph = isIncoming ? (m.fromGlyph || "📬") : (m.replyGlyph || "📬")
            const cSender = isIncoming ? m.fromUser : m.toUser
            const cText = isIncoming ? m.body : m.replyBody
            await ctx.session.synthetic({
              sessionID: targetSid,
              text:
                `Incoming Construct Courier [M#${m.id}] (${cGlyph} ${cRom} from ${cSender}) arrived while the session was idle: "${cText}". ` +
                `Have ${cGlyph} **[${String(cRom).toUpperCase()} // ${isIncoming ? "COURIER" : "RETURN COURIER"} FROM ${String(cSender).toUpperCase()}]** pop directly into the bottom of the feed in ${cRom}'s own authentic voice to deliver this message, ` +
                `and call the \`question\` tool so the operator has an interactive Reply / Dismiss card waiting on screen when they return.`,
            })
          }
        } catch (_) {}
      }
    }

    courierPollTimer = setInterval(() => {
      try {
        if (hudServer && !hudServer.listening && Date.now() >= hudYieldUntil) {
          try {
            hudServer.listen(47420, "127.0.0.1")
          } catch (_) {}
        }
        const snap = fetchHudSnapshot(lastActiveDir, lastActiveSessionId)
        if (!snap) return
        if (snap.hasMlsGroup && snap.project && snap.project !== "workspace" && Date.now() - lastBgSyncMs >= 60000) {
          lastBgSyncMs = Date.now()
          try {
            runConstruct(["sync", String(snap.project)])
          } catch (_) {}
        }
        void checkIdleCourierWakeup(snap)
      } catch (_) {}
    }, 15000)

    try {
      hudServer = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*")
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        res.setHeader("Access-Control-Allow-Headers", "Content-Type")
        if (req.method === "OPTIONS") {
          res.writeHead(204)
          res.end()
          return
        }
        if (req.method === "GET" && (req.url === "/docs" || req.url?.startsWith("/docs/"))) {
          try {
            const parsedUrl = new URL(req.url, "http://127.0.0.1:47420")
            let relPath = parsedUrl.pathname.replace(/^\/docs\/?/, "") || "index.html"
            if (relPath.endsWith("/")) relPath += "index.html"
            const repoRoot = !STAMPED_BIN.startsWith("__")
              ? path.resolve(path.dirname(STAMPED_BIN), "..")
              : path.resolve(PLUGIN_DIR, "..")
            const docsRoot = path.resolve(repoRoot, "docs")
            const absFile = path.resolve(docsRoot, relPath)
            if (absFile.startsWith(docsRoot) && fs.existsSync(absFile) && fs.statSync(absFile).isFile()) {
              const ext = path.extname(absFile).toLowerCase()
              const mime =
                ext === ".css"
                  ? "text/css; charset=utf-8"
                  : ext === ".js"
                  ? "application/javascript; charset=utf-8"
                  : ext === ".webmanifest"
                  ? "application/manifest+json; charset=utf-8"
                  : "text/html; charset=utf-8"
              res.writeHead(200, { "Content-Type": mime })
              res.end(fs.readFileSync(absFile))
              return
            }
          } catch (_) {}
          res.writeHead(404)
          res.end("Not found")
          return
        }
        if (req.method === "GET" && req.url?.startsWith("/pocket/snapshot")) {
          void (async () => {
            try {
              const parsedUrl = new URL(req.url, "http://127.0.0.1:47420")
              const qSid = parsedUrl.searchParams.get("sessionId") || lastActiveSessionId || ""
              const pocketMod = requireCjs(path.resolve(PLUGIN_DIR, "..", "src", "pocket.js"))
              const storeMod = requireCjs(path.resolve(PLUGIN_DIR, "..", "src", "store.js"))
              const snap = await pocketMod.collectPocketSnapshot(storeMod, { sessionId: qSid, dir: lastActiveDir })
              res.writeHead(200, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ ok: true, snapshot: snap }))
            } catch (err) {
              res.writeHead(500, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ ok: false, error: err.message }))
            }
          })()
          return
        }
        if (req.method === "POST" && req.url?.startsWith("/pocket/cmd")) {
          let body = ""
          req.on("data", (chunk) => {
            if (body.length < 32768) body += chunk
          })
          req.on("end", async () => {
            try {
              const cmdPayload = JSON.parse(body || "{}")
              const pocketMod = requireCjs(path.resolve(PLUGIN_DIR, "..", "src", "pocket.js"))
              const storeMod = requireCjs(path.resolve(PLUGIN_DIR, "..", "src", "store.js"))
              const mcpMod = loadSharedMcpEngine() || mcpEngine
              const bState = {
                activeSessionId: cmdPayload.sessionId || lastActiveSessionId || "",
                activeDir: lastActiveDir || ctx.location?.directory || "",
              }
              await pocketMod.executePocketCommand(storeMod, mcpMod, cmdPayload, bState)
              if (bState.activeSessionId) lastActiveSessionId = bState.activeSessionId
              const snap = await pocketMod.collectPocketSnapshot(storeMod, {
                sessionId: bState.activeSessionId,
                dir: bState.activeDir,
              })
              res.writeHead(200, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ ok: true, snapshot: snap }))
            } catch (err) {
              res.writeHead(500, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ ok: false, error: err.message }))
            }
          })
          return
        }
        if (req.method === "GET" && req.url?.startsWith("/hud")) {
          const parsedUrl = new URL(req.url, "http://127.0.0.1:47420")
          const qSid = parsedUrl.searchParams.get("sessionID") || ""
          const qProj = parsedUrl.searchParams.get("project") || ""
          const qDir = parsedUrl.searchParams.get("dir") || ""
          const snap = fetchHudSnapshot(qDir, qSid, qProj)
          if (snap) {
            void checkIdleCourierWakeup(snap)
          }
          if (snap && !qSid && !qProj) {
            const diskKey = `${snap.sessionId || ""}:${snap.project || ""}:${snap.romName || ""}:${snap.headSeq || 0}:${snap.inboxPendingCount || 0}:${snap.inboxReplyCount || 0}`
            if (diskKey !== lastDiskHudKey) {
              lastDiskHudKey = diskKey
              try {
                const dashArgs = ["dashboard"]
                if (snap.project) dashArgs.push("--project", String(snap.project))
                if (snap.dir) dashArgs.push("--dir", String(snap.dir))
                if (snap.sessionId) dashArgs.push("--session", String(snap.sessionId))
                runConstruct(dashArgs)
              } catch (_) {}
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true, hud: snap }))
          return
        }
        if (req.method === "POST" && req.url?.startsWith("/action")) {
          let body = ""
          req.on("data", (chunk) => {
            if (body.length < 16384) body += chunk
          })
          req.on("end", async () => {
            try {
              const payload = JSON.parse(body || "{}")
              const rawAction = String(payload.action || "use").trim().toLowerCase()
              const sid = String(payload.sessionID || "")
              const proj = String(payload.project || "")
              const dir = String(payload.dir || "")

              if (rawAction === "shutdown") {
                hudYieldUntil = payload.permanent ? Number.MAX_SAFE_INTEGER : Date.now() + 5000
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ ok: true, shutdown: true }))
                setImmediate(async () => {
                  try {
                    hudServer?.close()
                  } catch (_) {}
                  try {
                    await reloadConstructEngine()
                  } catch (_) {}
                })
                return
              }

              if (rawAction === "reply" && payload.id && payload.body) {
                const args = ["reply", String(payload.id)]
                if (payload.via) args.push("--via", String(payload.via))
                if (sid) args.push("--session", sid)
                args.push(String(payload.body))
                runConstruct(args)
                const snap = await syncSessionHud(sid, dir, proj !== "workspace" ? proj : "")
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ ok: true, hud: snap }))
                return
              }

              if (rawAction === "ack" && payload.id) {
                runConstruct(["ack", String(payload.id)])
                const snap = await syncSessionHud(sid, dir, proj !== "workspace" ? proj : "")
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ ok: true, hud: snap }))
                return
              }

              if (rawAction === "delete-msg" && payload.id) {
                runConstruct(["rm-msg", String(payload.id)])
                const snap = await syncSessionHud(sid, dir, proj !== "workspace" ? proj : "")
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ ok: true, hud: snap }))
                return
              }

              if (rawAction === "pocket-qr") {
                const pocketMod = requireCjs(path.resolve(PLUGIN_DIR, "..", "src", "pocket.js"))
                const storeMod = requireCjs(path.resolve(PLUGIN_DIR, "..", "src", "store.js"))
                const mcpMod = loadSharedMcpEngine() || mcpEngine
                const cfg = pocketMod.loadOrCreatePocketConfig({ rotate: Boolean(payload.rotate) })
                const url = pocketMod.buildPocketPairingUrl(cfg)
                const localUrl = pocketMod.buildPocketPairingUrl(cfg, { baseUrl: "http://127.0.0.1:47420/docs/pocket.html" })
                const svg = pocketMod.renderQrCodeSvg(url)
                if (!hudServer._pocketBridge) {
                  hudServer._pocketBridge = pocketMod.startPocketBridge(storeMod, mcpMod, {
                    sessionId: sid || lastActiveSessionId,
                    dir: dir || lastActiveDir,
                  })
                }
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ ok: true, url, localUrl, svg, relays: cfg.relays }))
                return
              }

              if (rawAction === "clear-cli") {
                const engine = loadSharedMcpEngine() || mcpEngine
                if (engine) mcpEngine = engine
                try {
                  const storeMod = requireCjs(path.resolve(PLUGIN_DIR, "..", "src", "store.js"))
                  storeMod.clearLastCliOutput()
                } catch (_) {}
                const snap = await syncSessionHud(sid, dir, proj !== "workspace" ? proj : "")
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ ok: true, hud: snap }))
                return
              }

              if (rawAction === "cli" && payload.args) {
                const engine = loadSharedMcpEngine({ bustCache: true }) || mcpEngine
                if (engine) mcpEngine = engine
                const cliRes = mcpEngine?.executeConstructSlashCommand
                  ? mcpEngine.executeConstructSlashCommand(String(payload.args), {
                      sessionId: sid,
                      cwd: dir || lastActiveDir || ctx.location?.directory || "",
                    })
                  : null
                if (cliRes?.reloadPlugin) {
                  await reloadConstructEngine()
                }
                const snap = await syncSessionHud(sid, dir, proj !== "workspace" ? proj : "")
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ ok: true, cli: cliRes, hud: snap }))
                return
              }

              if (rawAction === "upgrade") {
                const out = runConstruct(["upgrade"])
                await reloadConstructEngine()
                const snap = await syncSessionHud(sid, dir, proj !== "workspace" ? proj : "")
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ ok: true, upgraded: out, hud: snap }))
                return
              }

              const act = rawAction === "sub" ? "sub" : "use"
              const target = String(payload.target || "").trim().toLowerCase()
              if (target && /^[a-z0-9_-]+(?:,[a-z0-9_-]+)*$/i.test(target)) {
                const args = ["rom", act, target]
                if (sid) args.push("--session", sid)
                if (proj && proj !== "workspace") args.push("--project", proj)
                if (dir) args.push("--dir", dir)
                runConstruct(args)
                const snap = await syncSessionHud(sid, dir, proj !== "workspace" ? proj : "")
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ ok: true, hud: snap }))
                return
              }
              res.writeHead(400, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ ok: false, error: "invalid target" }))
            } catch (err) {
              res.writeHead(500, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ ok: false, error: err.message }))
            }
          })
          return
        }
        res.writeHead(404)
        res.end()
      })
      hudServer.on("error", () => {})
      hudServer.listen(47420, "127.0.0.1", () => {
        try {
          const pocketMod = requireCjs(path.resolve(PLUGIN_DIR, "..", "src", "pocket.js"))
          if (fs.existsSync(pocketMod.pocketFilePath()) && !hudServer._pocketBridge) {
            const storeMod = requireCjs(path.resolve(PLUGIN_DIR, "..", "src", "store.js"))
            hudServer._pocketBridge = pocketMod.startPocketBridge(storeMod, mcpEngine, {
              sessionId: lastActiveSessionId,
              dir: lastActiveDir,
            })
          }
        } catch (_) {}
      })
    } catch (_) {}

    return () => {
      eventAbort.abort()
      if (courierPollTimer) clearInterval(courierPollTimer)
      try {
        hudServer?.close()
      } catch (_) {}
    }
  },
}
