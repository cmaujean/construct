// Sequential memory construct backed by Node's built-in SQLite (WAL + FTS5).
//
// Five structures live in one database file:
//   1. `frames`: an append-only, monotonically numbered sequence of engineering
//      events (intent, probe, finding, dead_end, decision, change, commit,
//      release, thread), with causal parent links (`parent_seq`) and open/resolved
//      tracking (`open`, `resolved_by`).
//   2. `heads`: one current-state pointer per project (`state`, `next`, `repo`),
//      so booting a session reads the current head + all unresolved open frames +
//      the last N sequential frames in under 2ms.
//   3. `roms`: swappable and tunable Personality ROMs (`dixie`, `molly`, `razor`,
//      `architect`, or custom constructs).
//   4. `users`: per-operator personal agreements (experience, platform, calibration)
//      with OS-username detection and automatic new-operator onboarding.
//   5. `gotchas`: machine-wide & general tool gotchas with FTS5 search.
//
// `roms` + `users` + Core Engineering Protocol + `gotchas` compile into a single
// auto-loaded cartridge at `~/.config/opencode/active-rom.md`.

'use strict';

const crypto = require('node:crypto');
const { execFileSync, execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const romMod = require('./rom');
const protocol = require('./protocol');
const crdt = require('./crdt');
const relay = require('./relay');
const assimilateMod = require('./assimilate');

const KINDS = Object.freeze([
  'intent',
  'probe',
  'finding',
  'dead_end',
  'decision',
  'change',
  'commit',
  'release',
  'thread',
]);

const DEFAULT_DB = path.join(os.homedir(), '.config', 'opencode', 'construct.db');

function dbPath() {
  return process.env.CONSTRUCT_DB || DEFAULT_DB;
}

function expandHome(p) {
  if (!p || typeof p !== 'string') return '';
  const trimmed = p.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function normalizeFsPath(p) {
  if (!p) return '';
  const abs = path.resolve(expandHome(String(p)));
  const norm = abs.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

function normalizeProject(project, wsRoot = '') {
  if (typeof project !== 'string' || !project.trim()) {
    throw new Error('project key is required (e.g. "acme/alpha_app" or "board")');
  }
  let p = project.trim().replace(/\\/g, '/');
  if (wsRoot) {
    const normWs = expandHome(wsRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    if (p.toLowerCase().startsWith(normWs.toLowerCase() + '/')) {
      p = p.slice(normWs.length + 1);
    }
  }
  const cleaned = p.replace(/^~\/[^/]+\//, (m) => (m.toLowerCase() === '~/src/' ? '' : m)).replace(/^\/+|\/+$/g, '');
  return cleaned;
}

function validateKind(kind) {
  if (!KINDS.includes(kind)) {
    throw new Error(`unknown frame kind "${kind}". Valid kinds: ${KINDS.join(', ')}`);
  }
  return kind;
}

function normalizeRefs(refs) {
  if (!refs) return [];
  if (Array.isArray(refs)) {
    return refs.map((r) => String(r).trim()).filter(Boolean);
  }
  if (typeof refs === 'string') {
    return refs
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  }
  throw new Error('refs must be a comma-separated string or array of strings');
}

const dbCache = new Map();

function openDb(file = dbPath()) {
  if (file !== ':memory:' && dbCache.has(file)) {
    return dbCache.get(file);
  }
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  initSchema(db);
  if (file !== ':memory:') {
    dbCache.set(file, db);
  }
  return db;
}

function withDb(fn, file = dbPath()) {
  const db = openDb(file);
  try {
    return fn(db);
  } finally {
    if (file === ':memory:') {
      db.close();
    }
  }
}

function closeAllDbs() {
  for (const db of dbCache.values()) {
    try {
      db.close();
    } catch (_) {}
  }
  dbCache.clear();
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // ignore rollback error if already rolled back
    }
    throw err;
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS heads (
      project   TEXT PRIMARY KEY,
      repo      TEXT NOT NULL DEFAULT '',
      state     TEXT NOT NULL DEFAULT '',
      next      TEXT NOT NULL DEFAULT '',
      gh_synced TEXT NOT NULL DEFAULT '',
      updated   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS frames (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT NOT NULL,
      project     TEXT NOT NULL,
      kind        TEXT NOT NULL,
      summary     TEXT NOT NULL,
      detail      TEXT NOT NULL DEFAULT '',
      verified    TEXT NOT NULL DEFAULT '',
      parent_seq  INTEGER REFERENCES frames(seq),
      open        INTEGER NOT NULL DEFAULT 0,
      resolved_by INTEGER REFERENCES frames(seq),
      refs        TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_frames_project_seq ON frames(project, seq);
    CREATE INDEX IF NOT EXISTS idx_frames_open        ON frames(project, open, seq);
    CREATE INDEX IF NOT EXISTS idx_frames_parent      ON frames(parent_seq);
    CREATE INDEX IF NOT EXISTS idx_frames_resolved_by ON frames(resolved_by);

    CREATE VIRTUAL TABLE IF NOT EXISTS frames_fts USING fts5(
      project,
      kind,
      summary,
      detail,
      verified,
      refs,
      content='frames',
      content_rowid='seq'
    );

    CREATE TRIGGER IF NOT EXISTS frames_ai AFTER INSERT ON frames BEGIN
      INSERT INTO frames_fts(rowid, project, kind, summary, detail, verified, refs)
      VALUES (new.seq, new.project, new.kind, new.summary, new.detail, new.verified, new.refs);
    END;

    CREATE TRIGGER IF NOT EXISTS frames_ad AFTER DELETE ON frames BEGIN
      INSERT INTO frames_fts(frames_fts, rowid, project, kind, summary, detail, verified, refs)
      VALUES ('delete', old.seq, old.project, old.kind, old.summary, old.detail, old.verified, old.refs);
    END;

    CREATE TRIGGER IF NOT EXISTS frames_au AFTER UPDATE ON frames BEGIN
      INSERT INTO frames_fts(frames_fts, rowid, project, kind, summary, detail, verified, refs)
      VALUES ('delete', old.seq, old.project, old.kind, old.summary, old.detail, old.verified, old.refs);
      INSERT INTO frames_fts(rowid, project, kind, summary, detail, verified, refs)
      VALUES (new.seq, new.project, new.kind, new.summary, new.detail, new.verified, new.refs);
    END;

    CREATE TABLE IF NOT EXISTS assimilated_files (
      project  TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      abs_path TEXT NOT NULL,
      sha256   TEXT NOT NULL,
      updated  TEXT NOT NULL,
      PRIMARY KEY (project, rel_path)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key     TEXT PRIMARY KEY,
      value   TEXT NOT NULL,
      updated TEXT NOT NULL
    );
  `);

  const headCols = db.prepare('PRAGMA table_info(heads)').all().map((c) => c.name);
  if (!headCols.includes('gh_synced')) {
    db.exec("ALTER TABLE heads ADD COLUMN gh_synced TEXT NOT NULL DEFAULT '';");
  }

  romMod.initRomSchema(db);
  protocol.initProtocolSchema(db);
  crdt.initCrdtAndCommsSchema(db);
}

function hydrateFrame(row) {
  if (!row) return null;
  let refs = [];
  try {
    refs = JSON.parse(row.refs || '[]');
  } catch (_) {
    refs = [];
  }
  return {
    seq: Number(row.seq),
    ts: row.ts,
    project: row.project,
    kind: row.kind,
    summary: row.summary,
    detail: row.detail || '',
    verified: row.verified || '',
    parentSeq: row.parent_seq === null || row.parent_seq === undefined ? null : Number(row.parent_seq),
    open: Boolean(row.open),
    resolvedBy: row.resolved_by === null || row.resolved_by === undefined ? null : Number(row.resolved_by),
    refs,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function requireSeq(val, label = 'sequence id') {
  const cleaned = String(val ?? '').replace(/^#/, '').trim();
  if (!/^\d+$/.test(cleaned)) {
    throw new Error(`invalid ${label}: "${val}" (expected a positive integer, e.g. 42)`);
  }
  const n = Number(cleaned);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`invalid ${label}: "${val}"`);
  }
  return n;
}

function getFrameInDb(db, seq) {
  const row = db.prepare('SELECT * FROM frames WHERE seq = ?').get(seq);
  return hydrateFrame(row);
}

function getWorkspaceRootInDb(db) {
  const envRoot = process.env.CONSTRUCT_WORKSPACE_ROOT || process.env.CONSTRUCT_SRC_ROOT || '';
  if (envRoot.trim()) return envRoot.trim();
  const user = protocol.getCurrentUserInDb(db);
  return user?.workspaceRoot || '';
}

function defaultRepoPathInDb(db, project) {
  const existing = db.prepare('SELECT repo FROM heads WHERE project = ?').get(project);
  if (existing && existing.repo) return existing.repo;
  const wsRoot = getWorkspaceRootInDb(db);
  if (wsRoot) {
    return path.join(expandHome(wsRoot), ...project.split('/'));
  }
  return '';
}

function parseRepoSlugFromRemoteUrl(remoteUrl) {
  const u = String(remoteUrl || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!u) return '';
  // Match SSH `git@host:owner/repo` or HTTPS/local `.../owner/repo`
  const sshMatch = u.match(/^[^@]+@[^:]+:([^/]+\/[^/]+)$/);
  if (sshMatch) return sshMatch[1];
  const parts = u.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return parts[0] || '';
}

function resolveProjectFromDirInDb(db, dirInput) {
  if (!dirInput || !String(dirInput).trim()) return null;
  const absDir = path.resolve(expandHome(String(dirInput)));
  const normDir = normalizeFsPath(absDir);
  const wsRoot = getWorkspaceRootInDb(db);
  const normWs = wsRoot ? normalizeFsPath(wsRoot) : '';

  if (normWs && normDir === normWs) return null;

  // 1. Walk up from `absDir` to find nearest `.git` root
  let cur = absDir;
  let gitRoot = null;
  while (cur && cur !== path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, '.git'))) {
      gitRoot = cur;
      break;
    }
    if (normWs && normalizeFsPath(cur) === normWs) break;
    cur = path.dirname(cur);
  }

  const targetDir = gitRoot || absDir;
  const normTarget = normalizeFsPath(targetDir);
  if (normWs && normTarget === normWs) return null;

  // 2. Check if any registered head in `construct.db` already points to `targetDir`
  const allHeads = db.prepare('SELECT project, repo FROM heads').all();
  for (const h of allHeads) {
    if (h.repo && normalizeFsPath(h.repo) === normTarget) {
      return h.project;
    }
  }

  // 3. If operator configured a `workspace_root` and `targetDir` is inside it, derive relative key
  if (normWs && normTarget.startsWith(normWs + '/')) {
    const rawRel = targetDir
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .slice(expandHome(wsRoot).replace(/\\/g, '/').replace(/\/+$/, '').length + 1);
    const rel = rawRel ? normalizeProject(rawRel) : '';
    if (rel) {
      const existing = db.prepare('SELECT project, repo FROM heads WHERE project = ?').get(rel);
      if (existing && (!existing.repo || existing.repo.startsWith('~/'))) {
        db.prepare('UPDATE heads SET repo = ? WHERE project = ?').run(targetDir, rel);
      }
      return rel;
    }
  }

  // 4. Fallback for arbitrary directory layouts: derive from git remote `<owner>/<repo>` or basename
  if (!gitRoot) return null;
  let key = '';
  try {
    const remoteUrl = execFileSync('git', ['-C', gitRoot, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    const slug = parseRepoSlugFromRemoteUrl(remoteUrl);
    if (slug) {
      // If a head already exists for either `slug` or `path.basename(gitRoot)`, prefer the existing key
      const base = path.basename(gitRoot);
      const byBase = db.prepare('SELECT project FROM heads WHERE project = ?').get(base);
      key = byBase ? base : slug;
    }
  } catch (_) {}
  if (!key) key = path.basename(gitRoot);

  // Bind the discovered `gitRoot` path into `heads.repo` so future lookups resolve in <0.1ms
  const existing = db.prepare('SELECT project FROM heads WHERE project = ?').get(key);
  if (existing) {
    db.prepare('UPDATE heads SET repo = ? WHERE project = ?').run(gitRoot, key);
  } else {
    db.prepare('INSERT INTO heads (project, repo, state, next, updated) VALUES (?, ?, ?, ?, ?)').run(
      key,
      gitRoot,
      '',
      '',
      nowIso()
    );
  }
  return key;
}

function resolveProjectFromDir(dirInput, file = dbPath()) {
  return withDb((db) => resolveProjectFromDirInDb(db, dirInput), file);
}

function getDefaultRomNameInDb(db) {
  const user = protocol.getCurrentUserInDb(db);
  if (user) {
    if (user.defaultRom === 'off') return '';
    if (user.defaultRom) return user.defaultRom;
  }
  const offRow = db.prepare('SELECT active FROM roms WHERE active = -1 LIMIT 1').get();
  if (offRow) return '';
  const activeRow = db.prepare('SELECT name FROM roms WHERE active = 1 LIMIT 1').get();
  return activeRow?.name || 'crew';
}

function getActiveRomInDb(db, sessionId, project = '') {
  const sid = sessionId || process.env.CONSTRUCT_SESSION_ID || '';
  let proj = project ? normalizeProject(project) : '';
  if (sid) {
    const sessRow = db.prepare('SELECT rom_name, project FROM session_roms WHERE session_id = ?').get(sid);
    if (sessRow && sessRow.rom_name) {
      return getRomInDb(db, sessRow.rom_name);
    }
    if (!proj && sessRow && sessRow.project) {
      proj = sessRow.project;
    }
  }
  if (proj) {
    const projRow = db.prepare('SELECT rom_name FROM project_roms WHERE project = ?').get(proj);
    if (projRow && projRow.rom_name) {
      return getRomInDb(db, projRow.rom_name);
    }
  }
  const defaultRom = getDefaultRomNameInDb(db);
  if (defaultRom) {
    return getRomInDb(db, defaultRom);
  }
  if (sid) {
    return getRomInDb(db, 'razor');
  }
  const row =
    db.prepare("SELECT * FROM roms WHERE name = 'razor' LIMIT 1").get() ||
    db.prepare('SELECT * FROM roms ORDER BY name ASC LIMIT 1').get();
  return romMod.hydrateRom(row);
}

function isSessionRomSlottedInDb(db, sessionId, project = '') {
  const sid = sessionId || process.env.CONSTRUCT_SESSION_ID || '';
  let proj = project ? normalizeProject(project) : '';
  if (sid) {
    const sessRow = db.prepare('SELECT rom_name, project FROM session_roms WHERE session_id = ?').get(sid);
    if (sessRow && sessRow.rom_name) return true;
    if (!proj && sessRow && sessRow.project) proj = sessRow.project;
  }
  if (proj) {
    const projRow = db.prepare('SELECT rom_name FROM project_roms WHERE project = ?').get(proj);
    if (projRow && projRow.rom_name) return true;
  }
  if (!sid) return true;
  const defaultRom = getDefaultRomNameInDb(db);
  return Boolean(defaultRom);
}

function resolveSingleRomRowInDb(db, name) {
  const key = String(name || '').trim().toLowerCase();
  const aliasMap = {
    architect: 'wintermute',
    raz: 'erasmus',
    waterhouse: 'lawrence',
    shaman: 'talon',
    samurai: 'hatchetman',
    face: 'siren',
    sysop: 'captainchaos',
    toottoot: 'toot',
    archive: 'ivy',
    yonderboy: 'lupus',
    florimel: 'flora',
    ghost: 'ghostwheel',
  };
  const target = aliasMap[key] || key;
  return (
    db.prepare('SELECT * FROM roms WHERE name = ?').get(target) ||
    db.prepare('SELECT * FROM roms WHERE name = ?').get(key) ||
    null
  );
}

function getRomInDb(db, name) {
  if (!name) return getActiveRomInDb(db);
  const rawSpec = String(name).trim().toLowerCase();

  // Check if `rawSpec` is a known pack alias (`crew`, `all`, `sprawl`, `anathem`, `generic`, `standard`, `plain`)
  // or a custom pack name present in `roms.pack`
  const packAliasMap = {
    crew: 'sprawl',
    all: 'sprawl',
    sprawl: 'sprawl',
    anathem: 'anathem',
    nightcity: 'nightcity',
    afterlife: 'nightcity',
    cyberpunk: 'nightcity',
    cryptonomicon: 'cryptonomicon',
    epiphyte: 'cryptonomicon',
    shadowrun: 'shadowrun',
    shadowland: 'shadowrun',
    dresden: 'dresden',
    paranet: 'dresden',
    amber: 'amber',
    kolvir: 'amber',
    pattern: 'amber',
    generic: 'generic',
    standard: 'generic',
    plain: 'generic',
  };
  let packName = packAliasMap[rawSpec] || null;
  if (!packName && !rawSpec.includes(',')) {
    const singleRow = resolveSingleRomRowInDb(db, rawSpec);
    if (!singleRow) {
      const packCheck = db.prepare('SELECT COUNT(*) AS c FROM roms WHERE pack = ?').get(rawSpec);
      if (Number(packCheck?.c || 0) > 0) packName = rawSpec;
    }
  }

  if (packName || rawSpec.includes(',')) {
    let rosterRoms = [];
    let backupRoms = [];
    let packTitle = 'Coordinated 9-Seat Engineering Crew';
    let canonicalName = rawSpec;

    if (packName) {
      canonicalName = rawSpec === 'all' ? 'crew' : rawSpec === 'standard' || rawSpec === 'plain' ? 'generic' : rawSpec;
      const meta = romMod.PACK_METADATA[packName];
      packTitle = meta ? meta.title : `Custom Crew Bank: ${packName}`;

      const packRows = db.prepare('SELECT * FROM roms WHERE pack = ?').all(packName).map(romMod.hydrateRom);
      const seatOrder = romMod.SEAT_ORDER;
      const primaries = packRows
        .filter((r) => r.tier === 'primary')
        .sort((a, b) => seatOrder.indexOf(a.seat) - seatOrder.indexOf(b.seat));
      rosterRoms = primaries.length ? primaries : packRows;
      backupRoms = packRows.filter((r) => r.tier === 'backup');
    } else {
      const memberNames = rawSpec
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!memberNames.length) throw new Error('crew roster cannot be empty');
      rosterRoms = memberNames.map((m) => {
        const row = resolveSingleRomRowInDb(db, m);
        if (!row) throw new Error(`unknown ROM "${m}" in crew roster`);
        return romMod.hydrateRom(row);
      });
      canonicalName = rosterRoms.map((r) => r.name).join(',');
      const dominantPack = rosterRoms[0]?.pack || 'sprawl';
      const activeNames = new Set(rosterRoms.map((r) => r.name));
      backupRoms = db
        .prepare('SELECT * FROM roms WHERE pack = ?')
        .all(dominantPack)
        .map(romMod.hydrateRom)
        .filter((r) => !activeNames.has(r.name));
    }

    return {
      name: canonicalName,
      pack: packName || rosterRoms[0]?.pack || 'custom',
      seat: 'crew',
      tier: 'primary',
      handle:
        packName
          ? `Construct Crew [${packName}] // ${packTitle}`
          : `Construct Crew // Custom Roster (${rosterRoms.map((r) => r.name).join(' -> ')})`,
      tagline: `Coordinated specialist pipeline: ${rosterRoms.map((r) => r.name).join(' -> ')}`,
      voice: romMod.compileCrewPersonaPrompt(rosterRoms, canonicalName, {
        backupRoms,
        packTitle,
        packName: packName || rosterRoms[0]?.pack || 'sprawl',
      }),
      dials: { terse: 0.8, skepticism: 0.95, edge: 0.85, autonomy: 0.9, telemetry: 0.85 },
      directives: [],
      active: true,
      isCrew: true,
      roster: rosterRoms.map((r) => r.name),
      rosterRoms,
      backups: backupRoms.map((b) => b.name),
      updated: nowIso(),
    };
  }

  const row = resolveSingleRomRowInDb(db, rawSpec);
  if (!row) throw new Error(`unknown ROM or crew bank "${name}"`);
  return romMod.hydrateRom(row);
}

function syncActiveRomInDb(db, targetFile = romMod.activeRomPath()) {
  const rom = getActiveRomInDb(db);
  const detectedLogin = protocol.detectOsUsername();
  const user = protocol.getCurrentUserInDb(db);
  const gotchas = protocol.listGotchasInDb(db);
  // Write session-invariant base cartridge (Operator + Protocol + Global Gotchas) to disk
  // so slotting a ROM in one session never mutates other open sessions.
  return romMod.writeActiveRomFile(rom, { user, detectedLogin, gotchas, baseOnly: true }, targetFile);
}

function syncRom(file = dbPath()) {
  return withDb((db) => {
    romMod.reseedBuiltInRoms(db);
    const outPath = syncActiveRomInDb(db);
    return {
      path: outPath,
      rom: getActiveRomInDb(db),
      user: protocol.getCurrentUserInDb(db),
      detectedLogin: protocol.detectOsUsername(),
      gotchaCount: protocol.listGotchasInDb(db).length,
    };
  }, file);
}

function recordFrame(fields, file = dbPath()) {
  const project = normalizeProject(fields.project);
  const kind = validateKind(fields.kind);
  const summary = typeof fields.summary === 'string' ? fields.summary.trim() : '';
  if (!summary) throw new Error('frame summary is required');

  const detail = typeof fields.detail === 'string' ? fields.detail.trim() : '';
  const verified = typeof fields.verified === 'string' ? fields.verified.trim() : '';
  const ts = fields.ts ? String(fields.ts).trim() : nowIso();
  const parentSeq = fields.parentSeq != null ? requireSeq(fields.parentSeq, 'parent seq') : null;
  const open = fields.open !== undefined ? (fields.open ? 1 : 0) : kind === 'thread' ? 1 : 0;
  const refs = normalizeRefs(fields.refs);
  const resolvesList = fields.resolves
    ? (Array.isArray(fields.resolves) ? fields.resolves : String(fields.resolves).split(',').filter(Boolean)).map(
        (s) => requireSeq(s, 'resolves seq')
      )
    : [];

  return withDb(
    (db) =>
      tx(db, () => {
        if (parentSeq !== null) {
          const parent = getFrameInDb(db, parentSeq);
          if (!parent) throw new Error(`parent frame #${parentSeq} does not exist`);
        }
        for (const rSeq of resolvesList) {
          const target = getFrameInDb(db, rSeq);
          if (!target) throw new Error(`cannot resolve non-existent frame #${rSeq}`);
        }

      const identity = crdt.loadOrCreateIdentity();
      const uid = fields.uid || `frame-${project}-${crypto.randomUUID()}`;
      const hlc = crdt.nextHlc(identity.did);

      const info = db
        .prepare(
          `INSERT INTO frames (uid, hlc, ts, project, kind, summary, detail, verified, parent_seq, open, refs)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(uid, hlc, ts, project, kind, summary, detail, verified, parentSeq, open, JSON.stringify(refs));

      const newSeq = Number(info.lastInsertRowid);

      crdt.appendCrdtOpInDb(db, {
        project,
        entity: 'frame',
        recordUid: uid,
        payload: {
          uid,
          hlc,
          ts,
          project,
          kind,
          summary,
          detail,
          verified,
          open: Boolean(open),
          refs,
        },
      });

        if (resolvesList.length > 0) {
          const resolveStmt = db.prepare('UPDATE frames SET open = 0, resolved_by = ? WHERE seq = ?');
          for (const rSeq of resolvesList) {
            resolveStmt.run(newSeq, rSeq);
          }
        }

        const existingHead = db.prepare('SELECT project FROM heads WHERE project = ?').get(project);
        if (!existingHead) {
          db.prepare('INSERT INTO heads (project, repo, state, next, updated) VALUES (?, ?, ?, ?, ?)').run(
            project,
            defaultRepoPathInDb(db, project),
            '',
            '',
            ts
          );
        } else {
          db.prepare('UPDATE heads SET updated = ? WHERE project = ? AND updated < ?').run(ts, project, ts);
        }

        return {
          frame: getFrameInDb(db, newSeq),
          resolved: resolvesList,
        };
      }),
    file
  );
}

function editFrame(seq, changes, file = dbPath()) {
  const targetSeq = requireSeq(seq);
  return withDb(
    (db) =>
      tx(db, () => {
        const existing = getFrameInDb(db, targetSeq);
        if (!existing) throw new Error(`no frame #${targetSeq}`);

        const summary = changes.summary !== undefined ? String(changes.summary).trim() : existing.summary;
        if (!summary) throw new Error('frame summary cannot be empty');
        const kind = changes.kind !== undefined ? validateKind(changes.kind) : existing.kind;
        const detail = changes.detail !== undefined ? String(changes.detail).trim() : existing.detail;
        const verified = changes.verified !== undefined ? String(changes.verified).trim() : existing.verified;
        const refs = changes.refs !== undefined ? normalizeRefs(changes.refs) : existing.refs;
        let parentSeq = existing.parentSeq;
        if (changes.parentSeq !== undefined) {
          parentSeq =
            changes.parentSeq === null || changes.parentSeq === 'off' || changes.parentSeq === ''
              ? null
              : requireSeq(changes.parentSeq, 'parent seq');
          if (parentSeq === targetSeq) throw new Error('a frame cannot be its own parent');
          if (parentSeq !== null && !getFrameInDb(db, parentSeq)) {
            throw new Error(`parent frame #${parentSeq} does not exist`);
          }
        }

        db.prepare(
          `UPDATE frames
         SET kind = ?, summary = ?, detail = ?, verified = ?, parent_seq = ?, refs = ?
         WHERE seq = ?`
        ).run(kind, summary, detail, verified, parentSeq, JSON.stringify(refs), targetSeq);

        return getFrameInDb(db, targetSeq);
      }),
    file
  );
}

function resolveFrames(seqList, options = {}, file = dbPath()) {
  const ids = (Array.isArray(seqList) ? seqList : [seqList]).map((s) => requireSeq(s));
  if (!ids.length) throw new Error('give at least one frame seq to resolve');

  return withDb(
    (db) =>
      tx(db, () => {
        const targets = ids.map((id) => {
          const f = getFrameInDb(db, id);
          if (!f) throw new Error(`no frame #${id}`);
          return f;
        });

        let bySeq = options.by != null ? requireSeq(options.by, 'resolved-by seq') : null;
        let createdFrame = null;

        if (bySeq !== null && !getFrameInDb(db, bySeq)) {
          throw new Error(`resolving frame #${bySeq} does not exist`);
        }

        if (options.reason && bySeq === null) {
          const project = targets[0].project;
          const ts = options.ts ? String(options.ts).trim() : nowIso();
          const kind = options.kind ? validateKind(options.kind) : 'finding';
          const verified = options.verified ? String(options.verified).trim() : '';
          const info = db
            .prepare(
              `INSERT INTO frames (ts, project, kind, summary, detail, verified, parent_seq, open, refs)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
            )
            .run(
              ts,
              project,
              kind,
              String(options.reason).trim(),
              options.detail ? String(options.detail).trim() : '',
              verified,
              targets[0].seq,
              JSON.stringify(targets.flatMap((t) => t.refs))
            );
          bySeq = Number(info.lastInsertRowid);
          createdFrame = getFrameInDb(db, bySeq);
        }

        const stmt = db.prepare('UPDATE frames SET open = 0, resolved_by = COALESCE(?, resolved_by) WHERE seq = ?');
        for (const id of ids) {
          stmt.run(bySeq, id);
        }

        const resolvedFrames = ids.map((id) => getFrameInDb(db, id));
        const closedGhIssues = [];

        if (options.closeGh) {
          for (const rf of resolvedFrames) {
            for (const ref of rf.refs || []) {
              const m = String(ref).match(/^gh:#(\d+)$/i);
              if (!m) continue;
              const issueNum = m[1];
              const hRow = db.prepare('SELECT repo FROM heads WHERE project = ?').get(rf.project);
              const repoDir = options.repoDir || (hRow?.repo ? expandHome(hRow.repo) : defaultRepoPathInDb(db, rf.project));
              if (typeof options.closeIssueFn === 'function') {
                options.closeIssueFn(issueNum, rf.project, repoDir);
                closedGhIssues.push(Number(issueNum));
              } else if (repoDir && fs.existsSync(repoDir)) {
                execFileSync('gh', ['issue', 'close', String(issueNum)], {
                  cwd: repoDir,
                  encoding: 'utf8',
                  stdio: 'pipe',
                  windowsHide: true,
                });
                closedGhIssues.push(Number(issueNum));
              }
            }
          }
        }

        return {
          resolved: resolvedFrames,
          byFrame: createdFrame || (bySeq ? getFrameInDb(db, bySeq) : null),
          closedGhIssues,
        };
      }),
    file
  );
}

function reopenFrame(seq, file = dbPath()) {
  const id = requireSeq(seq);
  return withDb(
    (db) =>
      tx(db, () => {
        const existing = getFrameInDb(db, id);
        if (!existing) throw new Error(`no frame #${id}`);
        db.prepare('UPDATE frames SET open = 1, resolved_by = NULL WHERE seq = ?').run(id);
        return getFrameInDb(db, id);
      }),
    file
  );
}

function setHead(projectInput, fields, file = dbPath()) {
  const project = normalizeProject(projectInput);
  const ts = fields.ts ? String(fields.ts).trim() : nowIso();

  return withDb(
    (db) =>
      tx(db, () => {
        const existing = db.prepare('SELECT * FROM heads WHERE project = ?').get(project);
        const repo =
          fields.repo !== undefined ? String(fields.repo).trim() : existing?.repo || defaultRepoPathInDb(db, project);
        const state = fields.state !== undefined ? String(fields.state).trim() : existing?.state || '';
        const next = fields.next !== undefined ? String(fields.next).trim() : existing?.next || '';

        db.prepare(
          `INSERT INTO heads (project, repo, state, next, updated)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET
           repo = excluded.repo,
           state = excluded.state,
           next = excluded.next,
           updated = excluded.updated`
        ).run(project, repo, state, next, ts);

        return getHeadInDb(db, project);
      }),
    file
  );
}

function getHeadInDb(db, project) {
  const row = db.prepare('SELECT * FROM heads WHERE project = ?').get(project);
  if (!row) return null;
  return {
    project: row.project,
    repo: row.repo,
    state: row.state,
    next: row.next,
    updated: row.updated,
  };
}

function listProjects(file = dbPath()) {
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT
           p.project,
           COALESCE(h.repo, '') AS repo,
           COALESCE(h.state, '') AS state,
           COALESCE(h.next, '') AS next,
           COALESCE(MAX(f.ts), h.updated, '') AS updated,
           COUNT(f.seq) AS frame_count,
           SUM(CASE WHEN f.open = 1 THEN 1 ELSE 0 END) AS open_count,
           MAX(f.seq) AS last_seq
         FROM (
           SELECT project FROM heads
           UNION
           SELECT DISTINCT project FROM frames
         ) p
         LEFT JOIN heads h ON h.project = p.project
         LEFT JOIN frames f ON f.project = p.project
         GROUP BY p.project
         ORDER BY updated DESC, p.project ASC`
      )
      .all();

    return rows.map((r) => ({
      project: r.project,
      repo: r.repo,
      state: r.state,
      next: r.next,
      updated: r.updated,
      frameCount: Number(r.frame_count || 0),
      openCount: Number(r.open_count || 0),
      lastSeq: r.last_seq === null ? null : Number(r.last_seq),
    }));
  }, file);
}

function getTape(options = {}, file = dbPath()) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 30;
  const clauses = [];
  const params = [];

  if (options.project) {
    clauses.push('project = ?');
    params.push(normalizeProject(options.project));
  }
  if (options.kind) {
    clauses.push('kind = ?');
    params.push(validateKind(options.kind));
  }
  if (options.openOnly) {
    clauses.push('open = 1');
  }
  if (options.fromSeq != null) {
    clauses.push('seq >= ?');
    params.push(requireSeq(options.fromSeq, 'from seq'));
  }
  if (options.toSeq != null) {
    clauses.push('seq <= ?');
    params.push(requireSeq(options.toSeq, 'to seq'));
  }
  if (options.since) {
    clauses.push('ts >= ?');
    params.push(String(options.since).trim());
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM frames
           ${whereSql}
           ORDER BY seq DESC
           LIMIT ?
         ) ORDER BY seq ASC`
      )
      .all(...params, limit);

    return rows.map(hydrateFrame);
  }, file);
}

function bootProject(projectInput, options = {}, file = dbPath()) {
  const project = normalizeProject(projectInput);
  const tapeLimit = Number.isInteger(options.tapeLimit) && options.tapeLimit > 0 ? options.tapeLimit : 25;
  const sessionId = options.sessionId || process.env.CONSTRUCT_SESSION_ID || '';

  return withDb((db) => {
    const rom = getActiveRomInDb(db, sessionId, project);
    const romSlotted = isSessionRomSlottedInDb(db, sessionId, project);
    const allRoms = db.prepare('SELECT * FROM roms ORDER BY name ASC').all().map(romMod.hydrateRom);
    const detectedLogin = protocol.detectOsUsername();
    const user = protocol.getCurrentUserInDb(db);
    const head = getHeadInDb(db, project) || {
      project,
      repo: defaultRepoPathInDb(db, project),
      state: '',
      next: '',
      updated: '',
    };

    // Record tab -> project/directory binding on `session_roms` (preserving any explicitly slotted `rom_name`)
    if (sessionId && !sessionId.startsWith('pending_subagent:') && !sessionId.includes(':')) {
      const now = nowIso();
      const repoDir = options.dir || head.repo || '';
      db.prepare(
        `INSERT INTO session_roms (session_id, rom_name, project, directory, updated)
         VALUES (?, '', ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           project = CASE WHEN excluded.project != '' THEN excluded.project ELSE session_roms.project END,
           directory = CASE WHEN excluded.directory != '' THEN excluded.directory ELSE session_roms.directory END,
           updated = excluded.updated`
      ).run(sessionId, project, repoDir, now);
    }

    const openFrames = db
      .prepare('SELECT * FROM frames WHERE project = ? AND open = 1 ORDER BY seq ASC')
      .all(project)
      .map(hydrateFrame);

    const recentTape = db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM frames
           WHERE project = ?
           ORDER BY seq DESC
           LIMIT ?
         ) ORDER BY seq ASC`
      )
      .all(project, tapeLimit)
      .map(hydrateFrame);

    const statsRow = db
      .prepare('SELECT COUNT(*) AS total, MIN(seq) AS first_seq, MAX(seq) AS last_seq FROM frames WHERE project = ?')
      .get(project);

    const projectGotchas = protocol.listGotchasInDb(db, project);

    const activeUserId = user?.id || detectedLogin;
    const localIdentity = crdt.loadOrCreateIdentity();
    const recipientAliases = new Set(
      [activeUserId, user?.id, user?.name, detectedLogin, ...(user?.osUsers || []), 'all', 'team']
        .filter(Boolean)
        .map((s) => String(s).trim().toLowerCase())
    );
    const allPendingRows = db
      .prepare("SELECT * FROM messages WHERE status = 'pending' ORDER BY hlc ASC")
      .all();
    const inboxPending = allPendingRows
      .filter((row) => {
        const toLower = String(row.to_user || '').trim().toLowerCase();
        if (recipientAliases.has(toLower)) return true;
        // If sent by a remote MLS peer (different cryptographic DID), treat it as addressed to the local operator
        if (row.from_did && localIdentity?.did && row.from_did !== localIdentity.did) return true;
        return false;
      })
      .map((row) => {
        const m = crdt.hydrateMessage(row);
        m.courier = buildCourierProfileInDb(db, m.fromRom, m.fromUser, 'COURIER');
        return m;
      });

    const inboxReplies = db
      .prepare("SELECT * FROM messages WHERE status = 'replied' ORDER BY reply_hlc ASC")
      .all()
      .filter((row) => {
        const fromLower = String(row.from_user || '').trim().toLowerCase();
        if (recipientAliases.has(fromLower)) return true;
        if (row.from_did && localIdentity?.did && row.from_did === localIdentity.did) return true;
        return false;
      })
      .map((row) => {
        const m = crdt.hydrateMessage(row);
        m.courier = buildCourierProfileInDb(db, m.replyRom || m.fromRom, m.toUser, 'RETURN COURIER');
        return m;
      });

    const sessionRomPrompt = romSlotted
      ? rom.isCrew
        ? rom.voice
        : romMod.compileRomPersonaOnly(rom)
      : romMod.compileUnassignedBootloaderPrompt(rom, allRoms);

    // Check assimilated instruction files on disk for this project:
    // - Unchanged files are shadowed (stripped from `event.system` so they cost 0 tokens and don't conflict)
    // - Modified files (edited by a non-Construct teammate in git) are flagged as `driftedFiles`
    const assimilatedRows = db.prepare('SELECT * FROM assimilated_files WHERE project = ? ORDER BY rel_path ASC').all(project);
    const shadowedFiles = [];
    const driftedFiles = [];
    for (const r of assimilatedRows) {
      if (!r.abs_path || !fs.existsSync(r.abs_path)) continue;
      try {
        const currentHash = crypto.createHash('sha256').update(fs.readFileSync(r.abs_path, 'utf8'), 'utf8').digest('hex');
        if (currentHash === r.sha256) {
          shadowedFiles.push(r.abs_path);
        } else {
          driftedFiles.push({ relPath: r.rel_path, absPath: r.abs_path });
        }
      } catch (_) {}
    }

    // Check whether this project (or any other joined MLS group in construct.db) is due for a throttled (60s),
    // non-blocking detached background `construct sync` so teammates' frames, gotchas, and Couriers
    // arrive automatically regardless of which repository tab the operator currently has open.
    let autoSyncTriggered = false;
    const mlsRow = db.prepare('SELECT * FROM mls_groups WHERE project = ?').get(project);
    const allMlsRows = db.prepare('SELECT project, updated FROM mls_groups').all();
    const allowAutoSync =
      options.autoSync === true || (options.autoSync !== false && process.env.CONSTRUCT_NO_AUTOSYNC !== '1');
    if (allMlsRows.length && allowAutoSync) {
      const throttleMs = Number(options.autoSyncThrottleMs ?? 60000);
      const now = nowIso();
      for (const grp of allMlsRows) {
        const lastTs = Date.parse(grp.updated || '') || 0;
        if (Date.now() - lastTs >= throttleMs) {
          db.prepare('UPDATE mls_groups SET updated = ? WHERE project = ?').run(now, grp.project);
          if (grp.project === project) autoSyncTriggered = true;
          if (!options.dryRunAutoSync) {
            try {
              const binScript = path.resolve(__dirname, '..', 'bin', 'construct.js');
              const child = spawn(process.execPath, [binScript, 'sync', grp.project], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                env: { ...process.env, CONSTRUCT_DB: file },
              });
              child.unref();
            } catch (_) {}
          }
        }
      }
    }

    // Throttled (60s) non-blocking background GitHub Issues sync when a local git repo is present
    let ghIssuesSyncTriggered = false;
    const headSyncRow = db.prepare('SELECT repo, gh_synced FROM heads WHERE project = ?').get(project);
    const candidateRepo = headSyncRow?.repo ? expandHome(headSyncRow.repo) : head.repo ? expandHome(head.repo) : '';
    if (
      candidateRepo &&
      fs.existsSync(path.join(candidateRepo, '.git')) &&
      allowAutoSync
    ) {
      const lastGhTs = Date.parse(headSyncRow?.gh_synced || '') || 0;
      const throttleMs = Number(options.autoSyncThrottleMs ?? 60000);
      if (Date.now() - lastGhTs >= throttleMs) {
        const now = nowIso();
        db.prepare(
          `INSERT INTO heads (project, repo, state, next, gh_synced, updated)
           VALUES (?, ?, '', '', ?, ?)
           ON CONFLICT(project) DO UPDATE SET gh_synced = excluded.gh_synced`
        ).run(project, candidateRepo, now, now);
        ghIssuesSyncTriggered = true;
        if (!options.dryRunAutoSync) {
          try {
            const binScript = path.resolve(__dirname, '..', 'bin', 'construct.js');
            const child = spawn(process.execPath, [binScript, 'issues', 'sync', project], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
              env: { ...process.env, CONSTRUCT_DB: file },
            });
            child.unref();
          } catch (_) {}
        }
      }
    }

    // Throttled (15-minute) non-blocking background Construct upstream update check
    const upstreamUpdate = getCachedConstructUpstreamInDb(db);
    let upstreamCheckTriggered = false;
    if (allowAutoSync) {
      const lastUpTs = Date.parse(upstreamUpdate?.checkedAt || '') || 0;
      const upThrottleMs = Number(options.upstreamCheckThrottleMs ?? 15 * 60 * 1000);
      if (Date.now() - lastUpTs >= upThrottleMs) {
        const now = nowIso();
        setCachedConstructUpstreamInDb(db, {
          ...(upstreamUpdate || { behindCount: 0, localSha: '', remoteSha: '', commits: [] }),
          checkedAt: now,
        });
        upstreamCheckTriggered = true;
        if (!options.dryRunAutoSync) {
          try {
            const binScript = path.resolve(__dirname, '..', 'bin', 'construct.js');
            const child = spawn(process.execPath, [binScript, 'upgrade', '--check'], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
              env: { ...process.env, CONSTRUCT_DB: file },
            });
            child.unref();
          } catch (_) {}
        }
      }
    }

    return {
      rom,
      romSlotted,
      sessionId: sessionId || null,
      sessionRomPrompt,
      allRoms,
      user,
      detectedLogin,
      head,
      autoSyncTriggered,
      ghIssuesSyncTriggered,
      upstreamCheckTriggered,
      upstreamUpdate,
      hasMlsGroup: Boolean(mlsRow),
      stats: {
        totalFrames: Number(statsRow?.total || 0),
        openCount: openFrames.length,
        gotchaCount: projectGotchas.length,
        firstSeq: statsRow?.first_seq == null ? null : Number(statsRow.first_seq),
        lastSeq: statsRow?.last_seq == null ? null : Number(statsRow.last_seq),
      },
      shadowedFiles,
      driftedFiles,
      inboxPending,
      inboxReplies,
      projectGotchas,
      openFrames,
      recentTape,
    };
  }, file);
}

function zoomFrame(seqInput, options = {}, file = dbPath()) {
  const seq = requireSeq(seqInput);
  const windowSize = Number.isInteger(options.window) && options.window >= 0 ? options.window : 3;

  return withDb((db) => {
    const target = getFrameInDb(db, seq);
    if (!target) throw new Error(`no frame #${seq}`);

    const ancestors = [];
    const seen = new Set([target.seq]);
    let curParent = target.parentSeq;
    while (curParent !== null && !seen.has(curParent)) {
      seen.add(curParent);
      const p = getFrameInDb(db, curParent);
      if (!p) break;
      ancestors.unshift(p);
      curParent = p.parentSeq;
    }

    const children = db
      .prepare('SELECT * FROM frames WHERE parent_seq = ? OR resolved_by = ? ORDER BY seq ASC')
      .all(target.seq, target.seq)
      .map(hydrateFrame);

    const before =
      windowSize > 0
        ? db
            .prepare(
              `SELECT * FROM (
                 SELECT * FROM frames
                 WHERE project = ? AND seq < ?
                 ORDER BY seq DESC
                 LIMIT ?
               ) ORDER BY seq ASC`
            )
            .all(target.project, target.seq, windowSize)
            .map(hydrateFrame)
        : [];

    const after =
      windowSize > 0
        ? db
            .prepare(
              `SELECT * FROM frames
               WHERE project = ? AND seq > ?
               ORDER BY seq ASC
               LIMIT ?`
            )
            .all(target.project, target.seq, windowSize)
            .map(hydrateFrame)
        : [];

    return {
      frame: target,
      ancestors,
      children,
      neighbors: [...before, target, ...after],
    };
  }, file);
}

function toFtsQuery(rawQuery) {
  const q = String(rawQuery || '').trim();
  if (!q) throw new Error('search query cannot be empty');
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""'))
    .filter(Boolean);
  const safeQuery = tokens.map((t) => `"${t}"`).join(' ');
  return { raw: q, safe: safeQuery };
}

function searchFrames(queryInput, options = {}, file = dbPath()) {
  const { raw, safe } = toFtsQuery(queryInput);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
  const clauses = ['frames_fts MATCH ?'];
  const params = [];

  if (options.project) {
    clauses.push('f.project = ?');
    params.push(normalizeProject(options.project));
  }
  if (options.kind) {
    clauses.push('f.kind = ?');
    params.push(validateKind(options.kind));
  }
  if (options.openOnly) {
    clauses.push('f.open = 1');
  }

  const sql = `
    SELECT f.*, bm25(frames_fts, 1.0, 1.0, 5.0, 3.0, 2.0, 4.0) AS rank
    FROM frames_fts
    JOIN frames f ON f.seq = frames_fts.rowid
    WHERE ${clauses.join(' AND ')}
    ORDER BY rank ASC, f.seq DESC
    LIMIT ?
  `;

  return withDb((db) => {
    let rows;
    try {
      rows = db.prepare(sql).all(raw, ...params, limit);
    } catch (_) {
      rows = db.prepare(sql).all(safe, ...params, limit);
    }
    return rows.map(hydrateFrame);
  }, file);
}

// --- Personality ROM operations ---

function listRoms(options = {}, file = dbPath()) {
  const sid = (typeof options === 'string' ? '' : options?.sessionId) || process.env.CONSTRUCT_SESSION_ID || '';
  const actualFile = typeof options === 'string' ? options : file;
  return withDb((db) => {
    const sessRow = sid ? db.prepare('SELECT rom_name FROM session_roms WHERE session_id = ?').get(sid) : null;
    const rows = db.prepare('SELECT * FROM roms ORDER BY name ASC').all();
    return rows.map((r) => {
      const hydrated = romMod.hydrateRom(r);
      if (sid) {
        hydrated.active = sessRow ? hydrated.name === sessRow.rom_name : hydrated.name === 'razor';
        hydrated.slotted = Boolean(sessRow && hydrated.name === sessRow.rom_name);
      }
      return hydrated;
    });
  }, actualFile);
}

function setDefaultRom(nameOrOff, options = {}, file = dbPath()) {
  const raw = String(nameOrOff ?? '').trim().toLowerCase();
  const isClear = !raw || raw === 'off' || raw === 'none' || raw === 'clear';
  const sid = options?.sessionId || process.env.CONSTRUCT_SESSION_ID || '';

  return withDb(
    (db) =>
      tx(db, () => {
        const now = nowIso();
        const user = protocol.getCurrentUserInDb(db, options.user);
        if (isClear) {
          db.prepare('UPDATE roms SET active = 0').run();
          db.prepare("UPDATE roms SET active = -1 WHERE name = 'razor'").run();
          if (user) {
            db.prepare("UPDATE users SET default_rom = 'off', updated = ? WHERE id = ?").run(now, user.id);
          }
          return { cleared: true, defaultRom: null, user: user ? user.id : null };
        }

        const target = getRomInDb(db, raw);
        db.prepare('UPDATE roms SET active = 0').run();
        if (!target.isCrew) {
          db.prepare('UPDATE roms SET active = 1, updated = ? WHERE name = ?').run(now, target.name);
        }
        if (user) {
          db.prepare('UPDATE users SET default_rom = ?, updated = ? WHERE id = ?').run(target.name, now, user.id);
        }
        if (sid) {
          db.prepare(
            `INSERT INTO session_roms (session_id, rom_name, updated)
             VALUES (?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               rom_name = excluded.rom_name,
               updated = excluded.updated`
          ).run(sid, target.name, now);
        }
        return { cleared: false, defaultRom: target, user: user ? user.id : null };
      }),
    file
  );
}

function getRom(name, options = {}, file = dbPath()) {
  const sid = (typeof options === 'string' ? '' : options?.sessionId) || process.env.CONSTRUCT_SESSION_ID || '';
  const proj = typeof options === 'string' ? '' : options?.project || '';
  const actualFile = typeof options === 'string' ? options : file;
  return withDb((db) => {
    const resolvedProj = proj || (options?.dir ? resolveProjectFromDirInDb(db, options.dir) : '');
    return name ? getRomInDb(db, name) : getActiveRomInDb(db, sid, resolvedProj);
  }, actualFile);
}

function subRom(backupName, options = {}, file = dbPath()) {
  if (!backupName || !String(backupName).trim()) {
    throw new Error('give a backup ROM name to substitute into its seat, e.g. construct rom sub marly');
  }
  const sid = (typeof options === 'string' ? '' : options?.sessionId) || process.env.CONSTRUCT_SESSION_ID || '';
  const proj = typeof options === 'string' ? '' : options?.project || '';
  const dir = typeof options === 'string' ? '' : options?.dir || '';
  const actualFile = typeof options === 'string' ? options : file;

  const newSpec = withDb((db) => {
    const subRow = resolveSingleRomRowInDb(db, backupName);
    if (!subRow) throw new Error(`unknown ROM "${backupName}"`);
    const subHydrated = romMod.hydrateRom(subRow);

    const resolvedProj = proj || (dir ? resolveProjectFromDirInDb(db, dir) : '');
    const current = getActiveRomInDb(db, sid, resolvedProj);
    let rosterNames;
    if (current.isCrew && Array.isArray(current.roster)) {
      let replaced = false;
      rosterNames = current.rosterRoms.map((r) => {
        if (r.seat === subHydrated.seat) {
          replaced = true;
          return subHydrated.name;
        }
        return r.name;
      });
      if (!replaced) rosterNames.push(subHydrated.name);
    } else {
      const baseCrew = getRomInDb(db, subHydrated.pack || 'sprawl');
      rosterNames = baseCrew.rosterRoms.map((r) => (r.seat === subHydrated.seat ? subHydrated.name : r.name));
    }
    return rosterNames.join(',');
  }, actualFile);

  return useRom(newSpec, { sessionId: sid, project: proj, dir }, actualFile);
}

function listPacks(file = dbPath()) {
  return withDb((db) => {
    const allRoms = db.prepare('SELECT * FROM roms ORDER BY pack ASC, name ASC').all().map(romMod.hydrateRom);
    const byPack = new Map();
    for (const r of allRoms) {
      if (r.pack === 'core') continue;
      if (!byPack.has(r.pack)) {
        const meta = romMod.PACK_METADATA[r.pack];
        byPack.set(r.pack, {
          pack: r.pack,
          title: meta ? meta.title : `Custom Crew Bank (${r.pack})`,
          starters: [],
          backups: [],
        });
      }
      const entry = byPack.get(r.pack);
      if (r.tier === 'backup') entry.backups.push(r);
      else entry.starters.push(r);
    }
    const seatOrder = romMod.SEAT_ORDER;
    for (const entry of byPack.values()) {
      entry.starters.sort((a, b) => seatOrder.indexOf(a.seat) - seatOrder.indexOf(b.seat));
    }
    return [...byPack.values()];
  }, file);
}

function useRom(name, options = {}, file = dbPath()) {
  if (!name || !String(name).trim()) throw new Error('give a ROM name or crew roster to activate, e.g. construct rom use crew');
  const key = String(name).trim().toLowerCase();
  const sid = (typeof options === 'string' ? '' : options?.sessionId) || process.env.CONSTRUCT_SESSION_ID || '';
  const rawProject = typeof options === 'string' ? '' : options?.project || '';
  const rawDir = typeof options === 'string' ? '' : options?.dir || '';
  const actualFile = typeof options === 'string' ? options : file;

  return withDb(
    (db) =>
      tx(db, () => {
        const target = getRomInDb(db, key);
        const now = nowIso();
        let proj = rawProject ? normalizeProject(rawProject) : '';
        let dir = rawDir ? path.resolve(expandHome(rawDir)) : '';

        if (!proj && dir) {
          proj = resolveProjectFromDirInDb(db, dir) || '';
        }
        if (sid && (!proj || !dir)) {
          const existingSess = db.prepare('SELECT project, directory FROM session_roms WHERE session_id = ?').get(sid);
          if (!proj && existingSess?.project) proj = existingSess.project;
          if (!dir && existingSess?.directory) dir = existingSess.directory;
          if (!proj && dir) proj = resolveProjectFromDirInDb(db, dir) || '';
        }

        if (proj) {
          db.prepare(
            `INSERT INTO project_roms (project, rom_name, updated)
             VALUES (?, ?, ?)
             ON CONFLICT(project) DO UPDATE SET
               rom_name = excluded.rom_name,
               updated = excluded.updated`
          ).run(proj, target.name, now);
        }

        if (sid) {
          db.prepare(
            `INSERT INTO session_roms (session_id, rom_name, project, directory, updated)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               rom_name = excluded.rom_name,
               project = CASE WHEN excluded.project != '' THEN excluded.project ELSE session_roms.project END,
               directory = CASE WHEN excluded.directory != '' THEN excluded.directory ELSE session_roms.directory END,
               updated = excluded.updated`
          ).run(sid, target.name, proj, dir, now);
          return { ...target, active: true, sessionId: sid, project: proj || null };
        }

        if (proj) {
          // When switching a project's ROM without a specific session ID, also update any open tabs bound to that project
          db.prepare('UPDATE session_roms SET rom_name = ?, updated = ? WHERE project = ?').run(target.name, now, proj);
          return { ...target, active: true, sessionId: null, project: proj };
        }

        db.prepare('UPDATE roms SET active = 0').run();
        if (!target.isCrew) {
          db.prepare('UPDATE roms SET active = 1, updated = ? WHERE name = ?').run(now, target.name);
        }
        return target;
      }),
    actualFile
  );
}

function enqueuePendingSubagentRom(sessionId, romName, file = dbPath()) {
  const sid = String(sessionId || 'claude').trim();
  const target = String(romName || '').trim().toLowerCase();
  if (!sid || !target) return null;
  const key = `pending_subagent:${sid}`;
  return withDb(
    (db) =>
      tx(db, () => {
        const row = db.prepare('SELECT rom_name FROM session_roms WHERE session_id = ?').get(key);
        let queue = [];
        if (row && row.rom_name) {
          try {
            const parsed = JSON.parse(row.rom_name);
            if (Array.isArray(parsed)) queue = parsed;
          } catch (_) {
            queue = [row.rom_name];
          }
        }
        queue.push(target);
        db.prepare(
          `INSERT INTO session_roms (session_id, rom_name, updated)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             rom_name = excluded.rom_name,
             updated = excluded.updated`
        ).run(key, JSON.stringify(queue), nowIso());
        return queue;
      }),
    file
  );
}

function consumePendingSubagentRom(sessionId, preferredAgentType = '', file = dbPath()) {
  const sid = String(sessionId || 'claude').trim();
  const pref = String(preferredAgentType || '').trim().toLowerCase();
  const key = `pending_subagent:${sid}`;
  return withDb(
    (db) =>
      tx(db, () => {
        const row = db.prepare('SELECT rom_name FROM session_roms WHERE session_id = ?').get(key);
        let queue = [];
        if (row && row.rom_name) {
          try {
            const parsed = JSON.parse(row.rom_name);
            if (Array.isArray(parsed)) queue = parsed;
          } catch (_) {
            queue = [row.rom_name];
          }
        }
        if (!queue.length) return null;

        // If `preferredAgentType` matches an item in the queue, remove that specific item; otherwise FIFO shift
        let chosen = null;
        if (pref && queue.includes(pref)) {
          const idx = queue.indexOf(pref);
          chosen = queue.splice(idx, 1)[0];
        } else {
          chosen = queue.shift();
        }

        if (queue.length) {
          db.prepare('UPDATE session_roms SET rom_name = ?, updated = ? WHERE session_id = ?').run(
            JSON.stringify(queue),
            nowIso(),
            key
          );
        } else {
          db.prepare('DELETE FROM session_roms WHERE session_id = ?').run(key);
        }
        return chosen;
      }),
    file
  );
}

function writeClaudeSubagentsInDb(db, claudeDir) {
  const agentsDir = path.join(claudeDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const allRoms = db.prepare('SELECT * FROM roms ORDER BY name ASC').all().map(romMod.hydrateRom);
  const written = [];
  for (const r of allRoms) {
    if (r.name === 'razor') continue;
    const seatMeta = romMod.SEAT_MAP[r.seat] || { code: '?', claudeColor: 'blue', label: r.seat.toUpperCase(), desc: r.handle };
    const safeDesc = `${r.handle} (${r.pack} Seat ${seatMeta.code} - ${seatMeta.desc}): ${r.tagline}`.replace(
      /[\r\n"]+/g,
      ' '
    );
    const body = romMod.compileRomPersonaOnly(r);
    const md = [
      '---',
      `name: ${r.name}`,
      `description: "${safeDesc}"`,
      'model: inherit',
      `color: ${seatMeta.claudeColor || 'blue'}`,
      '---',
      '',
      body,
      '',
    ].join('\n');
    const agentFile = path.join(agentsDir, `${r.name}.md`);
    fs.writeFileSync(agentFile, md, 'utf8');
    written.push(agentFile);
  }
  return { agentsDir, count: written.length };
}

function tuneRom(dialUpdates, options = {}, file = dbPath()) {
  if (!dialUpdates || typeof dialUpdates !== 'object' || !Object.keys(dialUpdates).length) {
    throw new Error(`give at least one dial=0..1 to tune (${romMod.DIAL_KEYS.join(', ')})`);
  }
  return withDb(
    (db) =>
      tx(db, () => {
        const target = getRomInDb(db, options.rom);
        const mergedDials = romMod.normalizeDials(dialUpdates, target.dials);
        const now = nowIso();
        db.prepare('UPDATE roms SET dials = ?, updated = ? WHERE name = ?').run(
          JSON.stringify(mergedDials),
          now,
          target.name
        );
        const updated = getRomInDb(db, target.name);
        if (updated.active) {
          syncActiveRomInDb(db);
        }
        return updated;
      }),
    file
  );
}

function setRom(nameInput, fields = {}, file = dbPath()) {
  const name = String(nameInput || '').trim().toLowerCase();
  if (!name || !/^[a-z0-9_-]+$/.test(name)) {
    throw new Error('ROM name must be alphanumeric/hyphen/underscore, e.g. "dixie" or "case-v2"');
  }
  return withDb(
    (db) =>
      tx(db, () => {
        const existingRow = db.prepare('SELECT * FROM roms WHERE name = ?').get(name);
        const existing = existingRow ? romMod.hydrateRom(existingRow) : null;
        const pack = fields.pack !== undefined ? String(fields.pack).trim().toLowerCase() : existing?.pack || 'sprawl';
        const seat = fields.seat !== undefined ? String(fields.seat).trim().toLowerCase() : existing?.seat || 'recon';
        const tier = fields.tier !== undefined ? String(fields.tier).trim().toLowerCase() : existing?.tier || 'primary';
        const handle = fields.handle !== undefined ? String(fields.handle).trim() : existing?.handle || name;
        const tagline = fields.tagline !== undefined ? String(fields.tagline).trim() : existing?.tagline || '';
        const voice = fields.voice !== undefined ? String(fields.voice).trim() : existing?.voice || '';
        const dials = romMod.normalizeDials(fields.dials || {}, existing?.dials || {});
        const directives =
          fields.directives !== undefined
            ? Array.isArray(fields.directives)
              ? fields.directives.map((d) => String(d).trim()).filter(Boolean)
              : [String(fields.directives).trim()].filter(Boolean)
            : existing?.directives || [];
        const active = fields.active !== undefined ? (fields.active ? 1 : 0) : existing ? (existing.active ? 1 : 0) : 0;
        const now = nowIso();

        if (active) {
          db.prepare('UPDATE roms SET active = 0').run();
        }

        db.prepare(
          `INSERT INTO roms (name, pack, seat, tier, handle, tagline, voice, dials, directives, active, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           pack = excluded.pack,
           seat = excluded.seat,
           tier = excluded.tier,
           handle = excluded.handle,
           tagline = excluded.tagline,
           voice = excluded.voice,
           dials = excluded.dials,
           directives = excluded.directives,
           active = excluded.active,
           updated = excluded.updated`
        ).run(name, pack, seat, tier, handle, tagline, voice, JSON.stringify(dials), JSON.stringify(directives), active, now);

        const updated = getRomInDb(db, name);
        if (updated.active) {
          syncActiveRomInDb(db);
        }
        return updated;
      }),
    file
  );
}

function cloneRom(srcName, destName, overrides = {}, file = dbPath()) {
  const src = getRom(srcName, file);
  return setRom(
    destName,
    {
      handle: overrides.handle ?? `${src.handle} (${destName})`,
      tagline: overrides.tagline ?? src.tagline,
      voice: overrides.voice ?? src.voice,
      dials: { ...src.dials, ...(overrides.dials || {}) },
      directives: overrides.directives ?? [...src.directives],
      active: overrides.active ?? false,
    },
    file
  );
}

function burnDirective(text, options = {}, file = dbPath()) {
  const directive = String(text || '').trim();
  if (!directive) throw new Error('directive text cannot be empty');

  return withDb(
    (db) =>
      tx(db, () => {
        const target = getRomInDb(db, options.rom);
        const nextDirectives = [...target.directives];
        if (!nextDirectives.includes(directive)) {
          nextDirectives.push(directive);
        }
        const now = nowIso();
        db.prepare('UPDATE roms SET directives = ?, updated = ? WHERE name = ?').run(
          JSON.stringify(nextDirectives),
          now,
          target.name
        );
        const updated = getRomInDb(db, target.name);
        if (updated.active) {
          syncActiveRomInDb(db);
        }
        return updated;
      }),
    file
  );
}

function unburnDirective(indexOneBased, options = {}, file = dbPath()) {
  const idx = Number(indexOneBased) - 1;
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error('give a 1-based directive number to remove, e.g. construct rom unburn 2');
  }
  return withDb(
    (db) =>
      tx(db, () => {
        const target = getRomInDb(db, options.rom);
        if (idx >= target.directives.length) {
          throw new Error(`ROM "${target.name}" only has ${target.directives.length} directive(s)`);
        }
        const nextDirectives = target.directives.filter((_, i) => i !== idx);
        const now = nowIso();
        db.prepare('UPDATE roms SET directives = ?, updated = ? WHERE name = ?').run(
          JSON.stringify(nextDirectives),
          now,
          target.name
        );
        const updated = getRomInDb(db, target.name);
        if (updated.active) {
          syncActiveRomInDb(db);
        }
        return updated;
      }),
    file
  );
}

// --- Operator (User Agreement) operations ---

function listUsers(file = dbPath()) {
  return withDb((db) => {
    return db.prepare('SELECT * FROM users ORDER BY active DESC, id ASC').all().map(protocol.hydrateUser);
  }, file);
}

function getUser(id, file = dbPath()) {
  return withDb((db) => {
    const user = protocol.getCurrentUserInDb(db, id);
    return {
      user,
      detectedLogin: protocol.detectOsUsername(),
    };
  }, file);
}

function setUser(idInput, fields = {}, file = dbPath()) {
  const id = String(idInput || '').trim().toLowerCase();
  if (!id || !/^[a-z0-9_-]+$/.test(id)) {
    throw new Error('user id must be alphanumeric/hyphen/underscore, e.g. "alice" or "bob"');
  }

  return withDb(
    (db) =>
      tx(db, () => {
        const existingRow = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        const existing = existingRow ? protocol.hydrateUser(existingRow) : null;
        const name = fields.name !== undefined ? String(fields.name).trim() : existing?.name || id;
        const osUsers =
          fields.osUsers !== undefined
            ? normalizeRefs(fields.osUsers).map((x) => x.toLowerCase())
            : existing?.osUsers || [id];
        const experience = fields.experience !== undefined ? String(fields.experience).trim() : existing?.experience || '';
        const platform = fields.platform !== undefined ? String(fields.platform).trim() : existing?.platform || '';
        const workspaceRoot =
          fields.workspaceRoot !== undefined ? String(fields.workspaceRoot).trim() : existing?.workspaceRoot || '';
        const calibration =
          fields.calibration !== undefined ? String(fields.calibration).trim() : existing?.calibration || '';
        const defaultRom =
          fields.defaultRom !== undefined ? String(fields.defaultRom).trim().toLowerCase() : existing?.defaultRom || '';
        const hasAnyActive = Boolean(db.prepare('SELECT id FROM users WHERE active = 1 LIMIT 1').get());
        const active =
          fields.active !== undefined
            ? fields.active
              ? 1
              : 0
            : existing
              ? existing.active
                ? 1
                : 0
              : hasAnyActive
                ? 0
                : 1;
        const now = nowIso();

        if (active) {
          db.prepare('UPDATE users SET active = 0').run();
        }

        db.prepare(
          `INSERT INTO users (id, name, os_users, experience, platform, workspace_root, calibration, default_rom, active, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             os_users = excluded.os_users,
             experience = excluded.experience,
             platform = excluded.platform,
             workspace_root = excluded.workspace_root,
             calibration = excluded.calibration,
             default_rom = excluded.default_rom,
             active = excluded.active,
             updated = excluded.updated`
        ).run(id, name, JSON.stringify(osUsers), experience, platform, workspaceRoot, calibration, defaultRom, active, now);

        syncActiveRomInDb(db);
        return protocol.getCurrentUserInDb(db, id);
      }),
    file
  );
}

function useUser(idInput, file = dbPath()) {
  const id = String(idInput || '').trim().toLowerCase();
  if (!id) throw new Error('give a user id to activate, e.g. construct user use alice');

  return withDb(
    (db) =>
      tx(db, () => {
        const target = protocol.getCurrentUserInDb(db, id);
        if (!target) throw new Error(`unknown user "${id}"`);
        const now = nowIso();
        db.prepare('UPDATE users SET active = 0').run();
        db.prepare('UPDATE users SET active = 1, updated = ? WHERE id = ?').run(now, target.id);
        syncActiveRomInDb(db);
        return protocol.getCurrentUserInDb(db, target.id);
      }),
    file
  );
}

// --- Global & Project Gotchas operations ---

function listGotchas(scope = 'global', file = dbPath()) {
  const normScope = !scope || scope === 'global' || scope === 'all' ? scope || 'global' : normalizeProject(scope);
  return withDb((db) => protocol.listGotchasInDb(db, normScope), file);
}

function addGotcha(fields = {}, file = dbPath()) {
  const title = typeof fields.title === 'string' ? fields.title.trim() : '';
  if (!title) throw new Error('gotcha title is required');
  const scope =
    !fields.scope || fields.scope === 'global' ? 'global' : normalizeProject(fields.scope);
  const status = fields.status ? String(fields.status).trim() : 'observed';
  const tags = normalizeRefs(fields.tags);
  const evidence = fields.evidence ? String(fields.evidence).trim() : '';
  const fix = fields.fix ? String(fields.fix).trim() : '';
  const guardRegex = fields.guardRegex !== undefined ? String(fields.guardRegex).trim() : fields.guard ? String(fields.guard).trim() : '';
  if (guardRegex) {
    try {
      new RegExp(guardRegex, 'i');
    } catch (err) {
      throw new Error(`invalid gotcha guard regex "${guardRegex}": ${err.message}`);
    }
  }
  const rawPlat = String(fields.guardPlatform || fields.guardOs || 'all').trim().toLowerCase();
  const platAlias = { windows: 'win32', win: 'win32', mac: 'darwin', macos: 'darwin', osx: 'darwin' };
  const guardPlatform = platAlias[rawPlat] || rawPlat || 'all';
  if (!['all', 'win32', 'linux', 'darwin'].includes(guardPlatform)) {
    throw new Error(`invalid guardPlatform "${guardPlatform}". Use: all, win32, linux, or darwin`);
  }
  const created = fields.created ? String(fields.created).trim() : nowIso().slice(0, 10);

  return withDb(
    (db) =>
      tx(db, () => {
        const identity = crdt.loadOrCreateIdentity();
        const uid = fields.uid || `gotcha-${scope}-${crypto.randomUUID()}`;
        const hlc = crdt.nextHlc(identity.did);

        const info = db
          .prepare(
            'INSERT INTO gotchas (uid, hlc, scope, title, status, tags, evidence, fix, guard_regex, guard_platform, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .run(uid, hlc, scope, title, status, JSON.stringify(tags), evidence, fix, guardRegex, guardPlatform, created);
        const newId = Number(info.lastInsertRowid);

        crdt.appendCrdtOpInDb(db, {
          project: scope,
          entity: 'gotcha',
          recordUid: uid,
          payload: {
            uid,
            hlc,
            scope,
            title,
            status,
            tags,
            evidence,
            fix,
            guardRegex,
            guardPlatform,
            created,
          },
        });

        if (scope === 'global') {
          syncActiveRomInDb(db);
        }
        return protocol.hydrateGotcha(db.prepare('SELECT * FROM gotchas WHERE id = ?').get(newId));
      }),
    file
  );
}

function checkDynamicGotchaGuards(command, options = {}, file = dbPath()) {
  const cmd = String(command || '');
  if (!cmd.trim()) return true;
  const hostPlatform = String(options.platform || process.platform).toLowerCase();
  return withDb((db) => {
    const rows = db.prepare("SELECT * FROM gotchas WHERE guard_regex != '' ORDER BY id ASC").all();
    const project = options.project ? normalizeProject(options.project) : '';
    const parentScope = project.includes('/') ? project.split('/')[0] : '';
    for (const r of rows) {
      const scope = r.scope || 'global';
      if (scope !== 'global' && project && scope !== project && scope !== parentScope) {
        continue;
      }
      const guardPlat = (r.guard_platform || 'all').toLowerCase();
      if (guardPlat !== 'all' && guardPlat !== hostPlatform) {
        continue;
      }
      try {
        const re = new RegExp(r.guard_regex, 'i');
        if (re.test(cmd)) {
          const fixHint = r.fix ? ` Do instead: ${r.fix}` : '';
          throw new Error(`Construct Shell Guard (Gotcha #${r.id} [${scope}/${guardPlat}]): ${r.title}.${fixHint}`);
        }
      } catch (err) {
        if (err.message.startsWith('Construct Shell Guard')) throw err;
      }
    }
    return true;
  }, file);
}

function searchGotchas(queryInput, options = {}, file = dbPath()) {
  const { raw, safe } = toFtsQuery(queryInput);
  const clauses = ['gotchas_fts MATCH ?'];
  const params = [];
  if (options.scope && options.scope !== 'all') {
    const normScope = options.scope === 'global' ? 'global' : normalizeProject(options.scope);
    clauses.push('g.scope = ?');
    params.push(normScope);
  }
  const sql = `
    SELECT g.*, bm25(gotchas_fts, 1.0, 5.0, 3.0, 2.0, 3.0) AS rank
    FROM gotchas_fts
    JOIN gotchas g ON g.id = gotchas_fts.rowid
    WHERE ${clauses.join(' AND ')}
    ORDER BY rank ASC, g.id ASC
  `;
  return withDb((db) => {
    let rows;
    try {
      rows = db.prepare(sql).all(raw, ...params);
    } catch (_) {
      rows = db.prepare(sql).all(safe, ...params);
    }
    return rows.map(protocol.hydrateGotcha);
  }, file);
}

function removeGotcha(idInput, file = dbPath()) {
  const id = requireSeq(idInput, 'gotcha id');
  return withDb(
    (db) =>
      tx(db, () => {
        const existing = db.prepare('SELECT * FROM gotchas WHERE id = ?').get(id);
        if (!existing) throw new Error(`no gotcha #${id}`);
        db.prepare('DELETE FROM gotchas WHERE id = ?').run(id);
        syncActiveRomInDb(db);
        return protocol.hydrateGotcha(existing);
      }),
    file
  );
}

// --- Construct-to-Construct Comms & Courier Protocol ---

const PACK_DEFAULT_COURIER_MAP = Object.freeze({
  dresden: 'toot',
  sprawl: 'case',
  nightcity: 'songbird',
  anathem: 'jules',
  cryptonomicon: 'avi',
  shadowrun: 'dodger',
  amber: 'random',
  generic: 'pulse',
});

function resolveCourierRomNameInDb(db, explicitVia = '', sessionId = '', project = '') {
  const raw = String(explicitVia || '').trim().toLowerCase();
  if (raw) {
    const singleRow = resolveSingleRomRowInDb(db, raw);
    if (singleRow && singleRow.name) return singleRow.name;
    if (PACK_DEFAULT_COURIER_MAP[raw]) return PACK_DEFAULT_COURIER_MAP[raw];
    return raw;
  }
  const activeRom = getActiveRomInDb(db, sessionId, project);
  if (activeRom && !activeRom.isCrew && activeRom.name) {
    return activeRom.name;
  }
  const pack = activeRom?.pack || (activeRom?.name === 'crew' ? 'sprawl' : activeRom?.name || '');
  return PACK_DEFAULT_COURIER_MAP[pack] || activeRom?.roster?.[0] || 'dixie';
}

function buildCourierProfileInDb(db, romNameInput = '', senderUser = '', roleLabel = 'COURIER') {
  const raw = String(romNameInput || 'dixie').trim().toLowerCase();
  const mappedName = PACK_DEFAULT_COURIER_MAP[raw] || raw;
  const row = resolveSingleRomRowInDb(db, mappedName);
  const senderSuffix = senderUser ? ` FROM ${String(senderUser).toUpperCase()}` : '';

  if (!row) {
    return {
      name: raw,
      glyph: '📬',
      badge: `📬 **[${raw.toUpperCase()} // ${roleLabel}${senderSuffix}]**`,
      handle: raw,
      voiceCue: '',
    };
  }

  const rom = romMod.hydrateRom(row);
  const seatMeta = romMod.SEAT_MAP[rom.seat] || { glyph: '📬' };
  const glyph = seatMeta.glyph || '📬';
  const badge = `${glyph} **[${rom.name.toUpperCase()} // ${roleLabel}${senderSuffix}]**`;

  const syntaxMatch = rom.voice.match(/### 2\.[^\n]*\n-\s*([^\n]+)/);
  const syntaxText = syntaxMatch ? syntaxMatch[1].replace(/\*\*/g, '').trim() : '';
  const rightMatch = rom.voice.match(/\(RIGHT\):\*\s*"([^"\n]+)"/);
  const sampleText = rightMatch ? ` Sample: "${rightMatch[1].trim()}"` : '';
  const voiceCue = [rom.tagline, syntaxText].filter(Boolean).join(' ') + sampleText;

  return {
    name: rom.name,
    glyph,
    badge,
    handle: rom.handle,
    voiceCue: voiceCue.trim(),
  };
}

function sendMessage(fields = {}, file = dbPath()) {
  const project = normalizeProject(fields.project || 'global');
  const toUser = String(fields.to || fields.toUser || '').trim().toLowerCase();
  const body = String(fields.body || '').trim();
  if (!toUser) throw new Error('recipient user id (--to <user>) is required, e.g. --to bob');
  if (!body) throw new Error('message body is required');

  return withDb(
    (db) =>
      tx(db, () => {
        const identity = crdt.loadOrCreateIdentity();
        const user = protocol.getCurrentUserInDb(db);
        const fromUser = fields.fromUser
          ? String(fields.fromUser).trim().toLowerCase()
          : user?.id || protocol.detectOsUsername();
        const fromRom = resolveCourierRomNameInDb(
          db,
          fields.via || fields.fromRom || '',
          fields.sessionId || process.env.CONSTRUCT_SESSION_ID || '',
          project === 'global' ? '' : project
        );
        const uid = fields.uid || `msg-${project}-${crypto.randomUUID()}`;
        const hlc = crdt.nextHlc(identity.did);
        const created = fields.created || nowIso();

        const info = db
          .prepare(
            `INSERT INTO messages (uid, hlc, project, from_user, from_rom, from_did, to_user, body, status, created)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
          )
          .run(uid, hlc, project, fromUser, fromRom, identity.did, toUser, body, created);

        const newId = Number(info.lastInsertRowid);

        crdt.appendCrdtOpInDb(db, {
          project,
          entity: 'message',
          recordUid: uid,
          payload: {
            uid,
            hlc,
            project,
            fromUser,
            fromRom,
            fromDid: identity.did,
            toUser,
            body,
            status: 'pending',
            replyBody: '',
            replyRom: '',
            replyHlc: '',
            created,
          },
        });

        return crdt.hydrateMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(newId));
      }),
    file
  );
}

function replyMessage(idOrUid, replyBodyInput, optionsOrFile = {}, maybeFile = dbPath()) {
  const replyBody = String(replyBodyInput || '').trim();
  if (!replyBody) throw new Error('reply text cannot be empty');
  const options = typeof optionsOrFile === 'string' ? {} : optionsOrFile || {};
  const file = typeof optionsOrFile === 'string' ? optionsOrFile : maybeFile;

  return withDb(
    (db) =>
      tx(db, () => {
        const key = String(idOrUid || '').replace(/^[#M]+/i, '').trim();
        const row = /^\d+$/.test(key)
          ? db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(key))
          : db.prepare('SELECT * FROM messages WHERE uid = ?').get(key);
        if (!row) throw new Error(`no construct message matching "${idOrUid}"`);

        const identity = crdt.loadOrCreateIdentity();
        const replyRom = resolveCourierRomNameInDb(
          db,
          options.via || options.replyRom || '',
          options.sessionId || process.env.CONSTRUCT_SESSION_ID || '',
          row.project === 'global' ? '' : row.project
        );
        const replyHlc = crdt.nextHlc(identity.did, row.hlc);

        db.prepare(
          `UPDATE messages
           SET status = 'replied', reply_body = ?, reply_rom = ?, reply_hlc = ?
           WHERE id = ?`
        ).run(replyBody, replyRom, replyHlc, row.id);

        const updated = crdt.hydrateMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id));

        crdt.appendCrdtOpInDb(db, {
          project: updated.project,
          entity: 'message',
          recordUid: updated.uid,
          payload: {
            uid: updated.uid,
            hlc: updated.hlc,
            project: updated.project,
            fromUser: updated.fromUser,
            fromRom: updated.fromRom,
            fromDid: updated.fromDid,
            toUser: updated.toUser,
            body: updated.body,
            status: 'replied',
            replyBody: updated.replyBody,
            replyRom: updated.replyRom,
            replyHlc: updated.replyHlc,
            created: updated.created,
          },
        });

        return updated;
      }),
    file
  );
}

function ackMessage(idOrUid, file = dbPath()) {
  return withDb(
    (db) =>
      tx(db, () => {
        const key = String(idOrUid || '').replace(/^[#M]+/i, '').trim();
        const row = /^\d+$/.test(key)
          ? db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(key))
          : db.prepare('SELECT * FROM messages WHERE uid = ?').get(key);
        if (!row) throw new Error(`no construct message matching "${idOrUid}"`);

        const identity = crdt.loadOrCreateIdentity();
        const replyHlc = crdt.nextHlc(identity.did, row.reply_hlc || row.hlc);
        db.prepare("UPDATE messages SET status = 'delivered', reply_hlc = ? WHERE id = ?").run(replyHlc, row.id);
        return crdt.hydrateMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id));
      }),
    file
  );
}

function listMessages(options = {}, file = dbPath()) {
  return withDb((db) => {
    const clauses = [];
    const params = [];
    if (options.project) {
      clauses.push('project = ?');
      params.push(normalizeProject(options.project));
    }
    if (options.toUser) {
      clauses.push('to_user = ?');
      params.push(String(options.toUser).trim().toLowerCase());
    }
    if (options.status) {
      clauses.push('status = ?');
      params.push(String(options.status).trim());
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return db
      .prepare(`SELECT * FROM messages ${whereSql} ORDER BY hlc ASC`)
      .all(...params)
      .map(crdt.hydrateMessage);
  }, file);
}

// --- Encrypted Patch / Snippet Drop Over MLS Comms (`construct drop` & `construct apply-drop`) ---

function dropPatch(fields = {}, file = dbPath()) {
  const project = normalizeProject(fields.project || 'global');
  const toUser = String(fields.to || fields.toUser || '').trim().toLowerCase();
  if (!toUser) throw new Error('recipient user id (--to <user>) is required for drop');

  let content = fields.content ? String(fields.content) : '';
  let label = fields.note ? String(fields.note).trim() : '';
  let isGitDiff = Boolean(fields.gitDiff);
  let relPath = fields.filePath ? String(fields.filePath).trim() : '';

  if (!content && relPath) {
    const abs = path.resolve(expandHome(relPath));
    if (!fs.existsSync(abs)) throw new Error(`drop file does not exist: ${abs}`);
    content = fs.readFileSync(abs, 'utf8');
    relPath = path.basename(abs);
  } else if (!content && isGitDiff) {
    const repoDir = withDb((db) => {
      const h = db.prepare('SELECT repo FROM heads WHERE project = ?').get(project);
      return h?.repo ? expandHome(h.repo) : defaultRepoPathInDb(db, project);
    }, file);
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository path configured for "${project}" to capture git diff`);
    }
    content = execFileSync('git', ['-C', repoDir, 'diff'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (!content.trim()) {
      throw new Error(`working tree in ${repoDir} has no uncommitted git diff to drop`);
    }
  }

  if (!content) {
    throw new Error('give --file <path>, --git-diff, or --content "<patch>" to drop');
  }

  const dropEnvelope = {
    type: 'construct.drop.v1',
    filePath: relPath,
    isGitDiff,
    note: label,
    content,
  };
  const body = `[DROP:${relPath || (isGitDiff ? 'git-diff' : 'snippet')}] ${label || 'Encrypted patch/snippet drop'}\n` +
    `\`\`\`construct-drop\n${Buffer.from(JSON.stringify(dropEnvelope), 'utf8').toString('base64')}\n\`\`\``;

  return sendMessage({ project, to: toUser, body, via: fields.via, fromRom: fields.fromRom, sessionId: fields.sessionId }, file);
}

function applyDrop(idOrUid, options = {}, file = dbPath()) {
  const msg = withDb((db) => {
    const key = String(idOrUid || '').replace(/^[#M]+/i, '').trim();
    const row = /^\d+$/.test(key)
      ? db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(key))
      : db.prepare('SELECT * FROM messages WHERE uid = ?').get(key);
    return crdt.hydrateMessage(row);
  }, file);

  if (!msg) throw new Error(`no construct message matching "${idOrUid}"`);
  const m = msg.body.match(/```construct-drop\r?\n([A-Za-z0-9+/=]+)\r?\n```/);
  if (!m) {
    throw new Error(`message #${msg.id} does not contain a construct-drop payload`);
  }
  const drop = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  let writtenTo = '';

  if (options.targetFile) {
    const dest = path.resolve(expandHome(options.targetFile));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, drop.content, 'utf8');
    writtenTo = dest;
  } else if (options.apply && drop.isGitDiff) {
    const repoDir = options.repoDir || withDb((db) => {
      const h = db.prepare('SELECT repo FROM heads WHERE project = ?').get(msg.project);
      return h?.repo ? expandHome(h.repo) : defaultRepoPathInDb(db, msg.project);
    }, file);
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository path found for "${msg.project}" to apply diff`);
    }
    execFileSync('git', ['-C', repoDir, 'apply', '-'], {
      input: drop.content,
      encoding: 'utf8',
      windowsHide: true,
    });
    writtenTo = `${repoDir} (git apply)`;
  }

  return {
    messageId: msg.id,
    fromUser: msg.fromUser,
    fromRom: msg.fromRom,
    project: msg.project,
    filePath: drop.filePath || '',
    isGitDiff: Boolean(drop.isGitDiff),
    note: drop.note || '',
    content: drop.content,
    writtenTo,
  };
}

// --- Unified Provenance Lookup (`construct why <file_or_symbol>`) ---
// Combines synced CRDT frames (with author attribution from `crdt_log` & `mls_groups.members`),
// project/global gotchas, local `git log -S` provenance, and optional `[WHY]` peer Construct queries.

function whyTarget(projectInput, targetInput, options = {}, file = dbPath()) {
  const target = String(targetInput || '').trim();
  if (!target) throw new Error('give a file path, symbol, or term to inspect, e.g. construct why src/crdt.js');
  const project = projectInput ? normalizeProject(projectInput) : '';

  const result = withDb((db) => {
    const localIdentity = crdt.loadOrCreateIdentity();
    const activeUser = protocol.getCurrentUserInDb(db);
    const didToUser = new Map([[localIdentity.did, activeUser?.id || protocol.detectOsUsername()]]);

    const mlsRow = project ? db.prepare('SELECT * FROM mls_groups WHERE project = ?').get(project) : null;
    const mlsGroup = mlsRow ? crdt.hydrateMlsGroup(mlsRow) : null;
    if (mlsGroup) {
      for (const mem of mlsGroup.members || []) {
        if (mem.did && mem.userId) didToUser.set(mem.did, mem.userId);
      }
    }

    // 1. Search matching Gotchas (project + global)
    const lowerTarget = target.toLowerCase();
    const allGotchas = project
      ? [...protocol.listGotchasInDb(db, project), ...protocol.listGotchasInDb(db, 'global')]
      : protocol.listGotchasInDb(db, 'all');
    const seenGotchaIds = new Set();
    const gotchas = [];
    for (const g of allGotchas) {
      if (seenGotchaIds.has(g.id)) continue;
      const hay = `${g.title} ${g.evidence} ${g.fix} ${(g.tags || []).join(' ')} ${g.guardRegex || ''}`.toLowerCase();
      if (hay.includes(lowerTarget)) {
        seenGotchaIds.add(g.id);
        gotchas.push(g);
      }
    }

    // 2. Search matching Sequential Tape Frames + attribute each frame to its author Construct/Operator via `crdt_log`
    const frameCandidates = project
      ? db.prepare('SELECT * FROM frames WHERE project = ? ORDER BY seq DESC').all(project).map(hydrateFrame)
      : db.prepare('SELECT * FROM frames ORDER BY seq DESC LIMIT 200').all().map(hydrateFrame);

    const crdtAuthorStmt = db.prepare(
      "SELECT author_did FROM crdt_log WHERE entity = 'frame' AND record_uid = ? LIMIT 1"
    );
    const frames = [];
    for (const f of frameCandidates) {
      const hay = `${f.summary} ${f.detail} ${f.verified} ${(f.refs || []).join(' ')}`.toLowerCase();
      if (hay.includes(lowerTarget)) {
        let authorDid = localIdentity.did;
        if (f.uid) {
          const opRow = crdtAuthorStmt.get(f.uid);
          if (opRow?.author_did) authorDid = opRow.author_did;
        }
        const authorUser = didToUser.get(authorDid) || authorDid.slice(-8);
        frames.push({ ...f, authorDid, authorUser });
      }
    }

    // 3. Check local Git commit history if a local repo checkout exists
    let repoDir = options.repoDir || '';
    if (!repoDir && project) {
      const h = db.prepare('SELECT repo FROM heads WHERE project = ?').get(project);
      repoDir = h?.repo ? expandHome(h.repo) : defaultRepoPathInDb(db, project);
    }
    const gitCommits = [];
    if (repoDir && fs.existsSync(path.join(repoDir, '.git'))) {
      try {
        const candidatePath = path.join(repoDir, target);
        const gitArgs = fs.existsSync(candidatePath)
          ? ['-C', repoDir, 'log', '-n', '5', '--date=short', '--pretty=format:%h|%an|%ad|%s', '--', target]
          : ['-C', repoDir, 'log', '-n', '5', '--date=short', '--pretty=format:%h|%an|%ad|%s', '-S', target];
        const logOut = execFileSync('git', gitArgs, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        }).trim();
        if (logOut) {
          for (const line of logOut.split(/\r?\n/)) {
            const [hash, author, date, ...subjParts] = line.split('|');
            if (hash) {
              gitCommits.push({ hash, author, date, subject: subjParts.join('|') });
            }
          }
        }
      } catch (_) {}
    }

    return {
      project: project || 'all',
      target,
      hasMlsGroup: Boolean(mlsGroup),
      mlsMembers: mlsGroup ? mlsGroup.members : [],
      gotchas,
      frames,
      gitCommits,
    };
  }, file);

  // 4. Optional Peer Construct Escalation (`--ask <user>` or `autoAskPeers` when 0 local frames/gotchas found on an MLS project)
  let peerQuerySent = null;
  const askUser = options.ask ? String(options.ask).trim().toLowerCase() : '';
  if (askUser) {
    peerQuerySent = sendMessage(
      {
        project: project || 'global',
        to: askUser,
        body: `[WHY ${target}] Seeking provenance/context on "${target}" in ${project || 'workspace'} (local frames=${result.frames.length}, gotchas=${result.gotchas.length}). Why is it shaped this way?`,
      },
      file
    );
  } else if (
    options.autoAskPeers &&
    result.hasMlsGroup &&
    result.frames.length === 0 &&
    result.gotchas.length === 0
  ) {
    const localDid = getIdentity().did;
    const peerMember = (result.mlsMembers || []).find((m) => m.did && m.did !== localDid && m.userId);
    if (peerMember) {
      peerQuerySent = sendMessage(
        {
          project: project || 'global',
          to: peerMember.userId,
          body: `[WHY ${target}] No local Construct frames or gotchas matched "${target}" in ${project}. Can your Construct check its session history or checkout and reply with the context?`,
        },
        file
      );
    }
  }

  return { ...result, peerQuerySent };
}

// --- Zero-Dependency Dark-Mode HTML Dashboard (`construct dashboard`) ---

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PACK_EMBLEM_MAP = Object.freeze({
  sprawl: '🌃',
  nightcity: '🦾',
  anathem: '🏛️',
  cryptonomicon: '🔐',
  shadowrun: '🐉',
  dresden: '🕯️',
  amber: '🦄',
  generic: '⚙️',
  core: '🔪',
});

function detectFocusedDirFromOpenCodeLog() {
  if (process.env.CONSTRUCT_DB) return '';
  const logPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'log', 'opencode.log');
  if (!fs.existsSync(logPath)) return '';
  let fd = null;
  try {
    const stat = fs.statSync(logPath);
    const readSize = Math.min(stat.size, 65536);
    if (readSize <= 0) return '';
    const buf = Buffer.alloc(readSize);
    fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      if (line.includes('snapshot\\\\') || line.includes('.local\\\\share\\\\opencode') || line.includes('.local/share/opencode')) continue;
      // Match UI tab-focus VCS/file-tree spawns (`git`/`git.EXE`, `rg`/`rg.exe`, or shell executions)
      if (
        line.includes('command=') &&
        (/\b(?:git(?:\.exe)?|rg(?:\.exe)?|powershell(?:\.exe)?|bash|sh)\b/i.test(line))
      ) {
        const cwdMatch = line.match(/\bcwd="([^"]+)"/);
        if (cwdMatch && cwdMatch[1]) {
          return cwdMatch[1].replace(/\\\\/g, '/').replace(/\\/g, '/').replace(/\/+$/, '');
        }
      }
    }
  } catch (_) {
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }
  return '';
}

function listActiveTabsInDb(db, file = dbPath()) {
  const sessRows = db
    .prepare(
      "SELECT session_id, rom_name, project, directory, updated FROM session_roms WHERE session_id NOT LIKE 'pending_subagent:%' AND session_id NOT LIKE '%:%' ORDER BY updated DESC"
    )
    .all();

  const bySid = new Map();
  for (const r of sessRows) {
    bySid.set(r.session_id, {
      sessionId: r.session_id,
      romName: r.rom_name,
      project: r.project || '',
      directory: r.directory || '',
      title: '',
      updatedMs: Date.parse(r.updated || '') || 0,
    });
  }

  // When running against the primary Construct DB, also inspect OpenCode's live `session_v2` table (read-only)
  // so we know every open root tab's directory, human title, and `time_viewed` / `time_updated` across all Locations.
  if (!process.env.CONSTRUCT_DB) {
    const ocDbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    if (fs.existsSync(ocDbPath)) {
      let ocDb = null;
      try {
        ocDb = new DatabaseSync(ocDbPath, { readOnly: true });
        const ocRows = ocDb
          .prepare(
            'SELECT id, title, directory, time_viewed, time_updated FROM session_v2 WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY COALESCE(time_viewed, time_updated) DESC LIMIT 10'
          )
          .all();
        for (const row of ocRows) {
          if (!row.id) continue;
          const existing = bySid.get(row.id) || {
            sessionId: row.id,
            romName: '',
            project: '',
            directory: '',
            title: '',
            updatedMs: 0,
          };
          if (row.directory) existing.directory = row.directory;
          if (row.title) {
            existing.title = String(row.title)
              .replace(/^(?:🌃|🦾|🏛️|🔐|🐉|🕯️|⚙️|🔪)\s*\[[^\]]+\]\s*/u, '')
              .trim();
          }
          const ocTs = Math.max(Number(row.time_viewed || 0), Number(row.time_updated || 0));
          if (ocTs > existing.updatedMs) existing.updatedMs = ocTs;
          bySid.set(row.id, existing);
        }
      } catch (_) {
      } finally {
        try {
          ocDb?.close();
        } catch (_) {}
      }
    }
  }

  const focusedDir = detectFocusedDirFromOpenCodeLog().toLowerCase();
  const out = [];
  for (const item of bySid.values()) {
    let proj = item.project;
    if (!proj && item.directory) {
      proj = resolveProjectFromDirInDb(db, item.directory) || '';
    }
    const rom = getActiveRomInDb(db, item.sessionId, proj);
    const pack = rom.pack || (rom.name === 'crew' ? 'sprawl' : rom.name);
    const emblem = PACK_EMBLEM_MAP[pack] || '🦾';
    const displayRom = rom.name === 'crew' ? 'sprawl' : rom.name;
    const normItemDir = String(item.directory || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
    const isFocusedDir = Boolean(focusedDir && normItemDir && normItemDir === focusedDir);
    out.push({
      sessionId: item.sessionId,
      shortId: item.sessionId.replace(/^ses_/, '').slice(0, 6),
      project: proj || 'workspace',
      directory: item.directory || '',
      title: item.title || proj || item.sessionId.slice(0, 10),
      romName: displayRom,
      pack,
      emblem,
      isFocusedDir,
      updatedMs: item.updatedMs,
    });
  }

  // Sort by real-time `updatedMs` first, then boost the most recently active tab in `focusedDir` to index 0
  out.sort((a, b) => b.updatedMs - a.updatedMs);
  if (focusedDir) {
    const focusedIdx = out.findIndex((t) => t.isFocusedDir);
    if (focusedIdx > 0) {
      const [focusedTab] = out.splice(focusedIdx, 1);
      out.unshift(focusedTab);
    }
  }
  return out.slice(0, 8);
}

function getHudSnapshot(options = {}, file = dbPath()) {
  return withDb((db) => {
    const tabs = listActiveTabsInDb(db, file);
    let sessionId = options.sessionId || process.env.CONSTRUCT_SESSION_ID || '';
    let dir = options.dir || '';
    let project = options.project ? normalizeProject(options.project) : '';

    if (!project && dir) {
      project = resolveProjectFromDirInDb(db, dir) || '';
    }

    // If a sessionId was given without a project/dir, resolve its bound project/directory from `tabs` or `session_roms`
    if (sessionId && (!project || !dir)) {
      const matchingTab = tabs.find((t) => t.sessionId === sessionId);
      if (matchingTab) {
        if (!project && matchingTab.project && matchingTab.project !== 'workspace') project = matchingTab.project;
        if (!dir && matchingTab.directory) dir = matchingTab.directory;
      } else {
        const sessRow = db.prepare('SELECT project, directory FROM session_roms WHERE session_id = ?').get(sessionId);
        if (sessRow) {
          if (!project && sessRow.project) project = sessRow.project;
          if (!dir && sessRow.directory) dir = sessRow.directory;
          if (!project && dir) project = resolveProjectFromDirInDb(db, dir) || '';
        }
      }
    }

    // If a project was given without a sessionId, pick the most recently active tab on that project (if any)
    if (project && !sessionId) {
      const matchingTab = tabs.find((t) => t.project === project);
      if (matchingTab) {
        sessionId = matchingTab.sessionId;
        if (!dir && matchingTab.directory) dir = matchingTab.directory;
      }
    }

    // If neither sessionId nor project was given (e.g. auto-follow HUD poll), pick the most recently viewed/active tab
    if (!sessionId && !project && tabs.length) {
      sessionId = tabs[0].sessionId;
      if (tabs[0].project && tabs[0].project !== 'workspace') project = tabs[0].project;
      if (!dir && tabs[0].directory) dir = tabs[0].directory;
    }

    const rom = getActiveRomInDb(db, sessionId, project);
    const user = protocol.getCurrentUserInDb(db);
    const detectedLogin = protocol.detectOsUsername();
    const activeUserId = user?.id || detectedLogin;

    const pack = rom.pack || (rom.name === 'crew' ? 'sprawl' : rom.name);
    const emblem = PACK_EMBLEM_MAP[pack] || '🦾';
    const displayRom = rom.name === 'crew' ? 'sprawl' : rom.name;
    const roster = Array.isArray(rom.roster) ? rom.roster : [rom.name];

    const statsRow = project
      ? db
          .prepare('SELECT COUNT(*) AS total, MAX(seq) AS last_seq FROM frames WHERE project = ?')
          .get(project)
      : db.prepare('SELECT COUNT(*) AS total, MAX(seq) AS last_seq FROM frames').get();

    const openRows = project
      ? db
          .prepare('SELECT seq, ts, project, kind, summary, detail FROM frames WHERE project = ? AND open = 1 ORDER BY seq ASC')
          .all(project)
      : db.prepare('SELECT seq, ts, project, kind, summary, detail FROM frames WHERE open = 1 ORDER BY seq ASC').all();

    const recentRows = project
      ? db
          .prepare('SELECT * FROM frames WHERE project = ? ORDER BY seq DESC LIMIT 15')
          .all(project)
          .map(hydrateFrame)
      : db
          .prepare('SELECT * FROM frames ORDER BY seq DESC LIMIT 15')
          .all()
          .map(hydrateFrame);

    const headRow = project ? db.prepare('SELECT * FROM heads WHERE project = ?').get(project) : null;
    const projectGotchas = project ? protocol.listGotchasInDb(db, project) : [];
    const customGuardCount = Number(
      db.prepare("SELECT COUNT(*) AS c FROM gotchas WHERE guard_regex != ''").get()?.c || 0
    );
    const guardCount = 4 + customGuardCount; // 4 built-in mechanical guards + dynamic gotcha guards

    const inboxPendingCount = Number(
      db
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE to_user = ? AND status = 'pending'")
        .get(activeUserId)?.c || 0
    );
    const inboxReplyCount = Number(
      db
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE from_user = ? AND status = 'replied'")
        .get(activeUserId)?.c || 0
    );

    let driftCount = 0;
    if (project) {
      const assimRows = db.prepare('SELECT abs_path, sha256 FROM assimilated_files WHERE project = ?').all(project);
      for (const r of assimRows) {
        if (!r.abs_path || !fs.existsSync(r.abs_path)) continue;
        try {
          const curHash = crypto.createHash('sha256').update(fs.readFileSync(r.abs_path, 'utf8'), 'utf8').digest('hex');
          if (curHash !== r.sha256) driftCount++;
        } catch (_) {}
      }
    }

    const mlsRow = project ? db.prepare('SELECT group_id, epoch FROM mls_groups WHERE project = ?').get(project) : null;
    const headSeq = statsRow?.last_seq == null ? 0 : Number(statsRow.last_seq);
    const totalFrames = Number(statsRow?.total || 0);
    const openCount = openRows.length;
    const openSeqs = openRows.map((r) => Number(r.seq));
    const openSummaries = openRows.slice(0, 5).map((r) => `#${r.seq}: ${r.summary}`);
    const openThreads = openRows.map((r) => ({
      seq: Number(r.seq),
      ts: String(r.ts || '').slice(0, 10),
      project: r.project,
      summary: r.summary,
      detail: String(r.detail || '').slice(0, 240),
    }));
    const recentTape = recentRows.map((f) => ({
      seq: f.seq,
      ts: String(f.ts || '').slice(0, 10),
      project: f.project,
      kind: f.kind,
      summary: f.summary,
      verified: f.verified || '',
    }));
    const gotchaItems = projectGotchas.slice(0, 20).map((g) => ({
      id: g.id,
      title: g.title,
      status: g.status,
      fix: g.fix || '',
    }));

    const msgRows = db
      .prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 25')
      .all()
      .map(crdt.hydrateMessage);

    const commsItems = msgRows.map((m) => {
      const fromCourier = buildCourierProfileInDb(db, m.fromRom, m.fromUser, 'COURIER');
      const replyCourier = m.replyRom ? buildCourierProfileInDb(db, m.replyRom, m.toUser, 'RETURN COURIER') : null;
      return {
        id: m.id,
        project: m.project,
        fromUser: m.fromUser,
        fromRom: fromCourier.name,
        fromGlyph: fromCourier.glyph,
        fromHandle: fromCourier.handle,
        toUser: m.toUser,
        body: m.body,
        status: m.status,
        replyBody: m.replyBody || '',
        replyRom: replyCourier ? replyCourier.name : m.replyRom || '',
        replyGlyph: replyCourier ? replyCourier.glyph : '📬',
        created: String(m.created || '').slice(0, 10),
      };
    });

    const pillParts = [
      `${emblem} ${displayRom}`,
      project ? `${project}` : null,
      headSeq ? `#${headSeq}` : '0f',
      `${openCount} open`,
      `🛡️${guardCount}`,
    ].filter(Boolean);
    if (inboxPendingCount + inboxReplyCount > 0) {
      pillParts.push(`📬${inboxPendingCount + inboxReplyCount}`);
    }
    if (driftCount > 0) {
      pillParts.push(`⚠️${driftCount} drift`);
    }

    const pill = pillParts.join(' · ');
    const tabBadge = `${emblem} [${displayRom}${headSeq ? ` #${headSeq}` : ''} · ${openCount} open${
      inboxPendingCount + inboxReplyCount > 0 ? ` · 📬${inboxPendingCount + inboxReplyCount}` : ''
    }]`;

    const projectRoms = {};
    for (const r of db.prepare('SELECT project, rom_name FROM project_roms').all()) {
      const pRom = getRomInDb(db, r.rom_name);
      const pPack = pRom.pack || (pRom.name === 'crew' ? 'sprawl' : pRom.name);
      projectRoms[r.project] = {
        romName: pRom.name === 'crew' ? 'sprawl' : pRom.name,
        pack: pPack,
        emblem: PACK_EMBLEM_MAP[pPack] || '🦾',
      };
    }

    const upstreamUpdate = getCachedConstructUpstreamInDb(db);
    if (upstreamUpdate?.behindCount > 0) {
      pillParts.push(`⬆️${upstreamUpdate.behindCount} update`);
    }

    return {
      sessionId,
      dir: dir || headRow?.repo || '',
      project: project || 'workspace',
      pack,
      emblem,
      romName: displayRom,
      handle: rom.handle || displayRom,
      roster,
      operator: user ? `${user.name} [${user.id}]` : detectedLogin,
      operatorId: activeUserId,
      state: headRow?.state || '',
      next: headRow?.next || '',
      headSeq,
      totalFrames,
      openCount,
      openSeqs,
      openSummaries,
      openThreads,
      recentTape,
      gotchas: gotchaItems,
      comms: commsItems,
      gotchaCount: projectGotchas.length,
      guardCount,
      inboxPendingCount,
      inboxReplyCount,
      driftCount,
      hasMlsGroup: Boolean(mlsRow),
      upstreamUpdate,
      pill: pillParts.join(' · '),
      tabBadge,
      tabs,
      projectRoms,
    };
  }, file);
}

function generateDashboardHtml(options = {}, file = dbPath()) {
  const hud = getHudSnapshot(options, file);
  const projects = listProjects(file);

  const rosterPills = (hud.roster || [])
    .map((rName, idx) => {
      const seatId = romMod.SEAT_ORDER[idx] || 'recon';
      const glyph = romMod.SEAT_MAP[seatId]?.glyph || '🔹';
      return `<span class="badge">${glyph} ${escapeHtml(rName)}</span>`;
    })
    .join(' ');

  const initialTabs = Array.isArray(hud.tabs) ? hud.tabs : [];
  const tabSelectorButtons = initialTabs
    .map((t) => {
      const isSelected = (hud.sessionId && t.sessionId === hud.sessionId) || (!hud.sessionId && t.project === hud.project);
      return `<button class="crew-btn ${isSelected ? 'active' : ''}" data-target-sid="${escapeHtml(t.sessionId)}" data-target-proj="${escapeHtml(t.project)}" onclick="selectTarget('${escapeHtml(t.sessionId)}','${escapeHtml(t.project)}')">${escapeHtml(t.emblem)} ${escapeHtml(t.project)} <span class="sub">[tab:${escapeHtml(t.shortId)} · ${escapeHtml(t.romName)}]</span></button>`;
    })
    .join('\n      ');

  const projectSelectorButtons = projects
    .filter((p) => !initialTabs.some((t) => t.project === p.project))
    .map((p) => {
      const pRom = hud.projectRoms?.[p.project];
      const pEmblem = pRom?.emblem || '📁';
      const pRomLabel = pRom?.romName ? ` · ${pRom.romName}` : '';
      const isSelected = !hud.sessionId && p.project === hud.project;
      return `<button class="crew-btn ${isSelected ? 'active' : ''}" data-target-sid="" data-target-proj="${escapeHtml(p.project)}" onclick="selectTarget('','${escapeHtml(p.project)}')">${escapeHtml(pEmblem)} ${escapeHtml(p.project)} <span class="sub">[project${escapeHtml(pRomLabel)}]</span></button>`;
    })
    .join('\n      ');

  const openThreads = Array.isArray(hud.openThreads) ? hud.openThreads : [];
  const openRows = openThreads
    .map(
      (f) => `
      <tr>
        <td><code>#${f.seq}</code><div class="sub">${escapeHtml(f.ts || '')}</div></td>
        <td>${escapeHtml(f.summary)}${f.detail ? `<div class="sub">${escapeHtml(f.detail)}</div>` : ''}</td>
      </tr>`
    )
    .join('');

  const recentTape = Array.isArray(hud.recentTape) ? hud.recentTape : [];
  const tapeRows = recentTape
    .map(
      (f) => `
      <tr>
        <td><code>#${f.seq}</code><div class="sub">${escapeHtml(f.ts || '')}</div></td>
        <td><span class="badge">${escapeHtml(f.kind)}</span></td>
        <td>${escapeHtml(f.summary)} ${f.verified ? `<span class="sub">{verified: ${escapeHtml(f.verified)}}</span>` : ''}</td>
      </tr>`
    )
    .join('');

  const projectGotchas = Array.isArray(hud.gotchas) ? hud.gotchas : [];
  const gotchaRows = projectGotchas
    .map(
      (g) => `
      <tr>
        <td><code>G#${g.id}</code></td>
        <td><strong>${escapeHtml(g.title)}</strong> <span class="sub">(${escapeHtml(g.status || '')})</span>${
          g.fix ? `<div class="sub">-&gt; ${escapeHtml(g.fix)}</div>` : ''
        }</td>
      </tr>`
    )
    .join('');

  const upInfo = hud.upstreamUpdate || { behindCount: 0, localSha: '', remoteSha: '', commits: [] };
  const upgradeAlertHtml =
    upInfo.behindCount > 0
      ? `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <span class="badge" style="background:rgba(88,166,255,0.22);color:#fff;font-weight:700;">⬆️ CONSTRUCT UPDATE AVAILABLE (${upInfo.behindCount} new commit${upInfo.behindCount === 1 ? '' : 's'})</span>
          <span class="sub" style="margin-left:6px;">(${escapeHtml(upInfo.localSha || 'local')} -&gt; ${escapeHtml(upInfo.remoteSha || 'origin/main')})</span>
        </div>
        <button class="crew-btn active" onclick="upgradeConstructNow()">⚡ Upgrade Construct Now</button>
      </div>
      ${
        Array.isArray(upInfo.commits) && upInfo.commits.length
          ? `<div class="sub" style="margin-top:6px;color:#e6edf3;">${upInfo.commits.map((c) => '&bull; ' + escapeHtml(c)).join('<br/>')}</div>`
          : ''
      }`
      : '';

  const commsList = Array.isArray(hud.comms) ? hud.comms : [];
  const activeOpId = String(hud.operatorId || '').toLowerCase();
  const unreadComms = commsList.filter(
    (m) =>
      (m.status === 'pending' && String(m.toUser || '').toLowerCase() === activeOpId) ||
      (m.status === 'replied' && String(m.fromUser || '').toLowerCase() === activeOpId)
  );
  const unreadAlertHtml = unreadComms.length
    ? unreadComms
        .map((m) => {
          const isIncoming = m.status === 'pending';
          const courierLabel = isIncoming
            ? `${escapeHtml(m.fromGlyph || '📬')} ${escapeHtml(String(m.fromRom || '').toUpperCase())} // COURIER FROM ${escapeHtml(String(m.fromUser || '').toUpperCase())}`
            : `${escapeHtml(m.replyGlyph || '📬')} ${escapeHtml(String(m.replyRom || m.fromRom || '').toUpperCase())} // RETURN COURIER FROM ${escapeHtml(String(m.toUser || '').toUpperCase())}`;
          const msgText = isIncoming ? m.body : `${m.replyBody} (in reply to: "${m.body}")`;
          return `
      <div class="courier-alert-item">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div><span class="badge warn">📬 UNREAD COURIER [M#${m.id}]</span> <strong style="color:#fff;margin-left:6px;">${courierLabel}</strong> <span class="sub">(${escapeHtml(m.project)} · ${escapeHtml(m.created || '')})</span></div>
          <div style="display:flex;gap:6px;align-items:center;">
            ${
              isIncoming
                ? `<input type="text" class="reply-input" id="reply-input-${m.id}" placeholder="Type reply to ${escapeHtml(m.fromUser)}..." onkeydown="if(event.key==='Enter')replyCourier(${m.id})" />
                   <button class="crew-btn active" onclick="replyCourier(${m.id})">⚡ Send Reply</button>`
                : ''
            }
            <button class="crew-btn" onclick="ackCourier(${m.id})">✓ Ack / Dismiss</button>
          </div>
        </div>
        <div style="margin-top:6px;font-size:13px;color:#fff;">"${escapeHtml(msgText)}"</div>
      </div>`;
        })
        .join('')
    : '';

  const commsRows = commsList
    .map((m) => {
      const stClass = m.status === 'pending' ? 'warn' : 'ok';
      const replyBlock = m.replyBody
        ? `<div class="sub" style="margin-top:4px;color:var(--ok);"><strong>-&gt; ${escapeHtml(m.replyGlyph || '📬')} ${escapeHtml(m.replyRom)} (${escapeHtml(m.toUser)}):</strong> "${escapeHtml(m.replyBody)}"</div>`
        : '';
      const actionsBlock =
        m.status !== 'delivered'
          ? `<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
               ${
                 m.status === 'pending'
                   ? `<input type="text" class="reply-input" id="row-reply-${m.id}" placeholder="Reply..." onkeydown="if(event.key==='Enter')replyCourier(${m.id},'row-reply-${m.id}')" />
                      <button class="crew-btn" onclick="replyCourier(${m.id},'row-reply-${m.id}')">⚡ Reply</button>`
                   : ''
               }
               <button class="crew-btn" onclick="ackCourier(${m.id})">✓ Ack</button>
             </div>`
          : '';
      return `
      <tr>
        <td><code>M#${m.id}</code><div style="margin-top:3px;"><span class="badge ${stClass}">${escapeHtml(m.status)}</span></div><div class="sub">${escapeHtml(m.created || '')}</div></td>
        <td><strong>${escapeHtml(m.fromGlyph || '📬')} ${escapeHtml(m.fromRom)}</strong><div class="sub">${escapeHtml(m.fromUser)} -&gt; ${escapeHtml(m.toUser)}</div><div class="sub"><span class="badge">${escapeHtml(m.project || 'global')}</span></div></td>
        <td>"${escapeHtml(m.body)}"${replyBlock}${actionsBlock}</td>
      </tr>`;
    })
    .join('');

  const shortSidInit = hud.sessionId ? hud.sessionId.replace(/^ses_/, '').slice(0, 6) : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>CONSTRUCT // LIVE TELEMETRY HUD</title>
<style>
  :root {
    --bg: #0b0e14;
    --panel: #131822;
    --border: #242d3d;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --ok: #3fb950;
    --warn: #d29922;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px 24px;
    background: var(--bg);
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.5;
  }
  .hud-bar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: #0f1520;
    border: 1px solid var(--accent);
    border-radius: 6px;
    margin-bottom: 14px;
  }
  .hud-pill {
    font-size: 14px;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: 0.03em;
  }
  h1 { margin: 0; font-size: 16px; color: var(--accent); letter-spacing: 0.05em; }
  h2 { font-size: 13px; color: var(--accent); margin: 18px 0 8px; text-transform: uppercase; letter-spacing: 0.06em; }
  .roster-bar {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .state-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 14px;
    margin-bottom: 16px;
  }
  .control-deck {
    background: #0f1520;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 14px;
    margin-bottom: 16px;
  }
  .btn-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  button.crew-btn {
    background: #1a2333;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 5px 10px;
    font-family: inherit;
    font-size: 11.5px;
    cursor: pointer;
    transition: all 0.12s ease;
  }
  button.crew-btn:hover { border-color: var(--accent); color: #fff; background: #223049; }
  button.crew-btn.active { border-color: var(--accent); background: rgba(88, 166, 255, 0.22); color: #fff; font-weight: 700; }
  .courier-alert-box {
    background: rgba(210, 153, 34, 0.14);
    border: 2px solid var(--warn);
    border-radius: 6px;
    padding: 12px 14px;
    margin-bottom: 14px;
  }
  .upgrade-alert-box {
    background: rgba(88, 166, 255, 0.14);
    border: 2px solid var(--accent);
    border-radius: 6px;
    padding: 12px 14px;
    margin-bottom: 14px;
  }
  .courier-alert-item + .courier-alert-item {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid rgba(210, 153, 34, 0.35);
  }
  input.reply-input {
    background: #0b0e14;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
    font-family: inherit;
    font-size: 11.5px;
    width: 220px;
  }
  input.reply-input:focus { outline: none; border-color: var(--accent); }
  #hud-toast { color: var(--ok); font-weight: 600; font-size: 11.5px; margin-left: 10px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 11px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; background: #0f131b; }
  tr.active-row td { background: rgba(88, 166, 255, 0.07); }
  .sub { color: var(--muted); font-size: 11px; margin-top: 3px; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; background: #1f2937; color: var(--accent); font-size: 11px; }
  .badge.warn { background: rgba(210, 153, 34, 0.18); color: var(--warn); }
  .badge.ok { background: rgba(63, 185, 80, 0.18); color: var(--ok); }
  code { color: var(--accent); }
</style>
</head>
<body>
  <div class="hud-bar">
    <div>
      <div class="hud-pill" id="hud-pill">${escapeHtml(hud.pill)}</div>
      <div class="sub" id="hud-sub">CONSTRUCT // SEQUENTIAL MEMORY HUD — Tab: ${escapeHtml(shortSidInit || 'active')} (${escapeHtml(hud.project)}) | Operator: ${escapeHtml(hud.operator)} | Crew: ${escapeHtml(hud.handle)}</div>
    </div>
    <div>
      <span class="badge" id="hud-frames-badge">📁 ${escapeHtml(hud.project)} · #${hud.headSeq || 0} (${hud.totalFrames || 0} frames)</span>
      <span class="badge ${hud.openCount ? 'warn' : 'ok'}" id="hud-open-badge">${hud.openCount} Open Threads</span>
      <span class="badge ok" id="hud-guard-badge">🛡️ ${hud.guardCount} Active Shell Guards</span>
    </div>
  </div>

  <div id="hud-upgrade-alert-wrap" class="upgrade-alert-box" style="display:${upInfo.behindCount > 0 ? 'block' : 'none'};">${upgradeAlertHtml}</div>
  <div id="hud-courier-alert-wrap" class="courier-alert-box" style="display:${unreadComms.length ? 'block' : 'none'};">${unreadAlertHtml}</div>

  <div class="roster-bar">
    <strong style="margin-right:6px;">ACTIVE 9-SEAT CREW (<span id="active-rom-name">${escapeHtml(hud.romName.toUpperCase())}</span>):</strong>
    <span id="roster-pills">${rosterPills}</span>
  </div>

  <div class="control-deck">
    <div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--border);">
      <strong>TARGET TAB &amp; PROJECT SCOPE</strong>
      <span class="sub" style="margin-left:8px;">(Automatically follows your focused OpenCode tab, or click any tab/project pill to pin it)</span>
      <div class="btn-row" id="target-tab-row">
        <button class="crew-btn active" id="btn-autofollow" onclick="enableAutoFollow()">🎯 Auto-Follow Active Tab</button>
        ${tabSelectorButtons}
        ${projectSelectorButtons}
      </div>
    </div>
    <div>
      <strong>INTERACTIVE CREW SWITCHER &amp; BENCH DECK</strong>
      <span class="sub" style="margin-left:8px;">(Switches Crew for target: <code id="target-scope-label">${escapeHtml(hud.project)}${shortSidInit ? ` [tab:${shortSidInit}]` : ''} (auto-following)</code>)</span>
      <span id="hud-toast"></span>
    </div>
    <div class="btn-row">
      <button class="crew-btn ${hud.pack === 'sprawl' ? 'active' : ''}" data-pack="sprawl" onclick="switchCrew('use','sprawl')">🌃 Sprawl</button>
      <button class="crew-btn ${hud.pack === 'nightcity' ? 'active' : ''}" data-pack="nightcity" onclick="switchCrew('use','nightcity')">🦾 Night City</button>
      <button class="crew-btn ${hud.pack === 'anathem' ? 'active' : ''}" data-pack="anathem" onclick="switchCrew('use','anathem')">🏛️ Anathem</button>
      <button class="crew-btn ${hud.pack === 'cryptonomicon' ? 'active' : ''}" data-pack="cryptonomicon" onclick="switchCrew('use','cryptonomicon')">🔐 Cryptonomicon</button>
      <button class="crew-btn ${hud.pack === 'shadowrun' ? 'active' : ''}" data-pack="shadowrun" onclick="switchCrew('use','shadowrun')">🐉 Shadowrun</button>
      <button class="crew-btn ${hud.pack === 'dresden' ? 'active' : ''}" data-pack="dresden" onclick="switchCrew('use','dresden')">🕯️ Dresden</button>
      <button class="crew-btn ${hud.pack === 'amber' ? 'active' : ''}" data-pack="amber" onclick="switchCrew('use','amber')">🦄 Amber</button>
      <button class="crew-btn ${hud.pack === 'generic' ? 'active' : ''}" data-pack="generic" onclick="switchCrew('use','generic')">⚙️ Generic</button>
    </div>
    <div class="btn-row" style="margin-top:8px;">
      <span class="sub" style="align-self:center;margin-right:4px;">Bench Sub:</span>
      <button class="crew-btn" data-sub="toot" onclick="switchCrew('sub','toot')">⚡ Toot-Toot (Za-Lord)</button>
      <button class="crew-btn" data-sub="caine" onclick="switchCrew('sub','caine')">🟠 Caine (Admiral)</button>
      <button class="crew-btn" data-sub="ebenezar" onclick="switchCrew('sub','ebenezar')">🟣 Ebenezar</button>
      <button class="crew-btn" data-sub="michael" onclick="switchCrew('sub','michael')">🛡️ Michael</button>
      <button class="crew-btn" data-sub="lodoghir" onclick="switchCrew('sub','lodoghir')">🟣 Lodoghir (Procian)</button>
      <button class="crew-btn" data-sub="takemura" onclick="switchCrew('sub','takemura')">🟣 Takemura</button>
      <button class="crew-btn" data-sub="turing" onclick="switchCrew('sub','turing')">🟣 Turing</button>
      <button class="crew-btn" data-sub="johnson" onclick="switchCrew('sub','johnson')">🟣 Mr. Johnson</button>
      <button class="crew-btn" data-sub="jules" onclick="switchCrew('sub','jules')">⚡ Jules (A/B Probe)</button>
      <button class="crew-btn" data-sub="reed" onclick="switchCrew('sub','reed')">🛡️ Reed (FIA)</button>
      <button class="crew-btn" data-sub="marly" onclick="switchCrew('sub','marly')">🎨 Marly</button>
    </div>
  </div>

  <div class="state-card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <strong>STATE HEAD — <span id="hud-head-project">${escapeHtml(hud.project)}</span></strong>
      <span class="sub" id="hud-head-repo">${escapeHtml(hud.dir || '')}</span>
    </div>
    <div><strong>WHERE IT STANDS:</strong> <span id="hud-head-state">${escapeHtml(hud.state || '(unset)')}</span></div>
    <div style="margin-top:4px;"><strong>NEXT:</strong> <span id="hud-head-next">${escapeHtml(hud.next || '(unset)')}</span></div>
  </div>

  <h2 id="hud-comms-heading">Construct Comms &amp; Courier Log — ${escapeHtml(hud.project)} (${commsList.length})</h2>
  <table>
    <thead><tr><th style="width:95px;">ID / Status</th><th style="width:165px;">Courier &amp; Route</th><th>Message &amp; Reply</th></tr></thead>
    <tbody id="hud-comms-tbody">${commsRows || '<tr><td colspan="3">(no messages in construct comms log)</td></tr>'}</tbody>
  </table>

  <h2 id="hud-open-heading">Open Verification Threads — ${escapeHtml(hud.project)} (${openThreads.length})</h2>
  <table>
    <thead><tr><th style="width:90px;">Seq</th><th>Summary &amp; Detail</th></tr></thead>
    <tbody id="hud-open-tbody">${openRows || '<tr><td colspan="2">(none)</td></tr>'}</tbody>
  </table>

  <h2 id="hud-tape-heading">Recent Sequential Tape — ${escapeHtml(hud.project)} (${recentTape.length} of ${hud.totalFrames || 0})</h2>
  <table>
    <thead><tr><th style="width:90px;">Seq</th><th style="width:95px;">Kind</th><th>Summary</th></tr></thead>
    <tbody id="hud-tape-tbody">${tapeRows || '<tr><td colspan="3">(empty tape)</td></tr>'}</tbody>
  </table>

  <h2 id="hud-gotchas-heading">Project Gotchas — ${escapeHtml(hud.project)} (${hud.gotchaCount || 0})</h2>
  <table>
    <thead><tr><th style="width:80px;">ID</th><th>Gotcha &amp; Fix</th></tr></thead>
    <tbody id="hud-gotchas-tbody">${gotchaRows || '<tr><td colspan="2">(no project-specific gotchas)</td></tr>'}</tbody>
  </table>

  <script>
    let selectedSessionId = ${JSON.stringify(hud.sessionId || '')};
    let selectedProject = ${JSON.stringify(hud.project || '')};
    let autoFollow = true;
    const SEAT_GLYPHS = ['🔵', '🟠', '🟣', '🔴', '🟢', '⚡', '🛡️', '🎨', '📓'];

    function esc(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderTargetButtons(h) {
      const rowEl = document.getElementById('target-tab-row');
      if (!rowEl || !h) return;
      const tabs = Array.isArray(h.tabs) ? h.tabs : [];
      rowEl.innerHTML = '';

      const autoBtn = document.createElement('button');
      autoBtn.className = 'crew-btn' + (autoFollow ? ' active' : '');
      autoBtn.textContent = '🎯 Auto-Follow Active Tab';
      autoBtn.onclick = () => enableAutoFollow();
      rowEl.appendChild(autoBtn);

      tabs.forEach((t) => {
        const btn = document.createElement('button');
        const isCurrent = (selectedSessionId && t.sessionId === selectedSessionId) || (!selectedSessionId && t.project === selectedProject);
        btn.className = 'crew-btn' + (isCurrent ? ' active' : '');
        btn.textContent = (t.emblem || '🦾') + ' ' + t.project + ' [tab:' + (t.shortId || '') + ' · ' + (t.romName || '') + ']';
        btn.onclick = () => selectTarget(t.sessionId, t.project);
        rowEl.appendChild(btn);
      });

      const projectRoms = h.projectRoms || {};
      Object.keys(projectRoms).forEach((proj) => {
        if (tabs.some((t) => t.project === proj)) return;
        const pr = projectRoms[proj];
        const btn = document.createElement('button');
        const isSel = !selectedSessionId && selectedProject === proj;
        btn.className = 'crew-btn' + (isSel ? ' active' : '');
        btn.textContent = (pr.emblem || '📁') + ' ' + proj + ' [project · ' + (pr.romName || '') + ']';
        btn.onclick = () => selectTarget('', proj);
        rowEl.appendChild(btn);
      });
    }

    function applyHudToDom(h) {
      if (!h) return;
      if (autoFollow) {
        selectedSessionId = h.sessionId || '';
        selectedProject = h.project || '';
      }
      const shortSid = (h.sessionId || selectedSessionId || '').replace(/^ses_/, '').slice(0, 6);
      const scopeEl = document.getElementById('target-scope-label');
      if (scopeEl) {
        scopeEl.textContent = (h.project || selectedProject || 'workspace') + (shortSid ? ' [tab:' + shortSid + ']' : ' [project]') + (autoFollow ? ' (auto-following)' : ' (pinned)');
      }
      const pillEl = document.getElementById('hud-pill');
      if (pillEl && h.pill) pillEl.textContent = h.pill;
      const subEl = document.getElementById('hud-sub');
      if (subEl) {
        subEl.textContent = 'CONSTRUCT // SEQUENTIAL MEMORY HUD — Tab: ' + (shortSid || 'active') + ' (' + (h.project || '') + ') | Operator: ' + (h.operator || '') + ' | Crew: ' + (h.handle || h.romName || '');
      }
      const framesBadge = document.getElementById('hud-frames-badge');
      if (framesBadge) {
        framesBadge.textContent = '📁 ' + (h.project || 'workspace') + ' · #' + (h.headSeq || 0) + ' (' + (h.totalFrames || 0) + ' frames)';
      }
      const openBadge = document.getElementById('hud-open-badge');
      if (openBadge) {
        openBadge.textContent = (h.openCount || 0) + ' Open Threads';
        openBadge.className = 'badge ' + (h.openCount ? 'warn' : 'ok');
      }
      const guardBadge = document.getElementById('hud-guard-badge');
      if (guardBadge) {
        guardBadge.textContent = '🛡️ ' + (h.guardCount || 4) + ' Active Shell Guards';
      }
      const romNameEl = document.getElementById('active-rom-name');
      if (romNameEl && h.romName) romNameEl.textContent = String(h.romName).toUpperCase();
      const pillsEl = document.getElementById('roster-pills');
      if (pillsEl && Array.isArray(h.roster)) {
        pillsEl.innerHTML = '';
        h.roster.forEach((rName, idx) => {
          const span = document.createElement('span');
          span.className = 'badge';
          span.style.marginRight = '4px';
          span.textContent = (SEAT_GLYPHS[idx] || '🔹') + ' ' + rName;
          pillsEl.appendChild(span);
        });
      }
      document.querySelectorAll('button.crew-btn[data-pack]').forEach((btn) => {
        if (btn.getAttribute('data-pack') === h.pack) btn.classList.add('active');
        else btn.classList.remove('active');
      });
      document.querySelectorAll('button.crew-btn[data-sub]').forEach((btn) => {
        const subName = btn.getAttribute('data-sub');
        if (Array.isArray(h.roster) && h.roster.includes(subName)) btn.classList.add('active');
        else btn.classList.remove('active');
      });

      const headProjEl = document.getElementById('hud-head-project');
      if (headProjEl) headProjEl.textContent = h.project || 'workspace';
      const headRepoEl = document.getElementById('hud-head-repo');
      if (headRepoEl) headRepoEl.textContent = h.dir || '';
      const headStateEl = document.getElementById('hud-head-state');
      if (headStateEl) headStateEl.textContent = h.state || '(unset)';
      const headNextEl = document.getElementById('hud-head-next');
      if (headNextEl) headNextEl.textContent = h.next || '(unset)';

      const commsHeading = document.getElementById('hud-comms-heading');
      const commsTbody = document.getElementById('hud-comms-tbody');
      const upgradeWrap = document.getElementById('hud-upgrade-alert-wrap');
      const alertWrap = document.getElementById('hud-courier-alert-wrap');
      const commsArr = Array.isArray(h.comms) ? h.comms : [];
      const opId = String(h.operatorId || '').toLowerCase();
      const activeEl = document.activeElement;
      const isTypingReply = Boolean(activeEl && activeEl.classList && activeEl.classList.contains('reply-input'));

      if (upgradeWrap) {
        const up = h.upstreamUpdate || { behindCount: 0, commits: [] };
        if (!up.behindCount || up.behindCount <= 0) {
          upgradeWrap.style.display = 'none';
          upgradeWrap.innerHTML = '';
        } else {
          upgradeWrap.style.display = 'block';
          const commitsHtml = Array.isArray(up.commits) && up.commits.length
            ? '<div class="sub" style="margin-top:6px;color:#e6edf3;">' + up.commits.map((c) => '&bull; ' + esc(c)).join('<br/>') + '</div>'
            : '';
          upgradeWrap.innerHTML =
            '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">' +
            '<div><span class="badge" style="background:rgba(88,166,255,0.22);color:#fff;font-weight:700;">⬆️ CONSTRUCT UPDATE AVAILABLE (' + esc(up.behindCount) + ' new commit' + (up.behindCount === 1 ? '' : 's') + ')</span>' +
            '<span class="sub" style="margin-left:6px;">(' + esc(up.localSha || 'local') + ' -&gt; ' + esc(up.remoteSha || 'origin/main') + ')</span></div>' +
            '<button class="crew-btn active" onclick="upgradeConstructNow()">⚡ Upgrade Construct Now</button>' +
            '</div>' + commitsHtml;
        }
      }

      if (alertWrap && !isTypingReply) {
        const unread = commsArr.filter((m) =>
          (m.status === 'pending' && String(m.toUser || '').toLowerCase() === opId) ||
          (m.status === 'replied' && String(m.fromUser || '').toLowerCase() === opId)
        );
        if (!unread.length) {
          alertWrap.style.display = 'none';
          alertWrap.innerHTML = '';
        } else {
          alertWrap.style.display = 'block';
          alertWrap.innerHTML = unread.map((m) => {
            const isIncoming = m.status === 'pending';
            const cLabel = isIncoming
              ? esc(m.fromGlyph || '📬') + ' ' + esc(String(m.fromRom || '').toUpperCase()) + ' // COURIER FROM ' + esc(String(m.fromUser || '').toUpperCase())
              : esc(m.replyGlyph || '📬') + ' ' + esc(String(m.replyRom || m.fromRom || '').toUpperCase()) + ' // RETURN COURIER FROM ' + esc(String(m.toUser || '').toUpperCase());
            const mText = isIncoming ? m.body : (m.replyBody + ' (in reply to: "' + m.body + '")');
            const inputHtml = isIncoming
              ? '<input type="text" class="reply-input" id="reply-input-' + esc(m.id) + '" placeholder="Type reply to ' + esc(m.fromUser) + '..." onkeydown="if(event.key===\'Enter\')replyCourier(' + esc(m.id) + ')" />' +
                '<button class="crew-btn active" onclick="replyCourier(' + esc(m.id) + ')">⚡ Send Reply</button>'
              : '';
            return '<div class="courier-alert-item">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">' +
              '<div><span class="badge warn">📬 UNREAD COURIER [M#' + esc(m.id) + ']</span> <strong style="color:#fff;margin-left:6px;">' + cLabel + '</strong> <span class="sub">(' + esc(m.project) + ' · ' + esc(m.created) + ')</span></div>' +
              '<div style="display:flex;gap:6px;align-items:center;">' + inputHtml + '<button class="crew-btn" onclick="ackCourier(' + esc(m.id) + ')">✓ Ack / Dismiss</button></div>' +
              '</div>' +
              '<div style="margin-top:6px;font-size:13px;color:#fff;">"' + esc(mText) + '"</div>' +
              '</div>';
          }).join('');
        }
      }

      if (commsHeading) commsHeading.textContent = 'Construct Comms & Courier Log (' + commsArr.length + ')';
      if (commsTbody && !isTypingReply) {
        if (!commsArr.length) {
          commsTbody.innerHTML = '<tr><td colspan="3">(no messages in construct comms log)</td></tr>';
        } else {
          commsTbody.innerHTML = commsArr.map((m) => {
            const stClass = m.status === 'pending' ? 'warn' : 'ok';
            const replyHtml = m.replyBody
              ? '<div class="sub" style="margin-top:4px;color:var(--ok);"><strong>-&gt; ' + esc(m.replyGlyph || '📬') + ' ' + esc(m.replyRom) + ' (' + esc(m.toUser) + '):</strong> "' + esc(m.replyBody) + '"</div>'
              : '';
            const actHtml = m.status !== 'delivered'
              ? '<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
                (m.status === 'pending'
                  ? '<input type="text" class="reply-input" id="row-reply-' + esc(m.id) + '" placeholder="Reply..." onkeydown="if(event.key===\'Enter\')replyCourier(' + esc(m.id) + ',\'row-reply-' + esc(m.id) + '\')" />' +
                    '<button class="crew-btn" onclick="replyCourier(' + esc(m.id) + ',\'row-reply-' + esc(m.id) + '\')">⚡ Reply</button>'
                  : '') +
                '<button class="crew-btn" onclick="ackCourier(' + esc(m.id) + ')">✓ Ack</button></div>'
              : '';
            return '<tr><td><code>M#' + esc(m.id) + '</code><div style="margin-top:3px;"><span class="badge ' + stClass + '">' + esc(m.status) + '</span></div><div class="sub">' + esc(m.created) + '</div></td>' +
              '<td><strong>' + esc(m.fromGlyph || '📬') + ' ' + esc(m.fromRom) + '</strong><div class="sub">' + esc(m.fromUser) + ' -&gt; ' + esc(m.toUser) + '</div><div class="sub"><span class="badge">' + esc(m.project || 'global') + '</span></div></td>' +
              '<td>"' + esc(m.body) + '"' + replyHtml + actHtml + '</td></tr>';
          }).join('');
        }
      }

      const openHeading = document.getElementById('hud-open-heading');
      const openTbody = document.getElementById('hud-open-tbody');
      const openList = Array.isArray(h.openThreads) ? h.openThreads : [];
      if (openHeading) openHeading.textContent = 'Open Verification Threads — ' + (h.project || 'workspace') + ' (' + openList.length + ')';
      if (openTbody) {
        if (!openList.length) {
          openTbody.innerHTML = '<tr><td colspan="2">(none)</td></tr>';
        } else {
          openTbody.innerHTML = openList.map((f) =>
            '<tr><td><code>#' + esc(f.seq) + '</code><div class="sub">' + esc(f.ts) + '</div></td>' +
            '<td>' + esc(f.summary) + (f.detail ? '<div class="sub">' + esc(f.detail) + '</div>' : '') + '</td></tr>'
          ).join('');
        }
      }

      const tapeHeading = document.getElementById('hud-tape-heading');
      const tapeTbody = document.getElementById('hud-tape-tbody');
      const tapeList = Array.isArray(h.recentTape) ? h.recentTape : [];
      if (tapeHeading) tapeHeading.textContent = 'Recent Sequential Tape — ' + (h.project || 'workspace') + ' (' + tapeList.length + ' of ' + (h.totalFrames || 0) + ')';
      if (tapeTbody) {
        if (!tapeList.length) {
          tapeTbody.innerHTML = '<tr><td colspan="3">(empty tape)</td></tr>';
        } else {
          tapeTbody.innerHTML = tapeList.map((f) =>
            '<tr><td><code>#' + esc(f.seq) + '</code><div class="sub">' + esc(f.ts) + '</div></td>' +
            '<td><span class="badge">' + esc(f.kind) + '</span></td>' +
            '<td>' + esc(f.summary) + (f.verified ? ' <span class="sub">{verified: ' + esc(f.verified) + '}</span>' : '') + '</td></tr>'
          ).join('');
        }
      }

      const gotchaHeading = document.getElementById('hud-gotchas-heading');
      const gotchaTbody = document.getElementById('hud-gotchas-tbody');
      const gotchaList = Array.isArray(h.gotchas) ? h.gotchas : [];
      if (gotchaHeading) gotchaHeading.textContent = 'Project Gotchas — ' + (h.project || 'workspace') + ' (' + (h.gotchaCount || gotchaList.length) + ')';
      if (gotchaTbody) {
        if (!gotchaList.length) {
          gotchaTbody.innerHTML = '<tr><td colspan="2">(no project-specific gotchas)</td></tr>';
        } else {
          gotchaTbody.innerHTML = gotchaList.map((g) =>
            '<tr><td><code>G#' + esc(g.id) + '</code></td>' +
            '<td><strong>' + esc(g.title) + '</strong> <span class="sub">(' + esc(g.status) + ')</span>' +
            (g.fix ? '<div class="sub">-&gt; ' + esc(g.fix) + '</div>' : '') + '</td></tr>'
          ).join('');
        }
      }

      renderTargetButtons(h);
    }

    async function pollHud() {
      try {
        const qs = autoFollow
          ? ''
          : '?sessionID=' + encodeURIComponent(selectedSessionId || '') + '&project=' + encodeURIComponent(selectedProject || '');
        const res = await fetch('http://127.0.0.1:47420/hud' + qs);
        const data = await res.json();
        if (data && data.ok && data.hud) applyHudToDom(data.hud);
      } catch (_) {}
    }

    function selectTarget(sid, proj) {
      autoFollow = false;
      selectedSessionId = sid || '';
      selectedProject = proj || '';
      const toast = document.getElementById('hud-toast');
      if (toast) toast.textContent = 'Pinned target -> ' + (proj || sid);
      void pollHud();
    }

    function enableAutoFollow() {
      autoFollow = true;
      const toast = document.getElementById('hud-toast');
      if (toast) toast.textContent = '🎯 Following active OpenCode tab';
      void pollHud();
    }

    async function switchCrew(action, target) {
      const toast = document.getElementById('hud-toast');
      if (toast) toast.textContent = 'Switching ' + (selectedProject || 'active tab') + ' -> ' + target + '...';
      try {
        const res = await fetch('http://127.0.0.1:47420/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, target, sessionID: selectedSessionId, project: selectedProject })
        });
        const data = await res.json();
        if (data && data.ok && data.hud) {
          applyHudToDom(data.hud);
          if (toast) toast.textContent = '✓ Slotted ' + data.hud.emblem + ' ' + data.hud.romName + ' on ' + data.hud.project;
        } else if (toast) {
          toast.textContent = 'Updated: ' + target;
        }
      } catch (e) {
        if (toast) toast.textContent = 'Run "/construct ' + target + '" in prompt';
      }
    }

    async function replyCourier(msgId, inputId) {
      const el = document.getElementById(inputId || ('reply-input-' + msgId));
      const body = el ? String(el.value || '').trim() : '';
      if (!body) return;
      const toast = document.getElementById('hud-toast');
      if (toast) toast.textContent = 'Sending reply to M#' + msgId + '...';
      try {
        const res = await fetch('http://127.0.0.1:47420/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reply', id: msgId, body, sessionID: selectedSessionId, project: selectedProject })
        });
        const data = await res.json();
        if (data && data.ok && data.hud) {
          if (el) el.value = '';
          applyHudToDom(data.hud);
          if (toast) toast.textContent = '✓ Replied to M#' + msgId;
        }
      } catch (_) {}
    }

    async function ackCourier(msgId) {
      const toast = document.getElementById('hud-toast');
      if (toast) toast.textContent = 'Dismissing M#' + msgId + '...';
      try {
        const res = await fetch('http://127.0.0.1:47420/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'ack', id: msgId, sessionID: selectedSessionId, project: selectedProject })
        });
        const data = await res.json();
        if (data && data.ok && data.hud) {
          applyHudToDom(data.hud);
          if (toast) toast.textContent = '✓ Acknowledged M#' + msgId;
        }
      } catch (_) {}
    }

    async function upgradeConstructNow() {
      const toast = document.getElementById('hud-toast');
      if (toast) toast.textContent = 'Upgrading Construct (git pull + rom sync + install-plugin)...';
      try {
        const res = await fetch('http://127.0.0.1:47420/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'upgrade', sessionID: selectedSessionId, project: selectedProject })
        });
        const data = await res.json();
        if (data && data.ok) {
          if (data.hud) applyHudToDom(data.hud);
          if (toast) toast.textContent = '✓ Construct upgraded to latest!';
        }
      } catch (_) {}
    }

    void pollHud();
    window.addEventListener('focus', () => void pollHud());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void pollHud();
    });
    setInterval(pollHud, 1000);
  </script>
</body>
</html>`;

  const outFile =
    options.outFile ||
    path.join(os.homedir(), '.config', 'opencode', 'construct-hud.html');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html, 'utf8');

  // Also write a per-project pinned HUD file (`construct-hud-<project_slug>.html` with `autoFollow = false`)
  // so each OpenCode project tab can preview its own isolated HUD file without another tab overwriting it.
  let projectOutFile = outFile;
  if (!options.outFile && hud.project && hud.project !== 'workspace') {
    const slug = String(hud.project)
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    if (slug) {
      projectOutFile = path.join(os.homedir(), '.config', 'opencode', `construct-hud-${slug}.html`);
      const pinnedHtml = html.replace('let autoFollow = true;', 'let autoFollow = false;');
      fs.writeFileSync(projectOutFile, pinnedHtml, 'utf8');
    }
  }

  // Ensure the local loopback HUD server (`127.0.0.1:47420`) is running even if an OpenCode Location plugin unloaded
  if (!process.env.CONSTRUCT_DB && !options.noServerSpawn) {
    try {
      const binScript = path.resolve(__dirname, '..', 'bin', 'construct.js');
      const child = spawn(process.execPath, [binScript, 'hud-server'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch (_) {}
  }

  return { outFile, projectOutFile, html, hud, projectCount: projects.length, openCount: hud.openCount };
}

function startStandaloneHudServer(port = 47420, file = dbPath()) {
  const http = require('node:http');
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/hud')) {
        try {
          const parsedUrl = new URL(req.url, `http://127.0.0.1:${port}`);
          const qSid = parsedUrl.searchParams.get('sessionID') || '';
          const qProj = parsedUrl.searchParams.get('project') || '';
          const qDir = parsedUrl.searchParams.get('dir') || '';
          const snap = getHudSnapshot({ sessionId: qSid, project: qProj, dir: qDir }, file);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, hud: snap }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/action')) {
        let body = '';
        req.on('data', (chunk) => {
          if (body.length < 16384) body += chunk;
        });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            const rawAction = String(payload.action || 'use').trim().toLowerCase();
            const sid = String(payload.sessionID || '');
            const proj = String(payload.project || '');
            const dir = String(payload.dir || '');

            if (rawAction === 'reply' && payload.id && payload.body) {
              replyMessage(payload.id, payload.body, { via: payload.via, sessionId: sid }, file);
              const snap = getHudSnapshot({ sessionId: sid, project: proj !== 'workspace' ? proj : '', dir }, file);
              try {
                generateDashboardHtml({ sessionId: sid, project: snap.project, dir: snap.dir, noServerSpawn: true }, file);
              } catch (_) {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, hud: snap }));
              return;
            }
            if (rawAction === 'ack' && payload.id) {
              ackMessage(payload.id, file);
              const snap = getHudSnapshot({ sessionId: sid, project: proj !== 'workspace' ? proj : '', dir }, file);
              try {
                generateDashboardHtml({ sessionId: sid, project: snap.project, dir: snap.dir, noServerSpawn: true }, file);
              } catch (_) {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, hud: snap }));
              return;
            }
            if (rawAction === 'upgrade') {
              const up = upgradeConstruct({}, file);
              const snap = getHudSnapshot({ sessionId: sid, project: proj !== 'workspace' ? proj : '', dir }, file);
              try {
                generateDashboardHtml({ sessionId: sid, project: snap.project, dir: snap.dir, noServerSpawn: true }, file);
              } catch (_) {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, upgraded: up, hud: snap }));
              return;
            }

            const act = rawAction === 'sub' ? 'sub' : 'use';
            const target = String(payload.target || '').trim().toLowerCase();
            if (target && /^[a-z0-9_-]+(?:,[a-z0-9_-]+)*$/i.test(target)) {
              const opts = { sessionId: sid, project: proj !== 'workspace' ? proj : '', dir };
              if (act === 'sub') subRom(target, opts, file);
              else useRom(target, opts, file);
              const snap = getHudSnapshot(opts, file);
              try {
                generateDashboardHtml({ sessionId: sid, project: snap.project, dir: snap.dir, noServerSpawn: true }, file);
              } catch (_) {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, hud: snap }));
              return;
            }
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid target' }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on('error', () => {
      resolve(null);
    });
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

// --- GitHub Issues <-> Construct Open Threads Bridge (`construct issues [sync | publish]`) ---
//
// Invariant:
//   - Every OPEN GitHub Issue on the repository maps to an `[OPEN]` `thread` frame with `gh:#<number>` in `refs`.
//   - Every CLOSED GitHub Issue on the repository automatically resolves its matching `gh:#<number>` `thread` frame.
//   - Local Construct `thread` frames remain private inside `construct.db` (and MLS sync) unless explicitly
//     promoted to GitHub with `publishThreadToGithub(seq)` (`construct issues publish <seq>`), and GitHub issues
//     are never closed from Construct unless `--close-gh` is explicitly passed to `construct resolve`.

function syncGithubIssues(projectInput, options = {}, file = dbPath()) {
  const project = normalizeProject(projectInput);

  let issues = options.issues;
  if (!Array.isArray(issues)) {
    const repoDir =
      options.repoDir ||
      withDb((db) => {
        const h = db.prepare('SELECT repo FROM heads WHERE project = ?').get(project);
        return h?.repo ? expandHome(h.repo) : defaultRepoPathInDb(db, project);
      }, file);
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository directory found for "${project}" to query GitHub issues`);
    }
    const rawJson = execFileSync(
      'gh',
      ['issue', 'list', '--state', 'all', '--limit', String(options.limit || 50), '--json', 'number,title,state,body,labels,updatedAt'],
      {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    issues = JSON.parse(rawJson || '[]');
  }

  let openedCount = 0;
  let resolvedCount = 0;
  const createdSeqs = [];
  const resolvedSeqs = [];

  withDb(
    (db) =>
      tx(db, () => {
        const existingFrames = db
          .prepare('SELECT * FROM frames WHERE project = ? ORDER BY seq ASC')
          .all(project)
          .map(hydrateFrame);

        for (const issue of issues) {
          const num = Number(issue.number);
          if (!Number.isInteger(num) || num <= 0) continue;
          const ghRef = `gh:#${num}`;
          const shortRef = `#${num}`;
          const state = String(issue.state || 'OPEN').toUpperCase();
          const title = String(issue.title || `Issue #${num}`).trim();
          const body = String(issue.body || '').trim();
          const labelNames = Array.isArray(issue.labels)
            ? issue.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
            : [];

          // Find any existing frame linked to `gh:#<num>` (or a `thread` frame with `#<num>`)
          const matchingFrames = existingFrames.filter(
            (f) => f.refs.includes(ghRef) || (f.kind === 'thread' && f.refs.includes(shortRef))
          );

          if (state === 'OPEN') {
            if (matchingFrames.length === 0) {
              const identity = crdt.loadOrCreateIdentity();
              const uid = `frame-${project}-gh-${num}`;
              const hlc = crdt.nextHlc(identity.did);
              const ts = issue.updatedAt ? String(issue.updatedAt).trim() : nowIso();
              const refs = [ghRef, shortRef, ...labelNames];
              const summary = `[GH #${num}] ${title}`;
              const info = db
                .prepare(
                  `INSERT INTO frames (uid, hlc, ts, project, kind, summary, detail, verified, parent_seq, open, refs)
                   VALUES (?, ?, ?, ?, 'thread', ?, ?, '', NULL, 1, ?)`
                )
                .run(uid, hlc, ts, project, summary, body, JSON.stringify(refs));
              const newSeq = Number(info.lastInsertRowid);
              crdt.appendCrdtOpInDb(db, {
                project,
                entity: 'frame',
                recordUid: uid,
                payload: {
                  uid,
                  hlc,
                  ts,
                  project,
                  kind: 'thread',
                  summary,
                  detail: body,
                  verified: '',
                  open: true,
                  refs,
                },
              });
              openedCount++;
              createdSeqs.push(newSeq);
            }
          } else if (state === 'CLOSED') {
            for (const mf of matchingFrames) {
              if (mf.open) {
                const identity = crdt.loadOrCreateIdentity();
                const hlc = crdt.nextHlc(identity.did);
                const verifiedNote = mf.verified
                  ? `${mf.verified}; Closed on GitHub (${ghRef})`
                  : `Closed on GitHub (${ghRef})`;
                db.prepare('UPDATE frames SET open = 0, hlc = ?, verified = ? WHERE seq = ?').run(
                  hlc,
                  verifiedNote,
                  mf.seq
                );
                if (mf.uid) {
                  crdt.appendCrdtOpInDb(db, {
                    project,
                    entity: 'frame',
                    recordUid: mf.uid,
                    payload: {
                      uid: mf.uid,
                      hlc,
                      ts: mf.ts,
                      project: mf.project,
                      kind: mf.kind,
                      summary: mf.summary,
                      detail: mf.detail,
                      verified: verifiedNote,
                      open: false,
                      refs: mf.refs,
                    },
                  });
                }
                resolvedCount++;
                resolvedSeqs.push(mf.seq);
              }
            }
          }
        }

        const now = nowIso();
        db.prepare(
          `INSERT INTO heads (project, repo, state, next, gh_synced, updated)
           VALUES (?, '', '', '', ?, ?)
           ON CONFLICT(project) DO UPDATE SET gh_synced = excluded.gh_synced`
        ).run(project, now, now);
      }),
    file
  );

  return {
    project,
    totalIssuesChecked: issues.length,
    openedCount,
    resolvedCount,
    createdSeqs,
    resolvedSeqs,
  };
}

function publishThreadToGithub(seqInput, options = {}, file = dbPath()) {
  const seq = requireSeq(seqInput);
  const frame = withDb((db) => getFrameInDb(db, seq), file);
  if (!frame) throw new Error(`no frame #${seq}`);

  const existingGhRef = (frame.refs || []).find((r) => /^gh:#\d+$/i.test(r));
  if (existingGhRef) {
    return {
      alreadyPublished: true,
      issueNumber: Number(existingGhRef.replace(/^gh:#/i, '')),
      frame,
    };
  }

  const repoDir =
    options.repoDir ||
    withDb((db) => {
      const h = db.prepare('SELECT repo FROM heads WHERE project = ?').get(frame.project);
      return h?.repo ? expandHome(h.repo) : defaultRepoPathInDb(db, frame.project);
    }, file);

  const cleanTitle = frame.summary.replace(/^\[GH #\d+\]\s*/i, '');
  const body = frame.detail || `Promoted from Construct open thread #${frame.seq} (${frame.project}).`;
  let issueNumber = null;
  let issueUrl = '';

  if (typeof options.createIssueFn === 'function') {
    const created = options.createIssueFn({ title: cleanTitle, body, project: frame.project, repoDir });
    issueNumber = Number(created.number || created);
    issueUrl = created.url || '';
  } else {
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository directory found for "${frame.project}" to run "gh issue create"`);
    }
    const out = execFileSync('gh', ['issue', 'create', '--title', cleanTitle, '--body', body], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    issueUrl = out;
    const m = out.match(/\/issues\/(\d+)/) || out.match(/#(\d+)/);
    if (!m) throw new Error(`could not parse created GitHub issue number from output: "${out}"`);
    issueNumber = Number(m[1]);
  }

  const ghRef = `gh:#${issueNumber}`;
  const shortRef = `#${issueNumber}`;
  const nextRefs = [...new Set([...(frame.refs || []), ghRef, shortRef])];
  const updatedFrame = editFrame(frame.seq, { refs: nextRefs }, file);

  return {
    alreadyPublished: false,
    issueNumber,
    issueUrl,
    frame: updatedFrame,
  };
}

// --- PR-Driven Workflow Bridge (`construct pr [sync | open | review | merge]`) ---

function resolveTeammateUserInDb(db, project, explicitTo = '') {
  if (explicitTo && String(explicitTo).trim()) {
    return String(explicitTo).trim().toLowerCase();
  }
  const localIdentity = crdt.loadOrCreateIdentity();
  const activeUser = protocol.getCurrentUserInDb(db);
  const activeId = (activeUser?.id || protocol.detectOsUsername() || '').toLowerCase();

  if (project) {
    const mlsRow = db.prepare('SELECT * FROM mls_groups WHERE project = ?').get(project);
    if (mlsRow) {
      const group = crdt.hydrateMlsGroup(mlsRow);
      const peer = (group.members || []).find((m) => m.did && m.did !== localIdentity.did);
      if (peer && peer.userId && peer.userId !== 'peer') return peer.userId.toLowerCase();
    }
  }
  const otherUser = db
    .prepare('SELECT id FROM users WHERE LOWER(id) != ? ORDER BY active DESC, id ASC LIMIT 1')
    .get(activeId);
  if (otherUser && otherUser.id) return otherUser.id.toLowerCase();
  return '';
}

function syncGithubPrs(projectInput, options = {}, file = dbPath()) {
  const project = normalizeProject(projectInput);

  let prs = options.prs;
  if (!Array.isArray(prs)) {
    const repoDir =
      options.repoDir ||
      withDb((db) => {
        const h = db.prepare('SELECT repo FROM heads WHERE project = ?').get(project);
        return h?.repo ? expandHome(h.repo) : defaultRepoPathInDb(db, project);
      }, file);
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository directory found for "${project}" to query GitHub pull requests`);
    }
    const rawJson = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'all',
        '--limit',
        String(options.limit || 50),
        '--json',
        'number,title,state,body,author,headRefName,baseRefName,reviewDecision,isDraft,url,updatedAt',
      ],
      {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    prs = JSON.parse(rawJson || '[]');
  }

  let openedCount = 0;
  let updatedCount = 0;
  let resolvedCount = 0;
  const createdSeqs = [];
  const resolvedSeqs = [];

  withDb(
    (db) =>
      tx(db, () => {
        const existingFrames = db
          .prepare('SELECT * FROM frames WHERE project = ? ORDER BY seq ASC')
          .all(project)
          .map(hydrateFrame);

        for (const pr of prs) {
          const num = Number(pr.number);
          if (!Number.isInteger(num) || num <= 0) continue;
          const prRef = `pr:#${num}`;
          const shortRef = `#${num}`;
          const state = String(pr.state || 'OPEN').toUpperCase();
          const title = String(pr.title || `PR #${num}`).trim();
          const body = String(pr.body || '').trim();
          const authorLogin =
            typeof pr.author === 'string' ? pr.author : String(pr.author?.login || 'author').trim();
          const headBranch = String(pr.headRefName || '').trim();
          const reviewStatus = pr.isDraft
            ? 'DRAFT'
            : String(pr.reviewDecision || 'REVIEW_REQUIRED').trim();

          const matchingFrames = existingFrames.filter((f) => f.refs.includes(prRef));

          if (state === 'OPEN') {
            const summary = `[PR #${num}] ${title}${headBranch ? ` (${headBranch} by ${authorLogin} · ${reviewStatus})` : ` (by ${authorLogin} · ${reviewStatus})`}`;
            const refs = [
              prRef,
              shortRef,
              ...(headBranch ? [`branch:${headBranch}`] : []),
              `author:${authorLogin}`,
            ];

            if (matchingFrames.length === 0) {
              const identity = crdt.loadOrCreateIdentity();
              const uid = `frame-${project}-pr-${num}`;
              const hlc = crdt.nextHlc(identity.did);
              const ts = pr.updatedAt ? String(pr.updatedAt).trim() : nowIso();
              const info = db
                .prepare(
                  `INSERT INTO frames (uid, hlc, ts, project, kind, summary, detail, verified, parent_seq, open, refs)
                   VALUES (?, ?, ?, ?, 'thread', ?, ?, '', NULL, 1, ?)`
                )
                .run(uid, hlc, ts, project, summary, body, JSON.stringify(refs));
              const newSeq = Number(info.lastInsertRowid);
              crdt.appendCrdtOpInDb(db, {
                project,
                entity: 'frame',
                recordUid: uid,
                payload: {
                  uid,
                  hlc,
                  ts,
                  project,
                  kind: 'thread',
                  summary,
                  detail: body,
                  verified: '',
                  open: true,
                  refs,
                },
              });
              openedCount++;
              createdSeqs.push(newSeq);
            } else {
              for (const mf of matchingFrames) {
                if (mf.open && mf.summary !== summary) {
                  const identity = crdt.loadOrCreateIdentity();
                  const hlc = crdt.nextHlc(identity.did);
                  db.prepare('UPDATE frames SET summary = ?, hlc = ?, refs = ? WHERE seq = ?').run(
                    summary,
                    hlc,
                    JSON.stringify(refs),
                    mf.seq
                  );
                  if (mf.uid) {
                    crdt.appendCrdtOpInDb(db, {
                      project,
                      entity: 'frame',
                      recordUid: mf.uid,
                      payload: {
                        uid: mf.uid,
                        hlc,
                        ts: mf.ts,
                        project: mf.project,
                        kind: mf.kind,
                        summary,
                        detail: mf.detail,
                        verified: mf.verified,
                        open: true,
                        refs,
                      },
                    });
                  }
                  updatedCount++;
                }
              }
            }
          } else if (state === 'MERGED' || state === 'CLOSED') {
            for (const mf of matchingFrames) {
              if (mf.open) {
                const identity = crdt.loadOrCreateIdentity();
                const hlc = crdt.nextHlc(identity.did);
                const stateLabel = state === 'MERGED' ? 'Merged' : 'Closed';
                const verifiedNote = mf.verified
                  ? `${mf.verified}; ${stateLabel} on GitHub (${prRef})`
                  : `${stateLabel} on GitHub (${prRef})`;
                db.prepare('UPDATE frames SET open = 0, hlc = ?, verified = ? WHERE seq = ?').run(
                  hlc,
                  verifiedNote,
                  mf.seq
                );
                if (mf.uid) {
                  crdt.appendCrdtOpInDb(db, {
                    project,
                    entity: 'frame',
                    recordUid: mf.uid,
                    payload: {
                      uid: mf.uid,
                      hlc,
                      ts: mf.ts,
                      project: mf.project,
                      kind: mf.kind,
                      summary: mf.summary,
                      detail: mf.detail,
                      verified: verifiedNote,
                      open: false,
                      refs: mf.refs,
                    },
                  });
                }
                resolvedCount++;
                resolvedSeqs.push(mf.seq);
              }
            }
          }
        }
      }),
    file
  );

  return {
    project,
    totalPrsChecked: prs.length,
    openedCount,
    updatedCount,
    resolvedCount,
    createdSeqs,
    resolvedSeqs,
  };
}

function openGithubPr(projectInput, options = {}, file = dbPath()) {
  const project = normalizeProject(projectInput);
  const title = String(options.title || '').trim();
  const body = String(options.body || '').trim();
  if (!title) throw new Error('PR title (--title "<title>") is required to open a pull request');

  const { repoDir, branch: detectedBranch, toUser } = withDb((db) => {
    const meta = detectRepoGitMetaInDb(db, project, options.repoDir);
    const peer = resolveTeammateUserInDb(db, project, options.to);
    return { repoDir: meta.repoDir, branch: meta.branch, toUser: peer };
  }, file);

  const headBranch = options.head || detectedBranch || '';
  const baseBranch = options.base || 'main';
  let prNumber = null;
  let prUrl = '';

  if (typeof options.createPrFn === 'function') {
    const created = options.createPrFn({ project, title, body, headBranch, baseBranch, draft: Boolean(options.draft), repoDir });
    prNumber = Number(created.number || created);
    prUrl = created.url || '';
  } else {
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository directory found for "${project}" to run "gh pr create"`);
    }
    const ghArgs = ['pr', 'create', '--title', title, '--body', body || title];
    if (options.base) ghArgs.push('--base', String(options.base));
    if (options.head) ghArgs.push('--head', String(options.head));
    if (options.draft) ghArgs.push('--draft');
    const out = execFileSync('gh', ghArgs, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    prUrl = out;
    const m = out.match(/\/pull\/(\d+)/) || out.match(/#(\d+)/);
    if (!m) throw new Error(`could not parse created GitHub PR number from output: "${out}"`);
    prNumber = Number(m[1]);
  }

  const prRef = `pr:#${prNumber}`;
  const shortRef = `#${prNumber}`;
  const refs = [prRef, shortRef, ...(headBranch ? [`branch:${headBranch}`] : [])];
  const summary = `[PR #${prNumber}] ${title}${headBranch ? ` (${headBranch} · REVIEW_REQUIRED)` : ' (REVIEW_REQUIRED)'}`;

  const rec = recordFrame(
    {
      project,
      kind: 'thread',
      open: true,
      summary,
      detail: body ? `${prUrl ? `${prUrl}\n\n` : ''}${body}` : prUrl,
      refs,
    },
    file
  );

  let courierSent = null;
  if (toUser && options.notify !== false) {
    courierSent = sendMessage(
      {
        project,
        to: toUser,
        via: options.via,
        sessionId: options.sessionId,
        body: `[PR #${prNumber}] Opened pull request "${title}"${headBranch ? ` on branch \`${headBranch}\`` : ''}${prUrl ? ` (${prUrl})` : ''} -- ready for your review!`,
      },
      file
    );
  }

  return {
    project,
    prNumber,
    prUrl,
    headBranch,
    baseBranch,
    frame: rec.frame,
    courierSent,
  };
}

function reviewGithubPr(projectInput, prNumberInput, options = {}, file = dbPath()) {
  const project = normalizeProject(projectInput);
  const prNumber = requireSeq(prNumberInput, 'PR number');
  const verdict = options.approve
    ? 'APPROVED'
    : options.requestChanges
      ? 'CHANGES_REQUESTED'
      : 'COMMENTED';
  const body = String(options.body || options.note || (verdict === 'APPROVED' ? 'Approved and verified.' : '')).trim();
  if (!body) throw new Error('review note (--body "<note>") is required when reviewing a PR');

  const { repoDir, toUser } = withDb((db) => {
    const meta = detectRepoGitMetaInDb(db, project, options.repoDir);
    const peer = resolveTeammateUserInDb(db, project, options.to);
    return { repoDir: meta.repoDir, toUser: peer };
  }, file);

  if (typeof options.reviewPrFn === 'function') {
    options.reviewPrFn({ project, prNumber, verdict, body, repoDir });
  } else {
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository directory found for "${project}" to run "gh pr review"`);
    }
    const flag = verdict === 'APPROVED' ? '--approve' : verdict === 'CHANGES_REQUESTED' ? '--request-changes' : '--comment';
    execFileSync('gh', ['pr', 'review', String(prNumber), flag, '--body', body], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  const prRef = `pr:#${prNumber}`;
  const shortRef = `#${prNumber}`;
  const rec = recordFrame(
    {
      project,
      kind: 'finding',
      summary: `Reviewed [PR #${prNumber}] (${verdict}): ${body.split(/\r?\n/)[0].slice(0, 140)}`,
      detail: body,
      verified: options.verified || `PR #${prNumber} review (${verdict})`,
      refs: [prRef, shortRef],
    },
    file
  );

  // Also update any open `[PR #<prNumber>]` thread summary with the new review decision
  withDb((db) => {
    const openFrames = db
      .prepare('SELECT * FROM frames WHERE project = ? AND open = 1 ORDER BY seq ASC')
      .all(project)
      .map(hydrateFrame);
    for (const mf of openFrames) {
      if (mf.refs.includes(prRef)) {
        const updatedSummary = mf.summary.replace(/·\s*(?:REVIEW_REQUIRED|CHANGES_REQUESTED|APPROVED|DRAFT)\)/, `· ${verdict})`);
        if (updatedSummary !== mf.summary) {
          editFrame(mf.seq, { summary: updatedSummary }, file);
        }
      }
    }
  }, file);

  let courierSent = null;
  if (toUser && options.notify !== false) {
    courierSent = sendMessage(
      {
        project,
        to: toUser,
        via: options.via,
        sessionId: options.sessionId,
        body: `[PR #${prNumber} ${verdict}] ${body}`,
      },
      file
    );
  }

  return {
    project,
    prNumber,
    verdict,
    frame: rec.frame,
    courierSent,
  };
}

function mergeGithubPr(projectInput, prNumberInput, options = {}, file = dbPath()) {
  const project = normalizeProject(projectInput);
  const prNumber = requireSeq(prNumberInput, 'PR number');
  const strategy = options.squash ? 'squash' : options.rebase ? 'rebase' : 'merge';

  const { repoDir, toUser, matchingSeqs, prTitle } = withDb((db) => {
    const meta = detectRepoGitMetaInDb(db, project, options.repoDir);
    const peer = resolveTeammateUserInDb(db, project, options.to);
    const prRef = `pr:#${prNumber}`;
    const openFrames = db
      .prepare('SELECT * FROM frames WHERE project = ? AND open = 1 ORDER BY seq ASC')
      .all(project)
      .map(hydrateFrame);
    const matches = openFrames.filter((f) => f.refs.includes(prRef));
    const title = matches[0]
      ? matches[0].summary.replace(/^\[PR #\d+\]\s*/, '').replace(/\s*\([^)]*\)\s*$/, '').trim()
      : '';
    return {
      repoDir: meta.repoDir,
      toUser: peer,
      matchingSeqs: matches.map((f) => f.seq),
      prTitle: options.title || title,
    };
  }, file);

  if (typeof options.mergePrFn === 'function') {
    options.mergePrFn({ project, prNumber, strategy, deleteBranch: Boolean(options.deleteBranch), repoDir });
  } else {
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository directory found for "${project}" to run "gh pr merge"`);
    }
    const ghArgs = ['pr', 'merge', String(prNumber), `--${strategy}`];
    if (options.deleteBranch) ghArgs.push('--delete-branch');
    execFileSync('gh', ghArgs, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  const prRef = `pr:#${prNumber}`;
  const shortRef = `#${prNumber}`;
  const summary = `Merged [PR #${prNumber}]${prTitle ? `: ${prTitle}` : ''}`;
  const rec = recordFrame(
    {
      project,
      kind: 'commit',
      summary,
      verified: options.verified || `Merged on GitHub (${prRef}, ${strategy})`,
      resolves: matchingSeqs,
      refs: [prRef, shortRef],
    },
    file
  );

  let courierSent = null;
  if (toUser && options.notify !== false) {
    courierSent = sendMessage(
      {
        project,
        to: toUser,
        via: options.via,
        sessionId: options.sessionId,
        body: `[PR #${prNumber} MERGED] ${summary} -- pulled into main and closed on the Construct tape!`,
      },
      file
    );
  }

  return {
    project,
    prNumber,
    strategy,
    resolvedSeqs: rec.resolved,
    frame: rec.frame,
    courierSent,
  };
}

// --- DID Identity, DIDComm v2 Invitations, MLS Group Ratchet & CRDT Sync ---

function getIdentity() {
  return crdt.loadOrCreateIdentity();
}

function ensureMlsGroupInDb(db, projectInput, options = {}) {
  const project = normalizeProject(projectInput);
  const existing = db.prepare('SELECT * FROM mls_groups WHERE project = ?').get(project);
  if (existing) return crdt.hydrateMlsGroup(existing);

  const identity = crdt.loadOrCreateIdentity();
  const user = protocol.getCurrentUserInDb(db);
  const groupId = crypto.randomBytes(16).toString('hex');
  const epochSecret = crypto.randomBytes(32).toString('base64');
  const relays = options.relays ? normalizeRefs(options.relays) : [...crdt.DEFAULT_RELAYS];
  const members = [
    {
      did: identity.did,
      userId: user?.id || protocol.detectOsUsername(),
      signPub: identity.signPub,
      dhPub: identity.dhPub,
    },
  ];
  const now = nowIso();

  db.prepare(
    `INSERT INTO mls_groups (project, group_id, epoch, epoch_secret, members, relays, last_sync_hlc, updated)
     VALUES (?, ?, 1, ?, ?, ?, '', ?)`
  ).run(project, groupId, epochSecret, JSON.stringify(members), JSON.stringify(relays), now);

  crdt.backfillProjectCrdtLogInDb(db, project);
  return crdt.hydrateMlsGroup(db.prepare('SELECT * FROM mls_groups WHERE project = ?').get(project));
}

function detectRepoGitMetaInDb(db, project, explicitRepoDir) {
  let repoDir = explicitRepoDir ? expandHome(explicitRepoDir) : '';
  if (!repoDir) {
    const candidate = defaultRepoPathInDb(db, project);
    if (candidate) repoDir = expandHome(candidate);
  }
  if (!repoDir || !fs.existsSync(repoDir)) return { gitUrl: '', branch: '', repoDir: '' };
  let gitUrl = '';
  let branch = '';
  try {
    gitUrl = execFileSync('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch (_) {}
  try {
    branch = execFileSync('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch (_) {}
  return { gitUrl, branch, repoDir };
}

function createInvite(projectInput, options = {}, file = dbPath()) {
  const project = normalizeProject(projectInput);
  if (project === 'global') {
    throw new Error('cannot create a project invite for "global" scope');
  }

  return withDb(
    (db) =>
      tx(db, () => {
        const detectedGit = detectRepoGitMetaInDb(db, project, options.repoDir);
        const repoMeta = {
          gitUrl: options.gitUrl !== undefined ? String(options.gitUrl).trim() : detectedGit.gitUrl,
          branch: options.branch !== undefined ? String(options.branch).trim() : detectedGit.branch,
          setupCommands: options.setup ? normalizeRefs(options.setup) : [],
        };
        const group = ensureMlsGroupInDb(db, project, options);
        const identity = crdt.loadOrCreateIdentity();
        const user = protocol.getCurrentUserInDb(db);
        const inviteUri = crdt.createDidCommInvite(group, identity, user, repoMeta);
        return {
          inviteUri,
          project: group.project,
          gitUrl: repoMeta.gitUrl,
          branch: repoMeta.branch,
          setupCommands: repoMeta.setupCommands,
          groupId: group.groupId,
          epoch: group.epoch,
          fromDid: identity.did,
        };
      }),
    file
  );
}

function validateGitCloneParams(gitUrl, branch = '') {
  const url = String(gitUrl || '').trim();
  const br = String(branch || '').trim();
  if (!url) return true;
  if (url.startsWith('-') || /^ext::/i.test(url) || /[\r\n\0]/.test(url)) {
    throw new Error(`unsafe gitUrl rejected by Construct security guard: "${url}"`);
  }
  if (br && (br.startsWith('-') || br.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(br))) {
    throw new Error(`unsafe git branch rejected by Construct security guard: "${br}"`);
  }
  return true;
}

function joinInvite(inviteUri, options = {}, file = dbPath()) {
  const invite = crdt.parseAndVerifyDidCommInvite(inviteUri);
  const b = invite.body;
  const project = normalizeProject(b.project);
  if (project === 'global') {
    throw new Error('refusing invite for "global" scope');
  }
  validateGitCloneParams(b.gitUrl, b.branch);

  const resolvedTargetDir = withDb((db) => {
    if (options.targetDir) return path.resolve(expandHome(options.targetDir));
    if (options.srcRoot) return path.join(expandHome(options.srcRoot), ...project.split('/'));
    const fromDb = defaultRepoPathInDb(db, project);
    if (fromDb) return path.resolve(expandHome(fromDb));
    return '';
  }, file);

  const targetDir = resolvedTargetDir;
  let cloned = false;
  let setupRan = false;

  if (!targetDir && b.gitUrl && options.clone !== false) {
    throw new Error(
      `no local target directory or workspace_root configured to clone "${project}" (${b.gitUrl}). Pass --dir <target_path> or set your workspace root via "construct user set <id> --workspace-root <dir>".`
    );
  }

  if (targetDir && !fs.existsSync(targetDir) && b.gitUrl && options.clone !== false) {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    const cloneArgs = ['clone'];
    if (b.branch) cloneArgs.push('--branch', b.branch);
    cloneArgs.push('--', b.gitUrl, targetDir);
    execFileSync('git', cloneArgs, {
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
    });
    cloned = true;
  }

  if (targetDir && fs.existsSync(targetDir) && Array.isArray(b.setupCommands) && b.setupCommands.length > 0 && options.runSetup) {
    for (const cmd of b.setupCommands) {
      execSync(cmd, { cwd: targetDir, stdio: 'pipe', windowsHide: true });
    }
    setupRan = true;
  }

  const res = withDb(
    (db) =>
      tx(db, () => {
        const identity = crdt.loadOrCreateIdentity();
        const user = protocol.getCurrentUserInDb(db);
        const selfMember = {
          did: identity.did,
          userId: user?.id || protocol.detectOsUsername(),
          signPub: identity.signPub,
          dhPub: identity.dhPub,
        };
        const members = [b.inviterMember];
        if (!members.some((m) => m.did === selfMember.did)) {
          members.push(selfMember);
        }
        const now = nowIso();

        db.prepare(
          `INSERT INTO mls_groups (project, group_id, epoch, epoch_secret, members, relays, last_sync_hlc, updated)
           VALUES (?, ?, ?, ?, ?, ?, '', ?)
           ON CONFLICT(project) DO UPDATE SET
             group_id = excluded.group_id,
             epoch = excluded.epoch,
             epoch_secret = excluded.epoch_secret,
             members = excluded.members,
             relays = excluded.relays,
             updated = excluded.updated`
        ).run(
          project,
          b.groupId,
          Number(b.epoch),
          b.epochSecret,
          JSON.stringify(members),
          JSON.stringify(b.relays || crdt.DEFAULT_RELAYS),
          now
        );

        if (targetDir) {
          db.prepare(
            `INSERT INTO heads (project, repo, state, next, updated)
             VALUES (?, ?, '', '', ?)
             ON CONFLICT(project) DO UPDATE SET repo = excluded.repo`
          ).run(project, targetDir, now);
        }

        crdt.backfillProjectCrdtLogInDb(db, project);
        return {
          group: crdt.hydrateMlsGroup(db.prepare('SELECT * FROM mls_groups WHERE project = ?').get(project)),
          inviter: {
            did: invite.from,
            userId: invite.fromUser,
            name: invite.fromName,
          },
          gitUrl: b.gitUrl || '',
          branch: b.branch || '',
          targetDir,
          cloned,
          setupRan,
        };
      }),
    file
  );

  let assimilated = null;
  if (targetDir && fs.existsSync(targetDir)) {
    const candidate = assimilateLdk(targetDir, { project }, file);
    if (candidate.found) assimilated = candidate;
  }

  return { ...res, assimilated };
}

function exportEncryptedPacket(projectInput, options = {}, file = dbPath()) {
  const project = normalizeProject(projectInput);
  if (project === 'global') {
    throw new Error('refusing to export "global" scope in a project packet (prevents cross-project bleed)');
  }
  return withDb(
    (db) =>
      tx(db, () => {
        const group = ensureMlsGroupInDb(db, project, options);
        crdt.backfillProjectCrdtLogInDb(db, project);
        const sinceHlc = options.sinceHlc || '';
        const rows = db
          .prepare('SELECT * FROM crdt_log WHERE project = ? AND hlc > ? ORDER BY hlc ASC')
          .all(project, sinceHlc);

        const identity = crdt.loadOrCreateIdentity();
        const rawOps = rows
          .filter((r) => !options.onlyLocal || r.author_did === identity.did)
          .map((r) => ({
            opId: r.op_id,
            hlc: r.hlc,
            project: r.project,
            authorDid: r.author_did,
            entity: r.entity,
            recordUid: r.record_uid,
            payload: JSON.parse(r.payload),
          }))
          .filter((op) => op.project === project && (op.entity !== 'gotcha' || op.payload.scope === project));

        // Deduplicate by `entity:recordUid`, keeping the latest HLC state for each record
        const dedupedByRecord = new Map();
        for (const op of rawOps) {
          dedupedByRecord.set(`${op.entity}:${op.recordUid}`, op);
        }
        const ops = [...dedupedByRecord.values()].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
        const envelope = crdt.sealMlsApplicationMessage(group, identity, {
          project,
          opCount: ops.length,
          ops,
        });

        // Also build relay-safe chunk envelopes (<= 16 KB raw ops JSON per chunk -> < 28 KB Nostr event)
        // so public NIP-01 relays with 64 KB frame ceilings accept large initial project syncs.
        // Sort chunk priority so `message` and `head` ops always ride in Chunk #0 (first frame on the wire),
        // followed by `gotcha` and `frame` ops in HLC order.
        const chunkOrderedOps = [...ops].sort((a, b) => {
          const prio = (e) => (e === 'message' ? 0 : e === 'head' ? 1 : 2);
          const pa = prio(a.entity);
          const pb = prio(b.entity);
          if (pa !== pb) return pa - pb;
          return a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0;
        });

        const MAX_CHUNK_JSON_BYTES = 16000;
        const envelopes = [];
        let currentChunk = [];
        let currentBytes = 0;
        for (const op of chunkOrderedOps) {
          const opBytes = JSON.stringify(op).length;
          if (currentChunk.length > 0 && currentBytes + opBytes > MAX_CHUNK_JSON_BYTES) {
            envelopes.push({
              maxHlc: currentChunk.reduce((m, x) => (x.hlc > m ? x.hlc : m), ''),
              envelope: crdt.sealMlsApplicationMessage(group, identity, {
                project,
                opCount: currentChunk.length,
                ops: currentChunk,
              }),
            });
            currentChunk = [];
            currentBytes = 0;
          }
          currentChunk.push(op);
          currentBytes += opBytes;
        }
        if (currentChunk.length > 0) {
          envelopes.push({
            maxHlc: currentChunk.reduce((m, x) => (x.hlc > m ? x.hlc : m), ''),
            envelope: crdt.sealMlsApplicationMessage(group, identity, {
              project,
              opCount: currentChunk.length,
              ops: currentChunk,
            }),
          });
        }

        return {
          envelope,
          envelopes,
          token: `construct://packet/${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}`,
          opCount: ops.length,
          maxHlc: ops.length ? ops[ops.length - 1].hlc : sinceHlc,
        };
      }),
    file
  );
}

function importEncryptedPacket(packetInput, file = dbPath()) {
  let envelope = packetInput;
  if (typeof packetInput === 'string') {
    const cleaned = packetInput.trim().replace(/^construct:\/\/packet\//, '');
    envelope = cleaned.startsWith('{')
      ? JSON.parse(cleaned)
      : JSON.parse(Buffer.from(cleaned, 'base64url').toString('utf8'));
  }

  return withDb(
    (db) =>
      tx(db, () => {
        const groupRow = db.prepare('SELECT * FROM mls_groups WHERE group_id = ?').get(envelope.groupId);
        if (!groupRow) {
          throw new Error(`unknown MLS group "${envelope.groupId}" (join the project invite first)`);
        }
        const group = crdt.hydrateMlsGroup(groupRow);
        const decrypted = crdt.openMlsApplicationMessage(group, envelope);

        // Pin newly joined peer's Ed25519 public key into `mls_groups.members` on first verified epoch proof
        if (!group.members.some((m) => m.did === envelope.senderDid)) {
          const updatedMembers = [
            ...group.members,
            {
              did: envelope.senderDid,
              userId: 'peer',
              signPub: envelope.senderSignPub,
              dhPub: '',
            },
          ];
          db.prepare('UPDATE mls_groups SET members = ?, updated = ? WHERE group_id = ?').run(
            JSON.stringify(updatedMembers),
            nowIso(),
            group.groupId
          );
        }

        // Enforce strict project scope boundary: only ops belonging to `group.project` can be applied
        const applied = crdt.applyCrdtOpsInDb(db, decrypted.ops || [], undefined, group.project);
        return {
          project: group.project,
          senderDid: envelope.senderDid,
          epoch: envelope.epoch,
          totalOps: (decrypted.ops || []).length,
          appliedOps: applied,
        };
      }),
    file
  );
}

async function syncProject(projectInput, options = {}, file = dbPath()) {
  let project = normalizeProject(projectInput);
  const group = withDb((db) => {
    let row = db.prepare('SELECT * FROM mls_groups WHERE project = ?').get(project);
    if (!row && project.includes('/')) {
      const repoBase = project.split('/').pop().toLowerCase();
      const allGroups = db.prepare('SELECT * FROM mls_groups').all();
      row = allGroups.find((g) => String(g.project || '').toLowerCase().split('/').pop() === repoBase) || null;
      if (row) project = row.project;
    }
    if (!row) throw new Error(`project "${project}" has no MLS group yet (run "construct invite ${project}" or "construct join <uri>" first)`);
    return crdt.hydrateMlsGroup(row);
  }, file);

  const relays = options.relays ? normalizeRefs(options.relays) : group.relays;
  const { routeTag } = crdt.deriveEpochKeys(group.epochSecret, group.groupId, group.epoch);

  // 1. Pull and merge remote MLS envelopes from relays
  const fetched = await relay.fetchEnvelopesFromRelays(relays, routeTag, options.timeoutMs || 4000);
  let mergedOps = 0;
  let packetsProcessed = 0;

  for (const env of fetched.envelopes) {
    try {
      const res = importEncryptedPacket(env, file);
      mergedOps += res.appliedOps;
      packetsProcessed++;
    } catch (_) {
      // Ignore invalid/foreign packets on the public tag
    }
  }

  // 2. Export and push local CRDT delta since `group.lastSyncHlc` to relays (chunked for <28KB NIP-01 relay limits)
  const exported = exportEncryptedPacket(
    project,
    { relays, sinceHlc: options.full ? '' : group.lastSyncHlc || '', onlyLocal: true },
    file
  );
  let pushedOk = 0;
  if (exported.opCount > 0) {
    const rawEnvs = Array.isArray(exported.envelopes) && exported.envelopes.length
      ? exported.envelopes.map((c) => c.envelope)
      : [exported.envelope];
    const pubRes = await relay.publishEnvelopesToRelays(relays, routeTag, rawEnvs, options.timeoutMs || 8000);
    pushedOk = pubRes.results.filter((r) => r.ok).length;
    if (pushedOk > 0 && exported.maxHlc) {
      withDb((db) => {
        db.prepare('UPDATE mls_groups SET last_sync_hlc = ?, updated = ? WHERE project = ?').run(
          exported.maxHlc,
          nowIso(),
          project
        );
      }, file);
    }
  }

  return {
    project,
    groupId: group.groupId,
    epoch: group.epoch,
    relays,
    packetsFetched: packetsProcessed,
    mergedOps,
    pushedOps: exported.opCount,
    relaysAcked: pushedOk,
  };
}

function recordAssimilatedFiles(projectInput, files = [], file = dbPath()) {
  const project = normalizeProject(projectInput);
  return withDb(
    (db) =>
      tx(db, () => {
        const now = nowIso();
        const stmt = db.prepare(
          `INSERT INTO assimilated_files (project, rel_path, abs_path, sha256, updated)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project, rel_path) DO UPDATE SET
             abs_path = excluded.abs_path,
             sha256 = excluded.sha256,
             updated = excluded.updated`
        );
        for (const f of files) {
          if (!f.relPath || !f.absPath || !f.sha256) continue;
          stmt.run(project, f.relPath, f.absPath, f.sha256, now);
        }
      }),
    file
  );
}

function assimilateLdk(targetDir, options = {}, file = dbPath()) {
  const facade = {
    normalizeProject,
    resolveProjectFromDir: (dir) => resolveProjectFromDir(dir, file),
    listUsers: () => listUsers(file),
    setUser: (id, fields) => setUser(id, fields, file),
    listGotchas: (scope) => listGotchas(scope, file),
    addGotcha: (fields) => addGotcha(fields, file),
    removeGotcha: (id) => removeGotcha(id, file),
    recordFrame: (fields) => recordFrame(fields, file),
    recordAssimilatedFiles: (proj, tracked) => recordAssimilatedFiles(proj, tracked, file),
  };
  return assimilateMod.assimilateDirectory(facade, targetDir, options);
}

// One-command plug-and-play setup for any new user (`construct init [--rom <name>] [--dir <opencode_config_dir>]`):
//   1. Generates DID identity + initializes `construct.db`
//   2. Selects initial ROM (if `--rom` given)
//   3. Auto-discovers and assimilates any existing global `AGENTS.md` / `CLAUDE.md`
//   4. Installs `~/.config/opencode/plugins/construct.js`
//   5. Ensures `~/.config/opencode/active-rom.md` is in `~/.config/opencode/opencode.jsonc` instructions
//   6. Compiles `active-rom.md` (with New Operator Onboarding active if no user agreement exists yet)
function installPluginFile(configDir = path.join(os.homedir(), '.config', 'opencode')) {
  const pluginSrcDir = path.join(__dirname, '..', 'plugin');
  const pluginSrc = path.join(pluginSrcDir, 'construct.js');
  const pluginDestDir = path.join(configDir, 'plugins');
  const pluginDest = path.join(pluginDestDir, 'construct.js');
  const binPath = path.resolve(__dirname, '..', 'bin', 'construct.js').replace(/\\/g, '/');

  if (fs.existsSync(pluginSrc)) {
    fs.mkdirSync(pluginDestDir, { recursive: true });
    const content = fs.readFileSync(pluginSrc, 'utf8').replace('__CONSTRUCT_BIN_PATH__', binPath);
    fs.writeFileSync(pluginDest, content, 'utf8');
  }

  // Install the TUI HUD plugin (`tui.tsx`) alongside `construct.js` and remove any legacy `rpc.js`
  // so OpenCode's server plugin scanner only sees valid plugin entrypoints.
  const legacyRpcDest = path.join(pluginDestDir, 'rpc.js');
  if (fs.existsSync(legacyRpcDest)) {
    try {
      fs.unlinkSync(legacyRpcDest);
    } catch (_) {}
  }
  const tuiSrc = path.join(pluginSrcDir, 'tui.tsx');
  if (fs.existsSync(tuiSrc)) {
    fs.copyFileSync(tuiSrc, path.join(pluginDestDir, 'tui.tsx'));
  }
  return pluginDest;
}

function initConstruct(options = {}, file = dbPath()) {
  const configDir = options.configDir || path.join(os.homedir(), '.config', 'opencode');
  fs.mkdirSync(configDir, { recursive: true });

  const identity = crdt.loadOrCreateIdentity();
  if (options.rom) {
    useRom(options.rom, file);
  }

  const assimilated = [];
  const candidateGlobalDirs = [configDir, path.join(os.homedir(), '.claude')];
  for (const dir of candidateGlobalDirs) {
    if (fs.existsSync(dir)) {
      const res = assimilateLdk(dir, { project: 'global', rewriteAgents: false }, file);
      if (res.found) assimilated.push(res);
    }
  }

  // Install OpenCode V2 plugin with the actual resolved path to `bin/construct.js`
  const pluginDest = installPluginFile(configDir);

  // Ensure `~/.config/opencode/active-rom.md` is present in `opencode.jsonc`
  const jsoncPath = path.join(configDir, 'opencode.jsonc');
  if (!fs.existsSync(jsoncPath)) {
    const initialConfig = {
      $schema: 'https://opencode.ai/config.json',
      default_agent: 'build',
      instructions: ['~/.config/opencode/active-rom.md'],
    };
    fs.writeFileSync(jsoncPath, JSON.stringify(initialConfig, null, 2) + '\n', 'utf8');
  } else {
    const raw = fs.readFileSync(jsoncPath, 'utf8');
    if (!raw.includes('active-rom.md')) {
      try {
        const parsed = JSON.parse(raw);
        parsed.instructions = Array.isArray(parsed.instructions) ? parsed.instructions : [];
        parsed.instructions.unshift('~/.config/opencode/active-rom.md');
        fs.writeFileSync(jsoncPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      } catch (_) {}
    }
  }

  const syncRes = syncRom(file);

  // Optional Claude Code configuration (`construct init --claude`)
  let claudeConfigured = false;
  let claudeMdPath = '';
  let claudeSettingsPath = '';
  let claudeAgentsDir = '';
  let claudeAgentsCount = 0;
  if (options.claude) {
    const claudeDir = options.claudeDir || path.join(os.homedir(), '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
    fs.copyFileSync(syncRes.path, claudeMdPath);

    const subRes = withDb((db) => writeClaudeSubagentsInDb(db, claudeDir), file);
    claudeAgentsDir = subRes.agentsDir;
    claudeAgentsCount = subRes.count;

    claudeSettingsPath = path.join(claudeDir, 'settings.json');
    let settings = {};
    if (fs.existsSync(claudeSettingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
      } catch (_) {
        settings = {};
      }
    }
    const binPath = path.resolve(__dirname, '..', 'bin', 'construct.js').replace(/\\/g, '/');
    settings.mcpServers = settings.mcpServers || {};
    settings.mcpServers.construct = {
      command: 'node',
      args: [binPath, 'mcp'],
    };
    settings.hooks = settings.hooks || {};
    settings.hooks.SessionStart = [
      {
        hooks: [{ type: 'command', command: `node "${binPath}" claude-hook context` }],
      },
    ];
    settings.hooks.UserPromptSubmit = [
      {
        hooks: [{ type: 'command', command: `node "${binPath}" claude-hook context` }],
      },
    ];
    settings.hooks.SubagentStart = [
      {
        hooks: [{ type: 'command', command: `node "${binPath}" claude-hook subagent-start` }],
      },
    ];
    settings.hooks.PreToolUse = [
      {
        matcher: 'Bash|PowerShell|Agent|Task',
        hooks: [{ type: 'command', command: `node "${binPath}" claude-hook pre-tool` }],
      },
    ];
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    claudeConfigured = true;
  }

  return {
    did: identity.did,
    rom: syncRes.rom.name,
    user: syncRes.user ? syncRes.user.id : null,
    detectedLogin: syncRes.detectedLogin,
    onboardingRequired: !syncRes.user,
    pluginPath: pluginDest,
    romFilePath: syncRes.path,
    claudeConfigured,
    claudeMdPath,
    claudeSettingsPath,
    claudeAgentsDir,
    claudeAgentsCount,
    assimilated,
  };
}

function getCachedConstructUpstreamInDb(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'construct_upstream'").get();
    if (row && row.value) {
      return JSON.parse(row.value);
    }
  } catch (_) {}
  return { behindCount: 0, localSha: '', remoteSha: '', commits: [], checkedAt: '' };
}

function setCachedConstructUpstreamInDb(db, statusObj) {
  const now = nowIso();
  const payload = {
    behindCount: Number(statusObj?.behindCount || 0),
    localSha: String(statusObj?.localSha || ''),
    remoteSha: String(statusObj?.remoteSha || ''),
    commits: Array.isArray(statusObj?.commits) ? statusObj.commits : [],
    checkedAt: statusObj?.checkedAt || now,
  };
  db.prepare(
    `INSERT INTO meta (key, value, updated)
     VALUES ('construct_upstream', ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated = excluded.updated`
  ).run(JSON.stringify(payload), now);
  return payload;
}

function checkConstructUpstream(options = {}, file = dbPath()) {
  const repoDir = options.repoDir || path.resolve(__dirname, '..');
  const throttleMs = Number(options.throttleMs ?? 15 * 60 * 1000);

  if (!options.force) {
    const cached = withDb((db) => getCachedConstructUpstreamInDb(db), file);
    const lastTs = Date.parse(cached?.checkedAt || '') || 0;
    if (Date.now() - lastTs < throttleMs) {
      return cached;
    }
  }

  const execGit =
    options.execGitFn ||
    ((args) =>
      execFileSync('git', ['-C', repoDir, ...args], {
        encoding: 'utf8',
        timeout: 6000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim());

  let localSha = '';
  let remoteSha = '';
  let behindCount = 0;
  let commits = [];

  try {
    if (options.fetch !== false) {
      try {
        execGit(['fetch', 'origin', 'main', '--quiet']);
      } catch (_) {}
    }
    localSha = execGit(['rev-parse', '--short', 'HEAD']);
    remoteSha = execGit(['rev-parse', '--short', 'origin/main']);
    behindCount = Number(execGit(['rev-list', '--count', 'HEAD..origin/main']) || 0);
    if (behindCount > 0) {
      const logOut = execGit(['log', '--oneline', '-n', '5', 'HEAD..origin/main']);
      commits = logOut ? logOut.split(/\r?\n/).filter(Boolean) : [];
    }
  } catch (_) {}

  const statusObj = {
    behindCount,
    localSha,
    remoteSha,
    commits,
    checkedAt: nowIso(),
  };

  return withDb((db) => tx(db, () => setCachedConstructUpstreamInDb(db, statusObj)), file);
}

function upgradeConstruct(options = {}, file = dbPath()) {
  const repoDir = options.repoDir || path.resolve(__dirname, '..');
  const configDir = options.configDir || path.join(os.homedir(), '.config', 'opencode');
  const execGit =
    options.execGitFn ||
    ((args) =>
      execFileSync('git', ['-C', repoDir, ...args], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      }).trim());

  let previousSha = '';
  try {
    previousSha = execGit(['rev-parse', '--short', 'HEAD']);
  } catch (_) {}

  const pullOutput = execGit(['pull', '--ff-only', 'origin', 'main']);

  let currentSha = previousSha;
  try {
    currentSha = execGit(['rev-parse', '--short', 'HEAD']);
  } catch (_) {}

  // Reseed built-in ROMs, recompile active-rom.md, and reinstall OpenCode plugin files
  const syncRes = withDb((db) => {
    romMod.reseedBuiltInRoms(db);
    setCachedConstructUpstreamInDb(db, {
      behindCount: 0,
      localSha: currentSha,
      remoteSha: currentSha,
      commits: [],
      checkedAt: nowIso(),
    });
    return syncActiveRomInDb(db);
  }, file);

  const pluginPath = installPluginFile(configDir);

  return {
    upgraded: previousSha !== currentSha || Boolean(pullOutput),
    previousSha,
    currentSha,
    pullOutput,
    romFile: syncRes.path,
    pluginPath,
  };
}

module.exports = {
  KINDS,
  DEFAULT_DB,
  DIAL_KEYS: romMod.DIAL_KEYS,
  activeRomPath: romMod.activeRomPath,
  compileRomPersonaOnly: romMod.compileRomPersonaOnly,
  compileUnassignedBootloaderPrompt: romMod.compileUnassignedBootloaderPrompt,
  compileBaseProtocolMarkdown: romMod.compileBaseProtocolMarkdown,
  compileRomMarkdown: romMod.compileRomMarkdown,
  writeActiveRomFile: romMod.writeActiveRomFile,
  dbPath,
  normalizeProject,
  validateKind,
  recordFrame,
  editFrame,
  resolveFrames,
  reopenFrame,
  setHead,
  listProjects,
  getTape,
  bootProject,
  zoomFrame,
  searchFrames,
  listRoms,
  listPacks,
  getRom,
  useRom,
  subRom,
  enqueuePendingSubagentRom,
  consumePendingSubagentRom,
  setDefaultRom,
  tuneRom,
  setRom,
  cloneRom,
  burnDirective,
  unburnDirective,
  syncRom,
  listUsers,
  getUser,
  setUser,
  useUser,
  listGotchas,
  addGotcha,
  checkDynamicGotchaGuards,
  searchGotchas,
  removeGotcha,
  sendMessage,
  replyMessage,
  ackMessage,
  listMessages,
  dropPatch,
  applyDrop,
  whyTarget,
  syncGithubIssues,
  publishThreadToGithub,
  syncGithubPrs,
  openGithubPr,
  reviewGithubPr,
  mergeGithubPr,
  getHudSnapshot,
  generateDashboardHtml,
  startStandaloneHudServer,
  checkConstructUpstream,
  upgradeConstruct,
  ackMessage,
  listMessages,
  dropPatch,
  applyDrop,
  whyTarget,
  getHudSnapshot,
  generateDashboardHtml,
  syncGithubIssues,
  publishThreadToGithub,
  getIdentity,
  createInvite,
  joinInvite,
  validateGitCloneParams,
  exportEncryptedPacket,
  importEncryptedPacket,
  syncProject,
  assimilateLdk,
  installPluginFile,
  initConstruct,
  resolveProjectFromDir,
  startLocalRelayServer: relay.startLocalRelayServer,
  closeAllDbs,
};
