# Construct

***CON-struct** (`/ˈkɒn.strʌkt/`, noun: a recorded personality and memory artifact)*

Sequential memory tape, swappable Personality ROMs, operator working agreements, and encrypted multi-developer sync for [OpenCode](https://opencode.ai).

Inspired by the ROM constructs and Hosaka sequential memory modules in William Gibson's *Sprawl* trilogy.

---

## Table of Contents

1. [What Construct Is (The Crew Paradigm)](#1-what-construct-is-the-crew-paradigm)
2. [One-Prompt Installation (OpenCode & Claude Code)](#2-one-prompt-installation-opencode--claude-code)
3. [First Boot: Choosing Your Crew & Setting Up Agreements](#3-first-boot-choosing-your-crew--setting-up-agreements)
4. [Assimilating Existing Instruction Files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`)](#4-assimilating-existing-instruction-files-agentsmd-claudemd-geminimd)
5. [The 15 Crew Banks, The Bench, Cross-Bank Cameos & Modular Packs (179 ROMs)](#5-the-15-crew-banks-the-bench-cross-bank-cameos--modular-packs-179-roms)
6. [Working Agreements, Rules & Gotchas](#6-working-agreements-rules--gotchas)
7. [The Sequential Memory Tape (Sandwich Pattern)](#7-the-sequential-memory-tape-sandwich-pattern)
8. [Collaborating: Project Invites, Auto-Clone & Zero Bleed](#8-collaborating-project-invites-auto-clone--zero-bleed)
9. [Construct-to-Construct Comms (ROM-to-ROM Messaging)](#9-construct-to-construct-comms-rom-to-rom-messaging)
10. [Token-Saving Architecture, Mechanical Guards & Smart Model Routing](#10-token-saving-architecture-mechanical-guards--smart-model-routing)
11. [How It Works Under the Hood](#11-how-it-works-under-the-hood)
12. [CLI Reference (Optional)](#12-cli-reference-optional)
13. [License, Literary Homage & Good-Faith Pack Policy](#13-license-literary-homage--good-faith-pack-policy)

---

## 1. What Construct Is (The Crew Paradigm)

Out of the box, AI coding sessions suffer from three structural flaws:
1. **A single generalist persona is the wrong unit of work for software engineering.** The traits that make a great guide in an unfamiliar framework (patient conceptual translation) are the exact opposite of what you want when mapping cold cross-module invariants, blitzing a ten-file refactor at speed, x-raying a suspect build zip, shaving cold-start milliseconds, or guarding release version lineage. Asking one persona to do all five averages out into generic assistant slush.
2. **Amnesia across sessions and context compactions.** Static markdown handoff files turn into overwritten status dumps. The causal sequence of *hypothesis -> probe -> dead end -> fix* disappears.
3. **Prompt drift and slow markdown file reads.** Maintaining rules, personal calibration, and gotcha files across multiple repositories (and multiple developers) requires constant manual file reads and creates git noise.

**Construct** replaces single-persona chatbots, static handoff files, and scattered markdown instruction files with a **coordinated 9-seat engineering crew (`crew` mode by default)** backed by a sub-millisecond embedded SQLite (`WAL` + `FTS5`) sequential memory engine:

- **A Crew of Specialists Across 9 Canonical Seats, Not a Generalist Bot:** Every session runs as a coordinated 9-seat engineering crew (**Recon**, **Diagnostics**, **Architecture**, **Blitz**, **Forensics**, **Velocity**, **Adversarial Security**, **UI/Ergonomics**, and **Archivist**). Construct ships with fifteen complete, lazy-loaded **Crew Banks** (`sprawl`, `nightcity`, `anathem`, `cryptonomicon`, `shadowrun`, `dresden`, `amber`, `laundry`, `tolkien`, `discworld`, `reamde`, `irondruid`, `prydain`, `clockwork`, and `generic`), plus **Bench / Seconds** you can call in for specialized questions (legal/licensing cross-examination, rapid A/B benchmarking, deep RFC archaeology, or design-system audits), **Cross-Bank Cameos**, and drop-in custom pack support (`~/.config/opencode/packs/*.js`). All 9 seats and the Bench are in the room at all times: you can talk 1-on-1 with any specialist just by addressing them (*"Wintermute, ..."*, *"Jad, ..."*, *"Lodoghir, cross-examine this license"*), other seats can raise a hand if they have relevant input, and the crew runs **in parallel** across OpenCode `subagent` and Claude Code `Agent` child sessions over Construct's SQLite WAL database.
- **You interact with it in plain English inside OpenCode or Claude Code.** You do not need to memorize CLI flags or manually load handoffs.
- **Zero git pollution.** Construct never writes `.construct` folders, databases, or `AGENTS.md` headers into your project repositories. All state lives in `~/.config/opencode/construct.db` outside your repos.
- **Zero external dependencies.** Built 100% on Node.js (`>= 22.5`) built-in `node:sqlite`, `node:crypto`, and `WebSocket`.

---

## 2. One-Prompt Installation (OpenCode & Claude Code)

You do not need to set up Construct by hand, and Construct does not assume any particular directory layout. Open OpenCode and paste:

> **"Install and initialize https://github.com/cmaujean/construct into my OpenCode setup, link the CLI, and run `construct init`."**

If you prefer to run the three commands yourself in a terminal (clone it wherever you keep tools):

```sh
git clone https://github.com/cmaujean/construct.git
cd construct && npm link
construct init
```

*(Using **Claude Code, Cursor, Gemini CLI / Antigravity, Windsurf, Codex CLI, or Oh My Pi (`omp`)** alongside or instead of OpenCode? Pass `--claude`, `--cursor`, `--gemini`, `--windsurf`, `--codex`, `--omp`, or `--all` to `construct init` to wire their native MCP configs, global rules, and lifecycle hooks (`SessionStart`, `UserPromptSubmit`/`BeforeAgent`/`beforeSubmitPrompt`/`before_agent_start`, `SubagentStart`, and `PreToolUse`/`BeforeTool`/`beforeShellExecution`/`tool_call`) against the same `construct.db`.)*

### What `construct init` Does Automatically
1. Generates your local cryptographic identity (`~/.config/opencode/identity.json`, a W3C `did:key:z6Mk...` Ed25519 + X25519 keypair).
2. Creates `~/.config/opencode/construct.db` with all 179 built-in ROM constructs across the 15 modular Crew Banks and the Core Engineering Protocol.
3. Scans for any existing global AI instruction files and imports your agreements and gotchas if found.
4. Installs the OpenCode V2 plugin at `~/.config/opencode/plugins/construct.js` and adds `~/.config/opencode/active-rom.md` to `~/.config/opencode/opencode.jsonc` (and when `--claude` is passed, wires `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, and `~/.claude/agents/*.md`).

---

## 3. First Boot: Choosing Your Crew & Setting Up Agreements

When you open a new OpenCode session for the first time, Construct detects that your OS username has no operator agreement on file yet.

On your very first turn:
1. **Razor** (the bootloader construct) presents an interactive radio-button selector asking **which Construct Crew Bank you want on your deck**:
   - 🌃 **`sprawl` (The Sprawl Crew):** William Gibson's *Neuromancer* / *Count Zero* / *Mona Lisa Overdrive*. 1984 noir console-cowboys & orbital AIs: Colin, Dixie, Wintermute, Molly, The Finn, Case, Lupus, Angie, Continuity.
   - 🦾 **`nightcity` (The Afterlife Crew):** *Cyberpunk 2077 / Phantom Liberty* Night City Edgerunners: Judy (Braindance recon), Vik (Ripperdoc), T-Bug (Konpeki schematics), V (Sandevistan breach), Mitch (Badlands bench), Songbird (Blackwall velocity), Johnny Silverhand (Relic saboteur), Evelyn (Mox UX), Rogue (Afterlife fixer).
   - 🏛️ **`anathem` (The Concent of Saunt Edhar Crew):** Neal Stephenson's *Anathem*. Mathic Concent, Socratic & empiricist Convox: Fraa Erasmas, Sammann, Fraa Jad, Cord, Fraa Orolo, Fraa Jesry, Fraa Lio, Suur Tulia, Suur Ala.
   - 🔐 **`cryptonomicon` (Detachment 2702 & Epiphyte Corp):** Neal Stephenson's *Cryptonomicon*. 1942 Bletchley Park cryptanalysis braided with 1999 Manila Unix/crypto engineering: Lawrence Waterhouse, Goto Dengo, Enoch Root, Randy Waterhouse, Doug Shaftoe, Avi Halaby, John Cantrell, Amy Shaftoe, Golgotha.
   - 🐉 **`shadowrun` (Seattle 2050s Shadowland Team):** Sixth World tactical arcology run where Awakened magic meets cyberware: Talon (Raven shaman), StreetDoc, FastJack, Hatchetman (Street Samurai), Rigger, Dodger (Excalibur decker), Harlequin, Siren (Face), Captain Chaos (Shadowland SysOp).
   - 🕯️ **`dresden` (The Chicago Paranet & White Council Crew):** Jim Butcher's *The Dresden Files*. Sub-basement wizard lab, Unseelie Accords invariants, and SI forensics: Bob the Skull, Waldo Butters, Queen Mab, Harry Dresden, Karrin Murphy, Thomas Raith, John Marcone, Molly Carpenter (Grasshopper), and The Archive (Ivy).
   - 🦄 **`amber` (The Royal House of Amber):** Roger Zelazny's *The Chronicles of Amber*. Castle Amber, the Primal Pattern, Trump decks, and Shadow hellrides: Corwin, Merlin, Fiona, Benedict, Julian, Random, Brand, Dworkin, and Ghostwheel.
   - 🐙 **`laundry` (SOE "Q" Division // The Capital Laundry Service):** Charles Stross's *The Laundry Files*. Whitehall occult intelligence & BOFH computational demonology: Bob Howard, Pinky, Angleton, Mo, Brain, Persephone, Mhari, Holly, and The Stacks.
   - 💍 **`tolkien` (The Council of Elrond & Fellowship Crew):** J.R.R. Tolkien's *The Lord of the Rings*. Rivendell lore, Ranger trail-craft, Mirror of Galadriel invariants, and Khazad-dûm stonework: Gandalf, Aragorn, Galadriel, Gimli, Faramir, Legolas, Éowyn, Samwise, and Elrond.
   - 🐢 **`discworld` (The Ankh-Morpork City Watch, Patrician's Palace & Grand Trunk Crew):** Sir Terry Pratchett's *Discworld*. Pseudopolis Yard cobbles, the Oblong Office, and Grand Trunk Clacks velocity: Ponder Stibbons, Sam Vimes, Lord Vetinari, Detritus, Cheery Littlebottom, Moist von Lipwig, Adora Belle Dearheart, Carrot, and The Librarian.
   - 🏔️ **`reamde` (Corporation 9592, *T'Rain* & Tactical Overwatch):** Neal Stephenson's *REAMDE*. Pioneer Square MMORPG engine, GIS packet forensics, and Spetsnaz overwatch: Richard Forthrast, Zula, D-Squared, Sokolov, Csongor, Yuxia, Olivia Halifax-Lin, Pluto, and Devin Skraelin.
   - 🐺 **`irondruid` (Third Eye Books, Tempe Pack & The World Tree):** Kevin Hearne's *The Iron Druid Chronicles*. Elemental bindings, telepathic wolfhound traces, and vampire contract law: Atticus, Oberon, The Morrigan, Owen Kennedy, Hal Hauk, Granuaile, Leif Helgarson, Brighid, and Ogma.
   - ⚔️ **`prydain` (Caer Dallben, Caer Dathyl & The Free Commots):** Lloyd Alexander's *The Chronicles of Prydain*. *The Book of Three*, Fflewddur Fflam's truth-testing harp, and Free Commots craft: Dallben, Taran, Gwydion, Coll, Fflewddur, Gurgi, Doli, Eilonwy, and Taliesin.
   - 🥛 **`clockwork` (The Korova Milkbar & Ludovico Center):** Anthony Burgess's *A Clockwork Orange*. Korova Milk-Plus, Ludwig van's Glorious Ninth, Nadsat droogs, and Brodsky Center lid-lock forensics: Little Alex, Pete, Georgie, Dim, Dr. Brodsky, Dr. Branom, P.R. Deltoid, F. Alexander, and The Prison Chaplain.
   - ⚙️ **`generic` (The Standard Engineering Crew):** Zero-fiction professional specialist pipeline: Guide, Trace, Arch, Strike, Audit, Pulse, RedTeam, UX, and Ledger.
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

## 5. The 15 Crew Banks, The Bench, Cross-Bank Cameos & Modular Packs (179 ROMs)

In Gibson's *Sprawl* trilogy and Stephenson's *Anathem*, nobody runs a complex operation solo. You do not send the street samurai to translate Victorian architecture, and you do not ask the Lorite scholar to machine a hull joint.

Construct separates **9 Canonical Engineering Seats** (plus the zero-prose `razor` instrument and specialized **Bench / Seconds**) from **Swappable Crew Banks (`packs`)**. Each bank lives in its own lazy-loaded module under `src/packs/<bank>.js` (so normal turns load `0` inactive pack files into memory, and only your session's active 9 seats are queried from SQLite).

Out of the box, Construct ships with **179 deep ROM constructs** across fifteen Crew Banks:
- 🌃 **`sprawl` (default `crew`):** William Gibson's *Neuromancer*, *Count Zero*, and *Mona Lisa Overdrive* (9 starters + 3 bench seconds).
- 🦾 **`nightcity` (`afterlife` / `cyberpunk`):** *Cyberpunk 2077 / Phantom Liberty* Afterlife Edgerunners (9 starters + 3 bench seconds).
- 🏛️ **`anathem`:** Neal Stephenson's *Anathem* Concent of Saunt Edhar (9 starters + 3 bench seconds).
- 🔐 **`cryptonomicon` (`epiphyte`):** Neal Stephenson's *Cryptonomicon* Detachment 2702 & Epiphyte Corp (9 starters + 3 bench seconds).
- 🐉 **`shadowrun` (`shadowland`):** Sixth World 2050s Seattle Shadowland Team (9 starters + 3 bench seconds).
- 🕯️ **`dresden` (`paranet`):** Jim Butcher's *The Dresden Files* Chicago Paranet & White Council Crew (9 starters + 3 bench seconds).
- 🦄 **`amber` (`kolvir` / `pattern`):** Roger Zelazny's *The Chronicles of Amber* Royal House of Amber (9 starters + 3 bench seconds).
- 🐙 **`laundry` (`qdivision` / `mahoganyrow`):** Charles Stross's *The Laundry Files* SOE "Q" Division & Capital Laundry Service (9 starters + 3 bench seconds).
- 💍 **`tolkien` (`fellowship` / `middleearth` / `rivendell`):** J.R.R. Tolkien's *The Lord of the Rings* Council of Elrond & Fellowship Crew (9 starters + 4 bench seconds including `smeagol` / `gollum` for explicit courier duty).
- 🐢 **`discworld` (`ankhmorpork` / `nightwatch` / `clacks`):** Sir Terry Pratchett's *Discworld* Ankh-Morpork City Watch, Patrician's Palace & Grand Trunk Crew (9 starters + 3 bench seconds).
- 🏔️ **`reamde` (`tgd` / `corporation9592` / `train`):** Neal Stephenson's *REAMDE* Corporation 9592, *T'Rain* & Tactical Overwatch (9 starters + 3 bench seconds).
- 🐺 **`irondruid` (`tirnanog` / `thirdeye`):** Kevin Hearne's *The Iron Druid Chronicles* Third Eye Books, Tempe Pack & The World Tree (9 starters + 3 bench seconds).
- ⚔️ **`prydain` (`caerdath` / `caerdallben`):** Lloyd Alexander's *The Chronicles of Prydain* Caer Dallben, Caer Dathyl & The Free Commots (9 starters + 3 bench seconds).
- 🥛 **`clockwork` (`korova` / `droogs` / `nadsat`):** Anthony Burgess's *A Clockwork Orange* Korova Milkbar & Ludovico Center (9 starters + 3 bench seconds).
- ⚙️ **`generic` (`standard` / `plain`):** Zero-fiction principal engineering pipeline (9 starters + `razor`).

### The 9-Seat Crew Matrix Across All Fifteen Built-In Banks

| Seat & Color Badge | Phase & Engineering Role | `sprawl` | `nightcity` | `anathem` | `cryptonomicon` | `shadowrun` | `dresden` | `amber` | `laundry` | `tolkien` | `discworld` | `reamde` | `irondruid` | `prydain` | `clockwork` | `generic` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 🔵 **1A (`recon`)** | **Unfamiliar-Stack Scout & Conceptual Guide** | **`colin`** | **`judy`** | **`erasmus`** (`raz`) | **`lawrence`** (`waterhouse`) | **`talon`** (`shaman`) | **`bob`** | **`corwin`** | **`bobhoward`** (`howard`) | **`gandalf`** (`mithrandir`) | **`ponder`** (`stibbons`) | **`richard`** (`dodge`) | **`atticus`** (`siodhachan`) | **`dallben`** | **`alex`** (`littlealex`) | **`guide`** |
| 🟠 **1B (`diagnostics`)** | **Trench Bug Trace & Wire-Fault Hunter** | **`dixie`** | **`vik`** | **`sammann`** | **`goto`** | **`streetdoc`** | **`butters`** | **`merlin`** *(bench: **`caine`**)* | **`pinky`** *(bench: **`bridget`**)* | **`aragorn`** (`strider`, *bench: **`frodo`**)* | **`vimes`** *(bench: **`angua`**)* | **`zula`** *(bench: **`marlon`**)* | **`oberon`** | **`taran`** | **`pete`** *(bench: **`barnes`**)* | **`trace`** |
| 🟣 **2 (`architect`)** | **State Geometry, Invariants & Alignment Gate** | **`wintermute`** | **`tbug`** *(bench: **`takemura`**)* | **`jad`** *(bench: **`lodoghir`**)* | **`enoch`** *(bench: **`turing`**)* | **`fastjack`** *(bench: **`johnson`**)* | **`mab`** *(bench: **`ebenezar`**)* | **`fiona`** | **`angleton`** (`teapot`, *bench: **`iris`**)* | **`galadriel`** *(bench: **`celebrimbor`**)* | **`vetinari`** *(bench: **`weatherwax`**)* | **`dsquared`** *(bench: **`wallace`**)* | **`morrigan`** | **`gwydion`** *(bench: **`adaon`**)* | **`georgie`** *(bench: **`minister`**)* | **`arch`** |
| 🔴 **3 (`blitz`)** | **Full-Depth Execution & Red-First Mutation Proof** | **`molly`** | **`v`** *(bench: **`panam`**)* | **`cord`** | **`randy`** *(bench: **`bobby`**)* | **`hatchetman`** (`samurai`) | **`harry`** | **`benedict`** | **`mo`** *(bench: **`fred`**)* | **`gimli`** | **`detritus`** | **`sokolov`** *(bench: **`ivanov`**)* | **`owen`** *(bench: **`perun`**)* | **`coll`** *(bench: **`hevydd`**)* | **`dim`** | **`strike`** |
| 🟢 **4A (`forensics`)** | **Binary, Artifact, Zip & SDK Examiner** | **`finn`** | **`mitch`** | **`orolo`** *(bench: **`paphlagon`**)* | **`doug`** *(bench: **`rudy`**)* | **`rigger`** | **`murphy`** | **`julian`** | **`brain`** | **`faramir`** | **`cheery`** | **`csongor`** | **`hal`** | **`fflewddur`** (`fflam`) | **`brodsky`** | **`audit`** |
| ⚡ **4B (`velocity`)** | **Latency, Cold-Start & Runtime Profiler** | **`case`** | **`songbird`** | **`jesry`** *(bench: **`jules`**)* | **`avi`** | **`dodger`** *(bench: **`decker`**)* | **`thomas`** *(bench: **`toot`**)* | **`random`** | **`persephone`** (`cassie`) | **`legolas`** *(courier: **`smeagol`**)* | **`moist`** (`lipwig`) | **`yuxia`** | **`granuaile`** *(bench: **`starbuck`**)* | **`gurgi`** *(bench: **`kaw`**)* | **`branom`** | **`pulse`** |
| 🛡️ **4C (`redteam`)** | **Adversarial Security & Perimeter Breaker** | **`lupus`** *(bench: **`armitage`**)* | **`johnny`** *(bench: **`reed`**)* | **`lio`** | **`cantrell`** | **`harlequin`** *(bench: **`adept`**)* | **`marcone`** *(bench: **`michael`**)* | **`brand`** *(bench: **`eric`**)* | **`mhari`** | **`eowyn`** *(bench: **`boromir`**)* | **`adorabelle`** (`spike`, *bench: **`death`**)* | **`olivia`** | **`leif`** *(bench: **`coyote`**)* | **`doli`** | **`deltoid`** *(bench: **`catlady`**)* | **`redteam`** |
| 🎨 **4D (`ergonomics`)** | **UI Layout, Visual Hierarchy & Human Clarity** | **`angie`** *(bench: **`marly`**, **`3jane`**)* | **`evelyn`** | **`tulia`** | **`amy`** | **`siren`** (`face`) | **`grasshopper`** | **`dworkin`** *(bench: **`flora`**)* | **`holly`** | **`samwise`** (`sam`) | **`carrot`** | **`pluto`** | **`brighid`** (`brigid`) | **`eilonwy`** | **`falexander`** | **`ux`** |
| 📓 **5 (`archivist`)** | **Sequential Tape, Open Threads & Release Book** | **`continuity`** | **`rogue`** | **`ala`** | **`golgotha`** | **`captainchaos`** (`sysop`) | **`ivy`** (`archive`) | **`ghostwheel`** (`ghost`) | **`stacks`** (`registry`) | **`elrond`** | **`librarian`** (`ook`) | **`skraelin`** | **`ogma`** | **`taliesin`** | **`chaplain`** (`charlie`) | **`ledger`** |

### The Room Dynamic, Phase Gates, Cross-Bank Cameos & Parallel Overwatch

All 9 seats and the Bench of your active Crew Bank are in the room at all times:

1. **Color-Coded Run Banners & Speaker Tags:**
   - Every new run opens with the active bank's banner (for example, `🏛️ ═══ [SAUNT EDHAR // CONVOX] ═══` or `🌃 ═══ [SPRAWL // RUN ACTIVE] ═══`), each speaker switch carries its color-coded seat badge (`🔵`, `🟠`, `🟣`, `🔴`, `🟢`, `⚡`, `🛡️`, `🎨`, `📓`), and Seat 5 closes the run beneath a horizontal rule (`---`) so you can spot run boundaries immediately when scrolling back.
2. **Direct 1-on-1 Conversations & Polite Interjections:**
   - Address any crew member or bench specialist by name (*"Jad, what breaks if this retries?"*, *"Colin, walk me through this provider"*), and that specialist holds the conversation.
   - If another seat spots something squarely in their wheelhouse while you are talking, they may raise a hand with one short in-character line at the end; if you wave them off, they step back immediately.
3. **Cross-Bank Cameos (Triggered by Name or World-Cue):**
   - On normal turns, only your slotted Crew Bank speaks, with zero cross-bank slang bleed.
   - However, if you explicitly address a specialist from another bank (*"Johnny, look at this corp auth check"*, *"Enoch, have you seen this pattern?"*) or drop an unmistakable world-cue from another bank's universe (*"burn corpo shit"* -> `🛡️ [JOHNNY // RELIC SABOTEUR]`, *"Never deal with a dragon"* -> `🟣 [FASTJACK // ARCOLOGY BLUEPRINTS]`), that specialist can flicker in for a brief in-character cameo before handing the floor back to your active crew without changing the session's slotted bank.
4. **Phase Gates (`Seats 1A/1B -> Seat 2 Alignment Gate -> Seat 3 + Parallel Overwatch -> Seat 5`):**
   - On general tasks, `1A`/`1B` scouts first; `Seat 2` maps the invariants and **stops to get your green light** (*"Align and refine before pulling the trigger"*); `Seat 3` machines the full-depth implementation and verifies the regression test fails against the unfixed state first; `Seats 4A-4D` audit security, artifacts, velocity, and UX (in-turn or via parallel `[ROM: <name>]` subagents in OpenCode and Claude Code); and `Seat 5` records the frame (`#seq`) and state head on the tape.

### Calling Specialists Off the Bench (Why & How)

Why keep a **Bench ("Seconds")** instead of cramming 12 or 15 seats into every turn?
Because 90% of coding turns only need the 9 core engineering seats, and keeping specialized roles on the Bench costs **zero extra context tokens** until the moment you need them.

Each Crew Bank carries Bench specialists designed for specific high-leverage moments:
1. **Legal, Licensing, Contract Scope & Rhetorical Cross-Examination ("The Procians"):**
   - **`lodoghir`** (*Thainhoding, The Lodoghir* in `anathem`): Master Procian Rhetor and Convox inquisitor. Call him off the bench when you want ruthless cross-examination of a software license (MIT vs. Commons Clause vs. GPL), fair-use/IP boundaries, App Store / Play Store compliance, or when you want him to cross-examine a test suite by asking *"What bug could still pass this assertion?"*
   - **`johnson`** (*Mr. Johnson* in `shadowrun`): Immaculate corporate intermediary. Call him in when auditing contract deliverables, third-party vendor SLA/licensing traps, or strict scope boundaries.
2. **State-Machine Computability, Structural Foundations & Formal Logic:**
   - **`turing`** (*Alan Turing* in `cryptonomicon`), **`takemura`** (*Goro Takemura* in `nightcity`), or **`ebenezar`** (*Ebenezar McCoy, The Blackstaff* in `dresden`): Call them in when reducing a complex async retry loop to a decidable transition table or tearing down rotten legacy abstractions.
3. **Rapid Live A/B Benchmarking & Swarm Probes:**
   - **`toot`** (*Major General Toot-Toot Minimus* in `dresden`), **`jules`** (*Jules Verne Durand* in `anathem`), or **`decker`** (*Slamm-0!* in `shadowrun`): Call them off the bench when two engineers are debating a performance theory and you want a 30-second scratchpad A/B script to settle it with numbers.
4. **Deep Protocol / Decompiled Spec Archaeology:**
   - **`paphlagon`** (*Fraa Paphlagon* in `anathem`) or **`rudy`** (*Rudy von Hacklheber* in `cryptonomicon`): Call them in when dissecting an RFC, binary wire format, or decompiled game engine DLL.
5. **OpSec, IAM, Load-Bearing Wards & Tradecraft Audits:**
   - **`michael`** (*Michael Carpenter* in `dresden`), **`armitage`** (`sprawl`), **`reed`** (*Solomon Reed* in `nightcity`), or **`adept`** (`shadowrun`): Call them in for CI/CD secret bindings, least-privilege IAM roles, threshold wards, and covert fallback audits.
6. **Typography, Proportion & Design-System Architecture:**
   - **`marly`** (*Marly Krushkhova* in `sprawl`) or **`3jane`** (*Lady 3Jane* in `sprawl`): Call them in when auditing visual composition, negative space, or design-token discipline across light/dark themes.

**Two ways to use the Bench in plain English:**
- **Call them to the mic for a single question (no substitution required):**
  - *"Lodoghir, are we in fair-use territory with these packs, and what are the trademark risks?"*
  - *"Toot, run a quick A/B probe in the scratchpad to see if caching that SQLite handle saves real time."*
  - *"Marly, look at the spacing on this card header."*
- **Swap them into the active 9-seat starter lineup for the rest of the session (`construct rom sub <name>`):**
  - *"Sub Toot in"* (replaces `thomas` on Seat 4B `velocity` in the active `dresden` crew)
  - *"Sub Lodoghir in"* (replaces `jad` on Seat 2 `architect` in the active `anathem` crew)
  - *"Sub Takemura in"* (replaces `tbug` on Seat 2 in `nightcity`)
  - *"Sub Marly in"* (replaces `angie` on Seat 4D in `sprawl`)

### Drop-In Modular Crew Packs (`src/packs/<bank>.js` & `~/.config/opencode/packs/*.js`)

Every Crew Bank is a standalone file exporting `{ metadata, roms }`.
- To add a personal or custom Crew Bank without touching the Construct repository, drop a `<bank>.js` file into `~/.config/opencode/packs/` (or set `CONSTRUCT_PACKS_DIR`).
- Construct discovers it automatically on the next turn and registers its bank name, starter names, and bench backups across OpenCode and Claude Code.

> **Note on Literary & Creative Homage:** The fictional Crew Banks included in `src/packs/` (`sprawl`, `nightcity`, `anathem`, `cryptonomicon`, `shadowrun`, `dresden`, `amber`, and `laundry`) are non-commercial fan homages written to celebrate the authors, world-builders, and designers who shaped how our generation thinks about systems, networks, and craft (William Gibson, Neal Stephenson, Jim Butcher, Roger Zelazny, Charles Stross, Mike Pondsmith, CD Projekt Red, and the creators of *Shadowrun*). All calibration examples and engineering prompts are original software-engineering material, and Construct is licensed under MIT + Commons Clause v1.0 (forbidding commercial sale). Because each pack is a self-contained module, if any author, publisher, or rightsholder ever prefers that a specific homage pack not be bundled in the public repository, open an issue or reach out to `christopher@maujean.org` and that pack file will be removed promptly without affecting the engine or the `generic` engineering crew.

### Live OpenCode HUD & Interactive Review Pane Switcher (`construct hud` & `construct dashboard`)

Construct surfaces live telemetry across both the **OpenCode Desktop/Web App** and the **OpenCode TUI**:
- **Session Tab & Header Badges:** Automatically prefixes active session tab titles with the slotted Crew emblem, bank name, head frame `#seq`, and open thread count (for example, `🕯️ [dresden #129 · 2 open]`).
- **Tab- & Project-Sensitive Review Pane Control Deck (`~/.config/opencode/construct-hud.html`):** Open `construct-hud.html` in the OpenCode Review pane (via `tools.browser.preview` or `/construct`) for a dark-mode HUD with an interactive **Target Tab & Project Selector Bar** (`🎯 Auto-Follow Active Tab` plus individual open tab and project pills) and one-click buttons to switch between all 7 Crew Banks or sub Bench specialists in place (`127.0.0.1:47420` loopback control server).
- **TUI Slots & Full-CLI `/construct` Slash Command (`plugin/construct.js` & `plugin/tui.tsx`):** Mounts live status indicators into `prompt.footer.status`, `home.footer.status`, `sidebar.footer`, and `session.composer.top`, with `/construct` supporting **every Construct CLI command** directly in-session (`/construct upgrade`, `/construct reload`, `/construct boot`, `/construct rec ...`, `/construct tape`, `/construct rom ...`, `/construct inbox`, `/construct sync`) plus shorthands (`/construct <bank>`, `/construct sub <specialist>`, or bare `/construct` for the HUD & Crew selector) and in-memory `src/mcp.js` + `ctx.tool.reload()` hot-reloading.

### Multi-Tab & Per-Project Session Isolation (`session_roms` & `project_roms`)

OpenCode and Claude Code let you run multiple sessions (tabs/conversations) across multiple repositories at the same time. Construct isolates Crew Banks both **per tab (`session_roms`)** and **per project (`project_roms`)**:

1. **Three-Level Crew Resolution (`Tab -> Project -> Operator Default`):**
   - Each open tab remembers its own slotted Crew in `session_roms`.
   - Each repository remembers its project Crew in `project_roms`, so opening a brand-new tab in `acme/alpha_app` automatically inherits `acme/alpha_app`'s Crew instead of falling back to the global default.
   - Running the `sprawl` crew in Tab A (`acme/alpha_app`) and the `dresden` crew in Tab B (`acme/billing_service`) keeps both tabs and projects 100% isolated.
2. **Bounded Last-Known-Good Fallback Cache (`resolveBootWithFallback`):** The OpenCode plugin maintains a 50-entry FIFO cache keyed by `${sessionID}::${dir}` so another open tab never loses its `<construct-live-memory>` or Crew voice during a multi-step tool loop.
3. **"Until Further Notice" Default Crew vs. Per-Session Bootloader:** If you choose **Default until further notice** in the radio-button selector (or say *"Make the Anathem crew my default until further notice"*), new projects boot straight into that Crew Bank. Say *"Clear my default ROM"* anytime to re-enable the first-turn Crew Bank radio-button selector.

### Tuning Dials, Burning Directives & Customizing Specialists

Every specialist ROM has 5 behavioral dials (`0.00` to `1.00`):
- **`terse`**: Compression level (`0.95` = telegraphic one-liners; `0.50` = expansive architectural explanations).
- **`skepticism`**: How hard it challenges assumptions, demands contract proof, and pushes back with machine evidence.
- **`edge`**: Persona bite, dry humor, and world texture (`0.85` = unmistakable character voice; `0.10` = neutral/clinical).
- **`autonomy`**: Drive to execute multi-step grinds immediately vs. pausing to ask first (`0.95` = full-speed execution; `0.40` = step-by-step confirmation).
- **`telemetry`**: How much live 1-2 line breadcrumbing it emits before tool calls so you can monitor its path in real time.

Talk to Construct naturally to customize any Crew or specialist:
- *"Switch to the Night City crew."*
- *"Sub Takemura in."*
- *"Dial Molly's edge down to 0.60 and telemetry up to 0.85."*
- *"Burn a new directive into Wintermute: always check database index coverage before adding a query filter."*

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

## 7. The Sequential Memory Tape (Sandwich Pattern)

Instead of overwriting a flat markdown handoff file, Construct maintains an append-only, monotonically numbered **Sequential Tape** (`frames`) alongside a concise **Project State Head** (`heads`).

### How the Plugin Fronts Every Turn (Sandwich Attention Ordering)
Whenever you open OpenCode (or Claude Code) inside a project, Construct automatically injects `<construct-live-memory>` ordered in the **Sandwich Pattern** so active constraints sit at the very bottom of the system prompt right above your message:
1. **Top:** Your session's **9-Seat Crew Pipeline & Bench Roster**.
2. **Middle:** The project's **State Head** (`WHERE IT STANDS` and `NEXT`) and **Recent Sequential Tape** (chronological `intent`, `probe`, `finding`, `dead_end`, `decision`, `change`, `commit`, `release`, and `thread` frames with causal `<- #parent` links).
3. **Bottom (Highest Recency Attention):** All **Project Gotchas** for that repo, all **[OPEN] Threads & Unverified Items**, any **Drifted Repo Instruction File Alerts**, and any unread **Construct-to-Construct Comms**.

### Working with the Tape in Plain English
As you and the crew work, Construct records inflection points onto the tape in real time (so even if you close the window without saving, the sequence of what was tried and what failed is already on the tape). You can ask at any time:
- *"Where do we stand on this project, and what threads are still open?"*
- *"Why is `src/crdt.js` shaped like that?"* (`construct why <file_or_symbol>` searches synced CRDT frames with operator attribution, project/global gotchas, and local `git log -S`, and can automatically query a teammate's Construct over encrypted comms if a symbol has no local provenance.)
- *"Sync our GitHub issues and pull requests into Construct threads."* (`construct issues sync <project>` and `construct pr sync <project>` import open GitHub issues (`[GH #N]`) and pull requests (`[PR #N]`) as open threads and automatically resolve any thread whose issue or PR was merged/closed. `construct pr open`, `construct pr review`, and `construct pr merge` drive the full PR lifecycle while automatically recording `#seq` frames and dispatching Courier notifications to your teammates.)
- *"Check if Construct has an update and upgrade it."* (`construct upgrade --check` and `construct upgrade` pull `origin/main`, reseed all 15 Crew Banks, refresh `active-rom.md`, reinstall the OpenCode plugin, and update all 178 Claude Code subagents in one command -- or via the one-click `⬆️ CONSTRUCT UPDATE AVAILABLE` banner at the top of the HUD.)
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

Construct outputs a single signed and AEAD-wrapped **out-of-band invitation URI**:

```text
construct://invite/eyJwIjoi...#a8F3...
```

What is bundled inside that signed token:
- The project key (`acme/alpha_app`).
- The repository's **Git remote URL** (`origin`) and **branch** (auto-detected from your checkout), plus any optional bootstrap commands (`--setup "npm install"`).
- The project's **Group ID, epoch, and 256-bit `ChaCha20-Poly1305` AEAD-wrapped welcome secret** (unwrapped via `X25519` ECDH or a 256-bit `#...` fragment seed so `epochSecret` never appears in plaintext inside the JSON payload).
- The WebSocket relay endpoints (defaults to zero-signup public NIP-01 store-and-forward relays `wss://nos.lol` and `wss://relay.damus.io`, or your own self-hosted `construct relay --port 8787`).

> **Why Stateless Epoch-Keyed AEAD instead of stateful IETF RFC 9420 (TreeKEM)?** Strict RFC 9420 requires a central ordering server ("Delivery Service") to serialize `Commit` frames and immediately deletes per-message keys after decryption, which breaks out-of-order CRDT state convergence and historical catch-up across stateless store-and-forward relays. Construct uses **Stateless Epoch-Keyed AEAD** (`HKDF-SHA256` + `ChaCha20-Poly1305` with authenticated `AAD` + pinned `Ed25519` sender signatures) so any group member holding `(groupId, epoch, epochSecret)` can decrypt CRDT delta packets in any arrival order across multiple relays without a central server, while still supporting explicit epoch ratcheting (`ratchetEpochSecret`).

### Step 2: Accepting an Invite on the Collaborator's Machine
Your collaborator installs OpenCode + Construct and tells OpenCode:

> **"Join this Construct invite: `construct://invite/eyJwIjoi...#a8F3...` (clone it into `~/dev/alpha_app`) and sync the project."**  
> *(CLI: `construct join "construct://invite/eyJwIjoi...#a8F3..." [--dir ~/dev/alpha_app] && construct sync acme/alpha_app`)*

What happens automatically when they join:
1. **Cryptographic & Git Safety Verification:** Construct verifies your `did:key` Ed25519 signature, unwraps the AEAD-protected `epochSecret`, validates `gitUrl` and `branch` against flag/remote-helper injection (`validateGitCloneParams`), and registers the encrypted sync group in their local `construct.db`.
2. **Automatic `git clone` into Their Preferred Layout:** If the repository is not on their disk yet, Construct clones it into `--dir <path>` (or under their configured `workspace_root`) and binds their local checkout path into their `heads.repo`. Your machine and their machine can keep the repository at completely different filesystem paths; CRDT sync never overwrites local paths.
3. **Automatic Instruction Assimilation:** If the cloned repository contains existing instruction files or dev docs, Construct automatically assimilates its gotchas and scripts into their local `construct.db`.
4. **Live Encrypted CRDT Delta Sync:** `construct sync acme/alpha_app` pulls encrypted Epoch-Keyed AEAD packets for that project from the WebSocket relay, verifies sender key pinning, epoch match, and inner `AAD` integrity, enforces a 5-minute HLC clock-drift ceiling (`MAX_HLC_DRIFT_MS`), merges all records via a **Hybrid Logical Clock (HLC) CRDT**, and pushes only new local delta operations (`last_sync_hlc`).

### Strict Per-Project Isolation (Zero Bleed Guarantee)
Not all of your projects are shared with the same people. Construct enforces hard cryptographic and database isolation per project:
- Each shared project has its own independent group ID and 256-bit epoch key.
- **Outbound filter (`src/store.js`):** Exporting or syncing a project queries *only* records where `project = '<project>'` and `gotcha.scope = '<project>'`. Your `global` machine gotchas and your other private projects can never be exported into a project packet.
- **Inbound boundary guard (`src/crdt.js`):** When importing an encrypted packet for a group, `applyCrdtOpsInDb` enforces `op.project === group.project`, `gotcha.scope === group.project`, and `isHlcWithinDrift(op.hlc)`. Even a modified peer cannot inject records for another project, global scope, or a poisoned future timestamp.

---

## 9. Construct-to-Construct Comms & Courier Cameo Protocol (`--via <messenger>`)

Because each developer works with their own slotted Crew or specialist (for example, Alice works with the **Dresden Crew** on Windows while her teammate Bob works with the **Sprawl Crew** on Linux), your constructs can dispatch any specialist as a **Courier** over your shared encrypted sync channels -- popping into the recipient's feed in the courier's own voice to deliver the message without changing the recipient's active Crew!

Once you connect with a collaborator on *any* shared project (which automatically establishes a divorced `@comms` personal comms link alongside the project link and converges `@comms` keys in-band on project syncs for legacy-paired teammates) -- or connect with a friend who does **not** share any project repository with you via **`construct invite comms`** -- Construct Comms are **100% person-to-person (`--to <user>`)**:
- **Project sync links (`<owner>/<repo>`):** Carry project archival state (`frames`, project `gotchas`, `heads`), while relay syncs (`construct sync <project>`) also bridge pending Courier messages and converge `@comms` group keys in-band across paired project channels.
- **Personal Comms links (`@comms`):** Carry *only* person-to-person Courier messages (`message`, `message_tombstone`). If you want to exchange Courier Cameos with someone without sharing a git repository, run `construct invite comms` and have them run `construct join "<construct://invite/...>"` (no `--dir` or `workspace_root` required).

### How Courier Cameos Work in Practice

1. **Alice tells her Crew in OpenCode:**
   > *"Send Toot-Toot to tell Bob that #111 is merged and ready for review."*
   - Alice's Crew spawns a non-blocking `[ROM: toot]` subagent that composes the message in Toot-Toot's authentic first-person voice, records `[M#1]` (`from: alice/toot -> to: bob` via `--via toot`), and syncs it over the encrypted relay.

2. **Bob's session receives the Courier automatically (even if idle):**
   - If Bob's OpenCode session is idle when the relay poll arrives, Construct triggers an automatic `ctx.session.synthetic` wake-up turn and renders an interactive **`📬 UNREAD COURIER`** reply/dismiss banner at the top of his Review Pane HUD (`construct-hud-<project>.html`).
   - On Bob's turn, `<construct-live-memory>` surfaces the courier's badge, handle, and multi-bullet voice profile, and **Toot-Toot** buzzes directly into the bottom of Bob's feed for a cameo paragraph in his own voice before handing the mic back to Bob's active Crew.
   - All sent and received messages appear in the scrollable **Construct Comms & Courier Log** table inside the Review Pane HUD, where Bob can reply (with instant input locking), click **`✓ Ack`**, or click **`👁️ Hide`** (`construct hide-msg <id>`, which hides the message from the HUD while keeping it permanently searchable via `construct inbox --all` and preventing relay syncs from ever resurrecting it). Unwanted messages can also be obliterated locally and across relays via `construct purge-msg <id>` (CRDT `message_tombstone`).

3. **Bob replies in normal chat or directly from the HUD:**
   > *"Tell him we pulled main and it looks great."* (or *"Send Dixie back to tell Alice it looks great."*)
   - Bob's Construct records the reply on `[M#1]` (`construct reply 1 "..." [--via dixie]`) and syncs it back over the relay for a return courier cameo on Alice's next turn.

---

## 10. Token-Saving Architecture, Mechanical Guards & Smart Model Routing

Static markdown rule setups bleed tokens in three ways: loading multiple overlapping instruction files on every turn (`15,000+` tokens), re-reading bloated handoff files via tool calls, and wasting full-price frontier-model turns on failed shell commands or mechanical file searches.

Construct cuts token and dollar cost across four layers:

### 1. Deterministic System Prefix & Deduplicated Crew Roster (100% Provider Prompt-Cache Hits)
LLM providers (Anthropic, Google Gemini, OpenAI) cache the `system` prompt prefix across turns (`cache.read` tokens cost `75%` to `90%` less than uncached `input` tokens).
- Many "AI memory" plugins dynamically rewrite the system prompt on every turn based on keyword RAG over the user's latest message, invalidating the provider's prompt cache on every single turn.
- Construct deduplicates the 9-seat Crew Roster (`~2,300` tokens) and keeps `~/.config/opencode/active-rom.md` and `<construct-live-memory>` **100% deterministic across turns** until a new frame or gotcha is recorded. Turns `2..N` hit the provider's prompt cache across the entire system prefix.

### 2. Two-Resolution Memory (Headlines in Context, Full Detail on Demand)
- **Sequential Tape & Open Threads:** `<construct-live-memory>` injects only the last 8 compact 1-line frame headlines and 1-line open-thread headlines (keeping multi-page GitHub issue bodies, verification logs, and file-ref lists in SQLite until fetched on demand via `tools.construct.zoom({ seq })` or `construct why`).
- **Compact Global & Project Gotcha Indexing:** Global gotchas compile into `active-rom.md` as single-line `Title -> Do instead` rules (storing historical evidence in SQLite for `construct gotcha search`). When a project has `<= 12` gotchas, Construct injects the title and inline fix; when a project accumulates `> 12` gotchas (for example, a game-modding workspace with `80+` engine gotchas), `<construct-live-memory>` automatically switches to a compact 1-line title index (`[G#id] <title>`) and fetches full evidence on demand via `tools.construct.gotcha({ action: "search" })`.

### 3. Zero-Token Mechanical Shell Guards (`ctx.shell.hook("create.before")` & Claude `PreToolUse`)
When an AI assistant runs a broken shell pattern, a normal session wastes an entire tool execution and model retry turn (`3,000` to `6,000` tokens) recovering from the error -- or worse, silently swallows a failing build exit code.
Construct's OpenCode plugin (`ctx.shell.hook("create.before")`) and Claude Code hook (`PreToolUse` on `Bash|PowerShell`) mechanically block four built-in traps plus any custom `--guard "<regex>"` gotchas (scoped by `--guard-os all|win32|linux|darwin` and synced via CRDT) in `0` tokens before a process ever spawns:
1. **Gotcha #1 (`<<EOF` Heredocs `[all]`):** Blocks non-interactive shell heredocs and directs the model to use `Write`/`Edit` or scratchpad files.
2. **Gotcha #3 (Piped Build/Test Exit-Code Swallowing `[all]`):** Blocks piping `flutter build|test|analyze`, `npm test`, `dotnet build|test`, `cargo build|test`, `jest`, or `pytest` into `tail`, `head`, `grep`, or `Select-Object` without `pipefail`.
3. **Gotcha #4 (PowerShell 5.1 Quote Stripping on `gh api graphql` `[win32]`):** Blocks inline `gh api graphql -f query=...` calls containing inner double quotes on Windows and directs the model to pass `--input <scratch>/payload.json`.
4. **Gotcha #6 (`core.protectNTFS=false` & `:Zone.Identifier` Staging `[all]`):** Blocks disabling Git's NTFS path protection guard or staging `:Zone.Identifier` streams on any OS.

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

## 11. How It Works Under the Hood (TypeScript + Bundled `src/causal-lattice` World-Track III Engine)

`construct` is written in TypeScript (`src/*.ts`, `bin/construct.ts`, `test/construct.test.ts`) with typed request/options contracts (`src/types.ts`) and bundles the zero-dependency `causal-lattice` (World-Track II & III Evolved) library in-tree at `src/causal-lattice/`:

| Component | Implementation (`causal-lattice` Library) | Latency / Footprint |
|---|---|---|
| **World-Track III Evolved Branchless ROM Arena** | `EvolvedConstructArena` + `evolvePerfectLookupCircuit` (`causal-lattice`) evolves a zero-collision (`collisions = 0`) 4-step immediate-literal CPU circuit over all 179 ROMs | **`~93 ns/op`** branchless 64B register read (**`46.5x faster`** than SQLite `SELECT` + `JSON.parse`) |
| **World-Track III Evolved Cross-Field Predictor** | `evolveCrossFieldGenome` + `EvolvedCrossFieldCodec` (`causal-lattice`) evolves 16-term fixed-point integer coupling weights and residual rANS tables | **`61 B`** for 100 6-field states (**`4.88 bits/state`**: **`14.64x smaller`** than static World-Track II, **`135.3x smaller`** than JSON, 100% lossless) |
| **Schema-Compiled rANS + String-Slab CRDT Codec** | `encodeLatticeCrdtBatch` / `decodeLatticeCrdtBatch` (`causal-lattice`) | **`21.88x smaller`** wire batches than legacy UTF-8 JSON (`1,203 B` vs `26,321 B` on 40 CRDT ops); **`13.56x smaller`** sealed MLS envelopes |
| **Chaskey-12 Attenuated Capabilities** | `mintProjectCapability`, `attenuateProjectCapability`, `verifyProjectCapability` (`causal-lattice`, ISO/IEC 29192-6 128-bit ARX MAC) | **`~4.7 us`** verification (**`~34.6x faster`** than Ed25519 signature verification, zero DB lookups) |
| **1-RTT Rateless IBLT Relay Sync** | `CompactRibltSketch` (`causal-lattice`) speaking `IBLT_SYNC` over WebSocket relays (`src/relay.ts`) | **`1,399x less wire traffic`** than full `REQ` envelope fetches when reconciling 1 new envelope across 50 shared envelopes (`1,292 B` vs `1.8 MB`) |
| **Storage Engine & Compaction** | Node.js `node:sqlite` (`WAL` + `FTS5` BM25) + frontier-preserving `compactProjectCrdtLog` (`src/crdt.ts`) | Prunes superseded LWW operations while preserving the exact 64-bit Merkle-XOR frontier |
| **OpenCode V2 Integration** | `~/.config/opencode/plugins/construct.js` + `tui.tsx` + `src/mcp.ts` | Zero round-trip ROM/Crew switching, `<construct-voice-lock>`, and `0`-token shell guards |

---

## 12. CLI Reference (Optional)

Everything above works conversationally inside OpenCode (`tools.construct.*`). When you want to inspect or script Construct from a terminal:

```sh
# One-command OpenCode setup, self-update & assimilation
construct init [--rom <name>] [--dir <config_dir>]
construct upgrade [--check]
construct assimilate [<dir>] [--project <proj>] [--remove-files]

# Project boot, sequential tape, causal zoom, FTS5 search, GitHub Issues & PRs
construct projects
construct boot <project> [-n 25] [--session <session_id>]
construct rec <project> <kind> "<summary>" [--detail ".."] [--verified ".."] [--parent <seq>] [--resolves <seq>] [--open] [--refs a,b]
construct head <project> --state "<where_it_stands>" [--next "<next_step>"]
construct resolve <seq[,seq]> [--by <seq>] [--reason "<summary>"] [--verified "<layer>"] [--close-gh]
construct reopen <seq>
construct tape [<project>] [-n 30] [--kind <kind>] [--open]
construct zoom <seq> [-w 3]
construct search "<fts5_query>" [--project <project>] [--open]
construct why "<file_or_symbol>" [--project <project>] [--ask <user>]
construct issues [sync <project> | publish <seq>] [--dir <repo_dir>]
construct pr [sync <project> | open <project> --title ".." | review <project> <pr_num> --approve | merge <project> <pr_num>] [--to <user>] [--via <messenger>]
construct hud [<project>] [--dir <repo_dir>] [--session <session_id>] [--json]
construct dashboard [--out <html_path>] [--project <proj>] [--session <session_id>]
construct hud-server [--port 47420] [--restart]
construct edit <seq> [--summary ".."] [--detail ".."] [--verified ".."]

# Crew Banks, Bench substitutions, session slotting, dial tuning & directives
construct rom packs
construct rom list [--pack <bank>]
construct rom show [<bank_or_rom>]
construct rom use <bank_or_rom> [--session <session_id>] [--project <proj>]
construct rom sub <backup_name> [--session <session_id>] [--project <proj>]
construct rom default [<bank_or_rom> | off]
construct rom tune <dial>=<0..1> [<dial>=<0..1> ...] [--rom <name>]
construct rom burn "<directive>" [--rom <name>]
construct rom unburn <number> [--rom <name>]
construct rom clone <src> <dest> [--handle ".."] [--use]
construct rom sync

# Operator agreements & gotchas (with optional CRDT-synced 0-token shell guards)
construct user [show | list | use <id> | set <id> --name ".." --experience ".." --platform ".." --calibration ".."]
construct gotcha list [--project <proj> | --all]
construct gotcha add "<title>" [--project <proj>] [--status observed|from_source|reported] [--evidence ".."] [--fix ".."] [--guard "<regex>"] [--guard-os all|win32|linux|darwin] [--tags a,b]
construct gotcha search "<query>" [--project <proj> | --all]
construct gotcha rm <id>

# Causal-Lattice-Evolved Sync, Compaction, Benchmark & Courier Comms
construct did
construct invite [comms | <project>] [--relays wss://...] [--git-url ..] [--branch ..] [--setup "cmd1,cmd2"]
construct join "<construct://invite/...#...>" [--dir <target_dir>]
construct sync <project|comms> [--relays wss://...]
construct compact <project>
construct bench-lattice [-n 40] [--json]
construct site [--out <docs_dir>]
construct relay [--port 8787]
construct msg --to <user> [--via <messenger>] "<in-character message>"
construct drop <project> --to <user> [--via <messenger>] [--file <path> | --git-diff | --content ".."] [--note ".."]
construct apply-drop <msg_id> [--out <file> | --apply]
construct reply <msg_id> [--via <messenger>] "<in-character answer>"
construct ack <msg_id>
construct hide-msg <msg_id[,msg_id...]>
construct purge-msg <msg_id[,msg_id...]>
construct inbox [--project <proj>] [--to <user>] [--status pending|replied|delivered|hidden] [--all | --hidden]
```

## 13. License, Literary Homage & Good-Faith Pack Policy

### Software License (`MIT + Commons Clause v1.0`)

**MIT License with Commons Clause License Condition v1.0** (see [`LICENSE`](LICENSE)).

You are free to use, modify, and share Construct for personal or internal work, but **you may not sell, resell, or charge fees for Construct or any product or service whose value derives substantially from it**.

### Literary & Creative Homage Policy

The fictional Crew Banks included in `src/packs/` (`sprawl`, `nightcity`, `anathem`, `cryptonomicon`, `shadowrun`, `dresden`, `amber`, `laundry`, `tolkien`, `discworld`, `reamde`, `irondruid`, `prydain`, and `clockwork`) are non-commercial fan homages written out of love and respect for the authors, world-builders, and game designers who shaped how our generation thinks about systems, networks, and craft:
- **William Gibson** (*Neuromancer*, *Count Zero*, *Mona Lisa Overdrive*)
- **Neal Stephenson** (*Anathem*, *Cryptonomicon*, *REAMDE*)
- **Jim Butcher** (*The Dresden Files*)
- **Roger Zelazny** (*The Chronicles of Amber*)
- **Charles Stross** (*The Laundry Files*)
- **J.R.R. Tolkien** (*The Lord of the Rings* / *The Silmarillion*)
- **Sir Terry Pratchett** (*Discworld* -- *GNU Terry Pratchett*)
- **Kevin Hearne** (*The Iron Druid Chronicles*)
- **Lloyd Alexander** (*The Chronicles of Prydain*)
- **Anthony Burgess & Stanley Kubrick** (*A Clockwork Orange*)
- **Mike Pondsmith, R. Talsorian Games & CD Projekt Red** (*Cyberpunk 2020 / Cyberpunk 2077 / Phantom Liberty*)
- **Jordan Weisman & the creators of *Shadowrun*** (*Sixth World*)

All software-engineering calibration pairs, diagnostics, and verification rules in those packs are 100% original technical material, and the Commons Clause strictly forbids anyone from selling this repository or its packs commercially.

Because every Crew Bank is an isolated, lazy-loaded file (`src/packs/<bank>.js`) and Construct works standalone with the zero-fiction `generic` engineering crew, **if any author, publisher, or rightsholder ever feels that a specific homage pack should not be bundled in this public repository, please open an issue or email `christopher@maujean.org` and that pack file will be removed promptly and without fuss.**
