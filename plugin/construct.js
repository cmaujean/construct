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

export function validateShellCommand(command) {
  const cmd = String(command || "")
  // 1. Block heredocs (`<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`), which fail unpredictably in non-interactive shells
  if (/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(cmd)) {
    throw new Error(
      "Construct Shell Guard (Gotcha #1): Heredocs (<<EOF) fail unpredictably in non-interactive shells. Use the Write/Edit tools for files, or write multi-line scripts/commit messages to a scratchpad file first."
    )
  }
  // 2. Block disabling Git's NTFS path protection guard (`core.protectNTFS=false`)
  if (/core\.protectntfs\s*(?:=|\s+)\s*(?:false|0|no)\b/i.test(cmd)) {
    throw new Error(
      "Construct Shell Guard (Gotcha #6): Never disable core.protectNTFS. It is a safety guard; remove the offending path instead of silencing the check."
    )
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

export default {
  id: "construct",
  async setup(ctx) {
    const promptedSessions = new Set()

    // 0a. Pre-execution Shell Guard: block known shell traps in 0 tokens before spawning a process
    if (ctx.shell?.hook) {
      await ctx.shell.hook("create.before", (event) => {
        validateShellCommand(event.command)
      })
    }

    // 0. Watch for newly created sessions on the server event stream: if no ROM is slotted
    //    and no default_rom is set, trigger a synthetic turn so Razor immediately presents
    //    the interactive `question` radio-button array before the user types a prompt.
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
              if (check.includes("SESSION BOOTLOADER: NO ROM SLOTTED FOR THIS SESSION YET")) {
                await ctx.session.synthetic({
                  sessionID: String(sessionID),
                  text: "Session opened. Call the `question` tool now to present the Construct Personality ROM radio-button selector.",
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
      let output = dir
        ? runConstruct(["boot", "--dir", String(dir), "-n", "15", ...sessionArgs])
        : runConstruct(["projects", ...sessionArgs])

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
        execute: async (input) => {
          const args = ["rec", String(input.project), String(input.kind), String(input.summary)]
          if (input.detail) args.push("--detail", String(input.detail))
          if (input.verified) args.push("--verified", String(input.verified))
          if (input.parent) args.push("--parent", String(input.parent))
          if (input.resolves) args.push("--resolves", String(input.resolves))
          if (input.open) args.push("--open")
          if (input.refs) args.push("--refs", String(input.refs))
          return { content: runConstruct(args) }
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
        execute: async (input) => {
          const args = ["head", String(input.project), "--state", String(input.state)]
          if (input.next !== undefined) args.push("--next", String(input.next))
          if (input.repo !== undefined) args.push("--repo", String(input.repo))
          return { content: runConstruct(args) }
        },
      })

      editor.add({
        name: "resolve",
        description: "Resolve one or more open thread frames by seq ID.",
        input: {
          type: "object",
          properties: {
            seqs: { type: "string", description: "Comma-separated frame seq IDs to resolve, e.g. '28,29'" },
            by: { type: "integer", description: "Existing frame seq that resolved them" },
            reason: { type: "string", description: "If given without `by`, records a new resolution frame with this summary" },
            verified: { type: "string" },
          },
          required: ["seqs"],
          additionalProperties: false,
        },
        options: { namespace: "construct", codemode: true },
        execute: async (input) => {
          const args = ["resolve", String(input.seqs)]
          if (input.by) args.push("--by", String(input.by))
          if (input.reason) args.push("--reason", String(input.reason))
          if (input.verified) args.push("--verified", String(input.verified))
          return { content: runConstruct(args) }
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
        description: "FTS5 BM25 search across the sequential tape.",
        input: {
          type: "object",
          properties: {
            query: { type: "string" },
            project: { type: "string" },
            kind: { type: "string" },
            open: { type: "boolean" },
          },
          required: ["query"],
          additionalProperties: false,
        },
        options: { namespace: "construct", codemode: true },
        execute: async (input) => {
          const args = ["search", String(input.query)]
          if (input.project) args.push("--project", String(input.project))
          if (input.kind) args.push("--kind", String(input.kind))
          if (input.open) args.push("--open")
          return { content: runConstruct(args) }
        },
      })

      editor.add({
        name: "rom",
        description: "List, inspect, slot for this session (`use`), set/clear an until-further-notice default (`default`), tune, or burn directives into a Personality ROM.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["list", "show", "use", "default", "tune", "burn", "unburn", "sync"],
            },
            target: {
              type: "string",
              description: "ROM name (for show/use/default, or 'off' to clear default), dial=val pairs (for tune, e.g. 'edge=0.8 terse=0.9'), directive text (for burn), or 1-based index (for unburn)",
            },
            rom: { type: "string", description: "Optional ROM name when tuning or burning a non-active ROM" },
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
          if (context?.sessionID) args.push("--session", String(context.sessionID))
          return { content: runConstruct(args) }
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
          if (input.tags) args.push("--tags", String(input.tags))
          return { content: runConstruct(args) }
        },
      })

      editor.add({
        name: "comms",
        description: "Send, reply, acknowledge, or list Construct-to-Construct messages (e.g. Alice's Molly <-> Bob's Dixie).",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["msg", "reply", "ack", "inbox"],
            },
            project: { type: "string", description: "Project key, e.g. acme/alpha_app" },
            to: { type: "string", description: "Recipient operator id (for msg/inbox), e.g. bob" },
            id: { type: "integer", description: "Message id (for reply/ack)" },
            body: { type: "string", description: "Message or reply text" },
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
          const args = ["inbox"]
          if (input.project) args.push("--project", String(input.project))
          if (input.to) args.push("--to", String(input.to))
          return { content: runConstruct(args) }
        },
      })

      editor.add({
        name: "sync",
        description: "DIDComm v2 + MLS (RFC 9420) + HLC-CRDT group invite, join, live WebSocket relay sync, packet export/import, or instruction file assimilation.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["did", "invite", "join", "sync", "export", "import", "assimilate", "init"],
            },
            target: {
              type: "string",
              description: "Project key (for invite/sync/export), construct://invite/... URI (for join), construct://packet/... token (for import), or directory path (for assimilate)",
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

    return () => eventAbort.abort()
  },
}
