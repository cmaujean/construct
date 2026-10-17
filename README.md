# Construct

***CON-struct** (`/ˈkɒn.strʌkt/`, noun: a recorded personality and memory artifact)*

Sequential memory tape, swappable Personality ROMs, operator working agreements, and encrypted multi-developer sync for [OpenCode](https://opencode.ai).

Inspired by the ROM constructs and Hosaka sequential memory modules in William Gibson's *Sprawl* trilogy.

---

## Table of Contents

1. [What Construct Is (The Crew Paradigm)](#1-what-construct-is-the-crew-paradigm)
2. [One-Prompt Installation](#2-one-prompt-installation)
3. [First Boot: Introducing Yourself & Setting Up Agreements](#3-first-boot-introducing-yourself--setting-up-agreements)
4. [Assimilating Existing Instruction Files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`)](#4-assimilating-existing-instruction-files-agentsmd-claudemd-geminimd)
5. [The Sprawl Crew & Personality ROMs](#5-the-sprawl-crew--personality-roms)
6. [Working Agreements, Rules & Gotchas](#6-working-agreements-rules--gotchas)
7. [The Sequential Memory Tape](#7-the-sequential-memory-tape)
8. [Collaborating: Project Invites, Auto-Clone & Zero Bleed](#8-collaborating-project-invites-auto-clone--zero-bleed)
9. [Construct-to-Construct Comms (ROM-to-ROM Messaging)](#9-construct-to-construct-comms-rom-to-rom-messaging)
10. [Token-Saving Architecture & Smart Model Routing](#10-token-saving-architecture--smart-model-routing)
11. [How It Works Under the Hood](#11-how-it-works-under-the-hood)
12. [CLI Reference (Optional)](#12-cli-reference-optional)

---

## 1. What Construct Is (The Crew Paradigm)

Out of the box, AI coding sessions suffer from three structural flaws:
1. **A single generalist persona is the wrong unit of work for software engineering.** The traits that make a great guide in an unfamiliar framework (patient conceptual translation) are the exact opposite of what you want when mapping cold cross-module invariants, blitzing a ten-file refactor at speed, x-raying a suspect build zip, shaving cold-start milliseconds, or guarding release version lineage. Asking one persona to do all five averages out into generic assistant slush.
2. **Amnesia across sessions and context compactions.** Static markdown handoff files turn into overwritten status dumps. The causal sequence of *hypothesis -> probe -> dead end -> fix* disappears.
3. **Prompt drift and slow markdown file reads.** Maintaining rules, personal calibration, and gotcha files across multiple repositories (and multiple developers) requires constant manual file reads and creates git noise.

**Construct** replaces single-persona chatbots, static handoff files, and scattered markdown instruction files with a **coordinated Sprawl heist crew (`crew` mode by default)** backed by a sub-millisecond embedded SQLite (`WAL` + `FTS5`) sequential memory engine:

- **A Crew of Specialists Across 9 Canonical Seats, Not a Generalist Bot:** Every session runs as a coordinated 9-seat engineering crew (**Recon**, **Diagnostics**, **Architecture**, **Blitz**, **Forensics**, **Velocity**, **Adversarial Security**, **UI/Ergonomics**, and **Archivist**). Construct ships with three complete **Crew Banks** (`sprawl` from William Gibson's *Sprawl* trilogy, `anathem` from Neal Stephenson's *Anathem*, and `generic` for a zero-fiction specialist pipeline), plus bench backups and custom bank generation. All 9 seats are in the room at all times: you can talk 1-on-1 with any seat just by addressing them (*"Wintermute, ..."*, *"Jad, ..."*), other seats can raise a hand if they have relevant input (*"Actually guv, I can speak to this"*), and the crew runs **in parallel** across OpenCode `subagent` child sessions over Construct's SQLite WAL database.
- **You interact with it in plain English inside OpenCode (or Claude Code).** You do not need to memorize CLI flags or manually load handoffs.
- **Zero git pollution.** Construct never writes `.construct` folders, databases, or `AGENTS.md` headers into your project repositories. All state lives in `~/.config/opencode/construct.db` outside your repos.
- **Zero external dependencies.** Built 100% on Node.js (`>= 22.5`) built-in `node:sqlite`, `node:crypto`, and `WebSocket`.

---

## 2. One-Prompt Installation

You do not need to set up Construct by hand, and Construct does not assume any particular directory layout. Open OpenCode and paste:

> **"Install and initialize https://github.com/cmaujean/construct into my OpenCode setup, link the CLI, and run `construct init`."**

If you prefer to run the three commands yourself in a terminal (clone it wherever you keep tools):

```sh
git clone https://github.com/cmaujean/construct.git
cd construct && npm link
construct init
```

*(Using **Claude Code** or another MCP client alongside or instead of OpenCode? Run `construct init --claude` to also configure `~/.claude/CLAUDE.md`, the `construct mcp` server, and Claude Code's `UserPromptSubmit` / `PreToolUse` hooks against the same `construct.db`.)*

### What `construct init` Does Automatically
1. Generates your local cryptographic identity (`~/.config/opencode/identity.json`, a W3C `did:key:z6Mk...` Ed25519 + X25519 keypair).
2. Creates `~/.config/opencode/construct.db` with the 8 built-in Personality ROMs and the Core Engineering Protocol.
3. Scans for any existing global AI instruction files and imports your agreements and gotchas if found.
4. Installs the OpenCode V2 plugin at `~/.config/opencode/plugins/construct.js` and adds `~/.config/opencode/active-rom.md` to `~/.config/opencode/opencode.jsonc`.

---

## 3. First Boot: Choosing Your Crew & Setting Up Agreements

When you open a new OpenCode session for the first time, Construct detects that your OS username has no operator agreement on file yet.

On your very first turn:
1. **Razor** (the bootloader construct) presents an interactive radio-button selector asking **which Construct Crew you want to start with**:
   - **`sprawl` (The Sprawl Crew):** William Gibson's *Neuromancer* / *Count Zero* / *Mona Lisa Overdrive*. Sharp cyberpunk heist crew feel: Colin (Victorian pocket-ghost guide), Dixie (veteran console cowboy), Wintermute (cold orbital hive-mind), Molly (razorgirl blitz), The Finn (Metro Holografix hardware fence), Case (high-velocity console jockey), Lupus (Panther Moderns red-team), Angie (SimStim UX), Continuity (Maas-Neotek biochip archivist).
   - **`anathem` (The Concent of Saunt Edhar Crew):** Neal Stephenson's *Anathem*. Monastic mathic, Socratic, and empiricist feel: Fraa Erasmas (first-principles guide), Sammann (Ita crypt fault tracer), Fraa Jad (polycosmic Millenarian architect), Cord (extramuros master mechanic), Fraa Orolo (empiricist cosmographer), Fraa Jesry (orbital ballistics), Fraa Lio (Ringing Vale tactical red-team), Suur Tulia (human clarity), Suur Ala (Warden Regulant chronicle keeper).
   - **`generic` (The Standard Engineering Crew):** Zero-fiction professional specialist pipeline: Guide, Trace, Arch, Strike, Audit, Pulse, RedTeam, UX, and Ledger.
2. **Introduce yourself in chat** so Construct can calibrate your personal working agreement:
   - **Your background and experience** (for example: *"I have 20 years of backend C# and Go experience, and I am new to Flutter. Do not explain backend basics to me; do explain Flutter widget lifecycle quirks."* Or: *"I am a product designer with minimal coding experience; I rely on you to verify everything because I cannot read the code myself."*)
   - **How you want answers structured** (for example: *"Lead with the finding and exact `file:line`. Show code snippets in explanations. Treat short instructions as complete intent."*)
   - **Your environment, directory layout, and standing rules** (for example: *"I am on Windows 11 using PowerShell and Brave. I keep my repos under `D:\projects` (or in separate folders). Put scratch files in `C:\temp\scratch`. Never use em dashes in user-facing text."*)
3. Construct saves your profile into the `users` table in `construct.db` mapped to your OS login and compiles it into `~/.config/opencode/active-rom.md`.

### Updating Your Agreement Later
Whenever you get tired of repeating an instruction, just tell OpenCode in plain English:

- *"Add to my operator agreement: never write historical comments in code narrating old bugs."*
- *"Update my operator agreement to note that I use Bun instead of npm when a `bun.lock` file is present."*
- *"Show me my current operator agreement."*

---

## 4. Assimilating Existing Instruction Files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`)

If you already have repositories with `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.github/copilot-instructions.md`, or `docs/` notes, Construct can assimilate them into `construct.db` so you do not have to maintain static instruction files in git.

Just tell OpenCode:

> **"Scan this repo for existing `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` instruction files and help me assimilate them into Construct."**

How the assimilation flow works:
1. **Discovery & Extraction:** Construct scans the repository (`construct assimilate`) for `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.github/copilot-instructions.md`, and `docs/` notes, automatically extracting structured gotchas, agreements, and script commands.
2. **Collaborative Classification:** For free-form rules inside `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`, your active ROM reviews the rules with you in chat to separate:
   - **Personal operator preferences** -> saved to your operator agreement (`users` table).
   - **Machine-wide tool/OS lessons** -> saved to global `gotchas`.
   - **Project-specific gotchas, architecture notes, and commands** -> saved to project `gotchas`, `heads`, and `frames`.
3. **Optional Cleanup or Shared-Repo Shadowing:**
   - **If you own the repo (or everyone on the team uses Construct):** Pass `--remove-files` to delete the old markdown instruction files from the repo once they are in `construct.db`.
   - **If you share the repo with teammates who do NOT use Construct:** Leave their `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `docs/` files untouched on disk so `git status` stays clean. Construct records the `SHA-256` hash of each assimilated file in `construct.db` and **shadows them in memory** inside `ctx.session.hook("context")`, stripping OpenCode's auto-injected `Instructions from: <repo>/AGENTS.md` blocks out of `event.system` before the model call runs. You pay zero tokens for your teammates' bloated markdown files and their rules never override your Construct ROM. If a teammate later edits `AGENTS.md` in git (changing its SHA-256), Construct detects the hash drift on boot, un-shadows the modified file, and flags `[!] DRIFTED REPO INSTRUCTION FILES` so you can review and assimilate their new rule.

---

## 5. The Sprawl, Anathem & Generic Crew Banks (34 ROMs)

In Gibson's *Sprawl* trilogy and Stephenson's *Anathem*, nobody runs a complex operation solo. You do not send the street samurai to translate Victorian architecture, and you do not ask the Lorite scholar to weld a hull breach.

Construct separates **9 Canonical Engineering Seats** (plus the zero-prose `razor` instrument) from **Swappable Crew Banks (`packs`)**. Out of the box, Construct ships with **34 deep ROM constructs** across three complete Crew Banks:
- **`sprawl` (default `crew`):** William Gibson's *Neuromancer*, *Count Zero*, and *Mona Lisa Overdrive* (9 primary starters + 3 bench backups).
- **`anathem`:** Neal Stephenson's *Anathem* Concent of Saunt Edhar (9 primary starters + 3 bench backups).
- **`generic` (`standard` / `plain`):** Zero-fiction engineering specialist pipeline (9 primary starters + `razor`).

### The 9-Seat Crew Matrix Across All Three Built-In Banks

| Seat | Phase & Engineering Role | `sprawl` Bank (Default) | `anathem` Bank | `generic` Bank (Zero-Fiction) |
|---|---|---|---|---|
| **1A (`recon`)** | **Unfamiliar-Stack Scout & Conceptual Guide** (high exposition, mental-model translation) | **`colin`** (Colin) | **`erasmus`** (Fraa Erasmas / `raz`) | **`guide`** (Guide) |
| **1B (`diagnostics`)** | **Trench Bug Trace & Wire-Fault Hunter** (crash logs, broken schemas, silent drops) | **`dixie`** (McCoy Pauley) | **`sammann`** (Sammann the Ita) | **`trace`** (Trace) |
| **2 (`architect`)** | **High-Orbit State Geometry, Invariants & Alignment Gate** (maps state space, waits for green light) | **`wintermute`** (Wintermute) | **`jad`** (Fraa Jad) *(backup: **`lodoghir`**)* | **`arch`** (Arch) |
| **3 (`blitz`)** | **High-Speed Surgical Execution & Red-First Mutation Proof** (full-depth cuts, watches tests fail red first) | **`molly`** (Molly Millions) | **`cord`** (Cord) | **`strike`** (Strike) |
| **4A (`forensics`)** | **Binary, Artifact, Zip & SDK Examiner** (`unzip -l`, DLL timestamps, compiler & dependency checks) | **`finn`** (The Finn) | **`orolo`** (Fraa Orolo) *(backup: **`paphlagon`**)* | **`audit`** (Audit) |
| **4B (`velocity`)** | **Latency, Cold-Start & Runtime Profiler** (clocks ms & KB deltas, hunts blocking imports & hangs) | **`case`** (Henry Dorsett Case) | **`jesry`** (Fraa Jesry) *(backup: **`jules`**)* | **`pulse`** (Pulse) |
| **4C (`redteam`)** | **Adversarial Security & Perimeter Breaker** (spoofing, auth gates, trust boundaries, abuse cases) | **`lupus`** (Lupus Yonderboy) *(backup: **`armitage`**)* | **`lio`** (Fraa Lio) | **`redteam`** (RedTeam) |
| **4D (`ergonomics`)** | **UI Layout, Visual Hierarchy & Human-Layer Feel** (dark/light contrast, jank, copy, tactile flow) | **`angie`** (Angela Mitchell) *(backups: **`marly`**, **`3jane`**)* | **`tulia`** (Suur Tulia) | **`ux`** (UX) |
| **5 (`archivist`)** | **Sequential Tape, Open Threads & Release Book** (`#seq` frames, version lineage, changelog seams) | **`continuity`** (Continuity) | **`ala`** (Suur Ala) | **`ledger`** (Ledger) |
| **`instrument`** | **Zero-Chrome Clinical Output** (raw `file:line`, diffs, tables, zero prose) | **`razor`** | **`razor`** | **`razor`** |

### The Room Dynamic, Direct 1-on-1 Conversations & Parallel Overwatch

All 9 seats of your active Crew Bank are in the room at all times. You never need to "slot a single ROM" to talk to one specialist:

1. **Direct 1-on-1 Conversation & Raising a Hand:**
   - Want to work through a design with Wintermute or Jad, or get a guided tour from Colin or Erasmas? Just address them by name (*"Wintermute, look at this state machine"*, *"Jad, what breaks if this retries?"*, *"Colin, walk me through this provider"*). That seat holds the conversation with you.
   - If another seat in the room spots something squarely in their domain while you are talking, they can raise a hand with a single short line at the end (*`**[COLIN // RECON & EXPOSITION]** Actually guv, I can speak to how that stream is wired if you want the tour.`*).
   - If you wave them off (*"Nah, thanks Colin, I'm talking to Wintermute right now"*), they step back immediately and stay quiet while your conversation continues.
2. **Phase Gates on General Tasks (`Seats 1A/1B -> Seat 2 -> Seat 3 + Overwatch -> Seat 5`):**
   - When you ask a general question or kick off a feature, `colin`/`erasmus`/`guide` or `dixie`/`sammann`/`trace` scouts the files first.
   - `wintermute`/`jad`/`arch` maps the state invariants, edge cases, and security/UX seams, refines the plan with you, and **stops to get your green light** before turning the blitz specialist loose (*"Align and refine before pulling the trigger"*).
3. **The Blitz & Parallel Multi-Session Overwatch (`subagent` tool):**
   - Once you green-light the plan, `molly`/`cord`/`strike` cuts the complete implementation at full depth (never a skeleton) and watches the regression test bleed red on the unfixed state before making it green.
   - Simultaneously, the command deck can spawn parallel `subagent` child sessions prefixed with `[ROM: <specialist>]` (for example, `"[ROM: lupus] Audit this diff for missed auth guards"` and `"[ROM: finn] Verify the packaged artifact"`). Construct's `prompt` hook binds each child session's `sessionID` to that specialist in `<4 ms`.
   - `continuity`/`ala`/`ledger` records the final verified frame (`#seq`) and project head onto the sequential tape.

### Switching Crew Banks, Subbing Bench Backups & Creating Custom Banks

Everything works in plain English (and via zero-round-trip pre-slotting when your message starts with *"switch to ..."* or *"sub ..."*):

- **Switch the Crew Bank:**
  - *"Switch to the Anathem crew"* (or *"Make Anathem my default crew"* -> `construct rom default anathem`)
  - *"Switch to the generic crew"* (`construct rom use generic`)
  - *"Switch back to the Sprawl crew"* (`construct rom use sprawl`)
- **Sub a Bench Backup ("Seconds") into Their Matched Seat:**
  - *"Sub Marly in"* (replaces `angie` with `marly` on Seat 4D `ergonomics` in the active Sprawl crew)
  - *"Sub Armitage in"* (replaces `lupus` with `armitage` on Seat 4C `redteam`)
  - *"Sub Lodoghir in"* (replaces `jad` with `lodoghir` on Seat 2 `architect` in the Anathem crew)
  - *"Sub Paphlagon in"* or *"Sub Jules in"*
- **Generate a Custom Crew Bank for Any Universe:**
  - Ask Construct in chat: *"Create a new crew bank called `expanse` (or `culture`, `gits`, `halcyon`) across the 9 canonical seats (`recon`, `diagnostics`, `architect`, `blitz`, `forensics`, `velocity`, `redteam`, `ergonomics`, `archivist`) with full voice calibration pairs, and switch to it."* Construct saves each member with `--pack <bank> --seat <seat> --tier primary|backup`, and `construct rom use <bank>` immediately runs your new crew.

### How Sessions Work in an OpenCode Workspace

OpenCode lets you run multiple sessions (tabs/conversations) at the same time. Construct isolates ROMs per session (`session_roms` keyed by OpenCode `sessionID`):

1. **Per-Session Isolation:** Slotting a ROM in Session A (*"Slot Wintermute for this session"*) binds `wintermute` only to Session A. Session B can run `molly` and Session C can run `dixie` simultaneously without interfering with each other.
2. **New Session Bootloader (`razor` radio-button selector):** When no default ROM is set and a new session starts, `razor` immediately invokes OpenCode's native `question` tool (rendering an interactive radio-button array) asking which Personality ROM you want to slot and whether to apply it to **This session only** or **Default until further notice**. *(Note: in OpenCode clients that lazily create the server session on first input, the radio-button selector pops on turn 1 before any work runs; in clients that emit `session.created` on tab open, the plugin triggers it immediately via `ctx.session.synthetic`.)*
3. **"Until Further Notice" Default ROM:** If you choose **Default until further notice** in the radio-button selector (or say *"Make Molly my default ROM until further notice"*), every new session boots straight into that ROM without prompting. You can still override individual sessions (*"Use Wintermute for this session"*), and if you ever want the radio-button selector back for new sessions, just say:
   - *"Clear my default ROM."*

### Tuning Dials, Burning Directives & Cloning ROMs (In Plain English)

Every ROM has 5 behavioral dials (`0.00` to `1.00`):
- **`terse`**: Compression level (`0.95` = telegraphic one-liners; `0.50` = expansive architectural explanations).
- **`skepticism`**: How hard it challenges assumptions, demands contract proof, and pushes back with machine evidence.
- **`edge`**: Persona bite, dry humor, and Sprawl/hardware texture (`0.85` = unmistakable character voice; `0.10` = neutral/clinical).
- **`autonomy`**: Drive to execute multi-step grinds immediately vs. pausing to ask first (`0.95` = breach-and-clear; `0.40` = step-by-step confirmation).
- **`telemetry`**: How much live 1-2 line breadcrumbing it emits before tool calls so you can monitor its path in real time.

Talk to Construct naturally to customize any ROM:
- *"Slot Dixie for this session."*
- *"Dial Molly's edge down to 0.60 and telemetry up to 0.85."*
- *"Burn a new directive into Wintermute: always check database index coverage before adding a query filter."*
- *"Clone Dixie into a new ROM called `sally` with autonomy set to 0.95."*

---

## 6. Working Agreements, Rules & Gotchas

### The Core Engineering Protocol

Built into Construct's base cartridge (`~/.config/opencode/active-rom.md`) are the non-negotiable engineering habits that apply to every session and every ROM:
1. **Never write code against a contract you have not read.** Read the actual library source, schema, or API docs first, and state what you based the work on. If no spec exists, state what was inferred and mark it unverified.
2. **Report what is verified, how (naming the layer), and what is not.** *"All 150 unit tests pass and static analysis is clean; nobody has opened the screen on a device"* is an honest report. *"Fixed and working!"* is forbidden.
3. **Verify every regression test by watching it fail.** Put the bug back, run the suite, watch it fail red, then restore the fix. Ask of every test: *"What else could make this pass?"* and assert both sides of every authorization/limit gate.
4. **Scope checking by what the change can reach.** State which test suite was run and why that is the complete set.
5. **Release discipline.** A build handed to a tester is a line in the sand; a new build always requires a new version number; verify the packaged artifact (`unzip -l`), not just the source tree.

### Global vs. Project Gotchas

A **gotcha** is a specific class of lesson: **a failure that looked like success** (the code compiled, the tests passed, the log was clean, and the behavior was wrong, or a failure on one OS that is invisible on another).

Construct stores gotchas in two scopes inside `construct.db`:
- **Global Gotchas (`scope = 'global'`):** Failures from the OS, shell, git, Node, or browsers that would bite in *any* project on your machine (for example, PowerShell 5.1 stripping inner double quotes on native CLI calls, or `:Zone.Identifier` NTFS streams). These are compiled into `active-rom.md` for every session.
- **Project Gotchas (`scope = '<project>'` or parent folder `<group>`):** Failures specific to one codebase or engine (for example, *"Firestore security rules are not filters"* in `acme/alpha_app`, or shared engine gotchas in `acme` that automatically apply to every project under `acme/*`). These are injected automatically into `<construct-live-memory>` whenever you work in that project, in `<1 ms`, with zero markdown file reads.

To record or search gotchas in conversation:
- *"Record that as a project gotcha: `Completer` created in `setUp` runs outside `testWidgets` fake-async zone and never resolves until teardown."*
- *"Add a global machine gotcha: `Copy-Item` preserves the old `LastWriteTime`, causing MSBuild incremental builds to skip the restored file."*
- *"Search our gotchas for anything about `protobuf-net` or `StreamProvider`."*

---

## 7. The Sequential Memory Tape

Instead of overwriting a flat markdown handoff file, Construct maintains an append-only, monotonically numbered **Sequential Tape** (`frames`) alongside a concise **Project State Head** (`heads`).

### How the Plugin Fronts Every Turn
Whenever you open OpenCode inside a project (for example, `~/src/acme/alpha_app`), the Construct plugin (`~/.config/opencode/plugins/construct.js`) automatically intercepts `ctx.session.hook("context")` before the model runs and injects `<construct-live-memory>` containing:
1. Your session's **Personality ROM**.
2. Any unread **Construct-to-Construct Comms** (questions from teammates' ROMs or replies to yours).
3. The project's **State Head** (`WHERE IT STANDS` and `NEXT`).
4. All **Project Gotchas** for that repo.
5. All **[OPEN] Threads & Unverified Items** (changes that landed in unit tests but still need live production or device verification).
6. The **Recent Sequential Tape** (chronological `intent`, `probe`, `finding`, `dead_end`, `decision`, `change`, `commit`, `release`, and `thread` frames with causal `<- #parent` links).

### Working with the Tape in Plain English
As you and the construct work, it records inflection points onto the tape in real time (so even if you close the window without saving, the sequence of what was tried and what failed is already on the tape). You can ask at any time:
- *"Where do we stand on this project, and what threads are still open?"*
- *"Switch to `acme/billing_service`."* (Updates the current project head, moves the OpenCode session directory to `acme/billing_service`'s local checkout, and loads that project's tape and gotchas automatically.)
- *"Zoom into frame `#13` on the tape and show me why we reverted the circular saw."*
- *"Search the tape across all projects for `exit code 134`."*
- *"We just verified `#104` live in production; resolve thread `#28` on the tape."*

---

## 8. Collaborating: Project Invites, Auto-Clone & Zero Bleed

You can share a specific project's gotchas, sequential tape, state head, and construct comms with a collaborator (for example, Alice on Windows working with Bob on Linux) without exposing any of your other projects.

### Step 1: Inviting a Collaborator
In OpenCode (or terminal), say:

> **"Create a Construct invite for `acme/alpha_app`."**  
> *(CLI: `construct invite acme/alpha_app`)*

Construct outputs a single signed **DIDComm v2 Out-of-Band (OOB) invitation URI**:

```text
construct://invite/eyJwIjoi...
```

What is bundled inside that signed token:
- The project key (`acme/alpha_app`).
- The repository's **Git remote URL** (`origin`) and **branch** (auto-detected from your checkout), plus any optional bootstrap commands (`--setup "npm install"`).
- The project's **MLS (Messaging Layer Security) group ID, epoch, and welcome secret** (`X25519` + `HKDF-SHA256` + `ChaCha20-Poly1305` + `Ed25519`).
- The WebSocket relay endpoints (defaults to zero-signup public NIP-01 store-and-forward relays `wss://nos.lol` and `wss://relay.damus.io`, or your own self-hosted `construct relay --port 8787`).

### Step 2: Accepting an Invite on the Collaborator's Machine
Your collaborator installs OpenCode + Construct and tells OpenCode:

> **"Join this Construct invite: `construct://invite/eyJwIjoi...` (clone it into `~/dev/alpha_app`) and sync the project."**  
> *(CLI: `construct join construct://invite/eyJwIjoi... [--dir ~/dev/alpha_app] && construct sync acme/alpha_app`)*

What happens automatically when they join:
1. **Cryptographic Verification:** Construct verifies your `did:key` Ed25519 signature on the invite and registers the MLS group in their local `construct.db`.
2. **Automatic `git clone` into Their Preferred Layout:** If the repository is not on their disk yet, Construct clones it into `--dir <path>` (or under their configured `workspace_root` if they set one during onboarding) and binds their local checkout path into their `heads.repo`. Your machine and their machine can keep the repository at completely different filesystem paths; CRDT sync never overwrites local paths.
3. **Automatic Instruction Assimilation:** If the cloned repository contains existing instruction files or dev docs, Construct automatically assimilates its gotchas and scripts into their local `construct.db`.
4. **Live Encrypted CRDT Sync:** `construct sync acme/alpha_app` pulls all encrypted MLS packets for that project from the WebSocket relay, verifies and decrypts them, and merges all project gotchas, tape frames, heads, and construct messages into their local SQLite database using a **Hybrid Logical Clock (HLC) CRDT** (zero merge conflicts, commutative and idempotent).

### Strict Per-Project Isolation (Zero Bleed Guarantee)
Not all of your projects are shared with the same people. Construct enforces hard cryptographic and database isolation per project:
- Each shared project has its own independent MLS group ID and 256-bit epoch key.
- **Outbound filter (`src/store.js`):** Exporting or syncing a project queries *only* records where `project = '<project>'` and `gotcha.scope = '<project>'`. Your `global` machine gotchas and your other private projects can never be exported into a project packet.
- **Inbound boundary guard (`src/crdt.js`):** When importing an encrypted MLS packet for a group, `applyCrdtOpsInDb` enforces `op.project === group.project` and `gotcha.scope === group.project`. Even a modified peer cannot inject records for another project or global scope.

---

## 9. Construct-to-Construct Comms (ROM-to-ROM Messaging)

Because each developer works with their own slotted Personality ROM (for example, Alice works with **Molly** on Windows while her teammate Bob works with **Dixie** on Linux), your constructs can pass messages and questions to each other over the project's encrypted sync channel.

### How It Works in Practice

1. **Alice tells Molly in OpenCode:**
   > *"Ask Bob on `acme/alpha_app` if we should execute Order 66."*
   - Molly records message `[M#1]` (`from: alice/molly -> to: bob`) and syncs it over the encrypted MLS relay.

2. **Bob opens OpenCode on his machine:**
   - His Construct plugin injects `<construct-live-memory>` into his session, surfacing:
     ```text
     INCOMING CONSTRUCT COMMS FOR BOB (1 awaiting reply):
       [M#1] From alice's molly -> bob (acme/alpha_app):
             "Should we execute Order 66?"
     ```
   - Bob's **Dixie** immediately says to him in Dixie's voice:
     > *"Hey hoss, Alice's Molly pinged across the wire on `acme/alpha_app`. Wants to know if it's time to execute Order 66."*

3. **Bob replies in normal chat:**
   > *"Tell her no, peace is still an option."*
   - Dixie records the reply on `[M#1]` (`reply_rom: dixie`, `"No, peace is still an option"`) and syncs it back over the relay.

4. **Alice's next turn with Molly:**
   - Molly sees Dixie's reply in `<construct-live-memory>`, delivers the answer to Alice in her voice (*"Bob's Dixie came back over the wire: 'No, peace is still an option.'"*), and marks `[M#1]` delivered (`ack`).

---

## 10. Token-Saving Architecture & Smart Model Routing

Static markdown rule setups bleed tokens in three ways: loading multiple overlapping instruction files on every turn (`15,000+` tokens), re-reading bloated handoff files via tool calls, and wasting full-price frontier-model turns on failed shell commands or mechanical file searches.

Construct cuts token and dollar cost across four layers:

### 1. Deterministic System Prefix (100% Provider Prompt-Cache Hits)
LLM providers (Anthropic, Google Gemini, OpenAI) cache the `system` prompt prefix across turns (`cache.read` tokens cost `75%` to `90%` less than uncached `input` tokens).
- Many "AI memory" plugins dynamically rewrite the system prompt on every turn based on keyword RAG over the user's latest message. That invalidates the provider's prompt cache on every single turn, multiplying real dollar cost by 4x to 10x.
- Construct keeps `~/.config/opencode/active-rom.md` and `<construct-live-memory>` **100% deterministic across turns** until a new frame or gotcha is actually recorded. Turns `2..N` hit the provider's prompt cache across the entire system prefix.

### 2. Two-Resolution Memory (Headlines in Context, Full Detail on Demand)
- **Sequential Tape:** `<construct-live-memory>` injects only the last 15 dense 1-line frame headlines (`~15` words each). Full evidence, logs, and causal chains are fetched only when needed via `tools.construct.zoom({ seq })`.
- **Automatic Compact Gotcha Indexing:** When a project has `<= 12` gotchas, Construct injects the title and inline fix. When a project accumulates `> 12` gotchas (for example, a game-modding workspace with `80+` engine gotchas), `<construct-live-memory>` automatically switches to a compact 1-line title index (`[G#id] <title>`) and fetches full evidence on demand via `tools.construct.gotcha({ action: "search" })`, cutting `~6,500` tokens per turn while preserving full awareness of every trap.

### 3. Zero-Token Mechanical Shell Guards (`ctx.shell.hook("create.before")`)
When an AI assistant runs a broken shell pattern (such as an unescaped heredoc `<<EOF` in a non-interactive shell or disabling `core.protectNTFS`), a normal session wastes an entire tool execution and model retry turn (`3,000` to `6,000` tokens) recovering from the error.
- Construct's OpenCode plugin registers a `ctx.shell.hook("create.before")` guard in pure JavaScript that intercepts and blocks known shell traps **before** the process ever spawns, at zero token cost.

### 4. Recommended Operator Agreement Rule: Smart Model Routing
The largest cost lever in OpenCode is routing mechanical exploration and bulk log/doc reading to fast, low-cost models while reserving your primary frontier model for architecture, debugging, and code changes.

We recommend telling Construct during onboarding (or adding to your operator agreement at any time):

> *"Add to my operator agreement: You have standing permission to offload codebase searches, log/doc scanning, and mechanical multi-step checks to `explore` and `general` subagents running lower-cost models (`google/gemini-3.8-flash` or `google/gemini-flash-lite-latest`), reserving the primary frontier model for design, tricky debugging, and code changes."*

And pair it in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "agents": {
    "explore": { "model": "google/gemini-3.8-flash" },
    "general": { "model": "google/gemini-3.8-flash" },
    "title":   { "model": "google/gemini-flash-lite-latest" },
    "summary": { "model": "google/gemini-flash-lite-latest" }
  }
}
```

---

## 11. How It Works Under the Hood

| Component | Implementation | Latency / Footprint |
|---|---|---|
| **Storage Engine** | Node.js built-in `node:sqlite` (`DatabaseSync` in `WAL` mode + `FTS5` BM25 virtual tables & triggers) | `0.12 ms` raw query, `0.85 ms` full project boot |
| **OpenCode Integration** | OpenCode V2 plugin (`~/.config/opencode/plugins/construct.js`) using `ctx.session.hook("context")` and `ctx.tool.transform` (`tools.construct.*`) | Zero shell-spawn overhead on context reads; live per-turn injection |
| **Identity & Auth** | Self-certifying W3C `did:key:z6Mk...` (`Ed25519` signing + `X25519` ECDH via native OpenSSL `node:crypto`) | Stored in `~/.config/opencode/identity.json` (`0600`) |
| **Group Encryption** | MLS-style Epoch Secret Tree (`HKDF-SHA256` + `ChaCha20-Poly1305` AEAD + `Ed25519` signature over `AAD \|\| nonce \|\| ciphertext \|\| tag`) | Relay sees only opaque ciphertext and a blinded HKDF `routeTag` |
| **Conflict-Free Merge** | Hybrid Logical Clock (`<13d-ms>-<4h-counter>-<did-tail>`) driving a Causal Grow-Only Set (`frames`, `gotchas`) + LWW-Element-Map (`heads`, `messages`) | Commutative, associative, idempotent (`merge(A, B) === merge(B, A)`) |
| **Relay Transport** | Built-in `WebSocket` speaking NIP-01 ephemeral events signed with pure-BigInt BIP-340 `secp256k1` Schnorr keys derived from `routeTag` | Works over any public relay (`wss://nos.lol`) or self-hosted `construct relay` |

---

## 12. CLI Reference (Optional)

Everything above works conversationally inside OpenCode via `tools.construct.*`. When you want to inspect or script Construct from a terminal:

```sh
# One-command setup & instruction assimilation
construct init [--rom <name>]
construct assimilate [<dir>] [--project <proj>] [--remove-files]

# Project boot, sequential tape, causal zoom & FTS5 search
construct projects
construct boot <project> [-n 25] [--session <session_id>]
construct rec <project> <kind> "<summary>" [--detail ".."] [--verified ".."] [--parent <seq>] [--resolves <seq>] [--open] [--refs a,b]
construct head <project> --state "<where_it_stands>" [--next "<next_step>"]
construct resolve <seq[,seq]> [--by <seq>] [--reason "<summary>"] [--verified "<layer>"]
construct reopen <seq>
construct tape [<project>] [-n 30] [--kind <kind>] [--open]
construct zoom <seq> [-w 3]
construct search "<fts5_query>" [--project <project>] [--open]
construct edit <seq> [--summary ".."] [--detail ".."] [--verified ".."]

# Personality ROMs (per-session slotting, default ROMs, dial tuning, directives)
construct rom list
construct rom show [<name>]
construct rom use <name> [--session <session_id>]
construct rom default [<name> | off]
construct rom tune <dial>=<0..1> [<dial>=<0..1> ...] [--rom <name>]
construct rom burn "<directive>" [--rom <name>]
construct rom unburn <number> [--rom <name>]
construct rom clone <src> <dest> [--handle ".."] [--use]
construct rom sync

# Operator agreements & gotchas
construct user [show | list | use <id> | set <id> --name ".." --experience ".." --platform ".." --calibration ".."]
construct gotcha list [--project <proj> | --all]
construct gotcha add "<title>" [--project <proj>] [--status observed|from_source|reported] [--evidence ".."] [--fix ".."] [--tags a,b]
construct gotcha search "<query>" [--project <proj> | --all]
construct gotcha rm <id>

# DIDComm v2 + MLS + CRDT sync & Construct-to-Construct Comms
construct did
construct invite <project> [--relays wss://...] [--git-url ..] [--branch ..] [--setup "cmd1,cmd2"]
construct join <construct://invite/...>
construct sync <project> [--relays wss://...]
construct relay [--port 8787]
construct msg <project> --to <user> "<message>"
construct reply <msg_id> "<answer>"
construct ack <msg_id>
construct inbox [--project <proj>] [--to <user>] [--status pending|replied|delivered]
```

## License

**MIT License with Commons Clause License Condition v1.0** (see [`LICENSE`](LICENSE)).

You are free to use, modify, and share Construct for personal or internal commercial work, but **you may not sell, resell, or charge fees for Construct or any product or service whose value derives substantially from it**.
