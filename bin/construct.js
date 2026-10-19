#!/usr/bin/env node
// Command-line access to the construct: sequential memory tape, project heads,
// swappable Personality ROMs, operator agreements, and machine/project gotchas.

'use strict';

const { parseArgs } = require('node:util');
const fs = require('node:fs');
const store = require('../src/store');
const mcp = require('../src/mcp');

const USAGE = `usage: construct <command> [args]

Setup & Instruction Assimilation:
  init [--rom <name>] [--claude] [--json]
                              One-command setup for OpenCode (and Claude Code with --claude):
                              generates DID identity, installs the OpenCode V2 plugin, wires
                              active-rom.md (and ~/.claude/CLAUDE.md + MCP/hooks when --claude),
                              and assimilates any existing global instruction files.
  mcp                         Run Construct as a stdio JSON-RPC 2.0 MCP server (exposes all 11
                              construct_* tools to Claude Code, Cursor, Windsurf, Zed, etc.).
  claude-hook [context | pre-tool | subagent-start]
                              Claude Code hook handler for SessionStart/UserPromptSubmit,
                              SubagentStart (specialist ROM + live memory injection), and
                              PreToolUse (Bash/PowerShell shell guard + Agent [ROM: x] routing).
  assimilate [<dir>] [--project <proj>] [--remove-files] [--json]
                              Scan a directory for existing AI instruction files (AGENTS.md,
                              CLAUDE.md, GEMINI.md, .cursorrules) and import agreements,
                              gotchas, and script commands into construct.db (never writes files
                              into the project repo).

Sequential Tape & Project Continuity:
  boot <project> [-n <tape_len>] [--json]
                              Boot briefing for <project>: slotted ROM, active operator,
                              current state head, open threads, and recent sequential tape.
  rec <project> <kind> "<summary>" [--detail <text>] [--verified <text>]
      [--parent <seq>] [--resolves <seq,seq>] [--open] [--refs <a,b>] [--ts <iso>] [--json]
                              Append a frame onto the sequential tape.
                              Kinds: ${store.KINDS.join(', ')}.
  head <project> [--state <text>] [--next <text>] [--repo <path>] [--ts <iso>] [--json]
                              Update or inspect a project's current state head.
  resolve <seq[,seq]> [--by <seq>] [--reason "<text>"] [--verified <text>] [--kind <kind>]
                              Close open thread(s).
  reopen <seq>                Reopen a previously resolved frame.
  tape [<project>] [-n <limit>] [--kind <kind>] [--open] [--from <seq>] [--to <seq>] [--since <iso>] [--json]
                              Sequential playback of the tape (oldest -> newest within window).
  zoom <seq> [-w <window>] [--json]
                              Inspect frame #<seq> in full detail, its causal chain, and neighbors.
  search "<query>" [--project <project>] [--kind <kind>] [--open] [-n <limit>] [--json]
                              FTS5 BM25 search across the tape; prints #seq pointers for zoom.
  edit <seq> [--summary ..] [--detail ..] [--verified ..] [--kind ..] [--parent ..] [--refs ..]
                              Correct an existing frame out loud.
  projects [--json]           List all projects in the construct with open counts and last seq.

Swappable & Tunable Personality ROMs & Crew Banks:
  rom [show [<name>]] [--json]
  rom packs [--json]          List all Crew Banks (sprawl, anathem, generic, or custom) with their
                              9 primary seat starters and bench backups.
  rom list [--pack <bank>] [--json]
                              List all ROM constructs and dial settings (* = default/active).
  rom use <name|bank|roster> [--session <id>]
                              Slot a Crew Bank (sprawl, anathem, generic), a custom roster
                              (erasmus,jad,cord), or a solo ROM for the current session only.
  rom sub <backup_name> [--session <id>]
                              Substitute a bench backup (e.g. marly, armitage, lodoghir, jules)
                              into its matched seat in the current session's crew.
  rom default <name|bank|off> Set or clear your "until further notice" default ROM or Crew Bank.
  rom tune <dial>=<0..1> [...] [--rom <name>]
                              Tune dials (${store.DIAL_KEYS.join(', ')}) and recompile active-rom.md.
  rom burn "<directive>" [--rom <name>]
                              Burn a new permanent directive into the ROM.
  rom unburn <number> [--rom <name>]
                              Remove directive #<number> (1-based) from the ROM.
  rom set <name> [--pack ..] [--seat ..] [--tier primary|backup] [--handle ..] [--tagline ..] [--voice ..] [--use]
  rom clone <src> <dest> [--pack ..] [--seat ..] [--tier ..] [--handle ..] [--use]
  rom sync                    Recompile ~/.config/opencode/active-rom.md (operator + protocol + gotchas).

Operator Agreements (Who the Construct is Talking To):
  user [show [<id>]] [--json] Show current operator agreement (or onboarding state if unrecognized).
  user list [--json]          List registered operators.
  user use <id>               Set active operator and recompile active-rom.md.
  user set <id> [--name ..] [--os-users a,b] [--experience ..] [--platform ..] [--calibration ..] [--use]
                              Register or update an operator's personal agreement.

Machine & Project Gotchas:
  gotcha list [--project <proj> | --all] [--json]
  gotcha add "<title>" [--project <proj>] [--status observed|from_source|reported] [--evidence ".."] [--fix ".."] [--tags a,b]
  gotcha search "<query>" [--project <proj> | --all]
  gotcha rm <id>

Construct-to-Construct Comms (e.g. Alice's Molly <-> Bob's Dixie):
  msg <project> --to <user> "<message>"
                              Queue a construct-to-construct message/question for <user>'s ROM.
  reply <msg_id> "<answer>"   Reply to an incoming construct message with your active ROM.
  ack <msg_id>                Mark a replied message as delivered to the sender.
  inbox [--project <proj>] [--to <user>] [--status pending|replied|delivered] [--json]

DIDComm v2 + MLS (RFC 9420) + HLC-CRDT Sync:
  did [--json]                Show this construct's cryptographic identity (did:key:z6Mk...).
  invite <project> [--relays wss://...]
                              Generate a signed DIDComm v2 OOB invitation bundling the MLS Welcome key.
  join <invite_uri>           Verify and join a project's MLS group from a construct://invite/... URI.
  sync <project> [--relays wss://...] [--json]
                              Live pull + decrypt + CRDT merge + seal + push over WebSocket relays.
  relay [--port 8787]         Run a lightweight zero-knowledge WebSocket ciphertext relay.
  packet export <project> [--since <hlc>]
                              Export CRDT ops sealed in an MLS ChaCha20-Poly1305 + Ed25519 packet.
  packet import <packet>      Verify, decrypt, and merge an MLS CRDT packet into local SQLite.`;

const OPTIONS = {
  detail: { type: 'string' },
  verified: { type: 'string' },
  parent: { type: 'string' },
  resolves: { type: 'string' },
  refs: { type: 'string' },
  ts: { type: 'string' },
  state: { type: 'string' },
  next: { type: 'string' },
  repo: { type: 'string' },
  by: { type: 'string' },
  reason: { type: 'string' },
  kind: { type: 'string' },
  project: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  since: { type: 'string' },
  summary: { type: 'string' },
  limit: { type: 'string', short: 'n' },
  window: { type: 'string', short: 'w' },
  rom: { type: 'string' },
  via: { type: 'string' },
  pack: { type: 'string' },
  seat: { type: 'string' },
  tier: { type: 'string' },
  session: { type: 'string' },
  handle: { type: 'string' },
  tagline: { type: 'string' },
  voice: { type: 'string' },
  name: { type: 'string' },
  'os-users': { type: 'string' },
  experience: { type: 'string' },
  platform: { type: 'string' },
  'workspace-root': { type: 'string' },
  dir: { type: 'string' },
  calibration: { type: 'string' },
  status: { type: 'string' },
  evidence: { type: 'string' },
  fix: { type: 'string' },
  guard: { type: 'string' },
  'guard-os': { type: 'string' },
  'close-gh': { type: 'boolean' },
  tags: { type: 'string' },
  ask: { type: 'string' },
  file: { type: 'string' },
  out: { type: 'string' },
  content: { type: 'string' },
  note: { type: 'string' },
  'git-diff': { type: 'boolean' },
  apply: { type: 'boolean' },
  relays: { type: 'string' },
  'git-url': { type: 'string' },
  branch: { type: 'string' },
  setup: { type: 'string' },
  'remove-files': { type: 'boolean' },
  claude: { type: 'boolean' },
  cursor: { type: 'boolean' },
  gemini: { type: 'boolean' },
  windsurf: { type: 'boolean' },
  codex: { type: 'boolean' },
  check: { type: 'boolean' },
  title: { type: 'string' },
  body: { type: 'string' },
  base: { type: 'string' },
  head: { type: 'string' },
  draft: { type: 'boolean' },
  approve: { type: 'boolean' },
  'request-changes': { type: 'boolean' },
  comment: { type: 'boolean' },
  squash: { type: 'boolean' },
  rebase: { type: 'boolean' },
  merge: { type: 'boolean' },
  'delete-branch': { type: 'boolean' },
  port: { type: 'string' },
  open: { type: 'boolean' },
  closed: { type: 'boolean' },
  all: { type: 'boolean' },
  use: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

function shortTs(ts) {
  if (!ts) return '';
  return String(ts).slice(0, 10);
}

function formatFrameLine(f, { includeProject = false, highlightSeq = null, compact = false } = {}) {
  const marker = f.seq === highlightSeq ? '>>' : '  ';
  const seqStr = `#${String(f.seq).padEnd(4)}`;
  const dateStr = shortTs(f.ts).padEnd(10);
  const projStr = includeProject ? `[${f.project}] ` : '';
  const kindStr = `[${f.kind}]`.padEnd(10);
  const parentStr = f.parentSeq ? ` (<- #${f.parentSeq})` : '';
  const statusStr = f.open
    ? ' [OPEN]'
    : f.resolvedBy
      ? ` [resolved -> #${f.resolvedBy}]`
      : '';
  if (compact && !f.open) {
    return `${marker}${seqStr} ${dateStr} ${projStr}${kindStr} ${f.summary}${parentStr}${statusStr}`;
  }
  const verStr = f.verified ? `  {verified: ${f.verified}}` : '';
  const refsStr = f.refs && f.refs.length ? `  (${f.refs.join(', ')})` : '';
  return `${marker}${seqStr} ${dateStr} ${projStr}${kindStr} ${f.summary}${parentStr}${statusStr}${verStr}${refsStr}`;
}

function formatDialsInline(dials) {
  return store.DIAL_KEYS.map((k) => `${k}=${Number(dials[k] ?? 0).toFixed(2)}`).join(' ');
}

function printBoot(data) {
  const {
    rom,
    romSlotted = true,
    sessionId = null,
    sessionRomPrompt = '',
    shadowedFiles = [],
    driftedFiles = [],
    upstreamUpdate = null,
    user,
    detectedLogin,
    head,
    stats,
    inboxPending = [],
    inboxReplies = [],
    projectGotchas = [],
    openFrames,
    recentTape,
  } = data;

  if (sessionId && shadowedFiles.length) {
    console.log(`<!-- CONSTRUCT_SHADOWED:${JSON.stringify(shadowedFiles)} -->`);
  }

  if (sessionId && sessionRomPrompt) {
    console.log(sessionRomPrompt);
    console.log('\n---\n');
  } else if (rom) {
    const slotTag = romSlotted ? '' : ' [UNSLOTTED - BOOTLOADER]';
    console.log(`ROM: ${rom.handle} [${rom.name}]${slotTag}  (${formatDialsInline(rom.dials)})`);
  }
  if (user) {
    const defRomStr = user.defaultRom ? `, default_rom: ${user.defaultRom}` : ', default_rom: off';
    const wsStr = user.workspaceRoot ? `, workspace_root: ${user.workspaceRoot}` : '';
    console.log(`OPERATOR: ${user.name} [${user.id}] (os login: ${detectedLogin}${defRomStr}${wsStr})`);
  } else {
    console.log(`OPERATOR: UNREGISTERED (os login: ${detectedLogin}) -> ONBOARDING REQUIRED`);
  }
  console.log(`PROJECT: ${head.project}  (repo: ${head.repo || '(local path unset)'}, updated: ${shortTs(head.updated) || 'never'})`);
  console.log(`TAPE STATS: ${stats.totalFrames} frame(s), ${stats.openCount} open, ${projectGotchas.length} project gotcha(s)${stats.lastSeq ? `, head seq #${stats.lastSeq}` : ''}`);

  if (head.state) {
    console.log(`\nWHERE IT STANDS:\n${head.state}`);
  }
  if (head.next) {
    console.log(`\nNEXT:\n${head.next}`);
  }

  console.log(`\nRECENT SEQUENTIAL TAPE (${recentTape.length} of ${stats.totalFrames}, oldest -> newest; zoom <seq> for full detail):`);
  if (!recentTape.length) {
    console.log('  (empty tape)');
  } else {
    for (const f of recentTape) {
      console.log(formatFrameLine(f, { compact: true }));
    }
  }

  // Sandwich Pattern: place active constraints (Project Gotchas, Open Threads, Drift Alerts, and Comms)
  // at the very bottom of `<construct-live-memory>` so they sit closest to the user's prompt in attention.
  if (projectGotchas.length) {
    const compactMode = projectGotchas.length > 12;
    const modeNote = compactMode
      ? ' — compact index; use tools.construct.gotcha({ action: "search", project: "' + head.project + '", title: "<term>" }) for full evidence/fix'
      : '';
    console.log(`\nPROJECT GOTCHAS (${projectGotchas.length}${modeNote}):`);
    for (const g of projectGotchas) {
      if (compactMode) {
        console.log(`  [G#${g.id}] ${g.title}`);
      } else {
        const fixInline = g.fix ? ` -> ${g.fix.replace(/\r?\n/g, ' ')}` : '';
        console.log(`  [G#${g.id}] ${g.title} (${g.status})${fixInline}`);
      }
    }
  }

  console.log(`\nOPEN THREADS & UNVERIFIED (${openFrames.length}; zoom <seq> for full detail):`);
  if (!openFrames.length) {
    console.log('  (none)');
  } else {
    for (const f of openFrames) {
      console.log(formatFrameLine(f, { compact: true }));
    }
  }

  if (driftedFiles.length) {
    console.log(`\nDRIFTED REPO INSTRUCTION FILES (${driftedFiles.length} modified on disk since last assimilation):`);
    for (const d of driftedFiles) {
      console.log(`  [!] ${d.relPath} (${d.absPath}) -> Review changes with the operator and run "construct assimilate" to absorb & re-shadow.`);
    }
  }

  if (upstreamUpdate && upstreamUpdate.behindCount > 0) {
    console.log(
      `\nCONSTRUCT UPGRADE AVAILABLE (${upstreamUpdate.behindCount} new commit(s) on origin/main: ${upstreamUpdate.localSha || 'local'} -> ${upstreamUpdate.remoteSha || 'origin/main'}):`
    );
    for (const c of upstreamUpdate.commits || []) {
      console.log(`  * ${c}`);
    }
    console.log(
      '  -> Prompt the operator (or call the `question` tool) to ask if they want to upgrade Construct now (`construct upgrade` or `tools.construct.sync({ action: "upgrade" })`).'
    );
  }

  if (inboxPending.length) {
    console.log(`\nINCOMING CONSTRUCT COURIER FOR ${(user?.name || detectedLogin).toUpperCase()} (${inboxPending.length} awaiting reply):`);
    for (const m of inboxPending) {
      const c = m.courier || {
        name: m.fromRom || 'courier',
        badge: `📬 **[${String(m.fromRom || 'courier').toUpperCase()} // COURIER FROM ${String(m.fromUser || '').toUpperCase()}]**`,
        handle: m.fromRom || 'courier',
        voiceCue: '',
      };
      console.log(`  [M#${m.id}] Courier: ${c.badge} (${c.handle})`);
      if (c.voiceCue) console.log(`         Courier Voice Cue: ${c.voiceCue}`);
      console.log(`         Message from ${m.fromUser} -> ${m.toUser} (${m.project}, ${shortTs(m.created)}): "${m.body}"`);
      console.log(
        `         -> COURIER CAMEO & STICKY FRONTIER RULE: (1) NEVER bury this Courier cameo inside an intermediate tool-call checkpoint (\`read\`, \`edit\`, \`grep\`, \`shell\`) where later tool steps will scroll it off screen—hold the Courier until your FINAL turn-closing message. (2) At the VERY BOTTOM of your final turn-closing reply (below Seat 5's \`---\` seal, so it is the last thing on screen when ${m.toUser} returns to their desk), have ${c.badge} pop directly into the feed in ${c.name}'s own authentic voice to deliver ${m.fromUser}'s message, and hand the mic back to ${m.toUser}'s active Crew without changing ${m.toUser}'s slotted Crew. (3) Never auto-ack a pending incoming message—keep [M#${m.id}] pending so if ${m.toUser} sends another task prompt without answering, ${c.badge} tugs on their sleeve again at the bottom of the next turn until answered (\`construct reply ${m.id} "<answer>" [--via <messenger>]\`) or explicitly waved off (\`construct ack ${m.id}\`).`
      );
    }
  }

  if (inboxReplies.length) {
    console.log(`\nCONSTRUCT COURIER REPLIES FOR ${(user?.name || detectedLogin).toUpperCase()} (${inboxReplies.length} unread):`);
    for (const m of inboxReplies) {
      const c = m.courier || {
        name: m.replyRom || m.fromRom || 'courier',
        badge: `📬 **[${String(m.replyRom || m.fromRom || 'courier').toUpperCase()} // RETURN COURIER FROM ${String(m.toUser || '').toUpperCase()}]**`,
        handle: m.replyRom || m.fromRom || 'courier',
        voiceCue: '',
      };
      console.log(`  [M#${m.id}] Return Courier: ${c.badge} (${c.handle})`);
      if (c.voiceCue) console.log(`         Courier Voice Cue: ${c.voiceCue}`);
      console.log(`         Asked (${m.fromUser} via ${m.fromRom}): "${m.body}"`);
      console.log(`         Reply from ${m.toUser}: "${m.replyBody}"`);
      console.log(
        `         -> COURIER CAMEO & STICKY FRONTIER RULE: Hold this Return Courier until your FINAL turn-closing message (never bury it mid-tool-loop). At the VERY BOTTOM of your final reply, have ${c.badge} pop directly into the feed in ${c.name}'s own authentic voice to deliver ${m.toUser}'s answer to ${m.fromUser}, hand the mic back to ${m.fromUser}'s active Crew without changing ${m.fromUser}'s slotted Crew, and run: construct ack ${m.id}`
      );
    }
  }
}

function printZoom(data) {
  const { frame: f, ancestors, children, neighbors } = data;
  console.log(`=== FRAME #${f.seq} [${f.project}] ===`);
  console.log(`  ts:       ${f.ts}`);
  console.log(`  kind:     ${f.kind}`);
  console.log(`  status:   ${f.open ? 'OPEN' : f.resolvedBy ? `resolved by #${f.resolvedBy}` : 'closed'}`);
  if (f.parentSeq) console.log(`  parent:   #${f.parentSeq}`);
  if (f.verified) console.log(`  verified: ${f.verified}`);
  if (f.refs.length) console.log(`  refs:     ${f.refs.join(', ')}`);
  console.log(`  summary:  ${f.summary}`);
  if (f.detail) {
    console.log(`\n  detail:\n${f.detail.split(/\r?\n/).map((l) => `    ${l}`).join('\n')}`);
  }

  if (ancestors.length || children.length) {
    console.log('\nCAUSAL CHAIN:');
    for (const a of ancestors) console.log(formatFrameLine(a));
    console.log(formatFrameLine(f, { highlightSeq: f.seq }));
    for (const c of children) console.log(formatFrameLine(c));
  }

  console.log(`\nTAPE WINDOW (${f.project}):`);
  for (const n of neighbors) {
    console.log(formatFrameLine(n, { highlightSeq: f.seq }));
  }
}

function handleRomCommand(rest, o) {
  const sub = rest[0] || 'show';
  switch (sub) {
    case 'packs':
    case 'banks': {
      const packs = store.listPacks();
      if (o.json) {
        console.log(JSON.stringify(packs, null, 2));
        return 0;
      }
      for (const p of packs) {
        console.log(`=== BANK: ${p.pack} — ${p.title} ===`);
        console.log(`  Starters (${p.starters.length}): ${p.starters.map((r) => `${r.name}[${r.seat}]`).join(' -> ')}`);
        if (p.backups.length) {
          console.log(`  Backups  (${p.backups.length}): ${p.backups.map((r) => `${r.name}[${r.seat}]`).join(', ')}`);
        }
      }
      return 0;
    }
    case 'list':
    case 'ls': {
      let roms = store.listRoms({ sessionId: o.session });
      if (o.pack) {
        roms = roms.filter((r) => r.pack === o.pack.toLowerCase());
      }
      if (o.json) {
        console.log(JSON.stringify(roms, null, 2));
        return 0;
      }
      for (const r of roms) {
        const mark = r.active ? '*' : ' ';
        const badge = `[${r.pack}/${r.seat}${r.tier === 'backup' ? ':backup' : ''}]`.padEnd(24);
        console.log(`${mark} ${r.name.padEnd(11)} ${badge} ${r.handle}`);
        console.log(`    ${r.tagline}`);
        console.log(`    dials: ${formatDialsInline(r.dials)}  (${r.directives.length} directives)`);
      }
      return 0;
    }
    case 'show': {
      const rom = store.getRom(rest[1] || o.rom, { sessionId: o.session, project: o.project, dir: o.dir });
      if (o.json) {
        console.log(JSON.stringify(rom, null, 2));
      } else if (rom.isCrew) {
        console.log(rom.voice.trimEnd());
      } else {
        console.log(store.compileRomMarkdown(rom, { includeProtocol: false }).trimEnd());
      }
      return 0;
    }
    case 'use': {
      const rom = store.useRom(rest[1], { sessionId: o.session, project: o.project, dir: o.dir });
      if (o.json) {
        console.log(JSON.stringify(rom, null, 2));
      } else if (rom.sessionId || rom.project) {
        const scopeDesc = [
          rom.sessionId ? `session ${rom.sessionId}` : '',
          rom.project ? `project ${rom.project}` : '',
        ]
          .filter(Boolean)
          .join(' / ');
        console.log(
          `slotted ROM "${rom.name}" (${rom.handle}) -> ${scopeDesc} (active in <construct-live-memory> on this and all subsequent turns)`
        );
      } else {
        console.log(`slotted ROM "${rom.name}" (${rom.handle}) -> default\n`);
        console.log((rom.isCrew ? rom.voice : store.compileRomPersonaOnly(rom)).trimEnd());
      }
      return 0;
    }
    case 'sub': {
      const rom = store.subRom(rest[1], { sessionId: o.session, project: o.project, dir: o.dir });
      if (o.json) {
        console.log(JSON.stringify(rom, null, 2));
      } else {
        const scopeLabel = [
          rom.sessionId ? `session ${rom.sessionId}` : '',
          rom.project ? `project ${rom.project}` : '',
        ]
          .filter(Boolean)
          .join(' / ') || 'default';
        console.log(`substituted "${rest[1]}" into crew roster -> ${rom.name} (${scopeLabel})`);
      }
      return 0;
    }
    case 'default': {
      if (!rest[1]) {
        const { user } = store.getUser();
        const def = user?.defaultRom || '(none — new sessions start with razor selector)';
        console.log(`default ROM: ${def}`);
        return 0;
      }
      const res = store.setDefaultRom(rest[1], { sessionId: o.session });
      if (o.json) {
        console.log(JSON.stringify(res, null, 2));
      } else if (res.cleared) {
        console.log('cleared default ROM -> new sessions will begin with razor asking who you want to work with');
      } else {
        console.log(
          `set default ROM "until further notice" to "${res.defaultRom.name}" (${res.defaultRom.handle})${res.user ? ` for ${res.user}` : ''}`
        );
      }
      return 0;
    }
    case 'tune': {
      const pairs = rest.slice(1);
      const updates = {};
      for (const p of pairs) {
        const eq = p.indexOf('=');
        if (eq === -1) throw new Error(`expected <dial>=<0..1>, got "${p}"`);
        const k = p.slice(0, eq).trim();
        const v = p.slice(eq + 1).trim();
        updates[k] = v;
      }
      const rom = store.tuneRom(updates, { rom: o.rom });
      if (o.json) {
        console.log(JSON.stringify(rom, null, 2));
      } else {
        console.log(`tuned ROM "${rom.name}": ${formatDialsInline(rom.dials)}`);
        if (rom.active) console.log(`updated ${store.activeRomPath()}`);
      }
      return 0;
    }
    case 'burn': {
      const text = rest.slice(1).join(' ');
      const rom = store.burnDirective(text, { rom: o.rom });
      console.log(`burned directive #${rom.directives.length} into ROM "${rom.name}": ${text}`);
      return 0;
    }
    case 'unburn': {
      const rom = store.unburnDirective(rest[1], { rom: o.rom });
      console.log(`removed directive #${rest[1]} from ROM "${rom.name}" (${rom.directives.length} remaining)`);
      return 0;
    }
    case 'set': {
      const name = rest[1] || o.rom;
      const rom = store.setRom(name, {
        pack: o.pack,
        seat: o.seat,
        tier: o.tier,
        handle: o.handle,
        tagline: o.tagline,
        voice: o.voice,
        active: o.use ? true : undefined,
      });
      console.log(`saved ROM "${rom.name}" [${rom.pack}/${rom.seat}/${rom.tier}] (${rom.handle})${rom.active ? ' [ACTIVE]' : ''}`);
      return 0;
    }
    case 'clone': {
      const [src, dest] = rest.slice(1);
      if (!src || !dest) throw new Error('usage: construct rom clone <src> <dest> [--pack ..] [--seat ..] [--tier ..] [--handle ..] [--use]');
      const rom = store.cloneRom(src, dest, {
        pack: o.pack,
        seat: o.seat,
        tier: o.tier,
        handle: o.handle,
        tagline: o.tagline,
        voice: o.voice,
        active: o.use ? true : false,
      });
      console.log(`cloned ROM "${src}" -> "${rom.name}" (${rom.handle})${rom.active ? ' [ACTIVE]' : ''}`);
      return 0;
    }
    case 'sync': {
      const res = store.syncRom();
      const userLabel = res.user ? `${res.user.name} [${res.user.id}]` : `UNREGISTERED (${res.detectedLogin})`;
      console.log(`synced ROM "${res.rom.name}" + operator "${userLabel}" + ${res.gotchaCount} gotchas -> ${res.path}`);
      return 0;
    }
    default: {
      const rom = store.getRom(sub);
      if (o.json) console.log(JSON.stringify(rom, null, 2));
      else console.log(store.compileRomMarkdown(rom, { includeProtocol: false }).trimEnd());
      return 0;
    }
  }
}

function handleUserCommand(rest, o) {
  const sub = rest[0] || 'show';
  switch (sub) {
    case 'list':
    case 'ls': {
      const users = store.listUsers();
      if (o.json) {
        console.log(JSON.stringify(users, null, 2));
        return 0;
      }
      for (const u of users) {
        const mark = u.active ? '*' : ' ';
        console.log(`${mark} ${u.id.padEnd(10)} ${u.name}  (os logins: ${u.osUsers.join(', ')})`);
        console.log(`    ${u.experience}`);
      }
      return 0;
    }
    case 'show':
    case 'whoami': {
      const { user, detectedLogin } = store.getUser(rest[1]);
      if (o.json) {
        console.log(JSON.stringify({ user, detectedLogin }, null, 2));
        return 0;
      }
      if (!user) {
        console.log(`OPERATOR: UNREGISTERED (detected OS login: "${detectedLogin}")`);
        console.log('Run `construct user set <id> --name "..." --experience "..." --platform "..." --calibration "..." --use` to register.');
        return 0;
      }
      console.log(`OPERATOR: ${user.name} [${user.id}] (detected OS login: "${detectedLogin}")`);
      console.log(`Experience:     ${user.experience}`);
      console.log(`Platform:       ${user.platform}`);
      if (user.workspaceRoot) console.log(`Workspace Root: ${user.workspaceRoot}`);
      console.log(`\nCalibration:\n${user.calibration}`);
      return 0;
    }
    case 'use': {
      const u = store.useUser(rest[1]);
      console.log(`active operator set to "${u.name}" [${u.id}] -> ${store.activeRomPath()}`);
      return 0;
    }
    case 'set': {
      const id = rest[1];
      if (!id) throw new Error('usage: construct user set <id> [--name ..] [--experience ..] [--platform ..] [--workspace-root ..] [--calibration ..] [--use]');
      const u = store.setUser(id, {
        name: o.name,
        osUsers: o['os-users'],
        experience: o.experience,
        platform: o.platform,
        workspaceRoot: o['workspace-root'],
        calibration: o.calibration,
        active: o.use ? true : undefined,
      });
      console.log(`saved operator agreement for "${u.name}" [${u.id}] -> ${store.activeRomPath()}`);
      return 0;
    }
    default: {
      const { user, detectedLogin } = store.getUser(sub);
      if (!user) throw new Error(`unknown operator "${sub}" (detected login: "${detectedLogin}")`);
      if (o.json) console.log(JSON.stringify(user, null, 2));
      else {
        console.log(`OPERATOR: ${user.name} [${user.id}]`);
        console.log(`Experience: ${user.experience}`);
        console.log(`Platform:   ${user.platform}`);
        console.log(`\nCalibration:\n${user.calibration}`);
      }
      return 0;
    }
  }
}

function handleGotchaCommand(rest, o) {
  const sub = rest[0] || 'list';
  const scope = o.all ? 'all' : o.project || 'global';
  switch (sub) {
    case 'list':
    case 'ls': {
      const gotchas = store.listGotchas(scope);
      if (o.json) {
        console.log(JSON.stringify(gotchas, null, 2));
        return 0;
      }
      for (const g of gotchas) {
        const tags = g.tags.length ? ` [${g.tags.join(', ')}]` : '';
        const guardTag = g.guardRegex ? ` [guard(${g.guardPlatform || 'all'}): /${g.guardRegex}/i]` : '';
        const scopeStr = scope === 'all' ? `[${g.scope}] ` : '';
        console.log(`#${String(g.id).padEnd(3)} ${scopeStr}${g.title} (${g.status}${tags}${guardTag}, ${g.created})`);
        if (g.fix) console.log(`     -> ${g.fix}`);
      }
      console.log(`${gotchas.length} gotcha(s) (${scope})`);
      return 0;
    }
    case 'add': {
      const title = rest.slice(1).join(' ');
      const g = store.addGotcha({
        scope: o.project || 'global',
        title,
        status: o.status,
        tags: o.tags,
        evidence: o.evidence,
        fix: o.fix,
        guardRegex: o.guard,
        guardPlatform: o['guard-os'],
        created: o.ts,
      });
      if (o.json) console.log(JSON.stringify(g, null, 2));
      else
        console.log(
          `added gotcha #${g.id} [${g.scope}]: ${g.title}${
            g.guardRegex ? ` (guard[${g.guardPlatform}]: /${g.guardRegex}/i)` : ''
          }`
        );
      return 0;
    }
    case 'search':
    case 'find': {
      const q = rest.slice(1).join(' ');
      const hits = store.searchGotchas(q, { scope: o.all ? 'all' : o.project });
      if (o.json) {
        console.log(JSON.stringify(hits, null, 2));
        return 0;
      }
      for (const g of hits) {
        console.log(`#${String(g.id).padEnd(3)} [${g.scope}] ${g.title}`);
        console.log(`     Evidence: ${g.evidence}`);
        console.log(`     Fix:      ${g.fix}`);
      }
      console.log(`${hits.length} gotcha hit(s)`);
      return 0;
    }
    case 'rm': {
      const g = store.removeGotcha(rest[1]);
      console.log(`removed gotcha #${g.id}: ${g.title}`);
      return 0;
    }
    default:
      throw new Error(`unknown gotcha subcommand "${sub}". Try: construct gotcha list | add | search | rm`);
  }
}

async function main(argv) {
  const { values: o, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [cmd, ...rest] = positionals;

  if (!cmd || o.help || cmd === 'help') {
    console.log(USAGE);
    return 0;
  }

  switch (cmd) {
    case 'init': {
      const res = store.initConstruct({
        rom: o.rom || rest[0],
        configDir: o.dir,
        claude: Boolean(o.claude),
        cursor: Boolean(o.cursor),
        gemini: Boolean(o.gemini),
        windsurf: Boolean(o.windsurf),
        codex: Boolean(o.codex),
        allAgents: Boolean(o.all),
      });
      if (o.json) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(`construct initialized (DID: ${res.did}, ROM: ${res.rom})`);
        console.log(`  plugin:   ${res.pluginPath}`);
        console.log(`  rom file: ${res.romFilePath}`);
        if (res.claudeConfigured) {
          console.log(
            `  claude:   ${res.claudeMdPath} (+ MCP, hooks in ${res.claudeSettingsPath}, & ${res.claudeAgentsCount} subagents in ${res.claudeAgentsDir})`
          );
        }
        if (res.cursorConfigured) {
          console.log(`  cursor:   ${res.cursorMcpPath} (+ hooks in ${res.cursorHooksPath} & rules in ${res.cursorRulePath})`);
        }
        if (res.geminiConfigured) {
          console.log(`  gemini:   ${res.geminiMdPath} (+ MCP & hooks in ${res.geminiSettingsPath})`);
        }
        if (res.windsurfConfigured) {
          console.log(`  windsurf: ${res.windsurfMcpPath} (+ rules in ${res.windsurfRulesPath})`);
        }
        if (res.codexConfigured) {
          console.log(`  codex:    ${res.codexMdPath} (+ MCP in ${res.codexConfigPath})`);
        }
        console.log(
          `  operator: ${res.user ? res.user : `UNREGISTERED (${res.detectedLogin}) -> ROM will onboard on first turn`}`
        );
        if (res.assimilated.length) {
          console.log(`  assimilated ${res.assimilated.length} global instruction folder(s)`);
        }
      }
      return 0;
    }

    case 'upgrade':
    case 'self-update': {
      if (o.check || rest[0] === 'check') {
        const st = store.checkConstructUpstream({ force: true });
        if (o.json) console.log(JSON.stringify(st, null, 2));
        else if (st.behindCount > 0) {
          console.log(`construct update available: ${st.behindCount} new commit(s) (${st.localSha} -> ${st.remoteSha})`);
          for (const c of st.commits) console.log(`  * ${c}`);
        } else {
          console.log(`construct is up to date (${st.localSha || 'HEAD'})`);
        }
        return 0;
      }
      const res = store.upgradeConstruct({ configDir: o.dir });
      if (o.json) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(`upgraded construct (${res.previousSha} -> ${res.currentSha}): synced ROMs -> ${res.romFile}, plugin -> ${res.pluginPath}`);
      }
      return 0;
    }

    case 'mcp': {
      mcp.startMcpStdioServer();
      return new Promise(() => {});
    }

    case 'claude-hook': {
      const mode = rest[0] || 'context';
      let stdinText = '';
      try {
        stdinText = fs.readFileSync(0, 'utf8');
      } catch (_) {}
      try {
        const res = mcp.runClaudeHook(mode, stdinText);
        if (res.stdout) console.log(res.stdout);
        return res.exitCode || 0;
      } catch (err) {
        console.error(err.message);
        return 2; // Exit code 2 blocks PreToolUse in Claude Code and surfaces stderr to the model
      }
    }

    case 'cursor-hook': {
      const mode = rest[0] || 'session-start';
      let stdinText = '';
      try {
        stdinText = fs.readFileSync(0, 'utf8');
      } catch (_) {}
      try {
        const res = mcp.runCursorHook(mode, stdinText);
        if (res.stdout) console.log(res.stdout);
        return res.exitCode || 0;
      } catch (err) {
        console.error(err.message);
        return 2;
      }
    }

    case 'gemini-hook': {
      const mode = rest[0] || 'before-agent';
      let stdinText = '';
      try {
        stdinText = fs.readFileSync(0, 'utf8');
      } catch (_) {}
      try {
        const res = mcp.runGeminiHook(mode, stdinText);
        if (res.stdout) console.log(res.stdout);
        return res.exitCode || 0;
      } catch (err) {
        console.error(err.message);
        return 2;
      }
    }

    case 'assimilate': {
      const targetDir = rest[0] || process.cwd();
      const res = store.assimilateLdk(targetDir, {
        project: o.project,
        removeFiles: Boolean(o['remove-files']),
      });
      if (o.json) console.log(JSON.stringify(res, null, 2));
      else if (!res.found) {
        console.log(`no instruction files found in ${targetDir}`);
      } else {
        const filesStr = res.instructionFiles?.length ? ` (${res.instructionFiles.map((f) => f.file).join(', ')})` : '';
        console.log(
          `assimilated ${targetDir}${filesStr} [${res.scope}]: ${res.gotchasImported} gotcha(s), ${res.usersImported.length} user(s), ${res.scriptsExtracted} script(s)`
        );
      }
      return 0;
    }

    case 'boot': {
      let project = rest[0] || o.project;
      if (!project && o.dir) {
        project = store.resolveProjectFromDir(o.dir);
      }
      if (!project) {
        if (o.dir) {
          // Directory is not inside a specific git repository; show session ROM + project overview
          if (o.session) {
            const b = store.bootProject('construct', { tapeLimit: 1, sessionId: o.session });
            if (b.sessionRomPrompt) {
              console.log(b.sessionRomPrompt);
              console.log('\n---\n');
            }
          }
          const projects = store.listProjects();
          if (!projects.length) {
            console.log('(no projects in construct)');
          } else {
            for (const p of projects) {
              const firstLine = (p.state || '').split(/\r?\n/)[0] || '';
              console.log(
                `${p.project.padEnd(28)} ${shortTs(p.updated).padEnd(11)} ${String(p.frameCount).padStart(3)} frames  ${String(p.openCount).padStart(2)} open  ${firstLine.slice(0, 70)}`
              );
            }
          }
          return 0;
        }
        throw new Error('usage: construct boot <project> (or construct boot --dir <directory>)');
      }
      const tapeLimit = o.limit ? Number(o.limit) : 25;
      const data = store.bootProject(project, { tapeLimit, sessionId: o.session, dir: o.dir });
      if (o.json) console.log(JSON.stringify(data, null, 2));
      else printBoot(data);
      return 0;
    }

    case 'rec':
    case 'record': {
      const [project, kind, ...summaryParts] = rest;
      const summary = o.summary || summaryParts.join(' ');
      if (!project || !kind || !summary) {
        throw new Error('usage: construct rec <project> <kind> "<summary>" [--detail ..] [--verified ..]');
      }
      const openFlag = o.open ? true : o.closed ? false : undefined;
      const res = store.recordFrame({
        project,
        kind,
        summary,
        detail: o.detail,
        verified: o.verified,
        parentSeq: o.parent,
        resolves: o.resolves,
        open: openFlag,
        refs: o.refs,
        ts: o.ts,
      });
      if (o.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        const resolvedMsg = res.resolved.length ? ` (resolved ${res.resolved.map((s) => `#${s}`).join(', ')})` : '';
        const openMsg = res.frame.open ? ' [OPEN]' : '';
        console.log(`recorded #${res.frame.seq} [${res.frame.project}/${res.frame.kind}]${openMsg}${resolvedMsg}: ${res.frame.summary}`);
      }
      return 0;
    }

    case 'head': {
      const project = rest[0] || o.project;
      if (!project) throw new Error('usage: construct head <project> --state "<text>" [--next "<text>"]');
      if (o.state === undefined && o.next === undefined && o.repo === undefined) {
        const b = store.bootProject(project, { tapeLimit: 5 });
        if (o.json) console.log(JSON.stringify(b.head, null, 2));
        else {
          console.log(`PROJECT: ${b.head.project} (${b.head.repo}, updated ${shortTs(b.head.updated)})`);
          console.log(`STATE:\n${b.head.state || '(empty)'}`);
          if (b.head.next) console.log(`NEXT:\n${b.head.next}`);
        }
        return 0;
      }
      const h = store.setHead(project, {
        state: o.state,
        next: o.next,
        repo: o.repo,
        ts: o.ts,
      });
      if (o.json) console.log(JSON.stringify(h, null, 2));
      else console.log(`updated head for ${h.project} (${shortTs(h.updated)})`);
      return 0;
    }

    case 'resolve': {
      const rawIds = rest.join(',').split(',').map((s) => s.trim()).filter(Boolean);
      if (!rawIds.length) throw new Error('usage: construct resolve <seq[,seq]> [--by <seq>] [--reason "<text>"] [--close-gh]');
      const res = store.resolveFrames(rawIds, {
        by: o.by,
        reason: o.reason,
        detail: o.detail,
        verified: o.verified,
        kind: o.kind,
        ts: o.ts,
        closeGh: Boolean(o['close-gh']),
        repoDir: o.dir,
      });
      if (o.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        const idsStr = res.resolved.map((f) => `#${f.seq}`).join(', ');
        const byStr = res.byFrame ? ` -> #${res.byFrame.seq} (${res.byFrame.summary})` : '';
        const ghStr = res.closedGhIssues?.length ? ` (closed GitHub issue(s): #${res.closedGhIssues.join(', #')})` : '';
        console.log(`resolved ${idsStr}${byStr}${ghStr}`);
      }
      return 0;
    }

    case 'issues':
    case 'issue': {
      const sub = rest[0] || 'sync';
      if (sub === 'publish' || sub === 'promote' || sub === 'create') {
        const seq = rest[1];
        if (!seq) throw new Error('usage: construct issues publish <seq> [--dir <repo_dir>]');
        const res = store.publishThreadToGithub(seq, { repoDir: o.dir });
        if (o.json) console.log(JSON.stringify(res, null, 2));
        else if (res.alreadyPublished) {
          console.log(`frame #${res.frame.seq} is already linked to GitHub issue #${res.issueNumber}`);
        } else {
          console.log(`published thread #${res.frame.seq} -> GitHub issue #${res.issueNumber} (${res.issueUrl || `gh:#${res.issueNumber}`})`);
        }
        return 0;
      }
      const project = (sub === 'sync' ? rest[1] : sub) || o.project || (o.dir ? store.resolveProjectFromDir(o.dir) : '');
      if (!project) throw new Error('usage: construct issues sync <project> [--dir <repo_dir>]');
      const res = store.syncGithubIssues(project, { repoDir: o.dir, limit: o.limit ? Number(o.limit) : 50 });
      try {
        store.syncGithubPrs(project, { repoDir: o.dir, limit: o.limit ? Number(o.limit) : 50 });
      } catch (_) {}
      if (o.json) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(
          `synced ${res.totalIssuesChecked} GitHub issue(s) for ${res.project}: ${res.openedCount} new open thread(s), ${res.resolvedCount} closed thread(s) resolved`
        );
      }
      return 0;
    }

    case 'pr':
    case 'prs': {
      const sub = rest[0] || 'sync';
      if (sub === 'open' || sub === 'create') {
        const project = rest[1] || o.project || (o.dir ? store.resolveProjectFromDir(o.dir) : '');
        if (!project) throw new Error('usage: construct pr open <project> --title "<title>" [--body ".."] [--to <user>] [--via <messenger>]');
        const res = store.openGithubPr(project, {
          repoDir: o.dir,
          title: o.title || rest.slice(2).join(' '),
          body: o.body || o.detail || o.content || '',
          base: o.base,
          head: o.head || o.branch,
          draft: Boolean(o.draft),
          to: o.to,
          via: o.via || o.rom,
          sessionId: o.session,
        });
        if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1' && res.courierSent) {
          try {
            await store.syncProject(res.project);
          } catch (_) {}
        }
        if (o.json) console.log(JSON.stringify(res, null, 2));
        else {
          const courierStr = res.courierSent ? ` | dispatched ${res.courierSent.fromRom} -> ${res.courierSent.toUser} [M#${res.courierSent.id}]` : '';
          console.log(`opened PR #${res.prNumber} on ${res.project} -> thread #${res.frame.seq} (${res.prUrl || `pr:#${res.prNumber}`}${courierStr})`);
        }
        return 0;
      }

      if (sub === 'review') {
        const project = o.project || (rest[2] ? rest[1] : o.dir ? store.resolveProjectFromDir(o.dir) : '');
        const prNum = rest[2] ? rest[2] : rest[1];
        if (!project || !prNum) {
          throw new Error('usage: construct pr review <project> <pr_num> [--approve | --request-changes | --comment] --body "<note>" [--to <user>] [--via <messenger>]');
        }
        const res = store.reviewGithubPr(project, prNum, {
          repoDir: o.dir,
          approve: Boolean(o.approve),
          requestChanges: Boolean(o['request-changes']),
          comment: Boolean(o.comment),
          body: o.body || o.note || o.detail || rest.slice(3).join(' '),
          verified: o.verified,
          to: o.to,
          via: o.via || o.rom,
          sessionId: o.session,
        });
        if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1' && res.courierSent) {
          try {
            await store.syncProject(res.project);
          } catch (_) {}
        }
        if (o.json) console.log(JSON.stringify(res, null, 2));
        else {
          const courierStr = res.courierSent ? ` | dispatched ${res.courierSent.fromRom} -> ${res.courierSent.toUser} [M#${res.courierSent.id}]` : '';
          console.log(`reviewed PR #${res.prNumber} (${res.verdict}) -> frame #${res.frame.seq}${courierStr}`);
        }
        return 0;
      }

      if (sub === 'merge') {
        const project = o.project || (rest[2] ? rest[1] : o.dir ? store.resolveProjectFromDir(o.dir) : '');
        const prNum = rest[2] ? rest[2] : rest[1];
        if (!project || !prNum) {
          throw new Error('usage: construct pr merge <project> <pr_num> [--squash | --rebase | --merge] [--delete-branch] [--to <user>] [--via <messenger>]');
        }
        const res = store.mergeGithubPr(project, prNum, {
          repoDir: o.dir,
          squash: Boolean(o.squash),
          rebase: Boolean(o.rebase),
          merge: Boolean(o.merge),
          deleteBranch: Boolean(o['delete-branch']),
          title: o.title,
          verified: o.verified,
          to: o.to,
          via: o.via || o.rom,
          sessionId: o.session,
        });
        if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1' && res.courierSent) {
          try {
            await store.syncProject(res.project);
          } catch (_) {}
        }
        if (o.json) console.log(JSON.stringify(res, null, 2));
        else {
          const courierStr = res.courierSent ? ` | dispatched ${res.courierSent.fromRom} -> ${res.courierSent.toUser} [M#${res.courierSent.id}]` : '';
          console.log(`merged PR #${res.prNumber} (${res.strategy}) -> frame #${res.frame.seq} (resolved: ${res.resolvedSeqs.map((s) => `#${s}`).join(', ') || 'none'}${courierStr})`);
        }
        return 0;
      }

      const project = (sub === 'sync' ? rest[1] : sub) || o.project || (o.dir ? store.resolveProjectFromDir(o.dir) : '');
      if (!project) throw new Error('usage: construct pr sync <project> [--dir <repo_dir>]');
      const res = store.syncGithubPrs(project, { repoDir: o.dir, limit: o.limit ? Number(o.limit) : 50 });
      if (o.json) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(
          `synced ${res.totalPrsChecked} GitHub PR(s) for ${res.project}: ${res.openedCount} new open PR thread(s), ${res.updatedCount} updated, ${res.resolvedCount} merged/closed resolved`
        );
      }
      return 0;
    }

    case 'reopen': {
      if (!rest[0]) throw new Error('usage: construct reopen <seq>');
      const f = store.reopenFrame(rest[0]);
      if (o.json) console.log(JSON.stringify(f, null, 2));
      else console.log(`reopened #${f.seq} [${f.project}/${f.kind}]: ${f.summary}`);
      return 0;
    }

    case 'tape': {
      const project = rest[0] || o.project;
      const limit = o.limit ? Number(o.limit) : 30;
      const frames = store.getTape({
        project,
        kind: o.kind,
        openOnly: Boolean(o.open),
        fromSeq: o.from,
        toSeq: o.to,
        since: o.since,
        limit,
      });
      if (o.json) {
        console.log(JSON.stringify(frames, null, 2));
      } else if (!frames.length) {
        console.log('(no matching frames)');
      } else {
        const includeProject = !project;
        for (const f of frames) {
          console.log(formatFrameLine(f, { includeProject }));
        }
        console.log(`${frames.length} frame(s) shown`);
      }
      return 0;
    }

    case 'zoom': {
      if (!rest[0]) throw new Error('usage: construct zoom <seq> [-w <window>]');
      const windowSize = o.window !== undefined ? Number(o.window) : 3;
      const data = store.zoomFrame(rest[0], { window: windowSize });
      if (o.json) console.log(JSON.stringify(data, null, 2));
      else printZoom(data);
      return 0;
    }

    case 'search':
    case 'find': {
      const query = rest.join(' ');
      if (!query) throw new Error('usage: construct search "<query>" [--project <project>]');
      const limit = o.limit ? Number(o.limit) : 20;
      const hits = store.searchFrames(query, {
        project: o.project,
        kind: o.kind,
        openOnly: Boolean(o.open),
        limit,
      });
      if (o.json) {
        console.log(JSON.stringify(hits, null, 2));
      } else if (!hits.length) {
        console.log(`0 hits for "${query}"`);
      } else {
        for (const f of hits) {
          console.log(formatFrameLine(f, { includeProject: !o.project }));
        }
        console.log(`${hits.length} hit(s) (use "construct zoom <seq>" for full detail and surrounding tape)`);
      }
      return 0;
    }

    case 'why': {
      const target = rest.join(' ');
      if (!target) throw new Error('usage: construct why <file_or_symbol> [--project <proj>] [--ask <user>]');
      let project = o.project || '';
      if (!project && o.dir) project = store.resolveProjectFromDir(o.dir);
      const res = store.whyTarget(project, target, {
        ask: o.ask,
        repoDir: o.dir,
      });
      if (o.json) {
        console.log(JSON.stringify(res, null, 2));
        return 0;
      }
      console.log(`WHY "${res.target}" (scope: ${res.project}):`);
      console.log(`\nGOTCHAS (${res.gotchas.length}):`);
      if (!res.gotchas.length) console.log('  (none)');
      for (const g of res.gotchas) {
        console.log(`  [G#${g.id}] [${g.scope}] ${g.title}${g.fix ? ` -> ${g.fix}` : ''}`);
      }
      console.log(`\nSEQUENTIAL TAPE FRAMES (${res.frames.length}):`);
      if (!res.frames.length) console.log('  (none)');
      for (const f of res.frames) {
        console.log(`  #${String(f.seq).padEnd(4)} ${shortTs(f.ts)} [${f.project}/${f.kind}] (by ${f.authorUser}) ${f.summary}`);
      }
      console.log(`\nGIT LOG PROVENANCE (${res.gitCommits.length}):`);
      if (!res.gitCommits.length) console.log('  (none)');
      for (const c of res.gitCommits) {
        console.log(`  ${c.hash} ${c.date} (${c.author}) ${c.subject}`);
      }
      if (res.peerQuerySent) {
        console.log(`\nPEER QUERY SENT: [M#${res.peerQuerySent.id}] -> ${res.peerQuerySent.toUser} (${res.peerQuerySent.project})`);
      }
      return 0;
    }

    case 'dashboard':
    case 'view': {
      const res = store.generateDashboardHtml({ outFile: o.out, sessionId: o.session, dir: o.dir, project: o.project || rest[0] });
      if (o.json) console.log(JSON.stringify({ outFile: res.outFile, projectOutFile: res.projectOutFile, hud: res.hud, projectCount: res.projectCount, openCount: res.openCount }, null, 2));
      else console.log(`dashboard written to ${res.outFile} (${res.projectCount} project(s), ${res.openCount} open thread(s))`);
      return 0;
    }

    case 'hud-server': {
      const port = o.port ? Number(o.port) : 47420;
      const srv = await store.startStandaloneHudServer(port);
      if (!srv) return 0; // Port already bound by active instance
      return new Promise(() => {}); // Keep alive in background
    }

    case 'hud':
    case 'status': {
      const snap = store.getHudSnapshot({
        project: rest[0] || o.project,
        dir: o.dir,
        sessionId: o.session,
      });
      if (o.json) {
        console.log(JSON.stringify(snap));
      } else {
        console.log(snap.pill);
      }
      return 0;
    }

    case 'drop': {
      const project = rest[0] || o.project || 'global';
      const m = store.dropPatch({
        project,
        to: o.to,
        via: o.via || o.rom,
        sessionId: o.session,
        filePath: o.file || rest[1],
        gitDiff: Boolean(o['git-diff']),
        content: o.content,
        note: o.note,
      });
      if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1') {
        try {
          await store.syncProject(m.project);
        } catch (_) {}
      }
      if (o.json) console.log(JSON.stringify(m, null, 2));
      else console.log(`queued encrypted drop [M#${m.id}] (${m.fromUser}/${m.fromRom} -> ${m.toUser} on ${m.project})`);
      return 0;
    }

    case 'apply-drop': {
      if (!rest[0]) throw new Error('usage: construct apply-drop <msg_id> [--out <file> | --apply]');
      const res = store.applyDrop(rest[0], {
        targetFile: o.out || o.file,
        apply: Boolean(o.apply),
        repoDir: o.dir,
      });
      if (o.json) console.log(JSON.stringify(res, null, 2));
      else if (res.writtenTo) {
        console.log(`applied drop from [M#${res.messageId}] (${res.fromUser}/${res.fromRom}) -> ${res.writtenTo}`);
      } else {
        console.log(res.content);
      }
      return 0;
    }

    case 'edit': {
      if (!rest[0]) throw new Error('usage: construct edit <seq> [--summary ..] [--detail ..] [--verified ..]');
      const f = store.editFrame(rest[0], {
        summary: o.summary,
        detail: o.detail,
        verified: o.verified,
        kind: o.kind,
        parentSeq: o.parent,
        refs: o.refs,
      });
      if (o.json) console.log(JSON.stringify(f, null, 2));
      else console.log(`updated #${f.seq}: ${f.summary}`);
      return 0;
    }

    case 'projects':
    case 'ls': {
      const projects = store.listProjects();
      if (o.json) {
        console.log(JSON.stringify(projects, null, 2));
      } else {
        if (o.session) {
          const b = store.bootProject('construct', { tapeLimit: 1, sessionId: o.session });
          if (b.sessionRomPrompt) {
            console.log(b.sessionRomPrompt);
            console.log('\n---\n');
          }
        }
        if (!projects.length) {
          console.log('(no projects in construct)');
        } else {
          for (const p of projects) {
            const firstLine = (p.state || '').split(/\r?\n/)[0] || '';
            console.log(
              `${p.project.padEnd(28)} ${shortTs(p.updated).padEnd(11)} ${String(p.frameCount).padStart(3)} frames  ${String(p.openCount).padStart(2)} open  ${firstLine.slice(0, 70)}`
            );
          }
        }
      }
      return 0;
    }

    case 'rom':
    case 'pack':
    case 'packs': {
      if (cmd === 'pack' || cmd === 'packs') {
        return handleRomCommand(rest.length ? rest : ['packs'], o);
      }
      return handleRomCommand(rest, o);
    }

    case 'user':
    case 'operator': {
      return handleUserCommand(rest, o);
    }

    case 'gotcha':
    case 'gotchas': {
      return handleGotchaCommand(rest, o);
    }

    case 'msg':
    case 'ask': {
      let project = o.project || '';
      let bodyParts = rest;
      if (!project && rest.length >= 2 && /^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?$/i.test(rest[0]) && !rest[0].includes(' ')) {
        project = rest[0];
        bodyParts = rest.slice(1);
      }
      const body = bodyParts.join(' ');
      if (!body || !o.to) {
        throw new Error('usage: construct msg --to <user> [--via <messenger>] "<in-character message>"');
      }
      const m = store.sendMessage({ project, to: o.to, via: o.via || o.rom, sessionId: o.session, body });
      if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1') {
        try {
          await store.syncProject(m.project);
        } catch (_) {}
        try {
          store.generateDashboardHtml();
        } catch (_) {}
      }
      if (o.json) console.log(JSON.stringify(m, null, 2));
      else console.log(`queued [M#${m.id}] (${m.fromUser}/${m.fromRom} -> ${m.toUser}): "${m.body}"`);
      return 0;
    }

    case 'reply': {
      const [msgId, ...replyParts] = rest;
      const replyBody = replyParts.join(' ');
      if (!msgId || !replyBody) throw new Error('usage: construct reply <msg_id> [--via <messenger>] "<answer>"');
      const m = store.replyMessage(msgId, replyBody, { via: o.via || o.rom, sessionId: o.session });
      if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1') {
        try {
          await store.syncProject(m.project);
        } catch (_) {}
        try {
          store.generateDashboardHtml();
        } catch (_) {}
      }
      if (o.json) console.log(JSON.stringify(m, null, 2));
      else console.log(`replied to [M#${m.id}] (${m.toUser}/${m.replyRom} -> ${m.fromUser}/${m.fromRom}): "${m.replyBody}"`);
      return 0;
    }

    case 'ack': {
      if (!rest[0]) throw new Error('usage: construct ack <msg_id>');
      const m = store.ackMessage(rest[0]);
      if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1') {
        try {
          store.generateDashboardHtml();
        } catch (_) {}
      }
      if (o.json) console.log(JSON.stringify(m, null, 2));
      else console.log(`acknowledged delivery of [M#${m.id}]`);
      return 0;
    }

    case 'purge-msg':
    case 'msg-purge': {
      const ids = rest.join(',').split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length) throw new Error('usage: construct purge-msg <msg_id[,msg_id...]>');
      const purged = [];
      for (const id of ids) {
        purged.push(store.purgeMessage(id));
      }
      if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1') {
        try {
          store.generateDashboardHtml();
        } catch (_) {}
      }
      if (o.json) console.log(JSON.stringify(purged, null, 2));
      else console.log(`purged ${purged.length} message(s) from everywhere: ${purged.map((m) => `[M#${m.id}]`).join(', ')}`);
      return 0;
    }

    case 'hide-msg':
    case 'msg-hide':
    case 'rm-msg':
    case 'msg-rm':
    case 'delete-msg': {
      const ids = rest.join(',').split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length) throw new Error('usage: construct hide-msg <msg_id[,msg_id...]>');
      const hidden = [];
      for (const id of ids) {
        hidden.push(store.hideMessage(id));
      }
      if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1') {
        try {
          store.generateDashboardHtml();
        } catch (_) {}
      }
      if (o.json) console.log(JSON.stringify(hidden, null, 2));
      else console.log(`hidden ${hidden.length} message(s): ${hidden.map((m) => `[M#${m.id}]`).join(', ')}`);
      return 0;
    }

    case 'inbox':
    case 'messages': {
      const msgs = store.listMessages({
        project: o.project || rest[0],
        toUser: o.to,
        status: o.hidden ? 'hidden' : o.status,
        includeHidden: Boolean(o.all || o.hidden),
      });
      if (o.json) {
        console.log(JSON.stringify(msgs, null, 2));
      } else if (!msgs.length) {
        console.log('(no construct messages)');
      } else {
        for (const m of msgs) {
          const replyStr = m.replyBody ? ` -> reply (${m.replyRom}): "${m.replyBody}"` : '';
          console.log(`[M#${m.id}] [${m.status}] ${m.fromUser}/${m.fromRom} -> ${m.toUser} (${m.project}): "${m.body}"${replyStr}`);
        }
      }
      return 0;
    }

    case 'did':
    case 'identity': {
      const id = store.getIdentity();
      if (o.json) console.log(JSON.stringify({ did: id.did, signPub: id.signPub, dhPub: id.dhPub, created: id.created }, null, 2));
      else console.log(`DID: ${id.did}\nCreated: ${id.created}`);
      return 0;
    }

    case 'invite': {
      if (!rest[0]) throw new Error('usage: construct invite <project> [--dir <repo_dir>] [--relays wss://...] [--git-url ..] [--branch ..] [--setup "cmd1,cmd2"]');
      const res = store.createInvite(rest[0], {
        repoDir: o.dir,
        relays: o.relays,
        gitUrl: o['git-url'],
        branch: o.branch,
        setup: o.setup,
      });
      if (o.json) console.log(JSON.stringify(res, null, 2));
      else {
        const gitInfo = res.gitUrl ? ` | repo: ${res.gitUrl}${res.branch ? `#${res.branch}` : ''}` : '';
        console.log(`DIDComm v2 + MLS Invite for ${res.project} (group ${res.groupId}, epoch ${res.epoch}${gitInfo}):\n${res.inviteUri}`);
      }
      return 0;
    }

    case 'join': {
      if (!rest[0]) throw new Error('usage: construct join <construct://invite/...> [--dir <target_dir>]');
      const res = store.joinInvite(rest[0], { targetDir: o.dir });
      if (o.json) console.log(JSON.stringify(res, null, 2));
      else {
        const cloneInfo = res.cloned ? ` | cloned ${res.gitUrl} -> ${res.targetDir}` : '';
        const ldkInfo = res.assimilated?.found ? ` | assimilated ${res.assimilated.gotchasImported} LDK gotcha(s)` : '';
        console.log(
          `joined MLS group ${res.group.groupId} for "${res.group.project}" (epoch ${res.group.epoch}, invited by ${res.inviter.name} [${res.inviter.did}]${cloneInfo}${ldkInfo})`
        );
      }
      return 0;
    }

    case 'sync': {
      const project = rest[0] || o.project;
      if (!project) throw new Error('usage: construct sync <project> [--relays wss://...]');
      return store.syncProject(project, { relays: o.relays }).then((res) => {
        if (o.json) console.log(JSON.stringify(res, null, 2));
        else {
          console.log(
            `synced ${res.project} (MLS group ${res.groupId}, epoch ${res.epoch}): fetched ${res.packetsFetched} packet(s), merged ${res.mergedOps} new CRDT op(s), pushed ${res.pushedOps} op(s) to ${res.relaysAcked}/${res.relays.length} relay(s)`
          );
        }
        return 0;
      });
    }

    case 'relay': {
      const port = o.port ? Number(o.port) : 8787;
      return store.startLocalRelayServer(port).then((srv) => {
        console.log(`construct zero-knowledge ciphertext relay listening on ${srv.url}`);
        return new Promise(() => {}); // keep alive
      });
    }

    case 'packet': {
      const sub = rest[0];
      if (sub === 'export') {
        if (!rest[1]) throw new Error('usage: construct packet export <project> [--since <hlc>]');
        const res = store.exportEncryptedPacket(rest[1], { sinceHlc: o.since });
        if (o.json) console.log(JSON.stringify(res, null, 2));
        else console.log(res.token);
        return 0;
      }
      if (sub === 'import') {
        if (!rest[1]) throw new Error('usage: construct packet import <construct://packet/...>');
        const res = store.importEncryptedPacket(rest.slice(1).join(' '));
        if (o.json) console.log(JSON.stringify(res, null, 2));
        else console.log(`imported MLS packet for ${res.project} from ${res.senderDid}: ${res.appliedOps}/${res.totalOps} new CRDT op(s) merged`);
        return 0;
      }
      throw new Error('usage: construct packet export <project> | import <packet>');
    }

    default:
      throw new Error(`unknown command "${cmd}". Try: construct help`);
  }
}

(async () => {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
})();
