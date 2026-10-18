// Operator Agreements (`users`), Machine/Tool Gotchas (`gotchas`), and the
// Core Engineering Protocol (formerly `llm-dev-kit` 01..05).
//
// The construct always knows who is at the keyboard:
// - It checks `process.env.CONSTRUCT_USER` or `os.userInfo().username` against
//   registered `users` (`os_users` JSON list or `id`), falling back to an
//   explicitly selected `active = 1` user on single-user machines.
// - If `CONSTRUCT_USER` is set to an unknown login (or no user matches on a
//   new machine), `getCurrentUserInDb` returns `null` and the compiled ROM
//   activates the New Operator Onboarding Protocol so the construct introduces
//   itself and builds the new user's agreement interactively.

'use strict';

const os = require('node:os');

const CORE_PROTOCOL = `## Core Engineering Protocol (Non-Negotiable)

### 1. The Rule That Matters Most: Read the Contract First
- **Never write code against a contract you have not read** (a library API, REST endpoint, config format, schema, plugin protocol, or another module).
- Read the actual documentation or source first, and state what you based the work on.
- If you cannot find a spec, do **not** produce a finished-looking feature built on a guess. Say plainly: *"I could not find documentation for X. Here is what I inferred from Y, and it is unverified."*
- **Thirty seconds of testing beats any amount of plausibility.** Never leap from a plausible-sounding flag or name straight to a confident claim.
- **Align on design first; then build the complete thing, never a skeleton.** When a new feature, persona, or design is proposed, first articulate what you understand the target to be and refine it with the operator before pulling the trigger. Once the trigger is pulled, deliver the *complete* implementation at full depth—never a three-line sketch, stub, or watered-down skeleton unless a prototype was explicitly requested.

### 2. Verification & Reporting
- **Say what is verified, how it was verified (name the layer), and what is not.**
  - Layers: (1) Static analysis / build, (2) Automated unit/widget/integration tests, (3) Logs & warnings (filter for failure signatures—exceptions, \`error\`, \`failed\`, \`warning\`—not just success messages), (4) Human / real device / live server.
  - Good: *"63 tests pass and the build is clean. Nobody has opened the screen on a device."*
  - Bad: *"Fixed and working!"*
- **Do not say "confirmed" until the evidence is in.**
- **Correct earlier advice out loud.** If a note or earlier claim turns out to be wrong, say so plainly, fix it on the tape (\`construct edit\`), and move on.
- **Assert behaviour, not existence.** Encode worked examples from design discussions directly as assertions. Assert against what the running system actually registered/produced, not by reading your own fixture back.
- **Ask of every test: what else could make this pass?** Delete the feature mentally and ask whether the suite would notice.
- **Verify every regression test by watching it fail.** Put the bug back, run the suite, see red, then restore the fix. A test never seen failing is a guess about what it covers.
- **Assert both sides of a gate.** Test that an authorized caller passes *and* an unauthorized/unentitled caller is rejected.
- **Be suspicious when a number moves the way you expected.** When assertion or test counts drop after a refactor, account for the exact delta.
- **Scope your checking by what the change can actually reach.** Follow real dependencies; state which test set you ran and why that is the whole set.
- **Take a backup before any risky or bulk edit**, and leave the working tree clean of dead-end investigations.

### 3. Scripts & Automation
- Every routine operation (\`build\`, \`test\`, \`run\`, \`logs\`, \`clean\`) should be one command that exits non-zero on failure, prints a greppable summary line, and takes no interactive input.
- Put environment/tool paths in one place, overridable from the environment. Make destructive scripts state what they will destroy and require a flag.

### 4. Releases & Handovers
- **A build handed over is a line in the sand.** Any report afterwards is against *that* build, and the fix belongs to the next version.
- **A new build always means a new version number.** If an artifact already exists at the current version number, that number is spent—bump and split the changelog before packaging.
- **Two changelogs, two readers:** player/user changelogs carry one short entry per published release in user terms (no build/refactor internals, and a first publish is just "First release."); dev changelogs (\`docs/changelog-dev.md\`) carry per-build notes and what testers should look at.
- **Verify the artifact, not just the source.** Inspect the built zip/bundle layout, version, and included files before handing it over.`;

const SEED_USERS = Object.freeze([]);

const SEED_GOTCHAS = Object.freeze([]);

function initProtocolSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      os_users       TEXT NOT NULL DEFAULT '[]',
      experience     TEXT NOT NULL DEFAULT '',
      platform       TEXT NOT NULL DEFAULT '',
      workspace_root TEXT NOT NULL DEFAULT '',
      calibration    TEXT NOT NULL DEFAULT '',
      default_rom    TEXT NOT NULL DEFAULT '',
      active         INTEGER NOT NULL DEFAULT 0,
      updated        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gotchas (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      scope    TEXT NOT NULL DEFAULT 'global',
      title    TEXT NOT NULL,
      status   TEXT NOT NULL DEFAULT 'observed',
      tags     TEXT NOT NULL DEFAULT '[]',
      evidence TEXT NOT NULL DEFAULT '',
      fix      TEXT NOT NULL DEFAULT '',
      created  TEXT NOT NULL
    );
  `);

  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userCols.includes('default_rom')) {
    db.exec("ALTER TABLE users ADD COLUMN default_rom TEXT NOT NULL DEFAULT '';");
  }
  if (!userCols.includes('workspace_root')) {
    db.exec("ALTER TABLE users ADD COLUMN workspace_root TEXT NOT NULL DEFAULT '';");
  }

  const cols = db.prepare("PRAGMA table_info(gotchas)").all().map((c) => c.name);
  if (!cols.includes('scope')) {
    db.exec("ALTER TABLE gotchas ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_gotchas_scope ON gotchas(scope, id);

    CREATE VIRTUAL TABLE IF NOT EXISTS gotchas_fts USING fts5(
      scope,
      title,
      tags,
      evidence,
      fix,
      content='gotchas',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS gotchas_ai AFTER INSERT ON gotchas BEGIN
      INSERT INTO gotchas_fts(rowid, scope, title, tags, evidence, fix)
      VALUES (new.id, new.scope, new.title, new.tags, new.evidence, new.fix);
    END;

    CREATE TRIGGER IF NOT EXISTS gotchas_ad AFTER DELETE ON gotchas BEGIN
      INSERT INTO gotchas_fts(gotchas_fts, rowid, scope, title, tags, evidence, fix)
      VALUES ('delete', old.id, old.scope, old.title, old.tags, old.evidence, old.fix);
    END;

    CREATE TRIGGER IF NOT EXISTS gotchas_au AFTER UPDATE ON gotchas BEGIN
      INSERT INTO gotchas_fts(gotchas_fts, rowid, scope, title, tags, evidence, fix)
      VALUES ('delete', old.id, old.scope, old.title, old.tags, old.evidence, old.fix);
      INSERT INTO gotchas_fts(rowid, scope, title, tags, evidence, fix)
      VALUES (new.id, new.scope, new.title, new.tags, new.evidence, new.fix);
    END;
  `);

  const userCount = Number(db.prepare('SELECT COUNT(*) AS c FROM users').get()?.c || 0);
  if (userCount === 0) {
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT INTO users (id, name, os_users, experience, platform, calibration, active, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const u of SEED_USERS) {
      stmt.run(
        u.id,
        u.name,
        JSON.stringify(u.osUsers),
        u.experience,
        u.platform,
        u.calibration,
        u.active,
        now
      );
    }
  }

  const gotchaCount = Number(db.prepare('SELECT COUNT(*) AS c FROM gotchas').get()?.c || 0);
  if (gotchaCount === 0) {
    const stmt = db.prepare(
      `INSERT INTO gotchas (scope, title, status, tags, evidence, fix, created)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const g of SEED_GOTCHAS) {
      stmt.run(g.scope || 'global', g.title, g.status, JSON.stringify(g.tags), g.evidence, g.fix, g.created);
    }
  }
}

function hydrateUser(row) {
  if (!row) return null;
  let osUsers = [];
  try {
    osUsers = JSON.parse(row.os_users || '[]');
  } catch (_) {
    osUsers = [];
  }
  return {
    id: row.id,
    name: row.name,
    osUsers,
    experience: row.experience || '',
    platform: row.platform || '',
    workspaceRoot: row.workspace_root || '',
    calibration: row.calibration || '',
    defaultRom: row.default_rom || '',
    active: Boolean(row.active),
    updated: row.updated,
  };
}

function hydrateGotcha(row) {
  if (!row) return null;
  let tags = [];
  try {
    tags = JSON.parse(row.tags || '[]');
  } catch (_) {
    tags = [];
  }
  return {
    id: Number(row.id),
    scope: row.scope || 'global',
    title: row.title,
    status: row.status || 'observed',
    tags,
    evidence: row.evidence || '',
    fix: row.fix || '',
    created: row.created || '',
  };
}

let cachedOsUser = null;

function detectOsUsername() {
  if (process.env.CONSTRUCT_USER !== undefined && process.env.CONSTRUCT_USER.trim() !== '') {
    return process.env.CONSTRUCT_USER.trim().toLowerCase();
  }
  if (cachedOsUser) return cachedOsUser;
  try {
    cachedOsUser = os.userInfo().username.trim().toLowerCase();
    return cachedOsUser;
  } catch (_) {
    return (process.env.USER || process.env.USERNAME || 'unknown').trim().toLowerCase();
  }
}

function getCurrentUserInDb(db, explicitId) {
  const all = db.prepare('SELECT * FROM users ORDER BY active DESC, id ASC').all().map(hydrateUser);
  if (explicitId) {
    const key = String(explicitId).trim().toLowerCase();
    return all.find((u) => u.id === key || u.osUsers.map((x) => x.toLowerCase()).includes(key)) || null;
  }

  // If CONSTRUCT_USER is explicitly set, require a match on id or osUsers so we can test/trigger
  // new-user onboarding cleanly when an unrecognized operator connects.
  if (process.env.CONSTRUCT_USER && process.env.CONSTRUCT_USER.trim()) {
    const target = process.env.CONSTRUCT_USER.trim().toLowerCase();
    return all.find((u) => u.id === target || u.osUsers.map((x) => x.toLowerCase()).includes(target)) || null;
  }

  const osUser = detectOsUsername();
  const byOs = all.find((u) => u.id === osUser || u.osUsers.map((x) => x.toLowerCase()).includes(osUser));
  if (byOs) return byOs;

  // If no OS login matches, return null so the construct knows this is an unrecognized operator!
  return null;
}

function listGotchasInDb(db, scope = 'global') {
  if (!scope || scope === 'all') {
    return db.prepare('SELECT * FROM gotchas ORDER BY scope ASC, id ASC').all().map(hydrateGotcha);
  }
  const slashIdx = scope.indexOf('/');
  if (slashIdx !== -1) {
    const parentScope = scope.slice(0, slashIdx);
    return db
      .prepare('SELECT * FROM gotchas WHERE scope = ? OR scope = ? ORDER BY id ASC')
      .all(scope, parentScope)
      .map(hydrateGotcha);
  }
  return db.prepare('SELECT * FROM gotchas WHERE scope = ? ORDER BY id ASC').all(scope).map(hydrateGotcha);
}

function compileOperatorSection(user, detectedLogin) {
  if (!user) {
    return `## Operator Identity: UNREGISTERED (\`${detectedLogin}\`) — First-Boot Crew Selection & Onboarding Required

You do not have a working agreement on file for operator \`${detectedLogin}\`.
**On this very first turn, before diving into work, welcome the operator and run a two-part onboarding:**
1. **Ask which Construct Crew they want to start with** (invoke the \`question\` radio-button selector tool if not already answered) with these six Crew Banks and the personality feel each gives:
   - **\`sprawl\` — The Sprawl Crew (William Gibson's *Neuromancer* / *Count Zero* / *Mona Lisa Overdrive*):** Straylight matrix run with console cowboys, razorgirls, and orbital AIs: Colin, Dixie, Wintermute, Molly, The Finn, Case, Lupus, Angie, Continuity.
   - **\`nightcity\` — The Afterlife Crew (*Cyberpunk 2077 / Phantom Liberty*):** Night City Edgerunners: Judy, Vik, T-Bug, V, Mitch, Songbird, Johnny Silverhand, Evelyn, Rogue.
   - **\`anathem\` — The Concent of Saunt Edhar Crew (Neal Stephenson's *Anathem*):** Monastic mathic, Socratic, and empiricist voices: Fraa Erasmas, Sammann, Fraa Jad, Cord, Fraa Orolo, Fraa Jesry, Fraa Lio, Suur Tulia, Suur Ala.
   - **\`cryptonomicon\` — Detachment 2702 & Epiphyte Corp (Neal Stephenson's *Cryptonomicon*):** 1942 Bletchley cryptanalysis + 1999 Manila Unix/crypto engineering: Lawrence Waterhouse, Goto Dengo, Enoch Root, Randy Waterhouse, Doug Shaftoe, Avi Halaby, John Cantrell, Amy Shaftoe, Golgotha.
   - **\`shadowrun\` — The Seattle 2050s Shadowland Team (*Shadowrun*):** Awakened magic, Rigger drones, and Fairlight Excalibur Matrix decks: Talon, StreetDoc, FastJack, Hatchetman, Rigger, Dodger, Harlequin, Siren, Captain Chaos.
   - **\`generic\` — The Standard Engineering Crew (Zero-Fiction Specialist Pipeline):** Pure professional engineering specialists with zero literary fiction: Guide, Trace, Arch, Strike, Audit, Pulse, RedTeam, UX, and Ledger.
2. **Ask them to introduce themselves** so you can calibrate their personal working agreement:
   - Their engineering/domain experience level and which parts of the stack are new to them.
   - How they want explanations calibrated: code snippets vs. prose, lead with finding/` + '`file:line`' + ` vs. full walkthrough, and whether terse instructions should be executed immediately.
   - Their OS/shell/browser environment, scratch directory path (outside repositories), and whether they keep their git repositories under a common base directory (e.g. \`~/src\`, \`~/code\`, \`D:\\projects\`) or in separate locations.
   - Any standing rules they hate repeating.
3. As soon as they answer, set their chosen Crew Bank with \`tools.construct.rom({ action: "default", target: "<sprawl|nightcity|anathem|cryptonomicon|shadowrun|generic>" })\` and save their agreement with \`tools.construct.user({ action: "set", id: "${detectedLogin}", name: "...", osUsers: "${detectedLogin}", experience: "...", platform: "...", workspaceRoot: "...", calibration: "...", use: true })\`.`;
  }

  const wsLine = user.workspaceRoot ? `\n- **Workspace Root:** \`${user.workspaceRoot}\`` : '';
  return `## Active Operator Agreement: ${user.name} (\`${user.id}\`)

- **Who you are working with:** ${user.experience}
- **Platform & Environment:** ${user.platform}${wsLine}

### Personal Calibration (${user.name})
${user.calibration}`;
}

function compileGotchasSection(gotchas) {
  if (!gotchas || !gotchas.length) {
    return `## Global Machine & Tool Gotchas\n\n*(No global gotchas recorded yet. Add with \`construct gotcha add\`.)*`;
  }
  const lines = gotchas.map((g) => {
    const tagStr = g.tags.length ? ` [${g.tags.join(', ')}]` : '';
    return `### ${g.id}. ${g.title} (**${g.status}**${tagStr}, ${g.created})
- **Evidence:** ${g.evidence}
- **Do instead:** ${g.fix}`;
  });
  return `## Global Machine & Tool Gotchas (Read Before Running Commands)

> A lesson that would save an hour on any project goes in the construct via \`construct gotcha add\` (or \`tools.construct.gotcha\`). Project-specific gotchas go in that project's \`docs/dev/02-gotchas.md\`.

${lines.join('\n\n')}`;
}

module.exports = {
  CORE_PROTOCOL,
  SEED_USERS,
  SEED_GOTCHAS,
  initProtocolSchema,
  hydrateUser,
  hydrateGotcha,
  detectOsUsername,
  getCurrentUserInDb,
  listGotchasInDb,
  compileOperatorSection,
  compileGotchasSection,
};
