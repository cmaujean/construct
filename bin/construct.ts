#!/usr/bin/env node
// Command-line access to the construct: sequential memory tape, project heads,
// swappable Personality ROMs, operator agreements, and machine/project gotchas.

'use strict';

const { parseArgs } = require('node:util');
const fs = require('node:fs');
const store = require('../src/store.ts');
const mcp = require('../src/mcp.ts');

const USAGE = `CONSTRUCT-LATTICE: Sequential Memory Tape, 15 Crew Banks (179 ROMs) & Causal Lattice Sync
usage: construct <command> [args] [options]    (In-session: /construct <command> [args])
       construct help <command>                (Detailed flags & examples: /construct help <command>)

SETUP, SELF-UPDATE & ASSIMILATION
  init [--rom <name>] [--dir <cfg_dir>]    Initialize DID identity, DB, 179 ROMs & OpenCode V2 plugin
  upgrade [--check]                        Pull origin/main, reseed ROMs & refresh OpenCode plugin
  reload                                   Re-stamp configs & hot-reload plugin engine in memory (/construct)
  assimilate [<dir>] [--project <proj>]    Import AGENTS.md, CLAUDE.md, GEMINI.md & .cursorrules into DB

SEQUENTIAL TAPE, PROVENANCE & GITHUB
  boot [<project>] [-n <limit>]            Full project briefing: Crew, head, tape, gotchas, claims & comms
  projects (ls) [--json]                   List all tracked projects with frame counts, open threads & state
  head [<project>] [--state ".."]          Inspect or update a project's live state head and next step
  rec <proj> <kind> "<summary>" [opts]     Record a frame (${store.KINDS.join(', ')})
  resolve <seq[,seq]> [--reason ".."]      Close open thread/intent frame(s) (add --close-gh for GitHub)
  reopen <seq>                             Reopen a previously resolved frame
  edit <seq> [--summary ".."]              Correct an existing frame out loud and refresh FTS5 index
  tape [<project>] [-n 30] [--open]        Chronological playback of the sequential tape (oldest -> newest)
  zoom <seq> [-w 3]                        Inspect frame #<seq> in full detail with causal chain & neighbors
  search "<query>" [--project <proj>]      Full-text FTS5 BM25 search across the sequential tape
  why "<file_or_symbol>" [--ask <user>]    Unified provenance across gotchas, CRDT tape authors & git log -S
  issues [sync | publish <seq>]            Sync GitHub Issues into [OPEN] threads or publish a local thread
  pr [sync | open | review | merge]        Drive GitHub Pull Requests with automatic #seq & Courier dispatches

CREW BANKS, PERSONALITY ROMS, OPERATORS & GOTCHAS
  <bank>  |  sub <specialist>              Quick-switch Crew Bank (/construct nightcity) or sub Bench second
  rom [packs | list | show | use | sub]    List or slot the 15 Crew Banks (179 ROMs) & Bench seconds
  rom [default | tune | burn | unburn]     Set default ROM, tune 0..1 behavioral dials, or burn directives
  rom [set | clone | sync]                 Create/clone custom ROMs or recompile active-rom.md
  user [show | list | use | set <id>]      Inspect or update operator working agreements & calibration
  gotcha [list | add | search | rm]        Manage global & project gotchas (with --guard "<regex>" shell guards)

PERSON-TO-PERSON COURIER COMMS & ENCRYPTED CRDT SYNC
  msg --to <user> [--via <rom>] "<text>"   Send an in-character Courier message across shared groups
  reply <msg_id> [--via <rom>] "<text>"    Reply to an incoming Courier message
  inbox [--all | --hidden]                 List pending, replied, delivered, or hidden Courier messages
  ack <id> | hide-msg <id> | purge-msg     Acknowledge, hide from HUD, or obliterate message(s) via tombstone
  drop [<proj>] --to <user> [--git-diff]   Send an encrypted file or git-diff patch drop over Comms
  apply-drop <msg_id> [--apply]            Write or git-apply an incoming encrypted patch drop
  invite [comms | <project>]               Generate a signed 256-bit AEAD out-of-band invitation URI
  join "<construct://invite/...>"          Verify and join a project or @comms invite (auto-clones repo)
  sync [<project> | comms]                 Live 1-RTT IBLT set reconciliation + rANS CRDT merge over relays
  compact <project>                        Compact superseded LWW CRDT ops while preserving Merkle frontier
  bench-lattice [--ops 40]                 Run empirical benchmark (Legacy JSON/REQ vs Causal Lattice)
  did  |  hud  |  dashboard  |  site       Show did:key, status pill, HTML HUD, or generate 17-page Docs Hub
  relay [--port 8787]                      Run zero-knowledge WebSocket relay with 1-RTT IBLT sync support

Run "construct help <command>" or "construct <command> --help" (in-session: "/construct help <command>")
for detailed options and examples on any subcommand.`;

const COMMAND_HELP_ALIASES = Object.freeze({
  'self-update': 'upgrade',
  ls: 'projects',
  record: 'rec',
  find: 'search',
  issue: 'issues',
  prs: 'pr',
  status: 'hud',
  view: 'dashboard',
  pack: 'rom',
  packs: 'rom',
  operator: 'user',
  gotchas: 'gotcha',
  ask: 'msg',
  'msg-hide': 'hide-msg',
  'rm-msg': 'hide-msg',
  'msg-rm': 'hide-msg',
  'delete-msg': 'hide-msg',
  'msg-purge': 'purge-msg',
  messages: 'inbox',
  identity: 'did',
  'docs-site': 'site',
  'hot-reload': 'reload',
  bench: 'bench-lattice',
});

const COMMAND_HELP = Object.freeze({
  init: `NAME
  construct init - Initialize Construct identity, database, 179 ROMs, and OpenCode V2 plugin

SYNOPSIS
  construct init [--rom <name>] [--dir <config_dir>] [--json]
  /construct init

DESCRIPTION
  Generates local W3C did:key identity, seeds all 15 Crew Banks (179 ROMs) in construct.db,
  assimilates any existing global instruction files, installs the OpenCode V2 plugin, and
  compiles active-rom.md.

OPTIONS
  --rom <name>        Set initial active ROM or Crew Bank (default: crew)
  --dir <path>        Override OpenCode config directory (default: ~/.config/opencode)
  --json              Emit machine-readable JSON result

EXAMPLES
  construct init
  /construct init`,

  upgrade: `NAME
  construct upgrade - Check for or pull upstream Construct updates and refresh all agent integrations

SYNOPSIS
  construct upgrade [--check] [--dir <config_dir>] [--json]
  /construct upgrade [--check]

DESCRIPTION
  Fast-forward pulls origin/main in the Construct repository, reseeds all built-in ROMs,
  recompiles active-rom.md, refreshes all configured agent plugins/extensions/subagents,
  and (when invoked via /construct upgrade in OpenCode) hot-reloads the plugin engine in memory.

OPTIONS
  --check             Check origin/main for new commits without pulling or modifying files
  --dir <path>        Override OpenCode config directory
  --json              Emit machine-readable JSON result

EXAMPLES
  construct upgrade --check
  construct upgrade
  /construct upgrade`,

  reload: `NAME
  /construct reload - Re-stamp agent configs and hot-reload Construct MCP/plugin engine in memory

SYNOPSIS
  /construct reload

DESCRIPTION
  In-session slash command that runs "construct init --all", clears Node's module cache for src/*,
  reloads the shared MCP/hook engine in memory, and triggers ctx.tool.reload() without restarting OpenCode.`,

  assimilate: `NAME
  construct assimilate - Import existing repository instruction files into construct.db

SYNOPSIS
  construct assimilate [<dir>] [--project <proj>] [--remove-files] [--json]
  /construct assimilate [--project <proj>]

DESCRIPTION
  Scans <dir> (default: current working directory) for AGENTS.md, CLAUDE.md, GEMINI.md,
  .cursorrules, and .github/copilot-instructions.md, extracting operator agreements,
  gotchas, and script commands into construct.db and shadowing unchanged files.

OPTIONS
  --project <proj>    Override target project scope (default: auto-resolved from <dir> or global)
  --remove-files      Delete assimilated instruction files from disk after import
  --json              Emit machine-readable JSON result

EXAMPLES
  construct assimilate
  construct assimilate ~/src/acme/alpha_app --project acme/alpha_app`,

  boot: `NAME
  construct boot - Print full session boot briefing for a project

SYNOPSIS
  construct boot [<project>] [-n <tape_len>] [--session <id>] [--dir <path>] [--json]
  /construct boot [-n <tape_len>]

DESCRIPTION
  Prints the active Crew/ROM, operator agreement summary, project state head, recent
  sequential tape frames, project gotchas, active work claims & collision radar, open
  threads, and pending Construct Courier dispatches.

OPTIONS
  -n, --limit <num>   Number of recent sequential tape frames to include (default: 25)
  --session <id>      Session ID for session-isolated ROM resolution
  --dir <path>        Resolve project key automatically from directory path
  --json              Emit machine-readable JSON result

EXAMPLES
  construct boot construct -n 10
  construct boot --dir .
  /construct boot -n 15`,

  projects: `NAME
  construct projects (alias: ls) - List all tracked projects in construct.db

SYNOPSIS
  construct projects [--session <id>] [--json]
  construct ls [--json]
  /construct projects

DESCRIPTION
  Lists every project in construct.db with last-updated date, total frame count,
  open thread count, and first line of the current state head.

OPTIONS
  --session <id>      Include session ROM prompt header if unslotted
  --json              Emit machine-readable JSON array`,

  rec: `NAME
  construct rec (alias: record) - Append a frame onto the sequential memory tape

SYNOPSIS
  construct rec <project> <kind> "<summary>" [options]
  /construct rec <project> <kind> "<summary>" [options]

DESCRIPTION
  Records a monotonic frame onto the sequential tape and appends a signed CRDT operation.
  Valid kinds: ${store.KINDS.join(', ')}.
  Note: "thread" frames and "intent" frames with --refs open automatically (open=1).
  Recording a "commit", "change", "release", or "dead_end" frame with --parent <intent_seq>
  automatically resolves that parent intent claim.

OPTIONS
  --detail <text>     Detailed evidence, root cause, metrics, or context
  --verified <text>   Verification layer (e.g. "unit tests 10/10", "live device")
  --parent <seq>      Causal parent frame sequence number (#seq)
  --resolves <seqs>   Comma-separated open frame #seq IDs resolved by this frame
  --open              Mark frame as open ([OPEN]) regardless of kind
  --closed            Mark frame as closed (open=0) even if kind is "thread" or "intent"
  --refs <a,b>        Comma-separated file, issue (#N), PR (pr:#N), or commit refs
  --ts <iso>          Override ISO-8601 timestamp
  --json              Emit machine-readable JSON result

EXAMPLES
  construct rec acme/app intent "Refactoring token refresh" --refs "src/auth.ts,#114"
  construct rec acme/app commit "Shipped token refresh fix" --parent 42 --verified "npm test"
  /construct rec construct finding "Verified omp hook latency at 3.8ms"`,

  head: `NAME
  construct head - Inspect or update a project's live state head

SYNOPSIS
  construct head [<project>] [--state "<text>"] [--next "<text>"] [--repo <path>] [--dir <path>] [--json]
  /construct head [--state "<text>"] [--next "<text>"]

DESCRIPTION
  When called with no --state/--next/--repo flags, prints the current state head for <project>
  (or the project resolved from --dir). When called with flags, updates the LWW state head.

OPTIONS
  --state <text>      Current truth of where the project stands (2-5 lines)
  --next <text>       Immediate next step or priority
  --repo <path>       Local checkout path for this repository
  --dir <path>        Resolve project key from directory when <project> is omitted
  --ts <iso>          Override ISO-8601 timestamp
  --json              Emit machine-readable JSON result

EXAMPLES
  construct head construct
  construct head construct --state "Main green at c80b894" --next "Cut v0.2 release"
  /construct head`,

  resolve: `NAME
  construct resolve - Close one or more open thread or intent frames

SYNOPSIS
  construct resolve <seq[,seq...]> [--by <seq>] [--reason "<text>"] [--verified "<layer>"] [--close-gh] [--dir <repo_dir>] [--json]
  /construct resolve <seq[,seq...]> [--reason "<text>"]

DESCRIPTION
  Marks open frame(s) as resolved. If --reason is provided without --by, records a new
  resolution frame and links resolved_by -> new_seq.

OPTIONS
  --by <seq>          Existing frame #seq that resolved the target frame(s)
  --reason <text>     Record a new resolution frame with this summary
  --detail <text>     Optional detail for the new resolution frame
  --verified <text>   Verification layer for the resolution frame
  --kind <kind>       Kind for the new resolution frame (default: finding)
  --close-gh          Also close any linked gh:#N GitHub issues via "gh issue close"
  --dir <path>        Repository directory for --close-gh
  --json              Emit machine-readable JSON result

EXAMPLES
  construct resolve 28,29 --by 35
  construct resolve 42 --reason "Verified live on Android build" --verified "pixel 8" --close-gh`,

  reopen: `NAME
  construct reopen - Reopen a previously resolved frame

SYNOPSIS
  construct reopen <seq> [--json]
  /construct reopen <seq>

DESCRIPTION
  Sets open=1 and clears resolved_by on frame #<seq>.`,

  edit: `NAME
  construct edit - Correct an existing frame on the sequential tape out loud

SYNOPSIS
  construct edit <seq> [--summary "<text>"] [--detail "<text>"] [--verified "<text>"] [--kind <kind>] [--parent <seq>] [--refs <a,b>] [--json]
  /construct edit <seq> --summary "<text>"

DESCRIPTION
  Updates fields on frame #<seq> in place and refreshes the FTS5 search index.`,

  tape: `NAME
  construct tape - Sequential playback of the memory tape (oldest -> newest)

SYNOPSIS
  construct tape [<project>] [-n <limit>] [--kind <kind>] [--open] [--from <seq>] [--to <seq>] [--since <iso>] [--dir <path>] [--json]
  /construct tape [-n <limit>] [--open]

DESCRIPTION
  Prints sequential frames in chronological order within the requested window.

OPTIONS
  -n, --limit <num>   Maximum number of frames to return (default: 30)
  --project <proj>    Filter to a specific project
  --dir <path>        Auto-resolve project filter from directory when <project> is omitted
  --kind <kind>       Filter by frame kind (${store.KINDS.join(', ')})
  --open              Only show open ([OPEN]) frames
  --from <seq>        Minimum sequence number (inclusive)
  --to <seq>          Maximum sequence number (inclusive)
  --since <iso>       Minimum ISO timestamp/date (e.g. 2026-10-19)
  --json              Emit machine-readable JSON array

EXAMPLES
  construct tape construct -n 15
  construct tape --open
  /construct tape -n 10`,

  zoom: `NAME
  construct zoom - Inspect a frame's full detail, causal chain, and neighboring tape window

SYNOPSIS
  construct zoom <seq> [-w <window>] [--json]
  /construct zoom <seq> [-w <window>]

DESCRIPTION
  Shows full unclipped detail, verification notes, refs, causal ancestor/descendant chain,
  and +/- <window> neighboring frames on the same project tape.

OPTIONS
  -w, --window <num>  Number of neighboring frames before and after #<seq> (default: 3)
  --json              Emit machine-readable JSON result

EXAMPLES
  construct zoom 279
  construct zoom 279 -w 5
  /construct zoom 279`,

  search: `NAME
  construct search (alias: find) - Full-text BM25 search across the sequential tape

SYNOPSIS
  construct search "<query>" [--project <proj>] [--kind <kind>] [--open] [-n <limit>] [--json]
  /construct search "<query>" [--project <proj>]

DESCRIPTION
  Searches frame summaries, details, verification notes, and refs via SQLite FTS5 BM25.

OPTIONS
  --project <proj>    Restrict search to one project
  --kind <kind>       Restrict search to one frame kind
  --open              Only match open ([OPEN]) frames
  -n, --limit <num>   Maximum hits to return (default: 20)
  --json              Emit machine-readable JSON array

EXAMPLES
  construct search "shell guard" --project construct
  /construct search "OAuth"`,

  why: `NAME
  construct why - Unified provenance lookup across gotchas, CRDT tape authors, and git log -S

SYNOPSIS
  construct why "<file_or_symbol>" [--project <proj>] [--dir <repo_dir>] [--ask <teammate>] [--json]
  /construct why "<file_or_symbol>"

DESCRIPTION
  Searches gotchas, sequential tape frames (with CRDT operator attribution), and local
  "git log -S" pickaxe history for <file_or_symbol>. If --ask <user> is passed and no local
  provenance is found, dispatches a Courier query to that teammate.

OPTIONS
  --project <proj>    Project scope (default: resolved from --dir)
  --dir <path>        Repository directory for git log -S
  --ask <user>        Teammate operator ID to query over Comms if local provenance is empty
  --json              Emit machine-readable JSON result

EXAMPLES
  construct why validateShellCommand
  /construct why resolveSubagentRomFromHookPayload`,

  rom: `NAME
  construct rom (aliases: pack, packs) - Manage Crew Banks, Bench substitutions, solo ROMs, and dials

SYNOPSIS
  construct rom [show [<name>]] [--json]
  construct rom packs [--json]
  construct rom list [--pack <bank>] [--json]
  construct rom use <bank|roster|rom> [--session <id>] [--project <proj>] [--dir <path>]
  construct rom sub <backup_specialist> [--session <id>] [--project <proj>] [--dir <path>]
  construct rom default <bank|rom|off>
  construct rom tune <dial>=<0..1> [...] [--rom <name>]
  construct rom burn "<directive>" [--rom <name>]
  construct rom unburn <number> [--rom <name>]
  construct rom set <name> [--pack ..] [--seat ..] [--tier primary|backup] [--handle ..] [--tagline ..] [--voice ..] [--use]
  construct rom clone <src> <dest> [--pack ..] [--seat ..] [--tier ..] [--handle ..] [--use]
  construct rom sync

DESCRIPTION
  Controls the 15 lazy-loaded Crew Banks (sprawl, nightcity, anathem, cryptonomicon, shadowrun,
  dresden, amber, laundry, tolkien, discworld, reamde, irondruid, prydain, clockwork, generic)
  and 179 specialist ROMs.

OPTIONS
  --pack <bank>       Filter "rom list" by bank, or assign bank on "rom set/clone"
  --seat <seat>       Seat ID (recon, diagnostics, architect, blitz, forensics, velocity, redteam, ergonomics, archivist)
  --tier <tier>       Tier (primary or backup)
  --session <id>      Target session ID for isolated session slotting
  --project <proj>    Target project scope
  --rom <name>        Target ROM for tune/burn/unburn
  --json              Emit machine-readable JSON result

EXAMPLES
  construct rom packs
  construct rom use nightcity
  construct rom sub panam
  construct rom tune terse=0.90 edge=0.85 --rom v
  /construct rom list --pack nightcity`,

  user: `NAME
  construct user (alias: operator) - Manage operator working agreements and personal calibration

SYNOPSIS
  construct user [show [<id>]] [--json]
  construct user list [--json]
  construct user use <id>
  construct user set <id> [--name ".."] [--os-users a,b] [--experience ".."] [--platform ".."] [--workspace-root ".."] [--calibration ".."] [--use]

OPTIONS
  --name <name>             Display name (e.g. "Christopher")
  --os-users <list>         Comma-separated OS login usernames mapped to this operator
  --experience <text>       Engineering background summary
  --platform <text>         OS, shell, and hardware environment summary
  --workspace-root <path>   Default root folder for git repositories (e.g. ~/src)
  --calibration <markdown>  Personal working agreement bullets
  --use                     Make this operator active immediately
  --json                    Emit machine-readable JSON result

EXAMPLES
  construct user show
  /construct user show`,

  gotcha: `NAME
  construct gotcha (alias: gotchas) - Manage global and project gotchas with 0-token shell guards

SYNOPSIS
  construct gotcha list [--project <proj> | --all] [--json]
  construct gotcha add "<title>" [--project <proj>] [--status observed|from_source|reported] [--evidence ".."] [--fix ".."] [--guard "<regex>"] [--guard-os all|win32|linux|darwin] [--tags a,b]
  construct gotcha search "<query>" [--project <proj> | --all] [--json]
  construct gotcha rm <id>

OPTIONS
  --project <proj>    Project scope (omit for global machine/tool gotchas)
  --all               Include gotchas across all projects and global scope
  --status <status>   Verification status: observed (default), from_source, or reported
  --evidence <text>   Exact machine observation, error log, or commit evidence
  --fix <text>        "Do instead" remediation instruction
  --guard <regex>     Pre-execution shell guard regex (blocks matching commands in 0 tokens)
  --guard-os <os>     Target OS for --guard: all (default), win32, linux, or darwin
  --tags <a,b>        Comma-separated tags
  --json              Emit machine-readable JSON result

EXAMPLES
  construct gotcha list --all
  construct gotcha add "Never run deploy --yolo" --project acme/app --fix "Use ./release.sh" --guard "deploy\\s+--yolo"
  /construct gotcha search "PowerShell"`,

  msg: `NAME
  construct msg (alias: ask) - Send an encrypted person-to-person Courier message

SYNOPSIS
  construct msg --to <user> [--via <courier_rom>] [--project <proj>] "<in-character message>"
  /construct msg --to <user> [--via <courier_rom>] "<message>"

OPTIONS
  --to <user>         Recipient operator ID (required, e.g. mike)
  --via <rom>         Courier specialist ROM to deliver the cameo (e.g. toot, smeagol, death, moist)
  --project <proj>    Optional project label (routes over @comms and shared groups automatically)
  --session <id>      Source session ID
  --json              Emit machine-readable JSON result

EXAMPLES
  construct msg --to mike --via smeagol "We merged PR #4 into main, precious!"
  /construct msg --to mike --via toot "PR #12 is ready for review!"`,

  reply: `NAME
  construct reply - Reply to an incoming Construct Courier message

SYNOPSIS
  construct reply <msg_id> [--via <courier_rom>] "<in-character reply>"
  /construct reply <msg_id> [--via <courier_rom>] "<reply>"`,

  ack: `NAME
  construct ack - Mark a Construct Courier message as delivered/acknowledged

SYNOPSIS
  construct ack <msg_id> [--json]
  /construct ack <msg_id>`,

  'hide-msg': `NAME
  construct hide-msg (aliases: msg-hide, rm-msg, delete-msg) - Hide message(s) from HUD and boot

SYNOPSIS
  construct hide-msg <msg_id[,msg_id...]> [--json]
  /construct hide-msg <msg_id>

DESCRIPTION
  Hides message(s) from the active HUD and boot output while keeping them searchable via
  "construct inbox --all" and preventing relay syncs from resurrecting them.`,

  'purge-msg': `NAME
  construct purge-msg (alias: msg-purge) - Obliterate message(s) locally and across relays

SYNOPSIS
  construct purge-msg <msg_id[,msg_id...]> [--json]
  /construct purge-msg <msg_id>

DESCRIPTION
  Deletes message(s) from local SQLite and broadcasts a signed CRDT message_tombstone across relays.`,

  inbox: `NAME
  construct inbox (alias: messages) - List person-to-person Construct Courier messages

SYNOPSIS
  construct inbox [--project <proj>] [--to <user>] [--status pending|replied|delivered|hidden] [--all | --hidden] [--json]
  /construct inbox [--all]

OPTIONS
  --project <proj>    Filter by project tag
  --to <user>         Filter by recipient operator ID
  --status <status>   Filter by status (pending, replied, delivered, hidden)
  --all               Include hidden messages
  --hidden            Show only hidden messages
  --json              Emit machine-readable JSON array`,

  drop: `NAME
  construct drop - Send an encrypted patch or file snippet over Construct Comms

SYNOPSIS
  construct drop [<project>] --to <user> [--via <courier>] [--file <path> | --git-diff | --content ".."] [--note ".."] [--json]`,

  'apply-drop': `NAME
  construct apply-drop - Inspect, write, or git-apply an incoming encrypted patch drop

SYNOPSIS
  construct apply-drop <msg_id> [--out <file> | --apply] [--dir <repo_dir>] [--json]`,

  issues: `NAME
  construct issues (alias: issue) - Sync GitHub Issues with open Construct threads

SYNOPSIS
  construct issues sync [<project>] [--dir <repo_dir>] [-n <limit>] [--json]
  construct issues publish <seq> [--dir <repo_dir>] [--json]
  /construct issues sync

DESCRIPTION
  "sync" imports open GitHub issues as [OPEN] thread frames (gh:#N) and resolves threads whose
  GitHub issue closed. "publish <seq>" promotes a local thread frame to a new GitHub issue.`,

  pr: `NAME
  construct pr (alias: prs) - Sync, open, review, and merge GitHub Pull Requests

SYNOPSIS
  construct pr sync [<project>] [--dir <repo_dir>] [-n <limit>] [--json]
  construct pr open [<project>] --title "<title>" [--body ".."] [--base <branch>] [--head <branch>] [--draft] [--to <user>] [--via <courier>]
  construct pr review [<project>] <pr_num> [--approve | --request-changes | --comment] --body "<note>" [--verified ".."] [--to <user>] [--via <courier>]
  construct pr merge [<project>] <pr_num> [--squash | --rebase | --merge] [--delete-branch] [--verified ".."] [--to <user>] [--via <courier>]
  /construct pr sync`,

  sync: `NAME
  construct sync - Live pull, decrypt, HLC-CRDT merge, seal, and push over WebSocket relays

SYNOPSIS
  construct sync [<project>|comms] [--relays wss://...] [--dir <repo_dir>] [--json]
  /construct sync [<project>|comms]

DESCRIPTION
  Pulls encrypted Epoch-Keyed AEAD packets from configured WebSocket relays (plus @comms),
  verifies Ed25519 sender signatures and inner AAD, converges @comms keys in-band across
  paired project groups, merges HLC-CRDT operations, and pushes new local delta operations.`,

  invite: `NAME
  construct invite - Generate a signed out-of-band project or @comms invitation URI

SYNOPSIS
  construct invite [comms | <project>] [--relays wss://...] [--dir <repo_dir>] [--git-url <url>] [--branch <name>] [--setup "<cmd>"] [--json]
  /construct invite [comms | <project>]`,

  join: `NAME
  construct join - Verify and join a Construct invitation URI (with auto git-clone)

SYNOPSIS
  construct join "<construct://invite/...>" [--dir <target_clone_dir>] [--json]
  /construct join "<construct://invite/...>"`,

  did: `NAME
  construct did (alias: identity) - Display local W3C did:key cryptographic identity

SYNOPSIS
  construct did [--json]
  /construct did`,

  hud: `NAME
  construct hud (alias: status) - Print compact status pill, refresh HTML HUD, or output JSON snapshot

SYNOPSIS
  construct hud [reload|refresh|<project>] [--dir <repo_dir>] [--session <session_id>] [--json]
  /construct hud [reload]`,

  dashboard: `NAME
  construct dashboard (alias: view) - Generate dark-mode interactive HTML HUD files

SYNOPSIS
  construct dashboard [reload|refresh] [--out <html_path>] [--project <proj>] [--dir <repo_dir>] [--session <session_id>] [--json]
  /construct dashboard`,

  'hud-server': `NAME
  construct hud-server - Run or restart the local loopback HUD & Docs server on 127.0.0.1:47420

SYNOPSIS
  construct hud-server [--port 47420] [--restart]`,

  site: `NAME
  construct site (alias: docs-site) - Generate the 17-page GitHub Pages Brochure & Docs Hub

SYNOPSIS
  construct site [--out <dir>] [--json]
  /construct site`,

  relay: `NAME
  construct relay - Run a lightweight zero-knowledge WebSocket ciphertext relay

SYNOPSIS
  construct relay [--port 8787]`,

  packet: `NAME
  construct packet - Export or import offline encrypted CRDT packets

SYNOPSIS
  construct packet export <project> [--since <hlc>]
  construct packet import <packet_token>`,

  compact: `NAME
  construct compact - Compact superseded LWW CRDT operations while preserving the 64-bit Merkle frontier

SYNOPSIS
  construct compact <project> [--json]`,

  'bench-lattice': `NAME
  construct bench-lattice (alias: bench) - Run empirical head-to-head benchmark (Legacy JSON/REQ vs Causal Lattice)

SYNOPSIS
  construct bench-lattice [--n <ops>] [--json]`,
});

function formatCommandHelp(rawTopic = '') {
  const clean = String(rawTopic || '').trim().replace(/^\/+/, '').toLowerCase();
  if (!clean) return USAGE;
  const canonical = COMMAND_HELP_ALIASES[clean] || clean;
  if (COMMAND_HELP[canonical]) {
    return COMMAND_HELP[canonical];
  }
  return `Unknown Construct command "${rawTopic}".\n\n${USAGE}`;
}

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
  omp: { type: 'boolean' },
  'oh-my-pi': { type: 'boolean' },
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
  restart: { type: 'boolean' },
  rotate: { type: 'boolean' },
  daemon: { type: 'boolean' },
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
    activeClaims = [],
    refCollisions = [],
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

  if (activeClaims.length || refCollisions.length) {
    console.log(
      `\nACTIVE WORK CLAIMS & COLLISION RADAR (${activeClaims.length} intent claim(s), ${refCollisions.length} ref collision(s)):`
    );
    for (const col of refCollisions) {
      const claimants = col.frames
        .map((f) => `#${f.seq} (${f.authorUser}/${f.kind}: ${f.summary})`)
        .join(' <-> ');
      console.log(`  [!] COLLISION on ref "${col.ref}": ${claimants}`);
    }
    for (const c of activeClaims) {
      const refsStr = c.refs && c.refs.length ? `  (${c.refs.join(', ')})` : '';
      console.log(`  [CLAIM #${c.seq}] (${c.authorUser || 'local'}/intent) ${c.summary}${refsStr}`);
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

  if (!cmd) {
    console.log(USAGE);
    return 0;
  }
  if (cmd === 'help') {
    console.log(formatCommandHelp(rest[0] || ''));
    return 0;
  }
  if (o.help) {
    console.log(formatCommandHelp(cmd));
    return 0;
  }

  switch (cmd) {
    case 'reload':
    case 'hot-reload':
    case 'init': {
      const isReloadCmd = cmd === 'reload' || cmd === 'hot-reload';
      const res = store.initConstruct({
        rom: o.rom || rest[0],
        configDir: o.dir,
      });
      if (isReloadCmd) {
        try {
          store.generateDashboardHtml({ sessionId: o.session, project: o.project, dir: o.dir });
        } catch (_) {}
        try {
          const pocketMod = require('../src/pocket.ts');
          const tok = pocketMod.loadOrCreateHudToken();
          await fetch('http://127.0.0.1:47420/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Construct-Token': tok },
            body: JSON.stringify({ action: 'reload', sessionID: o.session || '', project: o.project || '' }),
            signal: AbortSignal.timeout(1500),
          });
        } catch (_) {}
      }
      if (o.json) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(
          `construct ${isReloadCmd ? 'reloaded' : 'initialized'} (DID: ${res.did}, ROM: ${res.rom}${
            isReloadCmd ? ', plugin & HUD refreshed' : ''
          })`
        );
        console.log(`  plugin:   ${res.pluginPath}`);
        console.log(`  rom file: ${res.romFilePath}`);
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

    case 'compact': {
      const project = rest[0] || o.project || (o.dir ? store.resolveProjectFromDir(o.dir) : '');
      if (!project) throw new Error('usage: construct compact <project>');
      const res = store.compactProjectCrdtLog(project);
      if (o.json) {
        console.log(
          JSON.stringify(
            { ...res, merkleFrontier64: '0x' + res.merkleFrontier64.toString(16) },
            null,
            2
          )
        );
      } else {
        console.log(
          `compacted ${project} CRDT log: ${res.totalBefore} -> ${res.retainedAfter} active op(s) (${res.pruned} superseded pruned, frontier 0x${res.merkleFrontier64.toString(16)})`
        );
      }
      return 0;
    }

    case 'bench-lattice':
    case 'bench': {
      const opsCount = o.limit ? Number(o.limit) : rest[0] ? Number(rest[0]) : 40;
      const report = store.benchLattice({ ops: opsCount });
      if (o.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log('=== CONSTRUCT CAUSAL-LATTICE-EVOLVED (WORLD-TRACK II & III) BENCHMARK ===');
        console.log(
          `1. Wire Batch (${report.opCount} CRDT ops): Legacy JSON ${report.wire.rawJsonBytes}B -> Lattice rANS+Slab ${report.wire.latticeBatchBytes}B (${report.wire.batchCompressionRatio}x smaller)`
        );
        console.log(
          `2. Sealed MLS Envelope: Legacy ${report.wire.legacyEnvelopeBytes}B -> Lattice ${report.wire.latticeEnvelopeBytes}B (${report.wire.envelopeCompressionRatio}x smaller)`
        );
        console.log(
          `3. World-Track III Evolved Branchless ROM Arena (${report.hotArenaReadNs.romCount} ROMs, collisions=${report.hotArenaReadNs.circuitCollisions}): SQLite+JSON ${report.hotArenaReadNs.sqliteSelectAndJsonParseNs}ns -> Evolved Circuit ${report.hotArenaReadNs.evolvedBranchlessArenaReadNs}ns (${report.hotArenaReadNs.speedupFactor}x faster)`
        );
        console.log(
          `4. World-Track III Evolved Cross-Field Predictor (${report.evolvedPredictor.trajectorySteps} steps): WT-II ${report.evolvedPredictor.worldTrack2Bytes}B -> Evolved ${report.evolvedPredictor.worldTrack3EvolvedBytes}B (${report.evolvedPredictor.bitsPer6FieldState} bits/state, ${report.evolvedPredictor.gainVsWorldTrack2}x smaller than WT-II, ${report.evolvedPredictor.gainVsJsonRaw}x smaller than JSON, lossless=${report.evolvedPredictor.losslessVerified})`
        );
        console.log(
          `5. Zero-Trust Capability Verify: Ed25519 ${report.capabilityGateNs.ed25519VerifyNs}ns -> Chaskey-12 Chain ${report.capabilityGateNs.chaskey12CapabilityVerifyNs}ns (${report.capabilityGateNs.speedupFactor}x faster)`
        );
        console.log(
          `6. 1-RTT IBLT Relay Sync (${report.relaySync.sharedEnvelopes} shared, ${report.relaySync.divergentEnvelopes} diff): Legacy REQ ${report.relaySync.legacyFetchAllBytes}B -> IBLT Sketch ${report.relaySync.ibltSingleRttSketchBytes}B (${report.relaySync.wireSavingsFactor}x less wire traffic, converged=${report.relaySync.peeledIdentically})`
        );
      }
      return 0;
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
                `${p.project.padEnd(28)} ${shortTs(p.updated).padEnd(11)} ${String(p.frameCount).padStart(3)} frames  ${String(p.openCount).padStart(2)} open  ${firstLine}`
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
      const project = rest[0] || o.project || (o.dir ? store.resolveProjectFromDir(o.dir) : '');
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
      const project = rest[0] || o.project || (o.dir ? store.resolveProjectFromDir(o.dir) : undefined);
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
      const subVerb = String(rest[0] || '').toLowerCase();
      const projArg = ['reload', 'refresh', 'restart', 'open', 'show'].includes(subVerb) ? o.project : (o.project || rest[0]);
      const res = store.generateDashboardHtml({ outFile: o.out, sessionId: o.session, dir: o.dir, project: projArg });
      if (o.json) console.log(JSON.stringify({ outFile: res.outFile, projectOutFile: res.projectOutFile, hud: res.hud, projectCount: res.projectCount, openCount: res.openCount }, null, 2));
      else console.log(`dashboard written to ${res.outFile} (${res.projectCount} project(s), ${res.openCount} open thread(s))`);
      return 0;
    }

    case 'hud-server': {
      const port = o.port ? Number(o.port) : 47420;
      const srv = await store.startStandaloneHudServer(port, undefined, { restart: Boolean(o.restart) });
      if (!srv) return 0; // Port already bound by active instance
      return new Promise(() => {}); // Keep alive in background
    }

    case 'pocket': {
      const pocketMod = require('../src/pocket.ts');
      const cfg = pocketMod.loadOrCreatePocketConfig({
        rotate: Boolean(o.rotate),
        relays: o.relays,
      });
      const url = pocketMod.buildPocketPairingUrl(cfg);
      const localUrl = pocketMod.buildPocketPairingUrl(cfg, {
        baseUrl: 'http://127.0.0.1:47420/docs/pocket.html',
      });
      const qrTerm = pocketMod.renderQrCodeTerminal(url);
      if (o.json) {
        console.log(JSON.stringify({ url, localUrl, relays: cfg.relays, created: cfg.created }, null, 2));
      } else {
        console.log('Construct Pocket — Encrypted Mobile Thin-Client Bridge (256-Bit AES-GCM + WebSocket Relays)');
        console.log(`Relays:        ${cfg.relays.join(', ')}`);
        console.log(`Mobile URL:    ${url}`);
        console.log(`Local Preview: ${localUrl}\n`);
        console.log(qrTerm);
        console.log('\nScan the QR code above with your phone camera (or copy the Mobile URL via Signal Note-to-Self).');
      }
      if (o.daemon) {
        pocketMod.startPocketBridge(store, mcp, {
          sessionId: o.session || '',
          dir: o.dir || process.cwd(),
        });
        console.log('Pocket bridge daemon listening on relays...');
        return new Promise(() => {});
      }
      return 0;
    }

    case 'hud':
    case 'status': {
      const subVerb = String(rest[0] || '').toLowerCase();
      const isReloadVerb = ['reload', 'refresh', 'restart', 'open', 'show'].includes(subVerb);
      const projArg = isReloadVerb ? o.project : (rest[0] || o.project);
      if (isReloadVerb) {
        const res = store.generateDashboardHtml({ outFile: o.out, sessionId: o.session, dir: o.dir, project: projArg });
        if (o.json) {
          console.log(JSON.stringify(res.hud));
        } else {
          console.log(res.hud.pill);
        }
        return 0;
      }
      const snap = store.getHudSnapshot({
        project: projArg,
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
              `${p.project.padEnd(28)} ${shortTs(p.updated).padEnd(11)} ${String(p.frameCount).padStart(3)} frames  ${String(p.openCount).padStart(2)} open  ${firstLine}`
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

    case 'use': {
      return handleRomCommand(['use', ...rest], o);
    }

    case 'sub': {
      return handleRomCommand(['sub', ...rest], o);
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
          await store.syncProject('comms');
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
          await store.syncProject('comms');
        } catch (_) {}
        try {
          store.generateDashboardHtml();
        } catch (_) {}
      }
      if (o.json) console.log(JSON.stringify(m, null, 2));
      else console.log(`replied to [M#${m.id}] (${m.toUser}/${m.replyRom} -> ${m.fromUser}/${m.fromRom}): "${m.replyBody}"`);
      return 0;
    }

    case 'seen':
    case 'seen-msg': {
      if (!rest[0]) throw new Error('usage: construct seen <msg_id>');
      const m = store.seenMessage(rest[0]);
      if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1') {
        try {
          await store.syncProject('comms');
        } catch (_) {}
        try {
          store.generateDashboardHtml();
        } catch (_) {}
      }
      if (o.json) console.log(JSON.stringify(m, null, 2));
      else console.log(`marked [M#${m.id}] as seen`);
      return 0;
    }

    case 'ack': {
      if (!rest[0]) throw new Error('usage: construct ack <msg_id>');
      const m = store.ackMessage(rest[0]);
      if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1') {
        try {
          await store.syncProject('comms');
        } catch (_) {}
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

    case 'site':
    case 'docs-site': {
      const res = store.generateDocsSite({ outDir: o.out || o.dir });
      if (o.json) console.log(JSON.stringify(res, null, 2));
      else console.log(`generated Construct docs site in ${res.outDir} (${res.crewPages.length} crew pages + index.html + guide.html)`);
      return 0;
    }

    case 'invite': {
      const targetProj = rest[0] || 'comms';
      const res = store.createInvite(targetProj, {
        repoDir: o.dir,
        relays: o.relays,
        gitUrl: o['git-url'],
        branch: o.branch,
        setup: o.setup,
      });
      if (o.json) console.log(JSON.stringify(res, null, 2));
      else {
        const gitInfo = res.gitUrl ? ` | repo: ${res.gitUrl}${res.branch ? `#${res.branch}` : ''}` : '';
        console.log(`Signed Epoch-Keyed AEAD Invite for ${res.project} (group ${res.groupId}, epoch ${res.epoch}${gitInfo}):\n${res.inviteUri}`);
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
      const project = rest[0] || o.project || (o.dir ? store.resolveProjectFromDir(o.dir) : '') || 'comms';
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

    default: {
      const candidateTarget = [cmd, ...rest].join(',').toLowerCase();
      if (mcp.isValidRomTarget(candidateTarget)) {
        return handleRomCommand(['use', candidateTarget], o);
      }
      throw new Error(`unknown command "${cmd}". Try: construct help`);
    }
  }
}

(async () => {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    try {
      store.closeAllDbs();
    } catch (_) {}
    process.exit(process.exitCode || 0);
  }
})();
