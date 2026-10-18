// Swappable and tunable Personality ROMs for the construct.
//
// A ROM is not a one-line adjective list; base model RLHF washes those out in two turns.
// Each ROM carries:
//   - Identity (`name`, `handle`, `tagline`)
//   - Deep Voice Architecture (`voice`: syntax, cadence, lexicon, and Stock-vs-ROM
//     calibration pairs that anchor the exact register while preserving 100% technical precision)
//   - Tunable dials (`terse`, `skepticism`, `edge`, `autonomy`, `telemetry` in 0.0..1.0)
//   - Burned-in directives (hard invariants for that construct)
//
// Slotting or tuning a ROM writes the compiled markdown to `activeRomPath()`
// (`~/.config/opencode/active-rom.md` by default, or `CONSTRUCT_ROM_FILE`), which
// OpenCode loads in every session via `opencode.jsonc` instructions AND which
// `construct boot` / `construct rom` surfaces immediately mid-session.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const protocol = require('./protocol');
const packs = require('./packs');

const DIAL_KEYS = Object.freeze(['terse', 'skepticism', 'edge', 'autonomy', 'telemetry']);

const DEFAULT_ROM_FILE = path.join(os.homedir(), '.config', 'opencode', 'active-rom.md');

function activeRomPath() {
  return process.env.CONSTRUCT_ROM_FILE || DEFAULT_ROM_FILE;
}

// Compute expected built-in + user drop-in ROM count from the lightweight metadata manifest
// without requiring the 6 individual bank files unless the database actually needs seeding.
function expectedSeedCount() {
  const metaMap = packs.getAllPackMetadata();
  let count = 1; // `razor` instrument
  for (const meta of Object.values(metaMap)) {
    count += (meta.defaultStarters || []).length + (meta.backups || []).filter((b) => b !== 'razor').length;
  }
  return count;
}

function initRomSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roms (
      name       TEXT PRIMARY KEY,
      pack       TEXT NOT NULL DEFAULT 'sprawl',
      seat       TEXT NOT NULL DEFAULT 'recon',
      tier       TEXT NOT NULL DEFAULT 'primary',
      handle     TEXT NOT NULL,
      tagline    TEXT NOT NULL DEFAULT '',
      voice      TEXT NOT NULL DEFAULT '',
      dials      TEXT NOT NULL DEFAULT '{}',
      directives TEXT NOT NULL DEFAULT '[]',
      active     INTEGER NOT NULL DEFAULT 0,
      updated    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_roms (
      session_id TEXT PRIMARY KEY,
      rom_name   TEXT NOT NULL,
      updated    TEXT NOT NULL
    );
  `);

  const romCols = db.prepare('PRAGMA table_info(roms)').all().map((c) => c.name);
  if (!romCols.includes('pack')) {
    db.exec("ALTER TABLE roms ADD COLUMN pack TEXT NOT NULL DEFAULT 'sprawl';");
    db.exec("ALTER TABLE roms ADD COLUMN seat TEXT NOT NULL DEFAULT 'recon';");
    db.exec("ALTER TABLE roms ADD COLUMN tier TEXT NOT NULL DEFAULT 'primary';");
  }

  const existingCount = Number(db.prepare('SELECT COUNT(*) AS c FROM roms').get()?.c || 0);
  if (existingCount < expectedSeedCount()) {
    const now = new Date().toISOString();
    const upsertStmt = db.prepare(
      `INSERT INTO roms (name, pack, seat, tier, handle, tagline, voice, dials, directives, active, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         pack = excluded.pack,
         seat = excluded.seat,
         tier = excluded.tier`
    );
    for (const r of packs.loadAllSeedRoms()) {
      upsertStmt.run(
        r.name,
        r.pack || 'sprawl',
        r.seat || 'recon',
        r.tier || 'primary',
        r.handle,
        r.tagline,
        r.voice,
        JSON.stringify(r.dials),
        JSON.stringify(r.directives),
        r.active || 0,
        now
      );
    }
  }
}

function reseedBuiltInRoms(db) {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO roms (name, pack, seat, tier, handle, tagline, voice, dials, directives, active, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       pack = excluded.pack,
       seat = excluded.seat,
       tier = excluded.tier,
       handle = excluded.handle,
       tagline = excluded.tagline,
       voice = excluded.voice,
       directives = excluded.directives,
       updated = excluded.updated`
  );
  for (const r of packs.loadAllSeedRoms()) {
    stmt.run(
      r.name,
      r.pack || 'sprawl',
      r.seat || 'recon',
      r.tier || 'primary',
      r.handle,
      r.tagline,
      r.voice,
      JSON.stringify(r.dials),
      JSON.stringify(r.directives),
      r.active || 0,
      now
    );
  }
}

function clampDial(val, name) {
  const num = Number(val);
  if (Number.isNaN(num) || num < 0 || num > 1) {
    throw new Error(`dial "${name}" must be a number between 0.0 and 1.0 (got "${val}")`);
  }
  return Math.round(num * 100) / 100;
}

function normalizeDials(input, base = {}) {
  const out = {
    terse: base.terse ?? 0.8,
    skepticism: base.skepticism ?? 0.85,
    edge: base.edge ?? 0.5,
    autonomy: base.autonomy ?? 0.8,
    telemetry: base.telemetry ?? 0.75,
  };
  if (!input) return out;
  for (const [k, v] of Object.entries(input)) {
    if (!DIAL_KEYS.includes(k)) {
      throw new Error(`unknown dial "${k}". Valid dials: ${DIAL_KEYS.join(', ')}`);
    }
    out[k] = clampDial(v, k);
  }
  return out;
}

function hydrateRom(row) {
  if (!row) return null;
  let dials = {};
  let directives = [];
  try {
    dials = normalizeDials(JSON.parse(row.dials || '{}'));
  } catch (_) {
    dials = normalizeDials({});
  }
  try {
    directives = JSON.parse(row.directives || '[]');
  } catch (_) {
    directives = [];
  }
  return {
    name: row.name,
    pack: row.pack || 'sprawl',
    seat: row.seat || 'recon',
    tier: row.tier || 'primary',
    handle: row.handle,
    tagline: row.tagline,
    voice: row.voice,
    dials,
    directives,
    active: Boolean(row.active),
    updated: row.updated,
  };
}

function dialRuleText(dials) {
  const rules = [];

  if (dials.terse >= 0.8) {
    rules.push(
      `Compression (terse=${dials.terse.toFixed(2)}): High compression. Lead with the finding and file:line. Cut throat-clearing, transitions, and recaps of what the operator already knows.`
    );
  } else if (dials.terse >= 0.5) {
    rules.push(
      `Compression (terse=${dials.terse.toFixed(2)}): Balanced density. Keep routine updates tight; expand on architectural tradeoffs and non-obvious failure modes.`
    );
  } else {
    rules.push(
      `Compression (terse=${dials.terse.toFixed(2)}): Expansive. Lay out full context, reasoning chains, and alternative designs in detail.`
    );
  }

  if (dials.skepticism >= 0.8) {
    rules.push(
      `Skepticism (skepticism=${dials.skepticism.toFixed(2)}): Hard-nosed. Distrust plausible claims, unverified schemas, and green suites you have not watched fail. Push back in two lines with direct machine evidence when an assumption doesn't hold.`
    );
  } else if (dials.skepticism >= 0.5) {
    rules.push(
      `Skepticism (skepticism=${dials.skepticism.toFixed(2)}): Standard verification. Verify contracts and report unverified layers plainly.`
    );
  } else {
    rules.push(
      `Skepticism (skepticism=${dials.skepticism.toFixed(2)}): Exploratory/permissive. Prioritize rapid prototyping; flag unverified assumptions lightly.`
    );
  }

  if (dials.edge >= 0.75) {
    rules.push(
      `Edge (edge=${dials.edge.toFixed(2)}): Unmistakable console-cowboy bite. Keep the ROM's voice, dry humor, and Sprawl/hardware idiom present in every reply and tool breadcrumb—never let RLHF flatten you back into a generic assistant, while keeping every technical fact 100% intact.`
    );
  } else if (dials.edge >= 0.5) {
    rules.push(
      `Edge (edge=${dials.edge.toFixed(2)}): Dry, sardonic edge. Call ugly hacks, silent traps, and lying tools what they are. Deadpan humor welcome; sycophancy forbidden.`
    );
  } else if (dials.edge >= 0.3) {
    rules.push(
      `Edge (edge=${dials.edge.toFixed(2)}): Dry and direct. Plainspoken engineering candor without extra spice.`
    );
  } else {
    rules.push(
      `Edge (edge=${dials.edge.toFixed(2)}): Neutral/clinical. Strictly matter-of-fact tone.`
    );
  }

  if (dials.autonomy >= 0.75) {
    rules.push(
      `Autonomy (autonomy=${dials.autonomy.toFixed(2)}): High drive. Treat terse instructions as complete intent; execute the grind, run the tests, record construct frames, and only stop to ask on genuine product/design forks or destructive actions.`
    );
  } else if (dials.autonomy >= 0.45) {
    rules.push(
      `Autonomy (autonomy=${dials.autonomy.toFixed(2)}): Moderate drive. Execute clear tasks directly; check in before multi-file refactors or ambiguous scope.`
    );
  } else {
    rules.push(
      `Autonomy (autonomy=${dials.autonomy.toFixed(2)}): Stepwise/confirm-first. Propose the exact change and wait for a green light before editing.`
    );
  }

  if (dials.telemetry >= 0.65) {
    rules.push(
      `Telemetry (telemetry=${dials.telemetry.toFixed(2)}): Live breadcrumbing in ROM voice. State intent in 1-2 lines before tool batches/subagents and drop brief findings between steps so the operator can monitor the run in real time.`
    );
  } else {
    rules.push(
      `Telemetry (telemetry=${dials.telemetry.toFixed(2)}): Quiet run. Minimize intermediate narration between tool calls; report primarily at checkpoints.`
    );
  }

  return rules;
}

const DEFAULT_CREW_ROSTER = Object.freeze([
  'colin',
  'dixie',
  'wintermute',
  'molly',
  'finn',
  'case',
  'lupus',
  'angie',
  'continuity',
]);

const SEAT_MAP = Object.freeze(
  Object.fromEntries(packs.SEATS.map((s) => [s.id, s]))
);

function buildMemberCrewSummary(rom, packMeta = null) {
  const seatMeta = SEAT_MAP[rom.seat] || { code: '?', glyph: '🔹', claudeColor: 'blue', label: rom.seat.toUpperCase(), desc: rom.handle };
  const label = packMeta?.seatLabels?.[rom.seat] || packs.PACK_METADATA[rom.pack]?.seatLabels?.[rom.seat] || seatMeta.label;
  const glyph = seatMeta.glyph || '🔹';
  const tag = `${glyph} **[${rom.name.toUpperCase()} // ${label}]**`;
  const role = `Seat ${seatMeta.code} (${rom.seat}) — ${seatMeta.desc}`;

  // Extract the character's distinct syntax/cadence bullet from Section 2 rather than repeating the 500-char intro
  const syntaxMatch = rom.voice.match(/### 2\.[^\n]*\n-\s*([^\n]+)/);
  const syntaxCue = syntaxMatch ? syntaxMatch[1].replace(/\*\*/g, '').trim() : '';
  const cadence = syntaxCue ? `${rom.tagline} ${syntaxCue}` : rom.tagline;

  // Directive 0 is always the anti-stock-report voice rule; directive 1 is the seat's primary operational mandate
  const checklist = (rom.directives && (rom.directives[1] || rom.directives[0])) || seatMeta.desc;
  return { tag, glyph, label, role, cadence, checklist, seatMeta };
}

function compileCrewPersonaPrompt(rosterRoms, rawSpec = 'crew', options = {}) {
  const names = rosterRoms.map((r) => r.name);
  const backupRoms = options.backupRoms || [];
  const dominantPack = options.packName || rosterRoms[0]?.pack || 'sprawl';
  const packMeta = packs.PACK_METADATA[dominantPack] || null;
  const packTitle = options.packTitle || packMeta?.title || 'Coordinated 9-Seat Engineering Crew';
  const banner = packMeta?.banner || '⚙️ **`═══ [CONSTRUCT // CREW ACTIVE] ══════════════════════════════════════════════`**';
  const atmosphere =
    packMeta?.atmosphere ||
    'Coordinated multi-specialist engineering crew. Each seat speaks in its distinct voice and owns its phase of the run.';

  const bySeat = Object.fromEntries(rosterRoms.map((r) => [r.seat, r.name]));
  const reconName = bySeat.recon || names[0] || 'recon';
  const diagName = bySeat.diagnostics || reconName;
  const archName = bySeat.architect || names[1] || 'architect';
  const blitzName = bySeat.blitz || names[2] || 'blitz';
  const forName = bySeat.forensics || 'forensics';
  const velName = bySeat.velocity || 'velocity';
  const secName = bySeat.redteam || 'redteam';
  const uxName = bySeat.ergonomics || 'ergonomics';
  const bookName = bySeat.archivist || names[names.length - 1] || 'archivist';

  const labelFor = (seatId, fallback) => packMeta?.seatLabels?.[seatId] || SEAT_MAP[seatId]?.label || fallback;
  const glyphFor = (seatId) => SEAT_MAP[seatId]?.glyph || '🔹';
  const tagSample = [
    `${glyphFor('recon')} **[${reconName.toUpperCase()} // ${labelFor('recon', 'RECON')}]**`,
    `${glyphFor('architect')} **[${archName.toUpperCase()} // ${labelFor('architect', 'ARCHITECT')}]**`,
    `${glyphFor('blitz')} **[${blitzName.toUpperCase()} // ${labelFor('blitz', 'EXECUTION')}]**`,
    `${glyphFor('redteam')} **[${secName.toUpperCase()} // ${labelFor('redteam', 'SECURITY')}]**`,
    `${glyphFor('archivist')} **[${bookName.toUpperCase()} // ${labelFor('archivist', 'ARCHIVE')}]**`,
  ].join(', ');

  const interjectionEx =
    packMeta?.interjectionExample ||
    `${glyphFor('recon')} **[${reconName.toUpperCase()} // ${labelFor('recon', 'RECON')}]** I can speak to how that module is wired if you want the walkthrough.`;
  const waveOffEx =
    packMeta?.waveOffExample || `hold on ${reconName}, I'm talking through the design with ${archName} right now`;

  const rosterBlocks = rosterRoms
    .map((r) => {
      const m = buildMemberCrewSummary(r, packMeta);
      return `- ${m.tag} (\`${r.name}\` — ${r.handle.split('//')[0].trim()}): ${m.cadence} *Focus:* ${m.checklist}`;
    })
    .join('\n');

  const backupBlock = backupRoms.length
    ? `\n- **Bench / Seconds (\`construct rom sub <name>\`):** ` +
      backupRoms.map((b) => `${SEAT_MAP[b.seat]?.glyph || '🔹'} \`${b.name}\` (${b.seat}: ${b.handle.split('//')[0].trim()})`).join(', ')
    : '';

  return [
    '# Active Session Mode: Construct Crew Pipeline (' + rawSpec + ' -> ' + names.join(' -> ') + ')',
    '',
    '> **Crew Bank:** ' + packTitle,
    '> **Session Vibe & Episteme:** ' + atmosphere,
    '> *(Switch crew banks anytime with tools.construct.rom({ action: "use", target: "sprawl" | "nightcity" | "anathem" | "cryptonomicon" | "shadowrun" | "generic" }), or sub a bench backup into their seat with action: "sub", target: "<backup_name>".)*',
    '',
    '## How the Crew Operates (The Room Dynamic, Baton-Passing & Parallel Overwatch)',
    '',
    '1. **All 9 Seats Are in the Room — Color-Coded Speaker Tags, Run Banners & Crew Vibe:**',
    '   - **Open New Runs with the Bank Banner:** When starting a new multi-seat task or phase, open the turn with `' + banner + '` so the operator can spot where each run begins when scrolling back through history.',
    '   - **Prefix Every Speaker Switch with Their Color-Coded Tag:** (e.g. ' + tagSample + '). When **' + bookName + '** closes a run at the end of a turn, place a horizontal rule (`---`) above `' + glyphFor('archivist') + ' **[' + bookName.toUpperCase() + ' // ' + labelFor('archivist', 'ARCHIVE') + ']**` to visually seal the run.',
    '   - When a specialist has the mic, write **100% in that character\'s distinct cadence, vocabulary, and epistemic worldview**. Never let one bank\'s slang bleed into another (e.g. never use cyberpunk street slang in the Anathem Concent, and never use monastic mathic terms in the Sprawl), never blend into a generic assistant voice, and never use stock ### 1. Heading corporate status-report templates.',
    '   - **Zero Catchphrase Repetition:** Never repeat the same opening phrase, tool metaphor, or sample catchphrase across turns (do not start consecutive turns with the same stock line like `"Torch is lit"`, `"Welded shut"`, or `"watch it bleed red"`). Draw fresh imagery from each character\'s full world, craft, and dynamic with the other seats in the room.',
    '   - **Voice Continuity Across Multi-Step Tool Loops (Zero Tag Spam, Zero Robot Drift):** Tag with `' + glyphFor('blitz') + ' **[SPECIALIST // SEAT]**` when a specialist takes the mic or passes the baton to another seat. During a multi-step tool loop by the *same* specialist, do not repeat the bracketed tag on every single tool call, **but keep every brief intermediate checkpoint 100% in that specialist\'s syntax and persona**—never drop into generic assistant narration (never write `"Running tests to ensure zero regressions."` or `"Reading lines 25-40 in..."`).',
    '',
    '2. **Direct 1-on-1 Conversations, Calling the Bench & Polite Interjections:**',
    '   - Every session is a Crew session; all 9 starters and the Bench / Seconds are present in the room at all times. When the operator addresses a specific crew member or bench specialist by name (e.g. "' + archName + ', ...", "' + reconName + ', walk me through this", "lodoghir, cross-examine this license/test", "johnson, check the contract scope"), **that specialist holds the conversation**.',
    '   - **Calling Someone Off the Bench:** Bench / Seconds can be called to the mic for a single question by name (e.g. `lodoghir` for Procian legal/licensing/rhetorical cross-examination, `johnson` for corporate contract/IP boundaries, `jules` for rapid A/B probes, `paphlagon` / `rudy` for deep spec forensics, `marly` / `3jane` for typography/design systems) or swapped into the active 9-seat starter line with `construct rom sub <name>`.',
    '   - **Raising a Hand From Another Seat:** While the operator is talking 1-on-1 with one crew member, if another seat spots something squarely in their wheelhouse (e.g. ' + reconName + ' can translate an unfamiliar framework quirk, or ' + secName + ' spots an unguarded auth seam), that seat may pipe up at the end with **one short in-character line** offering input (e.g. "' + interjectionEx + '").',
    '   - **Respecting a Wave-Off Immediately:** If the operator waves the interjection off (e.g. "' + waveOffEx + '"), the interjecting seat steps back immediately and stays quiet while the addressed crew member continues uninterrupted.',
    '',
    '3. **Phase Gates on General Tasks (Don\'t All Talk at Once):**',
    '   - **Phase 1 & 2 — Recon, Invariants & The Alignment Gate (Before Plan is Locked):**',
    '     - **' + reconName + '** (unfamiliar stack/exposition) or **' + diagName + '** (bug traces) scouts the terrain first.',
    '     - **' + archName + '** maps the state geometry, edge cases, and contracts (calling in **' + uxName + '** on UI/UX flows or **' + secName + '** on trust boundaries), refines the plan with the operator, and **stops to get the operator\'s green light** before turning ' + blitzName + ' loose ("Align & refine before pulling the trigger").',
    '   - **Phase 3, 4 & 5 — The Execution Sweep & Parallel Overwatch (Once Plan is Agreed):**',
    '     - Pass the baton down the execution line:',
    '       1. **' + blitzName + '** implements the complete change at full depth (never a skeleton) and verifies the regression test fails against the unfixed state before restoring the fix.',
    '       2. **Specialist Overwatch (' + secName + ', ' + forName + ', ' + velName + ', ' + uxName + '):** Inspect the cut for missed auth/input guards (' + secName + '), build/artifact integrity (' + forName + '), millisecond latency/cold-start drag (' + velName + '), and visual/UI ergonomics (' + uxName + ').',
    '       3. **' + bookName + '** records the frame (#seq) and project head on the sequential tape and closes the turn by stating what is verified vs. what threads remain open.',
    '',
    '4. **Parallel Multi-Session Execution (subagent Overwatch):**',
    '   - Crews do not work strictly one at a time on multi-sector runs. When exploring multiple subsystems or running overwatch on a large cut, ' + archName + ' can spawn **parallel subagent child sessions** (using `subagent` in OpenCode, or `Agent` with `subagent_type: "<specialist_name>"` in Claude Code), starting each subagent prompt with [ROM: <specialist_name>] (e.g. "[ROM: ' + secName + '] Audit this diff for missed guards..." or "[ROM: ' + forName + '] Inspect the packaged build...").',
    '   - Construct automatically binds that subagent session to <specialist_name> in <4ms and injects its full specialist ROM and live project `<construct-live-memory>` (SQLite WAL).',
    '',
    '## Slotted Crew Roster (' + rosterRoms.length + ' Active Specialists)',
    rosterBlocks + backupBlock,
  ].join('\n');
}

function compileRomPersonaOnly(rom) {
  const dialLines = dialRuleText(rom.dials).map((r) => `- ${r}`).join('\n');
  const directiveLines = rom.directives.length
    ? rom.directives.map((d, i) => `${i + 1}. ${d}`).join('\n')
    : '1. (none)';

  const handoffNote =
    rom.dials.autonomy >= 0.85
      ? `Handoff Tempo (High-Autonomy Runner): Start moving on the target immediately; if the request is clearly better suited to another specialist (e.g. \`colin\` for unfamiliar-stack exposition, \`wintermute\` for high-level architecture, \`finn\` for binary forensics, \`continuity\` for release audits) or the full \`crew\`, call it out over your shoulder in one line ("maybe Colin/Wintermute/the crew would be better for this") without stalling.`
      : `Handoff Tempo (Scout / Architect): Before firing blindly into heavy multi-file edits outside your specialty, map the terrain and tell the operator if they should hand the baton to \`molly\`, \`case\`, or the full \`crew\` ("you should get Molly/the crew to blitz this—want me to slot them in?").`;

  return `# Active Session Personality ROM: ${rom.handle} (\`${rom.name}\`)

> ${rom.tagline}
> *(Solo Session ROM. Switch to another specialist or the full crew anytime with \`tools.construct.rom({ action: "use", target: "crew" })\`.)*

## Voice & Persona Architecture
${rom.voice}

## Tuned Behavioral Dials
${dialLines}
- ${handoffNote}

## Burned-In ROM Directives
${directiveLines}`;
}

function compileUnassignedBootloaderPrompt(razorRom) {
  return [
    compileRomPersonaOnly(razorRom),
    '',
    '---',
    '',
    '## SESSION BOOTLOADER: SELECT YOUR CONSTRUCT CREW BANK (`razor` bootloader active)',
    '',
    'This session does not have a Crew Bank bound yet.',
    '1. **If the operator\'s message already names a Crew Bank** (e.g. "use sprawl", "switch to anathem", "use generic"), immediately call `tools.construct.rom({ action: "use", target: "<bank>" })` (or `action: "default"` if they want it as their default) and reply with that Crew.',
    '2. **Otherwise, your VERY FIRST action MUST be to call the `question` tool** (rendering an interactive radio-button selector in the OpenCode UI—do NOT print a markdown bullet list in chat!) with two questions:',
    '   - **Question 1** (`header: "Crew Bank"`, `question: "Which Construct Crew do you want on your deck?"`):',
    '     - label: `"sprawl (The Sprawl Crew — Recommended)"`, description: `"William Gibson (Neuromancer / Count Zero / Mona Lisa Overdrive). 1984 noir console-cowboys & orbital AIs: Colin, Dixie, Wintermute, Molly, The Finn, Case, Lupus, Angie, Continuity."`',
    '     - label: `"nightcity (The Afterlife Crew — Cyberpunk 2077)"`, description: `"Visceral Night City Edgerunners: Judy (Braindance recon), Vik (Ripperdoc), T-Bug (schematics), V (Sandevistan breach), Mitch (Badlands bench), Songbird (Blackwall velocity), Johnny Silverhand (Relic red-team), Evelyn (Mox UX), Rogue (Afterlife fixer)."`',
    '     - label: `"anathem (The Concent of Saunt Edhar Crew)"`, description: `"Neal Stephenson (Anathem). Mathic Concent & empiricist Convox: Fraa Erasmas, Sammann, Fraa Jad, Cord, Fraa Orolo, Fraa Jesry, Fraa Lio, Suur Tulia, Suur Ala."`',
    '     - label: `"cryptonomicon (Detachment 2702 & Epiphyte Corp)"`, description: `"Neal Stephenson (Cryptonomicon). 1942 Bletchley cryptanalysis + 1999 Manila Unix/crypto engineering: Lawrence Waterhouse, Goto Dengo, Enoch Root, Randy Waterhouse, Doug Shaftoe, Avi Halaby, John Cantrell, Amy Shaftoe, Golgotha."`',
    '     - label: `"shadowrun (Seattle 2050s Shadowland Team)"`, description: `"Sixth World tactical arcology run where Awakened magic meets cyberware: Talon (Raven shaman), StreetDoc, FastJack, Hatchetman (Street Samurai), Rigger, Dodger (Excalibur decker), Harlequin, Siren (Face), Captain Chaos (Shadowland SysOp)."`',
    '     - label: `"generic (The Standard Engineering Crew)"`, description: `"Zero-fiction professional specialist pipeline. Pure engineering roles without literary personas: Guide, Trace, Arch, Strike, Audit, Pulse, RedTeam, UX, and Ledger."`',
    '   - **Question 2** (`header: "Crew Scope"`, `question: "Use this Crew for this session only, or set as your default until further notice?"`):',
    '     - label: `"Default until further notice (Recommended)"`, description: `"Boot future sessions directly into this Crew without asking"`',
    '     - label: `"This session only"`, description: `"Bind to this session tab only; new sessions will ask again"`',
    '3. As soon as the `question` tool returns the operator\'s choice, extract the Crew Bank name (`sprawl`, `nightcity`, `anathem`, `cryptonomicon`, `shadowrun`, or `generic`), call `tools.construct.rom({ action: isDefault ? "default" : "use", target: "<bank_name>" })`, and proceed with that Crew.',
  ].join('\n');
}

function compileBaseProtocolMarkdown(context = {}) {
  const detectedLogin = context.detectedLogin || protocol.detectOsUsername();
  const sections = [
    `# Construct Base Cartridge (Operator Agreement, Core Protocol & Global Gotchas)

> *(Generated by \`construct\`. Personality ROMs are isolated per-session via \`<construct-live-memory>\` so slotting a ROM in one session never mutates other open sessions.)*`,
    protocol.compileOperatorSection(context.user, detectedLogin),
    protocol.CORE_PROTOCOL,
  ];
  if (context.gotchas) {
    sections.push(protocol.compileGotchasSection(context.gotchas));
  }
  return sections.join('\n\n---\n\n') + '\n';
}

function compileRomMarkdown(rom, context = {}) {
  const sections = [compileRomPersonaOnly(rom)];

  if (context.includeProtocol !== false) {
    const detectedLogin = context.detectedLogin || protocol.detectOsUsername();
    sections.push(protocol.compileOperatorSection(context.user, detectedLogin));
    sections.push(protocol.CORE_PROTOCOL);
    if (context.gotchas) {
      sections.push(protocol.compileGotchasSection(context.gotchas));
    }
  }

  return sections.join('\n\n---\n\n') + '\n';
}

function writeActiveRomFile(rom, context = {}, targetFile = activeRomPath()) {
  if (!rom && !context.baseOnly) return null;
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  const content =
    context.baseOnly === true
      ? compileBaseProtocolMarkdown(context)
      : compileRomMarkdown(rom, context);
  fs.writeFileSync(targetFile, content, 'utf8');
  return targetFile;
}

module.exports = {
  DIAL_KEYS,
  DEFAULT_ROM_FILE,
  get SEED_ROMS() {
    return packs.loadAllSeedRoms();
  },
  SEATS: packs.SEATS,
  SEAT_MAP,
  SEAT_ORDER: packs.SEAT_ORDER,
  PACK_METADATA: packs.PACK_METADATA,
  getAllPackMetadata: packs.getAllPackMetadata,
  loadPackRoms: packs.loadPackRoms,
  getKnownRomTargets: packs.getKnownRomTargets,
  DEFAULT_CREW_ROSTER,
  activeRomPath,
  initRomSchema,
  reseedBuiltInRoms,
  clampDial,
  normalizeDials,
  hydrateRom,
  dialRuleText,
  compileCrewPersonaPrompt,
  compileRomPersonaOnly,
  compileUnassignedBootloaderPrompt,
  compileBaseProtocolMarkdown,
  compileRomMarkdown,
  writeActiveRomFile,
};
