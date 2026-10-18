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
const { execFileSync, execSync } = require('node:child_process');
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
  return p.replace(/^~\/[^/]+\//, (m) => (m.toLowerCase() === '~/src/' ? '' : m)).replace(/^\/+|\/+$/g, '');
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
      project TEXT PRIMARY KEY,
      repo    TEXT NOT NULL DEFAULT '',
      state   TEXT NOT NULL DEFAULT '',
      next    TEXT NOT NULL DEFAULT '',
      updated TEXT NOT NULL
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
  `);

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
    const rel = targetDir
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .slice(expandHome(wsRoot).replace(/\\/g, '/').replace(/\/+$/, '').length + 1);
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

function getActiveRomInDb(db, sessionId) {
  const sid = sessionId || process.env.CONSTRUCT_SESSION_ID || '';
  if (sid) {
    const sessRow = db.prepare('SELECT rom_name FROM session_roms WHERE session_id = ?').get(sid);
    if (sessRow && sessRow.rom_name) {
      return getRomInDb(db, sessRow.rom_name);
    }
    const defaultRom = getDefaultRomNameInDb(db);
    if (defaultRom) {
      return getRomInDb(db, defaultRom);
    }
    return getRomInDb(db, 'razor');
  }
  const defaultRom = getDefaultRomNameInDb(db);
  if (defaultRom) {
    return getRomInDb(db, defaultRom);
  }
  const row =
    db.prepare("SELECT * FROM roms WHERE name = 'razor' LIMIT 1").get() ||
    db.prepare('SELECT * FROM roms ORDER BY name ASC LIMIT 1').get();
  return romMod.hydrateRom(row);
}

function isSessionRomSlottedInDb(db, sessionId) {
  const sid = sessionId || process.env.CONSTRUCT_SESSION_ID || '';
  if (!sid) return true;
  const sessRow = db.prepare('SELECT rom_name FROM session_roms WHERE session_id = ?').get(sid);
  if (sessRow && sessRow.rom_name) return true;
  const defaultRom = getDefaultRomNameInDb(db);
  return Boolean(defaultRom);
}

function resolveSingleRomRowInDb(db, name) {
  const key = String(name || '').trim().toLowerCase();
  const aliasMap = {
    architect: 'wintermute',
    raz: 'erasmus',
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

        return {
          resolved: ids.map((id) => getFrameInDb(db, id)),
          byFrame: createdFrame || (bySeq ? getFrameInDb(db, bySeq) : null),
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
    const rom = getActiveRomInDb(db, sessionId);
    const romSlotted = isSessionRomSlottedInDb(db, sessionId);
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
    const inboxPending = db
      .prepare(
        "SELECT * FROM messages WHERE to_user = ? AND status = 'pending' AND (project = ? OR project = 'global') ORDER BY hlc ASC"
      )
      .all(activeUserId, project)
      .map(crdt.hydrateMessage);

    const inboxReplies = db
      .prepare(
        "SELECT * FROM messages WHERE from_user = ? AND status = 'replied' AND (project = ? OR project = 'global') ORDER BY reply_hlc ASC"
      )
      .all(activeUserId, project)
      .map(crdt.hydrateMessage);

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

    return {
      rom,
      romSlotted,
      sessionId: sessionId || null,
      sessionRomPrompt,
      allRoms,
      user,
      detectedLogin,
      head,
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
  const actualFile = typeof options === 'string' ? options : file;
  return withDb((db) => (name ? getRomInDb(db, name) : getActiveRomInDb(db, sid)), actualFile);
}

function subRom(backupName, options = {}, file = dbPath()) {
  if (!backupName || !String(backupName).trim()) {
    throw new Error('give a backup ROM name to substitute into its seat, e.g. construct rom sub marly');
  }
  const sid = (typeof options === 'string' ? '' : options?.sessionId) || process.env.CONSTRUCT_SESSION_ID || '';
  const actualFile = typeof options === 'string' ? options : file;

  const newSpec = withDb((db) => {
    const subRow = resolveSingleRomRowInDb(db, backupName);
    if (!subRow) throw new Error(`unknown ROM "${backupName}"`);
    const subHydrated = romMod.hydrateRom(subRow);

    const current = getActiveRomInDb(db, sid);
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

  return useRom(newSpec, { sessionId: sid }, actualFile);
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
  const actualFile = typeof options === 'string' ? options : file;

  return withDb(
    (db) =>
      tx(db, () => {
        const target = getRomInDb(db, key);
        const now = nowIso();
        if (sid) {
          db.prepare(
            `INSERT INTO session_roms (session_id, rom_name, updated)
             VALUES (?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               rom_name = excluded.rom_name,
               updated = excluded.updated`
          ).run(sid, target.name, now);
          return { ...target, active: true, sessionId: sid };
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
  const created = fields.created ? String(fields.created).trim() : nowIso().slice(0, 10);

  return withDb(
    (db) =>
      tx(db, () => {
        const identity = crdt.loadOrCreateIdentity();
        const uid = fields.uid || `gotcha-${scope}-${crypto.randomUUID()}`;
        const hlc = crdt.nextHlc(identity.did);

        const info = db
          .prepare(
            'INSERT INTO gotchas (uid, hlc, scope, title, status, tags, evidence, fix, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .run(uid, hlc, scope, title, status, JSON.stringify(tags), evidence, fix, created);
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

// --- Construct-to-Construct Comms (Molly <-> Dixie) ---

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
        const rom = getActiveRomInDb(db);
        const user = protocol.getCurrentUserInDb(db);
        const fromUser = fields.fromUser
          ? String(fields.fromUser).trim().toLowerCase()
          : user?.id || protocol.detectOsUsername();
        const fromRom = fields.fromRom ? String(fields.fromRom).trim().toLowerCase() : rom?.name || 'dixie';
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

function replyMessage(idOrUid, replyBodyInput, file = dbPath()) {
  const replyBody = String(replyBodyInput || '').trim();
  if (!replyBody) throw new Error('reply text cannot be empty');

  return withDb(
    (db) =>
      tx(db, () => {
        const key = String(idOrUid || '').replace(/^[#M]+/i, '').trim();
        const row = /^\d+$/.test(key)
          ? db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(key))
          : db.prepare('SELECT * FROM messages WHERE uid = ?').get(key);
        if (!row) throw new Error(`no construct message matching "${idOrUid}"`);

        const identity = crdt.loadOrCreateIdentity();
        const rom = getActiveRomInDb(db);
        const replyRom = rom?.name || 'dixie';
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

function joinInvite(inviteUri, options = {}, file = dbPath()) {
  const invite = crdt.parseAndVerifyDidCommInvite(inviteUri);
  const b = invite.body;
  const project = normalizeProject(b.project);
  if (project === 'global') {
    throw new Error('refusing invite for "global" scope');
  }

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
    cloneArgs.push(b.gitUrl, targetDir);
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
  if (targetDir && fs.existsSync(path.join(targetDir, 'docs', 'dev'))) {
    assimilated = assimilateLdk(targetDir, { project }, file);
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

        const ops = rows
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

        const identity = crdt.loadOrCreateIdentity();
        const envelope = crdt.sealMlsApplicationMessage(group, identity, {
          project,
          opCount: ops.length,
          ops,
        });

        return {
          envelope,
          token: `construct://packet/${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}`,
          opCount: ops.length,
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
  const project = normalizeProject(projectInput);
  const group = withDb((db) => {
    const row = db.prepare('SELECT * FROM mls_groups WHERE project = ?').get(project);
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

  // 2. Export and push local CRDT state to relays
  const exported = exportEncryptedPacket(project, { relays }, file);
  let pushedOk = 0;
  if (exported.opCount > 0) {
    const pubRes = await relay.publishEnvelopeToRelays(relays, routeTag, exported.envelope, options.timeoutMs || 4000);
    pushedOk = pubRes.results.filter((r) => r.ok).length;
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
    listUsers: () => listUsers(file),
    setUser: (id, fields) => setUser(id, fields, file),
    listGotchas: (scope) => listGotchas(scope, file),
    addGotcha: (fields) => addGotcha(fields, file),
    recordFrame: (fields) => recordFrame(fields, file),
    recordAssimilatedFiles: (proj, tracked) => recordAssimilatedFiles(proj, tracked, file),
  };
  return assimilateMod.assimilateDirectory(facade, targetDir, options);
}

// One-command plug-and-play setup for any new user (`construct init [--rom <name>] [--dir <opencode_config_dir>]`):
//   1. Generates DID identity + initializes `construct.db`
//   2. Selects initial ROM (if `--rom` given)
//   3. Auto-discovers and eats any existing global `llm-dev-kit` (`~/.config/opencode/llm-dev-kit` or `~/.claude/llm-dev-kit`)
//   4. Installs `~/.config/opencode/plugins/construct.js`
//   5. Ensures `~/.config/opencode/active-rom.md` is in `~/.config/opencode/opencode.jsonc` instructions
//   6. Compiles `active-rom.md` (with New Operator Onboarding active if no user agreement exists yet)
function installPluginFile(configDir = path.join(os.homedir(), '.config', 'opencode')) {
  const pluginSrc = path.join(__dirname, '..', 'plugin', 'construct.js');
  const pluginDestDir = path.join(configDir, 'plugins');
  const pluginDest = path.join(pluginDestDir, 'construct.js');
  if (fs.existsSync(pluginSrc)) {
    fs.mkdirSync(pluginDestDir, { recursive: true });
    const binPath = path.resolve(__dirname, '..', 'bin', 'construct.js');
    const content = fs
      .readFileSync(pluginSrc, 'utf8')
      .replace('__CONSTRUCT_BIN_PATH__', binPath.replace(/\\/g, '/'));
    fs.writeFileSync(pluginDest, content, 'utf8');
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
  const candidateLdkDirs = [
    path.join(configDir, 'llm-dev-kit'),
    path.join(os.homedir(), '.claude', 'llm-dev-kit'),
  ];
  for (const dir of candidateLdkDirs) {
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
  searchGotchas,
  removeGotcha,
  sendMessage,
  replyMessage,
  ackMessage,
  listMessages,
  getIdentity,
  createInvite,
  joinInvite,
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
