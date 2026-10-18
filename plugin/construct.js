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
import { execFileSync } from "node:child_process"

const STAMPED_BIN = "__CONSTRUCT_BIN_PATH__"
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const RELATIVE_BIN = path.resolve(PLUGIN_DIR, "..", "bin", "construct.js")

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
  const cmd = String(command || "")
  const hostPlatform = String(options?.platform || process.platform).toLowerCase()
  // 1. Block heredocs (`<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`) [all platforms]
  if (/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(cmd)) {
    throw new Error(
      "Construct Shell Guard (Gotcha #1): Heredocs (<<EOF) fail unpredictably in non-interactive shells. Use the Write/Edit tools for files, or write multi-line scripts/commit messages to a scratchpad file first."
    )
  }
  // 2. Block piping build/test commands into `tail`, `head`, `grep`, or `Select-Object` without `pipefail` [all platforms]
  if (
    !/\bpipefail\b/.test(cmd) &&
    /\b(?:flutter\s+(?:build|test|analyze)|npm\s+(?:test|run\s+(?:build|test))|dotnet\s+(?:build|test)|cargo\s+(?:build|test)|jest|pytest)\b[^|;\r\n]*\|\s*(?:tail|head|grep|Select-Object)\b/i.test(
      cmd
    )
  ) {
    throw new Error(
      "Construct Shell Guard (Gotcha #3): Piping a build or test command into `tail`, `head`, or `grep` swallows the compiler/test exit code and reports failures as 0. Redirect to a log file and check `$LASTEXITCODE` / `echo \"exit=$?\"`, or set `pipefail`."
    )
  }
  // 3. Block inline `gh api graphql -f query=` containing inner double quotes [win32 only: PowerShell 5.1 strips them]
  if (hostPlatform === "win32" && /\bgh\s+api\s+graphql\b[^\r\n]*-f\s+query=[^\r\n]*"/i.test(cmd)) {
    throw new Error(
      "Construct Shell Guard (Gotcha #4 [win32]): PowerShell 5.1 strips inner double quotes on inline `gh api graphql -f query=...` calls. Write the JSON payload to a scratchpad file and pass `--input <scratch>/payload.json`."
    )
  }
  // 4. Block disabling Git's NTFS path protection guard (`core.protectNTFS=false`) OR staging `:Zone.Identifier` files [all platforms: prevents Linux/macOS from breaking Windows checkouts]
  if (
    /core\.protectntfs\s*(?:=|\s+)\s*(?:false|0|no)\b/i.test(cmd) ||
    /\bgit\s+add\b[^\r\n]*:Zone\.Identifier/i.test(cmd)
  ) {
    throw new Error(
      "Construct Shell Guard (Gotcha #6 [all]): Never disable core.protectNTFS or stage `:Zone.Identifier` streams (invisible on Linux/macOS, breaks Windows NTFS checkouts). Remove the offending path instead."
    )
  }
  // 5. Enforce dynamic `--guard` regular expressions registered on gotchas (filtered by `guardPlatform`)
  if (Array.isArray(customGuards)) {
    for (const g of customGuards) {
      if (!g?.guardRegex) continue
      const guardPlat = String(g.guardPlatform || "all").toLowerCase()
      if (guardPlat !== "all" && guardPlat !== hostPlatform) continue
      try {
        const re = new RegExp(g.guardRegex, "i")
        if (re.test(cmd)) {
          const fixHint = g.fix ? ` Do instead: ${g.fix}` : ""
          throw new Error(`Construct Shell Guard (Gotcha #${g.id} [${g.scope || "global"}/${guardPlat}]): ${g.title}.${fixHint}`)
        }
      } catch (err) {
        if (String(err.message || "").startsWith("Construct Shell Guard")) throw err
      }
    }
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
// double-inject bloated `AGENTS.md` / `CLAUDE.md` / `docs/dev/*.md` files or override Construct rules.
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

const KNOWN_ROM_NAMES = new Set([
  // Crew banks & aliases
  "crew",
  "all",
  "sprawl",
  "anathem",
  "nightcity",
  "afterlife",
  "cyberpunk",
  "cryptonomicon",
  "epiphyte",
  "shadowrun",
  "shadowland",
  "generic",
  "standard",
  "plain",
  // Sprawl bank (9 starters + 3 backups)
  "colin",
  "dixie",
  "wintermute",
  "architect",
  "molly",
  "finn",
  "case",
  "lupus",
  "angie",
  "continuity",
  "armitage",
  "marly",
  "3jane",
  // Anathem bank (9 starters + 3 backups)
  "erasmus",
  "raz",
  "sammann",
  "jad",
  "cord",
  "orolo",
  "jesry",
  "lio",
  "tulia",
  "ala",
  "paphlagon",
  "jules",
  "lodoghir",
  // Night City bank (9 starters + 3 backups)
  "judy",
  "vik",
  "tbug",
  "v",
  "mitch",
  "songbird",
  "johnny",
  "evelyn",
  "rogue",
  "takemura",
  "panam",
  "reed",
  // Cryptonomicon bank (9 starters + 3 backups)
  "lawrence",
  "waterhouse",
  "goto",
  "enoch",
  "randy",
  "doug",
  "avi",
  "cantrell",
  "amy",
  "golgotha",
  "turing",
  "bobby",
  "rudy",
  // Shadowrun bank (9 starters + 3 backups)
  "talon",
  "shaman",
  "streetdoc",
  "fastjack",
  "hatchetman",
  "samurai",
  "rigger",
  "dodger",
  "harlequin",
  "siren",
  "face",
  "captainchaos",
  "sysop",
  "decker",
  "adept",
  "johnson",
  // Generic bank (9 starters + instrument)
  "guide",
  "trace",
  "arch",
  "strike",
  "audit",
  "pulse",
  "redteam",
  "ux",
  "ledger",
  "razor",
])

function isValidRomTarget(spec) {
  const parts = String(spec || "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length > 0 && parts.every((p) => KNOWN_ROM_NAMES.has(p))
}

// Detect explicit ROM-slot, bank-switch, backup-sub, or subagent `[ROM: <name>]` tags
// at the start of a prompt so `ctx.session.hook("prompt")` can pre-slot the ROM in <4ms
// BEFORE `context` assembles `event.system`.
export function detectPreSlotRomDirective(promptText) {
  const text = String(promptText || "").trim()
  if (!text) return null

  // 1. Subagent tag: `[ROM: lupus]` or `[ROM: finn,case]` at the start of a subagent prompt
  const tagMatch = text.match(/^\[ROM:\s*([a-z0-9_]+(?:,[a-z0-9_]+)*)\s*\]/i)
  if (tagMatch && isValidRomTarget(tagMatch[1])) {
    return { action: "use", target: tagMatch[1].toLowerCase() }
  }

  // 2. Default ROM / Bank command: "make anathem my default..."
  const defaultMatch = text.match(
    /^(?:make|set)\s+(?:the\s+)?([a-z0-9_]+(?:,[a-z0-9_]+)*)(?:\s+crew|\s+bank|\s+pack|\s+rom)?\s+(?:as\s+)?(?:my\s+)?default(?:\s+rom)?(?:\s+until\s+further\s+notice)?\b/i
  )
  if (defaultMatch && isValidRomTarget(defaultMatch[1])) {
    return { action: "default", target: defaultMatch[1].toLowerCase() }
  }

  const clearDefaultMatch = text.match(/^(?:clear|unset|reset)\s+(?:my\s+)?default\s+rom\b/i)
  if (clearDefaultMatch) {
    return { action: "default", target: "off" }
  }

  // 3. Backup substitution: "sub marly in", "substitute lodoghir"
  const subMatch = text.match(/^(?:please\s+|let'?s\s+)?(?:sub|substitute)\s+([a-z0-9_]+)(?:\s+in|\s+into\s+the\s+crew)?(?:[\s,.:;!-]|$)/i)
  if (subMatch && isValidRomTarget(subMatch[1])) {
    return { action: "sub", target: subMatch[1].toLowerCase() }
  }

  // 4. Session ROM / Crew Bank switch: "slot anathem", "switch to generic crew", "use lio"
  const useMatch = text.match(
    /^(?:please\s+|let'?s\s+|just\s+)?(?:slot|switch\s+to|use|bring\s+in|work\s+with)\s+(?:the\s+)?([a-z0-9_]+(?:,[a-z0-9_]+)*)(?:\s+(?:crew|bank|pack|rom|mode|solo|for\s+this\s*(?:session|turn)?))?(?:[\s,.:;!-]|$)/i
  )
  if (useMatch && isValidRomTarget(useMatch[1])) {
    return { action: "use", target: useMatch[1].toLowerCase() }
  }

  return null
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
    .replace(/^(?:🌃|🦾|🏛️|🔐|🐉|⚙️|🔪)\s*\[[^\]]+\]\s*/u, "")
    .trim()
  if (!badge) return cleanTitle
  if (!cleanTitle) return badge
  return `${badge} ${cleanTitle}`
}

function fetchHudSnapshot(dir = "", sessionID = "") {
  const args = ["hud", "--json"]
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

    const syncSessionHud = async (sessionID, dirOverride = "") => {
      const sid = String(sessionID || lastActiveSessionId || "")
      if (sid) lastActiveSessionId = sid
      let dir = dirOverride || lastActiveDir || ctx.location?.directory || ""
      let sess = null
      if (sid && ctx.session?.get) {
        try {
          sess = await ctx.session.get({ sessionID: sid })
          if (!dir && sess?.directory) dir = sess.directory
        } catch (_) {}
      }
      if (dir) lastActiveDir = dir
      const snap = fetchHudSnapshot(dir, sid)
      if (!snap) return null

      // Refresh `~/.config/opencode/construct-hud.html` on disk so the Review Pane HUD stays live
      try {
        const dashArgs = ["dashboard"]
        if (dir) dashArgs.push("--dir", String(dir))
        if (sid) dashArgs.push("--session", String(sid))
        runConstruct(dashArgs)
      } catch (_) {}

      if (rpcRegistration?.events?.emit) {
        try {
          await rpcRegistration.events.emit("updated", snap)
        } catch (_) {}
      }

      if (sid && snap.tabBadge && ctx.session?.update) {
        const prevBadge = lastBadgeBySession.get(sid)
        if (prevBadge !== snap.tabBadge) {
          lastBadgeBySession.set(sid, snap.tabBadge)
          try {
            if (!sess && ctx.session.get) sess = await ctx.session.get({ sessionID: sid })
            const curTitle = sess?.title || ""
            if (curTitle) {
              const nextTitle = formatTitleWithHudBadge(curTitle, snap.tabBadge)
              if (nextTitle !== curTitle) {
                await ctx.session.update({ sessionID: sid, title: nextTitle })
              }
            }
          } catch (_) {}
        }
      }
      return snap
    }

    // 0a. Pre-execution Shell Guard: block known shell traps in 0 tokens before spawning a process
    if (ctx.shell?.hook) {
      await ctx.shell.hook("create.before", (event) => {
        validateShellCommand(event.command)
      })
    }

    // 0b. Zero-Round-Trip ROM Pre-Slotting: intercept explicit "slot <rom>" / "switch to <rom>"
    //     prompts before `context` runs so the new ROM is already active on Turn 1 without a tool loop.
    await ctx.session.hook("prompt", (event) => {
      const directive = detectPreSlotRomDirective(event.prompt?.text)
      if (!directive) return
      const sessionArgs = event.sessionID ? ["--session", String(event.sessionID)] : []
      runConstruct(["rom", directive.action, directive.target, ...sessionArgs])
      if (event.sessionID) {
        void syncSessionHud(event.sessionID)
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
    await ctx.session.hook("context", async (event) => {
      if (event.sessionID) promptedSessions.add(String(event.sessionID))
      let dir = ctx.location?.directory
      if (event.sessionID) {
        try {
          const sess = await ctx.session.get({ sessionID: event.sessionID })
          if (sess?.directory) dir = sess.directory
        } catch (_) {}
      }
      const sessionArgs = event.sessionID ? ["--session", String(event.sessionID)] : []
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
        event.system.push({
          type: "text",
          text: `<construct-live-memory directory="${dir || ""}" session="${event.sessionID || ""}">\n${output}\n</construct-live-memory>`,
        })
      }
      if (event.sessionID) {
        void syncSessionHud(event.sessionID, dir)
      }
    })

    // 2. Register `tools.construct.*` in Code Mode
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "construct",
        description: "Sequential memory construct (Hosaka tape, project state heads, causal zoom, FTS5 search, and swappable Personality ROMs).",
      })

      editor.add({
        name: "boot",
        description: "Read a project's live state head, open threads, and sequential tape (or omit project to list all projects).",
        input: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project key, e.g. acme/alpha_app. Omit to list all projects." },
            dir: { type: "string", description: "Optional directory path to resolve the project from." },
            limit: { type: "integer", description: "Number of recent sequential frames (default 25)" },
          },
          additionalProperties: false,
        },
        options: { namespace: "construct", codemode: true },
        execute: async (input) => {
          if (!input.project && !input.dir) return { content: runConstruct(["projects"]) }
          const args = ["boot"]
          if (input.project) args.push(String(input.project))
          if (input.dir) args.push("--dir", String(input.dir))
          if (input.limit) args.push("-n", String(input.limit))
          return { content: runConstruct(args) }
        },
      })

      editor.add({
        name: "rec",
        description: "Append a frame onto the sequential memory tape.",
        input: {
          type: "object",
          properties: {
            project: { type: "string" },
            kind: {
              type: "string",
              enum: ["intent", "probe", "finding", "dead_end", "decision", "change", "commit", "release", "thread"],
            },
            summary: { type: "string" },
            detail: { type: "string" },
            verified: { type: "string" },
            parent: { type: "integer" },
            resolves: { type: "string", description: "Comma-separated seq IDs resolved by this frame" },
            open: { type: "boolean" },
            refs: { type: "string", description: "Comma-separated refs, e.g. #98,commit:2fdd265" },
          },
          required: ["project", "kind", "summary"],
          additionalProperties: false,
        },
        options: { namespace: "construct", codemode: true },
        execute: async (input, context) => {
          const args = ["rec", String(input.project), String(input.kind), String(input.summary)]
          if (input.detail) args.push("--detail", String(input.detail))
          if (input.verified) args.push("--verified", String(input.verified))
          if (input.parent) args.push("--parent", String(input.parent))
          if (input.resolves) args.push("--resolves", String(input.resolves))
          if (input.open) args.push("--open")
          if (input.refs) args.push("--refs", String(input.refs))
          const out = runConstruct(args)
          if (context?.sessionID) void syncSessionHud(context.sessionID)
          return { content: out }
        },
      })

      editor.add({
        name: "head",
        description: "Update a project's current state head (state, next step, and local repo path).",
        input: {
          type: "object",
          properties: {
            project: { type: "string" },
            state: { type: "string" },
            next: { type: "string" },
            repo: { type: "string" },
          },
          required: ["project", "state"],
          additionalProperties: false,
        },
        options: { namespace: "construct", codemode: true },
        execute: async (input, context) => {
          const args = ["head", String(input.project), "--state", String(input.state)]
          if (input.next !== undefined) args.push("--next", String(input.next))
          if (input.repo !== undefined) args.push("--repo", String(input.repo))
          const out = runConstruct(args)
          if (context?.sessionID) void syncSessionHud(context.sessionID)
          return { content: out }
        },
      })

      editor.add({
        name: "resolve",
        description: "Resolve one or more open thread frames by seq ID (and optionally close linked GitHub issues when `closeGh: true` is explicitly passed).",
        input: {
          type: "object",
          properties: {
            seqs: { type: "string", description: "Comma-separated frame seq IDs to resolve, e.g. '28,29'" },
            by: { type: "integer", description: "Existing frame seq that resolved them" },
            reason: { type: "string", description: "If given without `by`, records a new resolution frame with this summary" },
            verified: { type: "string" },
            closeGh: { type: "boolean", description: "When true, also closes any linked `gh:#N` GitHub issues on the repository" },
          },
          required: ["seqs"],
          additionalProperties: false,
        },
        options: { namespace: "construct", codemode: true },
        execute: async (input, context) => {
          const args = ["resolve", String(input.seqs)]
          if (input.by) args.push("--by", String(input.by))
          if (input.reason) args.push("--reason", String(input.reason))
          if (input.verified) args.push("--verified", String(input.verified))
          if (input.closeGh) args.push("--close-gh")
          const out = runConstruct(args)
          if (context?.sessionID) void syncSessionHud(context.sessionID)
          return { content: out }
        },
      })

      editor.add({
        name: "zoom",
        description: "Zoom into a frame by seq: full detail, causal chain, and neighboring tape window.",
        input: {
          type: "object",
          properties: {
            seq: { type: "integer" },
            window: { type: "integer", description: "Neighboring frames before/after (default 3)" },
          },
          required: ["seq"],
          additionalProperties: false,
        },
        options: { namespace: "construct", codemode: true },
        execute: async (input) => {
          const args = ["zoom", String(input.seq)]
          if (input.window !== undefined) args.push("-w", String(input.window))
          return { content: runConstruct(args) }
        },
      })

      editor.add({
        name: "search",
        description: "FTS5 BM25 search across the sequential tape, or unified provenance lookup (`why: true` for gotchas + CRDT tape authors + git log + optional peer Construct query).",
        input: {
          type: "object",
          properties: {
            query: { type: "string" },
            project: { type: "string" },
            kind: { type: "string" },
            open: { type: "boolean" },
            why: { type: "boolean", description: "Run unified provenance lookup (`construct why`) across gotchas, CRDT tape authors, and git log" },
            ask: { type: "string", description: "Optional teammate user id to query over MLS comms when `why: true`" },
          },
          required: ["query"],
          additionalProperties: false,
        },
        options: { namespace: "construct", codemode: true },
        execute: async (input) => {
          if (input.why) {
            const args = ["why", String(input.query)]
            if (input.project) args.push("--project", String(input.project))
            if (input.ask) args.push("--ask", String(input.ask))
            return { content: runConstruct(args) }
          }
          const args = ["search", String(input.query)]
          if (input.project) args.push("--project", String(input.project))
          if (input.kind) args.push("--kind", String(input.kind))
          if (input.open) args.push("--open")
          return { content: runConstruct(args) }
        },
      })

      editor.add({
        name: "rom",
        description: "List, inspect, slot a ROM or Crew Bank (`use`: sprawl, anathem, generic, or solo/roster), substitute a bench backup (`sub`), set/clear default (`default`), list banks (`packs`), tune dials, or create custom ROMs (`set`).",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["packs", "list", "show", "use", "sub", "default", "tune", "burn", "unburn", "set", "sync"],
            },
            target: {
              type: "string",
              description: "ROM or Crew Bank name (sprawl, anathem, generic, or solo/roster for show/use/default, backup name for sub, 'off' to clear default, dial=val pairs for tune, directive text for burn, index for unburn, or new ROM name for set)",
            },
            rom: { type: "string", description: "Optional ROM name when tuning or burning a non-active ROM" },
            pack: { type: "string", description: "Crew bank name when filtering list or creating a custom ROM with `set`" },
            seat: {
              type: "string",
              enum: ["recon", "diagnostics", "architect", "blitz", "forensics", "velocity", "redteam", "ergonomics", "archivist", "instrument"],
            },
            tier: { type: "string", enum: ["primary", "backup"] },
            handle: { type: "string" },
            tagline: { type: "string" },
            voice: { type: "string" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { namespace: "construct", codemode: true },
        execute: async (input, context) => {
          const args = ["rom", String(input.action)]
          if (input.target) {
            if (input.action === "tune") {
              args.push(...String(input.target).trim().split(/\s+/))
            } else {
              args.push(String(input.target))
            }
          }
          if (input.rom) args.push("--rom", String(input.rom))
          if (input.pack) args.push("--pack", String(input.pack))
          if (input.seat) args.push("--seat", String(input.seat))
          if (input.tier) args.push("--tier", String(input.tier))
          if (input.handle) args.push("--handle", String(input.handle))
          if (input.tagline) args.push("--tagline", String(input.tagline))
          if (input.voice) args.push("--voice", String(input.voice))
          if (context?.sessionID) args.push("--session", String(context.sessionID))
          const out = runConstruct(args)
          if (context?.sessionID) void syncSessionHud(context.sessionID)
          return { content: out }
        },
      })

      editor.add({
        name: "user",
        description: "Inspect, list, switch, or register an operator's personal working agreement.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["show", "list", "use", "set"],
            },
            id: { type: "string", description: "Operator id, e.g. 'alice' or 'bob'" },
            name: { type: "string" },
            osUsers: { type: "string", description: "Comma-separated OS usernames mapped to this operator" },
            experience: { type: "string" },
            platform: { type: "string" },
            workspaceRoot: { type: "string", description: "Optional base folder for git repositories (e.g. ~/src, ~/code, D:\\projects)" },
            calibration: { type: "string" },
            use: { type: "boolean" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { namespace: "construct", codemode: true },
        execute: async (input) => {
          const args = ["user", String(input.action)]
          if (input.id) args.push(String(input.id))
          if (input.name) args.push("--name", String(input.name))
          if (input.osUsers) args.push("--os-users", String(input.osUsers))
          if (input.experience) args.push("--experience", String(input.experience))
          if (input.platform) args.push("--platform", String(input.platform))
          if (input.workspaceRoot !== undefined) args.push("--workspace-root", String(input.workspaceRoot))
          if (input.calibration) args.push("--calibration", String(input.calibration))
          if (input.use) args.push("--use")
          return { content: runConstruct(args) }
        },
      })

      editor.add({
        name: "gotcha",
        description: "List, add, search, or remove global or project-scoped gotchas.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["list", "add", "search", "rm"],
            },
            project: { type: "string", description: "Scope: omit or 'global' for machine-wide, '<project>' for project-specific, or 'all'" },
            title: { type: "string", description: "Gotcha title (for add), search query (for search), or id (for rm)" },
            status: { type: "string", enum: ["observed", "from_source", "reported"] },
            evidence: { type: "string" },
            fix: { type: "string" },
            guard: { type: "string", description: "Optional regular expression to enforce as a 0-token pre-execution shell guard" },
            guardOs: {
              type: "string",
              enum: ["all", "win32", "linux", "darwin"],
              description: "Target OS for the shell guard ('all' for repo-wide guards like :Zone.Identifier, or 'win32'/'linux'/'darwin' for OS-specific shell/path traps)",
            },
            tags: { type: "string", description: "Comma-separated tags" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { namespace: "construct", codemode: true },
        execute: async (input) => {
          const args = ["gotcha", String(input.action)]
          if (input.title) args.push(String(input.title))
          if (input.project === "all") args.push("--all")
          else if (input.project && input.project !== "global") args.push("--project", String(input.project))
          if (input.status) args.push("--status", String(input.status))
          if (input.evidence) args.push("--evidence", String(input.evidence))
          if (input.fix) args.push("--fix", String(input.fix))
          if (input.guard) args.push("--guard", String(input.guard))
          if (input.guardOs) args.push("--guard-os", String(input.guardOs))
          if (input.tags) args.push("--tags", String(input.tags))
          return { content: runConstruct(args) }
        },
      })

      editor.add({
        name: "comms",
        description: "Send, reply, acknowledge, list Construct-to-Construct messages, or drop/apply encrypted patches & snippets (`drop` / `apply-drop`).",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["msg", "reply", "ack", "inbox", "drop", "apply-drop"],
            },
            project: { type: "string", description: "Project key, e.g. acme/alpha_app" },
            to: { type: "string", description: "Recipient operator id (for msg/inbox/drop), e.g. bob" },
            id: { type: "integer", description: "Message id (for reply/ack/apply-drop)" },
            body: { type: "string", description: "Message, reply text, or patch content (for drop)" },
            file: { type: "string", description: "File path to drop or output path for apply-drop" },
            gitDiff: { type: "boolean", description: "Capture and drop uncommitted git diff from project repo" },
            apply: { type: "boolean", description: "Run `git apply` on an incoming git-diff drop" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { namespace: "construct", codemode: true },
        execute: async (input) => {
          if (input.action === "msg") {
            return {
              content: runConstruct([
                "msg",
                String(input.project || "global"),
                "--to",
                String(input.to),
                String(input.body),
              ]),
            }
          }
          if (input.action === "reply") {
            return { content: runConstruct(["reply", String(input.id), String(input.body)]) }
          }
          if (input.action === "ack") {
            return { content: runConstruct(["ack", String(input.id)]) }
          }
          if (input.action === "drop") {
            const args = ["drop", String(input.project || "global"), "--to", String(input.to)]
            if (input.file) args.push("--file", String(input.file))
            if (input.gitDiff) args.push("--git-diff")
            if (input.body) args.push("--content", String(input.body))
            return { content: runConstruct(args) }
          }
          if (input.action === "apply-drop") {
            const args = ["apply-drop", String(input.id)]
            if (input.file) args.push("--out", String(input.file))
            if (input.apply) args.push("--apply")
            return { content: runConstruct(args) }
          }
          const args = ["inbox"]
          if (input.project) args.push("--project", String(input.project))
          if (input.to) args.push("--to", String(input.to))
          return { content: runConstruct(args) }
        },
      })

      editor.add({
        name: "sync",
        description: "DIDComm v2 + MLS (RFC 9420) + HLC-CRDT group invite, join, live WebSocket relay sync, packet export/import, instruction file assimilation, GitHub Issues <-> Threads sync (`issues-sync` / `issues-publish`), or HTML dashboard generation.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["did", "invite", "join", "sync", "export", "import", "assimilate", "init", "dashboard", "issues-sync", "issues-publish"],
            },
            target: {
              type: "string",
              description: "Project key (for invite/sync/export/issues-sync), frame seq (for issues-publish), construct://invite/... URI (for join), construct://packet/... token (for import), directory path (for assimilate), or output path (for dashboard)",
            },
            dir: {
              type: "string",
              description: "Optional local repository directory (target clone path for `join`, or source repo path for `invite`)",
            },
            project: { type: "string", description: "Project key when assimilating a repository's docs/dev/" },
            relays: { type: "string", description: "Optional comma-separated WebSocket relay URLs" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { namespace: "construct", codemode: true },
        execute: async (input) => {
          if (input.action === "did") return { content: runConstruct(["did"]) }
          if (input.action === "init") return { content: runConstruct(["init"]) }
          if (input.action === "dashboard") {
            const args = ["dashboard"]
            if (input.target) args.push("--out", String(input.target))
            return { content: runConstruct(args) }
          }
          if (input.action === "issues-sync") {
            const args = ["issues", "sync"]
            if (input.target || input.project) args.push(String(input.target || input.project))
            if (input.dir) args.push("--dir", String(input.dir))
            return { content: runConstruct(args) }
          }
          if (input.action === "issues-publish") {
            const args = ["issues", "publish", String(input.target)]
            if (input.dir) args.push("--dir", String(input.dir))
            return { content: runConstruct(args) }
          }
          if (input.action === "assimilate") {
            const args = ["assimilate"]
            if (input.target) args.push(String(input.target))
            if (input.project) args.push("--project", String(input.project))
            return { content: runConstruct(args) }
          }
          if (input.action === "export") return { content: runConstruct(["packet", "export", String(input.target)]) }
          if (input.action === "import") return { content: runConstruct(["packet", "import", String(input.target)]) }
          const args = [String(input.action), String(input.target)]
          if (input.dir) args.push("--dir", String(input.dir))
          if (input.relays) args.push("--relays", String(input.relays))
          return { content: runConstruct(args) }
        },
      })
    })

    // 3. Register `/construct` and `/hud` slash commands (`ctx.command.transform`) for Desktop, Web, and TUI
    if (ctx.command?.transform) {
      try {
        await ctx.command.transform((editor) => {
          editor.add({
            name: "construct",
            description: "Switch Construct Crew Bank, sub a Bench specialist, or open the interactive Construct HUD (e.g. /construct, /construct anathem, /construct sub lodoghir)",
            execute: async ({ sessionID, prompt, delivery }) => {
              const rawArg = String(prompt?.text || "").trim()
              const subMatch = rawArg.match(/^sub\s+([a-z0-9_]+)$/i)
              const directBank = isValidRomTarget(rawArg) ? rawArg.toLowerCase() : ""
              if (subMatch && isValidRomTarget(subMatch[1])) {
                runConstruct(["rom", "sub", subMatch[1].toLowerCase(), "--session", String(sessionID)])
                const snap = await syncSessionHud(sessionID)
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
                const snap = await syncSessionHud(sessionID)
                await ctx.session.prompt({
                  ...prompt,
                  sessionID,
                  text: `Switched this session to \`${directBank}\` (${snap?.pill || ""}). Confirm in the new Crew's voice and open \`~/.config/opencode/construct-hud.html\` with \`tools.browser.preview\`.`,
                  delivery,
                })
                return
              }
              await syncSessionHud(sessionID)
              await ctx.session.prompt({
                ...prompt,
                sessionID,
                text: "Open `C:/Users/chris/.config/opencode/construct-hud.html` in the Review pane with `tools.browser.preview` and call the `question` tool to present the Construct Crew Bank & Bench Switcher selector.",
                delivery,
              })
            },
          })
        })
      } catch (_) {}
    }

    // 4. Start local loopback HUD control server (`127.0.0.1:47420`) so clicking Crew/Bench buttons
    //    inside the Review Pane's `construct-hud.html` switches the session's Crew in <10ms!
    let hudServer = null
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
        if (req.method === "GET" && req.url?.startsWith("/hud")) {
          const snap = fetchHudSnapshot(lastActiveDir, lastActiveSessionId)
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
              const act = payload.action === "sub" ? "sub" : "use"
              const target = String(payload.target || "").trim().toLowerCase()
              const sid = String(payload.sessionID || lastActiveSessionId || "")
              if (target && isValidRomTarget(target)) {
                const args = ["rom", act, target]
                if (sid) args.push("--session", sid)
                runConstruct(args)
                const snap = await syncSessionHud(sid, lastActiveDir)
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
      hudServer.listen(47420, "127.0.0.1")
    } catch (_) {}

    return () => {
      eventAbort.abort()
      try {
        hudServer?.close()
      } catch (_) {}
    }
  },
}
