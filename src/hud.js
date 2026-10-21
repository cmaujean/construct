'use strict';
// Construct HUD Snapshot, Interactive HTML Dashboard & Loopback Control Server (127.0.0.1:47420).

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function createHudModule(deps) {
  const {
    dbPath,
    withDb,
    tx,
    nowIso,
    expandHome,
    normalizeProject,
    hydrateFrame,
    resolveProjectFromDirInDb,
    resolveProjectFromDir,
    getRomInDb,
    getActiveRomInDb,
    isSessionRomSlottedInDb,
    getHeadInDb,
    defaultRepoPathInDb,
    buildCourierProfileInDb,
    resolveCourierRomNameInDb,
    getCachedConstructUpstreamInDb,
    listProjects,
    bootProject,
    useRom,
    subRom,
    setDefaultRom,
    ackMessage,
    hideMessage,
    purgeMessage,
    deleteMessage,
    sendMessage,
    replyMessage,
    syncProject,
    upgradeConstruct,
    crdt,
    romMod,
    protocol,
    siteMod,
  } = deps;

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
  laundry: '🐙',
  tolkien: '💍',
  discworld: '🐢',
  reamde: '🏔️',
  irondruid: '🐺',
  prydain: '⚔️',
  clockwork: '🥛',
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

function getLastCliOutputInDb(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'last_cli_output'").get();
    if (row && row.value) {
      return JSON.parse(row.value);
    }
  } catch (_) {}
  return null;
}

function setLastCliOutput(payload, file = dbPath()) {
  const now = typeof nowIso === 'function' ? nowIso() : new Date().toISOString();
  const obj = {
    cmd: String(payload?.cmd || ''),
    output: String(payload?.output || ''),
    isError: Boolean(payload?.isError),
    ts: payload?.ts || now,
  };
  return withDb((db) => {
    db.prepare(
      `INSERT INTO meta (key, value, updated)
       VALUES ('last_cli_output', ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated = excluded.updated`
    ).run(JSON.stringify(obj), now);
    return obj;
  }, file);
}

function clearLastCliOutput(file = dbPath()) {
  return withDb((db) => {
    db.prepare("DELETE FROM meta WHERE key = 'last_cli_output'").run();
    return true;
  }, file);
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

    const rawMsgRows = db
      .prepare("SELECT * FROM messages WHERE status != 'hidden' ORDER BY id DESC LIMIT 40")
      .all()
      .map(crdt.hydrateMessage);
    const seenCommsFingerprints = new Set();
    const msgRows = [];
    for (const m of rawMsgRows) {
      const fp = `${m.fromUser}:${m.fromRom}:${m.body}`;
      if (seenCommsFingerprints.has(fp)) continue;
      seenCommsFingerprints.add(fp);
      msgRows.push(m);
      if (msgRows.length >= 25) break;
    }

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
    const lastCliOutput = getLastCliOutputInDb(db);

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
      lastCliOutput,
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
                ? `<input type="text" class="reply-input" id="reply-input-${m.id}" data-msg-id="${m.id}" placeholder="Type reply to ${escapeHtml(m.fromUser)}..." onkeydown="handleReplyKey(event,this)" />
                   <button class="crew-btn active" id="reply-btn-${m.id}" onclick="replyCourier(${m.id},'reply-input-${m.id}',this)">⚡ Send Reply</button>`
                : ''
            }
            <button class="crew-btn" onclick="ackCourier(${m.id},this)">✓ Ack / Dismiss</button>
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
      const actionsBlock = `<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
               ${
                 m.status === 'pending'
                   ? `<input type="text" class="reply-input" id="row-reply-${m.id}" data-msg-id="${m.id}" placeholder="Reply..." onkeydown="handleReplyKey(event,this)" />
                      <button class="crew-btn" id="row-reply-btn-${m.id}" onclick="replyCourier(${m.id},'row-reply-${m.id}',this)">⚡ Reply</button>`
                   : ''
               }
               ${m.status !== 'delivered' ? `<button class="crew-btn" onclick="ackCourier(${m.id},this)">✓ Ack</button>` : ''}
               <button class="crew-btn" title="Hide message M#${m.id} (kept in archive)" onclick="deleteCourier(${m.id},this)">👁️ Hide</button>
             </div>`;
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
  table { width: 100%; border-collapse: collapse; background: var(--panel); }
  .table-scroll { max-height: 240px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); }
  th, td { text-align: left; padding: 9px 11px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; background: #0f131b; position: sticky; top: 0; z-index: 1; }
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

  <div class="control-deck" id="hud-cli-drawer" style="margin-bottom:14px;">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        <strong>CONSTRUCT CLI CONSOLE</strong>
        <code id="hud-cli-cmd-label" style="font-size:11.5px;">${escapeHtml(hud.lastCliOutput?.cmd || '')}</code>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <input type="text" class="reply-input" id="hud-cli-input" style="width:260px;" placeholder="Command (e.g. help, help tape, tape -n 10)..." onkeydown="handleCliKey(event,this)" />
        <button class="crew-btn active" onclick="runHudCliFromInput()">▶ Run</button>
        <button class="crew-btn" data-cli="help" onclick="runHudCliButton(this)">📖 Help</button>
        <button class="crew-btn" data-cli="tape -n 12" onclick="runHudCliButton(this)">📼 Tape</button>
        <button class="crew-btn" data-cli="projects" onclick="runHudCliButton(this)">🗂️ Projects</button>
        <button class="crew-btn" id="hud-cli-clear-btn" style="display:${hud.lastCliOutput?.output ? 'inline-block' : 'none'};" onclick="clearHudCli()">✕ Clear</button>
      </div>
    </div>
    <pre id="hud-cli-output" style="display:${hud.lastCliOutput?.output ? 'block' : 'none'};margin:8px 0 0 0;padding:10px 12px;background:#090c10;border:1px solid var(--border);border-radius:6px;color:#e6edf3;font-size:11.5px;line-height:1.45;overflow-x:auto;max-height:440px;overflow-y:auto;">${escapeHtml(hud.lastCliOutput?.output || '')}</pre>
  </div>

  <div class="roster-bar">
    <strong style="margin-right:6px;">ACTIVE 9-SEAT CREW (<span id="active-rom-name">${escapeHtml(hud.romName.toUpperCase())}</span>):</strong>
    <span id="roster-pills">${rosterPills}</span>
  </div>

  <div class="control-deck">
    <div>
      <strong>INTERACTIVE CREW SWITCHER &amp; BENCH DECK</strong>
      <span class="sub" style="margin-left:8px;">(Project: <code id="target-scope-label">${escapeHtml(hud.project)}</code>)</span>
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
      <button class="crew-btn ${hud.pack === 'laundry' ? 'active' : ''}" data-pack="laundry" onclick="switchCrew('use','laundry')">🐙 Laundry</button>
      <button class="crew-btn ${hud.pack === 'tolkien' ? 'active' : ''}" data-pack="tolkien" onclick="switchCrew('use','tolkien')">💍 Tolkien</button>
      <button class="crew-btn ${hud.pack === 'discworld' ? 'active' : ''}" data-pack="discworld" onclick="switchCrew('use','discworld')">🐢 Discworld</button>
      <button class="crew-btn ${hud.pack === 'reamde' ? 'active' : ''}" data-pack="reamde" onclick="switchCrew('use','reamde')">🏔️ REAMDE</button>
      <button class="crew-btn ${hud.pack === 'irondruid' ? 'active' : ''}" data-pack="irondruid" onclick="switchCrew('use','irondruid')">🐺 Iron Druid</button>
      <button class="crew-btn ${hud.pack === 'prydain' ? 'active' : ''}" data-pack="prydain" onclick="switchCrew('use','prydain')">⚔️ Prydain</button>
      <button class="crew-btn ${hud.pack === 'clockwork' ? 'active' : ''}" data-pack="clockwork" onclick="switchCrew('use','clockwork')">🥛 Clockwork</button>
      <button class="crew-btn ${hud.pack === 'generic' ? 'active' : ''}" data-pack="generic" onclick="switchCrew('use','generic')">⚙️ Generic</button>
    </div>
    <div class="btn-row" style="margin-top:8px;">
      <span class="sub" style="align-self:center;margin-right:4px;">Bench Sub:</span>
      <button class="crew-btn" data-sub="weatherwax" onclick="switchCrew('sub','weatherwax')">🟣 Granny Weatherwax</button>
      <button class="crew-btn" data-sub="angua" onclick="switchCrew('sub','angua')">🟠 Angua</button>
      <button class="crew-btn" data-sub="death" onclick="switchCrew('sub','death')">🛡️ DEATH</button>
      <button class="crew-btn" data-sub="wallace" onclick="switchCrew('sub','wallace')">🟣 Wallace (T'Rain)</button>
      <button class="crew-btn" data-sub="coyote" onclick="switchCrew('sub','coyote')">🛡️ Coyote</button>
      <button class="crew-btn" data-sub="hevydd" onclick="switchCrew('sub','hevydd')">🔴 Hevydd (Smith)</button>
      <button class="crew-btn" data-sub="kaw" onclick="switchCrew('sub','kaw')">⚡ Kaw (Crow)</button>
      <button class="crew-btn" data-sub="minister" onclick="switchCrew('sub','minister')">🟣 Minister (Interior)</button>
      <button class="crew-btn" data-sub="catlady" onclick="switchCrew('sub','catlady')">🛡️ Cat Lady</button>
      <button class="crew-btn" data-sub="toot" onclick="switchCrew('sub','toot')">⚡ Toot-Toot (Za-Lord)</button>
      <button class="crew-btn" data-sub="boromir" onclick="switchCrew('sub','boromir')">🛡️ Boromir (Gondor)</button>
      <button class="crew-btn" data-sub="celebrimbor" onclick="switchCrew('sub','celebrimbor')">🟣 Celebrimbor</button>
      <button class="crew-btn" data-sub="frodo" onclick="switchCrew('sub','frodo')">🟠 Frodo</button>
      <button class="crew-btn" data-sub="caine" onclick="switchCrew('sub','caine')">🟠 Caine (Admiral)</button>
      <button class="crew-btn" data-sub="fred" onclick="switchCrew('sub','fred')">🔴 Fred (RHR)</button>
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
  <div class="table-scroll">
    <table>
      <thead><tr><th style="width:95px;">ID / Status</th><th style="width:165px;">Courier &amp; Route</th><th>Message &amp; Reply</th></tr></thead>
      <tbody id="hud-comms-tbody">${commsRows || '<tr><td colspan="3">(no messages in construct comms log)</td></tr>'}</tbody>
    </table>
  </div>

  <h2 id="hud-open-heading">Open Verification Threads — ${escapeHtml(hud.project)} (${openThreads.length})</h2>
  <div class="table-scroll">
    <table>
      <thead><tr><th style="width:90px;">Seq</th><th>Summary &amp; Detail</th></tr></thead>
      <tbody id="hud-open-tbody">${openRows || '<tr><td colspan="2">(none)</td></tr>'}</tbody>
    </table>
  </div>

  <h2 id="hud-tape-heading">Recent Sequential Tape — ${escapeHtml(hud.project)} (${recentTape.length} of ${hud.totalFrames || 0})</h2>
  <div class="table-scroll">
    <table>
      <thead><tr><th style="width:90px;">Seq</th><th style="width:95px;">Kind</th><th>Summary</th></tr></thead>
      <tbody id="hud-tape-tbody">${tapeRows || '<tr><td colspan="3">(empty tape)</td></tr>'}</tbody>
    </table>
  </div>

  <h2 id="hud-gotchas-heading">Project Gotchas — ${escapeHtml(hud.project)} (${hud.gotchaCount || 0})</h2>
  <table>
    <thead><tr><th style="width:80px;">ID</th><th>Gotcha &amp; Fix</th></tr></thead>
    <tbody id="hud-gotchas-tbody">${gotchaRows || '<tr><td colspan="2">(no project-specific gotchas)</td></tr>'}</tbody>
  </table>

  <script>
    const selectedSessionId = ${JSON.stringify(hud.sessionId || '')};
    const selectedProject = ${JSON.stringify(hud.project || '')};
    const SEAT_GLYPHS = ['🔵', '🟠', '🟣', '🔴', '🟢', '⚡', '🛡️', '🎨', '📓'];

    function esc(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function applyHudToDom(h) {
      if (!h) return;
      const shortSid = (h.sessionId || selectedSessionId || '').replace(/^ses_/, '').slice(0, 6);
      const scopeEl = document.getElementById('target-scope-label');
      if (scopeEl) {
        scopeEl.textContent = h.project || selectedProject || 'workspace';
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
              ? '<input type="text" class="reply-input" id="reply-input-' + esc(m.id) + '" data-msg-id="' + esc(m.id) + '" placeholder="Type reply to ' + esc(m.fromUser) + '..." onkeydown="handleReplyKey(event,this)" />' +
                '<button class="crew-btn active" id="reply-btn-' + esc(m.id) + '" onclick="replyCourier(' + esc(m.id) + ',this.previousElementSibling.id,this)">⚡ Send Reply</button>'
              : '';
            return '<div class="courier-alert-item">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">' +
              '<div><span class="badge warn">📬 UNREAD COURIER [M#' + esc(m.id) + ']</span> <strong style="color:#fff;margin-left:6px;">' + cLabel + '</strong> <span class="sub">(' + esc(m.project) + ' · ' + esc(m.created) + ')</span></div>' +
              '<div style="display:flex;gap:6px;align-items:center;">' + inputHtml + '<button class="crew-btn" onclick="ackCourier(' + esc(m.id) + ',this)">✓ Ack / Dismiss</button></div>' +
              '</div>' +
              '<div style="margin-top:6px;font-size:13px;color:#fff;">"' + esc(mText) + '"</div>' +
              '</div>';
          }).join('');
        }
      }

      if (commsHeading) commsHeading.textContent = 'Construct Comms & Courier Log — ' + (h.project || 'workspace') + ' (' + commsArr.length + ')';
      if (commsTbody && !isTypingReply) {
        if (!commsArr.length) {
          commsTbody.innerHTML = '<tr><td colspan="3">(no messages in construct comms log)</td></tr>';
        } else {
          commsTbody.innerHTML = commsArr.map((m) => {
            const stClass = m.status === 'pending' ? 'warn' : 'ok';
            const replyHtml = m.replyBody
              ? '<div class="sub" style="margin-top:4px;color:var(--ok);"><strong>-&gt; ' + esc(m.replyGlyph || '📬') + ' ' + esc(m.replyRom) + ' (' + esc(m.toUser) + '):</strong> "' + esc(m.replyBody) + '"</div>'
              : '';
            const actHtml = '<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
              (m.status === 'pending'
                ? '<input type="text" class="reply-input" id="row-reply-' + esc(m.id) + '" data-msg-id="' + esc(m.id) + '" placeholder="Reply..." onkeydown="handleReplyKey(event,this)" />' +
                  '<button class="crew-btn" id="row-reply-btn-' + esc(m.id) + '" onclick="replyCourier(' + esc(m.id) + ',this.previousElementSibling.id,this)">⚡ Reply</button>'
                : '') +
              (m.status !== 'delivered' ? '<button class="crew-btn" onclick="ackCourier(' + esc(m.id) + ',this)">✓ Ack</button>' : '') +
              '<button class="crew-btn" title="Hide message M#' + esc(m.id) + ' (kept in archive)" onclick="deleteCourier(' + esc(m.id) + ',this)">👁️ Hide</button></div>';
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

      const cliLabel = document.getElementById('hud-cli-cmd-label');
      const cliOut = document.getElementById('hud-cli-output');
      const cliClear = document.getElementById('hud-cli-clear-btn');
      if (cliOut) {
        if (h.lastCliOutput && h.lastCliOutput.output) {
          if (cliLabel) cliLabel.textContent = h.lastCliOutput.cmd || '';
          cliOut.textContent = h.lastCliOutput.output;
          cliOut.style.display = 'block';
          if (cliClear) cliClear.style.display = 'inline-block';
        } else {
          if (cliLabel) cliLabel.textContent = '';
          cliOut.textContent = '';
          cliOut.style.display = 'none';
          if (cliClear) cliClear.style.display = 'none';
        }
      }
    }

    async function pollHud() {
      try {
        const qs = '?sessionID=' + encodeURIComponent(selectedSessionId || '') + '&project=' + encodeURIComponent(selectedProject || '');
        const res = await fetch('http://127.0.0.1:47420/hud' + qs);
        const data = await res.json();
        if (data && data.ok && data.hud) applyHudToDom(data.hud);
      } catch (_) {}
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

    function handleReplyKey(ev, inputEl) {
      if (ev && ev.key === 'Enter' && inputEl) {
        ev.preventDefault();
        const msgId = Number(inputEl.getAttribute('data-msg-id'));
        const btnEl = inputEl.nextElementSibling;
        if (msgId) void replyCourier(msgId, inputEl.id, btnEl);
      }
    }

    async function replyCourier(msgId, inputId, btnEl) {
      const el = document.getElementById(inputId || ('reply-input-' + msgId));
      if (!el || el.disabled) return;
      const body = String(el.value || '').trim();
      if (!body) return;
      el.disabled = true;
      el.style.opacity = '0.5';
      const btn = btnEl || el.nextElementSibling;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Queued...';
      }
      const toast = document.getElementById('hud-toast');
      if (toast) toast.textContent = '⏳ Reply queued for M#' + msgId + '...';
      try {
        const res = await fetch('http://127.0.0.1:47420/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reply', id: msgId, body, sessionID: selectedSessionId, project: selectedProject })
        });
        const data = await res.json();
        if (data && data.ok && data.hud) {
          applyHudToDom(data.hud);
          if (toast) toast.textContent = '✓ Replied to M#' + msgId;
        }
      } catch (_) {
        el.disabled = false;
        el.style.opacity = '1';
        if (btn) {
          btn.disabled = false;
          btn.textContent = '⚡ Reply';
        }
      }
    }

    async function ackCourier(msgId, btnEl) {
      if (btnEl) {
        if (btnEl.disabled) return;
        btnEl.disabled = true;
        btnEl.textContent = '✓...';
      }
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
      } catch (_) {
        if (btnEl) btnEl.disabled = false;
      }
    }

    async function deleteCourier(msgId, btnEl) {
      if (btnEl) {
        if (btnEl.disabled) return;
        btnEl.disabled = true;
        btnEl.textContent = '👁️...';
      }
      const toast = document.getElementById('hud-toast');
      if (toast) toast.textContent = 'Hiding M#' + msgId + '...';
      try {
        const res = await fetch('http://127.0.0.1:47420/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete-msg', id: msgId, sessionID: selectedSessionId, project: selectedProject })
        });
        const data = await res.json();
        if (data && data.ok && data.hud) {
          applyHudToDom(data.hud);
          if (toast) toast.textContent = '✓ Hidden M#' + msgId + ' (searchable via construct inbox --all)';
        }
      } catch (_) {
        if (btnEl) btnEl.disabled = false;
      }
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

    async function runHudCli(argsStr) {
      const clean = String(argsStr || '').trim().replace(/^\\/construct\\s+/i, '');
      if (!clean) return;
      const toast = document.getElementById('hud-toast');
      if (toast) toast.textContent = 'Running construct ' + clean + '...';
      try {
        const res = await fetch('http://127.0.0.1:47420/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cli', args: clean, sessionID: selectedSessionId, project: selectedProject })
        });
        const data = await res.json();
        if (data && data.ok && data.hud) {
          applyHudToDom(data.hud);
          if (toast) toast.textContent = '✓ Executed: /construct ' + clean;
        }
      } catch (_) {}
    }

    function runHudCliFromInput() {
      const el = document.getElementById('hud-cli-input');
      if (!el) return;
      const val = String(el.value || '').trim();
      if (!val) return;
      void runHudCli(val);
    }

    function runHudCliButton(btnEl) {
      if (!btnEl) return;
      const cmd = btnEl.getAttribute('data-cli');
      if (cmd) void runHudCli(cmd);
    }

    function handleCliKey(ev, inputEl) {
      if (ev && ev.key === 'Enter' && inputEl) {
        ev.preventDefault();
        runHudCliFromInput();
      }
    }

    async function clearHudCli() {
      try {
        const res = await fetch('http://127.0.0.1:47420/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'clear-cli', sessionID: selectedSessionId, project: selectedProject })
        });
        const data = await res.json();
        if (data && data.ok && data.hud) applyHudToDom(data.hud);
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
      const nodeCmd = /node(?:\.exe)?$/i.test(process.execPath) ? process.execPath : 'node';
      const child = spawn(nodeCmd, [binScript, 'hud-server'], {
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
      if (req.method === 'GET' && (req.url === '/docs' || req.url?.startsWith('/docs/'))) {
        try {
          const parsedUrl = new URL(req.url, `http://127.0.0.1:${port}`);
          let relPath = parsedUrl.pathname.replace(/^\/docs\/?/, '') || 'index.html';
          if (relPath.endsWith('/')) relPath += 'index.html';
          const docsRoot = path.resolve(__dirname, '..', 'docs');
          const absFile = path.resolve(docsRoot, relPath);
          if (absFile.startsWith(docsRoot) && fs.existsSync(absFile) && fs.statSync(absFile).isFile()) {
            const ext = path.extname(absFile).toLowerCase();
            const mime =
              ext === '.css'
                ? 'text/css; charset=utf-8'
                : ext === '.js'
                ? 'application/javascript; charset=utf-8'
                : 'text/html; charset=utf-8';
            res.writeHead(200, { 'Content-Type': mime });
            res.end(fs.readFileSync(absFile));
            return;
          }
        } catch (_) {}
        res.writeHead(404);
        res.end('Not found');
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

            if (rawAction === 'shutdown') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, shutdown: true }));
              setImmediate(() => {
                try {
                  server.close();
                } catch (_) {}
                process.exit(0);
              });
              return;
            }
            if (rawAction === 'reply' && payload.id && payload.body) {
              const m = replyMessage(payload.id, payload.body, { via: payload.via, sessionId: sid }, file);
              const snap = getHudSnapshot({ sessionId: sid, project: proj !== 'workspace' ? proj : '', dir }, file);
              try {
                generateDashboardHtml({ sessionId: sid, project: snap.project, dir: snap.dir, noServerSpawn: true }, file);
              } catch (_) {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, hud: snap }));
              if (process.env.CONSTRUCT_NO_AUTOSYNC !== '1' && m?.project) {
                setImmediate(() => {
                  syncProject(m.project, {}, file).catch(() => {});
                });
              }
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
            if (rawAction === 'delete-msg' && payload.id) {
              deleteMessage(payload.id, file);
              const snap = getHudSnapshot({ sessionId: sid, project: proj !== 'workspace' ? proj : '', dir }, file);
              try {
                generateDashboardHtml({ sessionId: sid, project: snap.project, dir: snap.dir, noServerSpawn: true }, file);
              } catch (_) {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, hud: snap }));
              return;
            }
            if (rawAction === 'clear-cli') {
              clearLastCliOutput(file);
              const snap = getHudSnapshot({ sessionId: sid, project: proj !== 'workspace' ? proj : '', dir }, file);
              generateDashboardHtml({ sessionId: sid, project: proj !== 'workspace' ? proj : '', dir, noServerSpawn: true }, file);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, hud: snap }));
              return;
            }

            if (rawAction === 'cli' && payload.args) {
              const mcpMod = require('./mcp');
              const cliRes = mcpMod.executeConstructSlashCommand(String(payload.args), {
                sessionId: sid,
                cwd: dir,
              });
              const snap = getHudSnapshot({ sessionId: sid, project: proj !== 'workspace' ? proj : '', dir }, file);
              generateDashboardHtml({ sessionId: sid, project: proj !== 'workspace' ? proj : '', dir, noServerSpawn: true }, file);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, cli: cliRes, hud: snap }));
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


  return {
    escapeHtml,
    PACK_EMBLEM_MAP,
    detectFocusedDirFromOpenCodeLog,
    listActiveTabsInDb,
    setLastCliOutput,
    clearLastCliOutput,
    getHudSnapshot,
    generateDashboardHtml,
    startStandaloneHudServer,
  };
}

module.exports = { createHudModule };
