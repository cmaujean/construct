// Deterministic Static Site & Brochure Generator for Construct (`docs/` -> GitHub Pages).
//
// Generates:
//   - `docs/.nojekyll`
//   - `docs/assets/style.css`
//   - `docs/index.html` (Flagship Adopter Brochure, Interactive 15-Crew Preview, Token & Speed Benchmarks, 15-Crew Grid)
//   - `docs/guide.html` (In-Depth Architecture, 6-Agent Setup, Sequential Tape, MLS/CRDT Sync, Personal Comms & CLI Reference)
//   - `docs/crews/<bank>.html` (15 Dedicated Crew Introduction Pages with all 179 ROMs, 5-bar dial meters, and Wrong/Right calibration pairs)
//
// Enforces zero em dashes in all generated HTML so user-facing pages stay 100% compliant with operator calibration.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const packs = require('./packs');
const romMod = require('./rom');

const PACK_EMBLEMS = Object.freeze({
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
});

const PACK_ALIASES = Object.freeze({
  sprawl: ['crew', 'all', 'sprawl'],
  nightcity: ['nightcity', 'afterlife', 'cyberpunk'],
  anathem: ['anathem'],
  cryptonomicon: ['cryptonomicon', 'epiphyte'],
  shadowrun: ['shadowrun', 'shadowland'],
  dresden: ['dresden', 'paranet'],
  amber: ['amber', 'kolvir', 'pattern'],
  laundry: ['laundry', 'qdivision', 'mahoganyrow'],
  tolkien: ['tolkien', 'fellowship', 'middleearth', 'rivendell'],
  discworld: ['discworld', 'ankhmorpork', 'nightwatch', 'clacks'],
  reamde: ['reamde', 'tgd', 'corporation9592', 'train'],
  irondruid: ['irondruid', 'tirnanog', 'thirdeye'],
  prydain: ['prydain', 'caerdath', 'caerdallben'],
  clockwork: ['clockwork', 'korova', 'droogs', 'nadsat'],
  generic: ['generic', 'standard', 'plain'],
});

const PACK_DEFAULT_COURIER = Object.freeze({
  sprawl: 'case',
  nightcity: 'songbird',
  anathem: 'jules',
  cryptonomicon: 'avi',
  shadowrun: 'dodger',
  dresden: 'toot',
  amber: 'random',
  laundry: 'persephone',
  tolkien: 'legolas (or --via smeagol)',
  discworld: 'moist',
  reamde: 'yuxia',
  irondruid: 'oberon',
  prydain: 'gurgi (or --via kaw)',
  clockwork: 'branom',
  generic: 'pulse',
});

function sanitizeEmDashes(str) {
  return String(str || '').replace(/\s*—\s*/g, ' -- ');
}

function esc(str) {
  return sanitizeEmDashes(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseVoiceSections(voiceText = '') {
  const clean = sanitizeEmDashes(voiceText);
  const introMatch = clean.split(/###\s*1\./)[0] || '';
  const intro = introMatch.trim();

  const sec2Match = clean.match(/###\s*2\.[^\n]*\n([\s\S]*?)(?=\n###\s*3\.|$)/);
  const sec2Bullets = sec2Match
    ? sec2Match[1]
        .split('\n')
        .map((l) => l.replace(/^\s*-\s*/, '').replace(/\*\*/g, '').trim())
        .filter(Boolean)
    : [];

  const pairs = [];
  const sec3Match = clean.match(/###\s*3\.[^\n]*\n([\s\S]*)$/);
  if (sec3Match) {
    const blocks = sec3Match[1].split(/\n-\s*\*\*/).filter((b) => b.trim());
    for (const blk of blocks) {
      const titleMatch = blk.match(/^([^*\n]+)\*\*:/);
      const wrongMatch = blk.match(/\(WRONG\):\*\s*"([^"\n]+)"/);
      const rightMatch = blk.match(/\(RIGHT\):\*\s*"([^"\n]+)"/);
      if (wrongMatch || rightMatch) {
        pairs.push({
          label: titleMatch ? titleMatch[1].replace(/^\s*-\s*\*\*/, '').trim() : 'Calibration Example',
          wrong: wrongMatch ? wrongMatch[1].trim() : '',
          right: rightMatch ? rightMatch[1].trim() : '',
        });
      }
    }
  }

  return { intro, sec2Bullets, pairs };
}

function buildStylesheet() {
  return `:root {
  --bg: #0b0e14;
  --bg-elev: #111621;
  --panel: #151b28;
  --border: #253045;
  --text: #e6edf3;
  --muted: #8b949e;
  --accent: #58a6ff;
  --accent-glow: rgba(88, 166, 255, 0.16);
  --ok: #3fb950;
  --ok-bg: rgba(63, 185, 80, 0.12);
  --warn: #d29922;
  --danger: #f85149;
  --danger-bg: rgba(248, 81, 73, 0.12);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.6;
  font-size: 15px;
}
code, pre, .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.nav-bar {
  position: sticky;
  top: 0;
  z-index: 100;
  background: rgba(11, 14, 20, 0.92);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
  padding: 12px 24px;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.nav-brand {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-weight: 800;
  font-size: 16px;
  color: #fff;
  letter-spacing: 0.04em;
}
.nav-links {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 13.5px;
  font-weight: 600;
}
.container {
  max-width: 1180px;
  margin: 0 auto;
  padding: 36px 24px 72px;
}
.hero {
  background: radial-gradient(circle at top right, rgba(88, 166, 255, 0.14), transparent 55%), var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 40px 36px;
  margin-bottom: 36px;
}
.hero-eyebrow {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--accent-glow);
  border: 1px solid var(--accent);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 14px;
}
.hero h1 {
  margin: 0 0 14px;
  font-size: 34px;
  line-height: 1.2;
  color: #fff;
}
.hero p.lead {
  font-size: 17.5px;
  color: var(--muted);
  max-width: 860px;
  margin: 0 0 24px;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  margin: 24px 0 36px;
}
.stat-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 18px 20px;
}
.stat-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 26px;
  font-weight: 800;
  color: var(--ok);
}
.stat-label {
  font-size: 13px;
  color: var(--muted);
  margin-top: 4px;
}
h2.section-title {
  font-size: 23px;
  color: #fff;
  margin: 44px 0 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.crew-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 18px;
  margin-top: 20px;
}
.crew-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.crew-card:hover {
  border-color: var(--accent);
  transform: translateY(-2px);
}
.crew-card h3 {
  margin: 0 0 8px;
  font-size: 18px;
  color: #fff;
}
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  background: #1f2937;
  color: var(--accent);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}
.badge.ok { background: var(--ok-bg); color: var(--ok); }
.badge.warn { background: rgba(210, 153, 34, 0.18); color: var(--warn); }
.rom-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 24px;
  margin-bottom: 22px;
}
.rom-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 12px;
  margin-bottom: 14px;
}
.rom-title {
  font-size: 19px;
  font-weight: 700;
  color: #fff;
  margin: 0;
}
.dial-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  margin: 14px 0;
  background: var(--bg-elev);
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
}
.dial-item { font-size: 12px; }
.dial-bar-bg {
  height: 6px;
  background: #222b3a;
  border-radius: 3px;
  margin-top: 4px;
  overflow: hidden;
}
.dial-bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
}
.cal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  margin-top: 12px;
}
.cal-box {
  padding: 12px 14px;
  border-radius: 8px;
  font-size: 13.5px;
}
.cal-wrong {
  background: var(--danger-bg);
  border: 1px solid rgba(248, 81, 73, 0.35);
}
.cal-right {
  background: var(--ok-bg);
  border: 1px solid rgba(63, 185, 80, 0.35);
}
table.bench-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  font-size: 13.5px;
  margin: 16px 0;
}
table.bench-table th, table.bench-table td {
  text-align: left;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
table.bench-table th {
  background: #0f141e;
  color: var(--accent);
  font-weight: 700;
}
pre.code-block {
  background: #0d1119;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  font-size: 13px;
  color: #e6edf3;
}
.pill-btn {
  background: #1a2333;
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12.5px;
  cursor: pointer;
}
.pill-btn:hover, .pill-btn.active {
  border-color: var(--accent);
  background: var(--accent-glow);
  color: #fff;
}
.footer {
  margin-top: 64px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
`;
}

function renderNavBar(prefix = '') {
  return `<nav class="nav-bar">
  <div class="nav-brand"><a href="${prefix}index.html" style="color:#fff;text-decoration:none;">🦾 CONSTRUCT // 9-SEAT CREW &amp; SEQUENTIAL MEMORY</a></div>
  <div class="nav-links">
    <a href="${prefix}index.html">Overview &amp; Benchmarks</a>
    <a href="${prefix}index.html#crews">The 15 Crew Banks (179 ROMs)</a>
    <a href="${prefix}guide.html">Architecture &amp; Multi-Agent Guide</a>
    <a href="${prefix}guide.html#personal-comms">Personal Comms (@comms)</a>
    <a href="https://github.com/cmaujean/construct">GitHub</a>
  </div>
</nav>`;
}

function renderRomCard(r, packMeta) {
  const seatMeta = romMod.SEAT_MAP[r.seat] || { code: '?', glyph: '🔹', label: r.seat.toUpperCase(), desc: r.handle };
  const seatLabel = packMeta?.seatLabels?.[r.seat] || seatMeta.label;
  const tag = `${seatMeta.glyph} [${r.name.toUpperCase()} // ${seatLabel}]`;
  const parsed = parseVoiceSections(r.voice);
  const dials = r.dials || {};
  const dialHtml = ['terse', 'skepticism', 'edge', 'autonomy', 'telemetry']
    .map((k) => {
      const val = Number(dials[k] ?? 0.8);
      const pct = Math.round(val * 100);
      return `<div class="dial-item">
        <div style="display:flex;justify-content:space-between;"><span>${esc(k)}</span><strong class="mono">${val.toFixed(2)}</strong></div>
        <div class="dial-bar-bg"><div class="dial-bar-fill" style="width:${pct}%;"></div></div>
      </div>`;
    })
    .join('');

  const bulletsHtml = parsed.sec2Bullets.length
    ? `<ul>${parsed.sec2Bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
    : '';

  const pairsHtml = parsed.pairs
    .map(
      (p) => `<div style="margin-top:12px;">
        <div style="font-size:12.5px;font-weight:700;color:var(--muted);text-transform:uppercase;">${esc(p.label)}</div>
        <div class="cal-grid">
          <div class="cal-box cal-wrong"><strong>❌ Stock Assistant Drone (WRONG):</strong><div style="margin-top:4px;">"${esc(p.wrong)}"</div></div>
          <div class="cal-box cal-right"><strong>✅ ${esc(r.name)} ROM Voice (RIGHT):</strong><div style="margin-top:4px;">"${esc(p.right)}"</div></div>
        </div>
      </div>`
    )
    .join('');

  const directivesHtml = Array.isArray(r.directives) && r.directives.length
    ? `<div style="margin-top:14px;font-size:13px;color:var(--muted);"><strong>Burned-In Directives:</strong><ol style="margin:6px 0 0 18px;padding:0;">${r.directives
        .map((d) => `<li>${esc(d)}</li>`)
        .join('')}</ol></div>`
    : '';

  return `<div class="rom-card" id="rom-${esc(r.name)}">
    <div class="rom-header">
      <div>
        <h3 class="rom-title">${esc(seatMeta.glyph)} ${esc(r.handle)}</h3>
        <div style="margin-top:4px;">
          <span class="badge">${esc(tag)}</span>
          <span class="badge ${r.tier === 'backup' ? 'warn' : 'ok'}" style="margin-left:6px;">${
            r.tier === 'backup' ? 'Bench / Second (sub)' : `Seat ${seatMeta.code} (${r.seat}) -- ${seatMeta.desc}`
          }</span>
        </div>
      </div>
      <div class="mono" style="font-size:12px;color:var(--muted);">
        ${r.tier === 'backup' ? `<code>construct rom sub ${esc(r.name)}</code>` : `<code>construct rom use ${esc(r.name)}</code>`}
        <div style="margin-top:3px;">Courier: <code>--via ${esc(r.name)}</code></div>
      </div>
    </div>
    <p style="margin:0 0 10px;font-weight:600;color:#fff;">${esc(r.tagline)}</p>
    <p style="margin:0 0 10px;color:var(--text);">${esc(parsed.intro)}</p>
    ${bulletsHtml}
    <div class="dial-row">${dialHtml}</div>
    ${pairsHtml}
    ${directivesHtml}
  </div>`;
}

function generateCrewPageHtml(packName, packMeta, packRoms, allPackNames) {
  const emblem = PACK_EMBLEMS[packName] || '🦾';
  const aliases = PACK_ALIASES[packName] || [packName];
  const defaultCourier = PACK_DEFAULT_COURIER[packName] || 'pulse';
  const starters = [];
  const backups = [];

  for (const sName of packMeta.defaultStarters || []) {
    const found = packRoms.find((r) => r.name === sName);
    if (found) starters.push(found);
  }
  for (const r of packRoms) {
    if (!starters.includes(r)) backups.push(r);
  }

  const otherLinks = allPackNames
    .map(
      (p) =>
        `<a class="pill-btn ${p === packName ? 'active' : ''}" href="${esc(p)}.html" style="text-decoration:none;display:inline-block;margin:3px;">${
          PACK_EMBLEMS[p] || '🦾'
        } ${esc(p)}</a>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(emblem)} ${esc(packName.toUpperCase())} Crew Bank -- Construct Documentation</title>
<link rel="stylesheet" href="../assets/style.css" />
</head>
<body>
${renderNavBar('../')}
<div class="container">
  <div style="margin-bottom:18px;">${otherLinks}</div>
  <div class="hero">
    <div class="hero-eyebrow">${esc(emblem)} Crew Bank // ${esc(packName)} (${packRoms.length} ROMs)</div>
    <h1>${esc(packMeta.title)}</h1>
    <p class="lead">${esc(packMeta.atmosphere)}</p>
    <pre class="code-block">${esc(packMeta.banner)}</pre>
    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:16px;font-size:13.5px;">
      <span class="badge ok">Slot in Chat: <code>switch to ${esc(packName)} crew</code></span>
      <span class="badge">CLI: <code>construct rom use ${esc(packName)}</code></span>
      <span class="badge">Aliases: <code>${esc(aliases.join(', '))}</code></span>
      <span class="badge warn">Default Courier: <code>--via ${esc(defaultCourier)}</code></span>
    </div>
    ${
      Array.isArray(packMeta.cameoTriggers) && packMeta.cameoTriggers.length
        ? `<div style="margin-top:14px;font-size:13px;color:var(--muted);"><strong>Cross-Bank World-Cue Cameo Triggers:</strong> ${packMeta.cameoTriggers
            .map((t) => `<span class="badge" style="margin:2px 4px;">${esc(t)}</span>`)
            .join('')}</div>`
        : ''
    }
  </div>

  <h2 class="section-title">The 9 Canonical Starter Seats (${starters.length})</h2>
  <p style="color:var(--muted);">All 9 starters are in the room simultaneously on every turn. Address any specialist 1-on-1 by name, or let the Crew run the <code>Recon -&gt; Alignment Gate -&gt; Blitz + Overwatch + Docs Parity -&gt; Archive</code> pipeline automatically.</p>
  ${starters.map((r) => renderRomCard(r, packMeta)).join('\n')}

  ${
    backups.length
      ? `<h2 class="section-title">The Bench / Seconds &amp; On-Demand Couriers (${backups.length})</h2>
         <p style="color:var(--muted);">Call any Bench specialist into a conversation by name, substitute them into the active 9-seat lineup with <code>construct rom sub &lt;name&gt;</code>, or dispatch them across the wire with <code>construct msg --to &lt;person&gt; --via &lt;name&gt;</code>.</p>
         ${backups.map((r) => renderRomCard(r, packMeta)).join('\n')}`
      : ''
  }

  <div class="footer">
    Construct Sequential Memory &amp; Multi-Bank 9-Seat Crew Engine &bull; <a href="../index.html">Back to Brochure &amp; Benchmarks</a> &bull; <a href="../guide.html">Architecture &amp; Multi-Agent Guide</a>
  </div>
</div>
</body>
</html>\n`;
}

function generateIndexHtml(allMeta, romCountsByPack) {
  const crewCardsHtml = Object.entries(allMeta)
    .map(([pName, meta]) => {
      const emblem = PACK_EMBLEMS[pName] || '🦾';
      const starters = (meta.defaultStarters || []).join(' · ');
      const bench = (meta.backups || []).length ? `Bench: ${meta.backups.join(', ')}` : 'Zero-fiction engineering pipeline';
      const count = romCountsByPack[pName] || 12;
      return `<div class="crew-card">
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span class="badge ok">${esc(emblem)} ${esc(pName)}</span>
            <span class="mono" style="font-size:12px;color:var(--muted);">${count} ROMs</span>
          </div>
          <h3><a href="crews/${esc(pName)}.html" style="color:#fff;">${esc(meta.title)}</a></h3>
          <p style="font-size:13.5px;color:var(--muted);margin:8px 0 12px;">${esc(meta.atmosphere)}</p>
        </div>
        <div>
          <div class="mono" style="font-size:12px;color:var(--accent);margin-bottom:6px;">Starters: ${esc(starters)}</div>
          <div class="mono" style="font-size:11.5px;color:var(--muted);margin-bottom:12px;">${esc(bench)}</div>
          <a class="pill-btn" href="crews/${esc(pName)}.html" style="display:inline-block;text-decoration:none;">Explore ${esc(pName)} Crew &rarr;</a>
        </div>
      </div>`;
    })
    .join('\n');

  const interactivePreviewData = {};
  for (const [pName, meta] of Object.entries(allMeta)) {
    const s = meta.defaultStarters || [];
    interactivePreviewData[pName] = {
      emblem: PACK_EMBLEMS[pName] || '🦾',
      title: sanitizeEmDashes(meta.title),
      banner: sanitizeEmDashes(meta.banner).replace(/\*\*`/g, '').replace(/`\*\*/g, ''),
      recon: s[0] || 'recon',
      diag: s[1] || 'diagnostics',
      arch: s[2] || 'architect',
      blitz: s[3] || 'blitz',
      book: s[8] || 'archivist',
      sample: sanitizeEmDashes(meta.interjectionExample || ''),
    };
  }

  const switcherButtons = Object.keys(allMeta)
    .map(
      (pName, idx) =>
        `<button class="pill-btn ${idx === 0 ? 'active' : ''}" data-preview-pack="${esc(pName)}" onclick="showPreview('${esc(pName)}')">${
          PACK_EMBLEMS[pName] || '🦾'
        } ${esc(pName)}</button>`
    )
    .join(' ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Construct -- 9-Seat Engineering Crews, Sub-Millisecond SQLite Memory &amp; Encrypted Courier Sync</title>
<link rel="stylesheet" href="assets/style.css" />
</head>
<body>
${renderNavBar('')}
<div class="container">
  <div class="hero">
    <div class="hero-eyebrow">Zero External Dependencies &bull; Node.js Built-In SQLite (WAL + FTS5) &bull; 15 Crew Banks (179 ROMs)</div>
    <h1>Stop Asking One Generalist Chatbot to Do Nine Different Engineering Jobs.</h1>
    <p class="lead">
      <strong>Construct</strong> replaces amnesia-prone markdown handoff files and single-persona AI assistants with a
      <strong>coordinated 9-seat specialist engineering crew</strong>, a sub-millisecond embedded SQLite sequential memory tape,
      <code>0.083 ms</code> mechanical shell guards, and encrypted person-to-person Courier Cameos across
      <strong>OpenCode, Claude Code, Cursor, Gemini CLI, Windsurf, Codex, and Oh My Pi (<code>omp</code>)</strong>.
    </p>
    <pre class="code-block"># Install &amp; wire into OpenCode (plus optional --claude, --cursor, --gemini, --windsurf, --codex, --omp, or --all)
git clone https://github.com/cmaujean/construct.git
cd construct &amp;&amp; npm link
construct init --all</pre>
  </div>

  <div class="stat-grid">
    <div class="stat-card">
      <div class="stat-value">-72% to -80%</div>
      <div class="stat-label">Session token reduction vs. static <code>AGENTS.md</code> + handoff docs (<code>29,128 -&gt; 5,699..8,202</code> prompt-cached tokens)</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">~$5.20 - $11.20</div>
      <div class="stat-label">Saved per 25-turn feature session via 100% prompt-cache hits, 0 cold-start file reads, and 0-token shell guards</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">2.4 ms / 0.083 ms</div>
      <div class="stat-label">In-process MCP tool execution (<code>51x</code> faster than CLI spawn) &amp; <code>83 &micro;s</code> pre-execution shell guard</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">179 ROMs / 15 Banks</div>
      <div class="stat-label">Lazy-loaded 9-seat Crews + Bench seconds + Person-to-Person Courier Cameos (<code>@comms</code> &amp; per-project MLS)</div>
    </div>
  </div>

  <h2 class="section-title">1. Measured Token &amp; Speed Benchmarks (Bare Model vs. Static AGENTS.md vs. Construct)</h2>
  <p style="color:var(--muted);">Measured directly on real multi-repository production workspaces (<code>Node 24.15.0</code> on Windows 11, 25-turn / ~100-step feature sessions):</p>

  <table class="bench-table">
    <thead>
      <tr>
        <th>Metric / Dimension</th>
        <th>1. Bare Model (No Memory)</th>
        <th>2. Static <code>AGENTS.md</code> + <code>docs/dev/</code></th>
        <th>3a. Construct (<code>⚙️ generic</code> Crew)</th>
        <th>3b. Construct (9-Seat Immersive Crew)</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><strong>Upfront System Context (Turn 1)</strong></td>
        <td><code>0</code> tokens <em>(blind cold-start)</em></td>
        <td><code>29,128</code> tokens <em>(bloated markdown stack)</em></td>
        <td><strong><code>5,699</code> tokens</strong> <em>(Base + 9-seat generic + tape)</em></td>
        <td><strong><code>8,202</code> tokens</strong> <em>(Base + full 9-seat Crew + tape)</em></td>
      </tr>
      <tr>
        <td><strong>Cold-Start Orientation Tool Calls (Turns 1-3)</strong></td>
        <td><code>4-7</code> file/git reads (<strong><code>~29,340</code> uncached tokens</strong>)</td>
        <td><code>3-5</code> file reads/writes (<strong><code>~35,000</code> uncached tokens</strong>)</td>
        <td><strong><code>0</code> tool calls</strong> <em>(Head, 8 frames, &amp; gotchas pre-injected)</em></td>
        <td><strong><code>0</code> tool calls</strong> <em>(Head, 8 frames, &amp; gotchas pre-injected)</em></td>
      </tr>
      <tr>
        <td><strong>Provider Prompt-Cache Hit Rate (Turns 2..N)</strong></td>
        <td>Low (<code>~40%</code>)</td>
        <td>Medium (<code>~65%</code>)</td>
        <td><strong><code>100%</code> deterministic prefix</strong> (<code>75-90%</code> cheaper <code>cache.read</code>)</td>
        <td><strong><code>100%</code> deterministic prefix</strong> (<code>75-90%</code> cheaper <code>cache.read</code>)</td>
      </tr>
      <tr>
        <td><strong>Cost of a Shell Trap</strong> (<code>&lt;&lt;EOF</code>, <code>npm test | tail</code>, <code>:Zone.Identifier</code>)</td>
        <td><code>3,500 - 6,000</code> wasted retry tokens</td>
        <td><code>3,500 - 6,000</code> wasted retry tokens <em>(advisory text only)</em></td>
        <td><strong><code>0</code> tokens</strong> <em>(blocked mechanically in <code>0.083 ms</code>)</em></td>
        <td><strong><code>0</code> tokens</strong> <em>(blocked mechanically in <code>0.083 ms</code>)</em></td>
      </tr>
      <tr>
        <td><strong>25-Turn (~100-Step) Effective Token Load</strong></td>
        <td><code>~1.85M</code> tokens</td>
        <td><code>~2.91M</code> tokens</td>
        <td><strong><code>~0.57M</code> cached tokens (<code>-80.4%</code> vs. AGENTS.md)</strong></td>
        <td><strong><code>~0.82M</code> cached tokens (<code>-71.8%</code> vs. AGENTS.md)</strong></td>
      </tr>
      <tr>
        <td><strong>Net Dollar Savings per 25-Turn Session</strong></td>
        <td>Baseline (highest rework risk)</td>
        <td><code>+$2.80</code> <em>more</em> expensive than Bare</td>
        <td><strong>Saves <code>~$5.80 - $11.20</code> / session</strong></td>
        <td><strong>Saves <code>~$5.20 - $10.50</code> / session</strong></td>
      </tr>
    </tbody>
  </table>

  <table class="bench-table" style="margin-top:20px;">
    <thead>
      <tr>
        <th>Runtime Operation</th>
        <th>Static Markdown / Subprocess CLI Way</th>
        <th>Construct Unified In-Process Engine (<code>src/mcp.js</code> + <code>node:sqlite</code> WAL)</th>
        <th>Measured Speedup</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><strong>Pre-Execution Shell Guard (<code>validateShellCommand</code>)</strong></td>
        <td><code>3,500 - 8,000 ms</code> <em>(spawns broken shell + LLM retry turn)</em></td>
        <td><strong><code>0.083 ms</code></strong> <em>(83 microseconds in-memory regex + SQLite guard)</em></td>
        <td><strong><code>~45,000x</code> faster</strong></td>
      </tr>
      <tr>
        <td><strong>MCP <code>tools/list</code> Catalog (11 tools)</strong></td>
        <td><code>~120 ms</code> <em>(external CLI spawn)</em></td>
        <td><strong><code>0.013 ms</code></strong> <em>(13 microseconds from frozen <code>CONSTRUCT_TOOL_SPECS</code>)</em></td>
        <td><strong><code>~9,200x</code> faster</strong></td>
      </tr>
      <tr>
        <td><strong>Record Frame / Update Head (<code>construct_rec</code> / <code>head</code>)</strong></td>
        <td><code>123.5 ms</code> (CLI spawn) or <code>2,500 ms</code> (LLM <code>Edit</code> on <code>HANDOFF.md</code>)</td>
        <td><strong><code>2.4 ms</code></strong> <em>(direct in-process SQLite WAL write)</em></td>
        <td><strong><code>51x - 1,000x</code> faster</strong></td>
      </tr>
      <tr>
        <td><strong>Session Boot Briefing (<code>store.bootProject</code>)</strong></td>
        <td><code>2,000 - 4,500 ms</code> <em>(LLM calling <code>Read</code> on 3-4 markdown files)</em></td>
        <td><strong><code>5.26 ms</code></strong> (<code>generic</code>) / <strong><code>14.49 ms</code></strong> (9-seat Crew)</td>
        <td><strong><code>~250x</code> faster (0 model roundtrips)</strong></td>
      </tr>
    </tbody>
  </table>

  <h2 class="section-title">2. Interactive Crew Preview: How the 9 Seats Operate</h2>
  <p style="color:var(--muted);">Click any Crew Bank below to preview its run banner, 9-seat specialist pipeline, and in-character interjection style:</p>
  <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">${switcherButtons}</div>
  <div class="rom-card" id="preview-box">
    <div class="mono" id="preview-banner" style="color:var(--accent);font-weight:700;margin-bottom:8px;"></div>
    <div id="preview-title" style="font-size:18px;font-weight:700;color:#fff;margin-bottom:6px;"></div>
    <div class="mono" id="preview-pipeline" style="font-size:13px;color:var(--ok);margin-bottom:12px;"></div>
    <div class="cal-box cal-right" id="preview-sample"></div>
    <div style="margin-top:12px;"><a id="preview-link" class="pill-btn active" href="crews/sprawl.html">Open Full Crew Roster Page &rarr;</a></div>
  </div>

  <h2 class="section-title" id="crews">3. The 15 Crew Banks (179 Full-Depth ROMs)</h2>
  <p style="color:var(--muted);">Each Crew Bank lives in its own lazy-loaded module (<code>src/packs/&lt;bank&gt;.js</code>) so inactive banks consume <code>0</code> bytes of memory. Click any Crew Bank to inspect all 9 starter specialists, Bench seconds, behavioral dial meters, and Wrong vs. Right calibration pairs:</p>
  <div class="crew-grid">
    ${crewCardsHtml}
  </div>

  <div class="footer">
    Construct Sequential Memory &amp; Multi-Bank 9-Seat Crew Engine &bull; MIT + Commons Clause v1.0 &bull; <a href="guide.html">Read the Full Architecture &amp; Multi-Agent Guide &rarr;</a>
  </div>
</div>
<script>
const PREVIEW_DATA = ${JSON.stringify(interactivePreviewData)};
function showPreview(pack) {
  const d = PREVIEW_DATA[pack];
  if (!d) return;
  document.getElementById('preview-banner').textContent = d.banner;
  document.getElementById('preview-title').textContent = d.emblem + ' ' + d.title;
  document.getElementById('preview-pipeline').textContent = 'Pipeline: 🔵 ' + d.recon + ' (Recon) -> 🟠 ' + d.diag + ' (Trace) -> 🟣 ' + d.arch + ' (Alignment Gate) -> 🔴 ' + d.blitz + ' (Blitz) -> 📓 ' + d.book + ' (Archive)';
  document.getElementById('preview-sample').textContent = d.sample;
  document.getElementById('preview-link').href = 'crews/' + pack + '.html';
  document.getElementById('preview-link').textContent = 'Open Full ' + pack.toUpperCase() + ' Crew Page ->';
  document.querySelectorAll('[data-preview-pack]').forEach((btn) => {
    if (btn.getAttribute('data-preview-pack') === pack) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}
showPreview('sprawl');
</script>
</body>
</html>\n`;
}

function generateGuideHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Architecture, Multi-Agent Setup &amp; Personal Comms Guide -- Construct</title>
<link rel="stylesheet" href="assets/style.css" />
</head>
<body>
${renderNavBar('')}
<div class="container">
  <div class="hero">
    <div class="hero-eyebrow">Architecture &amp; Adopter Handbook</div>
    <h1>How Construct Fronts Every Coding Agent, Saves 72-80% of Tokens, and Connects Developers via Courier Cameos</h1>
    <p class="lead">Complete reference for Multi-Agent Setup (OpenCode, Claude Code, Cursor, Gemini CLI, Windsurf &amp; Codex), the 9-Seat Phase Gate, Sandwich Attention Ordering, Project &amp; Non-Collaborator Personal Comms (<code>@comms</code>), and the CLI.</p>
  </div>

  <h2 class="section-title" id="multi-agent">1. One-Command Setup Across All 6 Coding Agents</h2>
  <p>Construct's unified <code>src/mcp.js</code> engine exposes the exact same 11 tools, MCP prompts, MCP resources, and lifecycle hooks across every major AI coding environment against a single shared SQLite WAL database (<code>~/.config/opencode/construct.db</code>):</p>
  <table class="bench-table">
    <thead>
      <tr>
        <th>Coding Agent</th>
        <th>Setup Command</th>
        <th>What Construct Wires Automatically</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><strong>OpenCode V2</strong></td>
        <td><code>construct init</code></td>
        <td>Installs <code>~/.config/opencode/plugins/construct.js</code> + <code>tui.tsx</code>, wires <code>active-rom.md</code>, zero-roundtrip <code>prompt</code>/<code>context</code>/<code>shell</code> hooks, tab badges, idle Courier wake-up, and the <code>127.0.0.1:47420</code> HUD server.</td>
      </tr>
      <tr>
        <td><strong>Claude Code</strong></td>
        <td><code>construct init --claude</code></td>
        <td>Wires <code>~/.claude/CLAUDE.md</code>, <code>~/.claude/settings.json</code> (<code>mcpServers.construct</code> + <code>SessionStart</code>, <code>UserPromptSubmit</code>, <code>SubagentStart</code>, <code>PreToolUse</code> hooks), and all <strong>178 specialist subagents</strong> in <code>~/.claude/agents/*.md</code>.</td>
      </tr>
      <tr>
        <td><strong>Cursor IDE &amp; Cloud Agent</strong></td>
        <td><code>construct init --cursor</code></td>
        <td>Wires <code>~/.cursor/mcp.json</code>, <code>~/.cursor/rules/construct.mdc</code> (<code>alwaysApply: true</code>), and <code>~/.cursor/hooks.json</code> (<code>sessionStart</code>, <code>beforeSubmitPrompt</code>, <code>beforeShellExecution</code>, <code>postToolUse</code>).</td>
      </tr>
      <tr>
        <td><strong>Gemini CLI / Antigravity</strong></td>
        <td><code>construct init --gemini</code></td>
        <td>Wires <code>~/.gemini/GEMINI.md</code> and <code>~/.gemini/settings.json</code> (<code>mcpServers.construct</code> + <code>SessionStart</code>, <code>BeforeAgent</code>, and <code>BeforeTool</code> shell guard hooks).</td>
      </tr>
      <tr>
        <td><strong>Windsurf (Cascade)</strong></td>
        <td><code>construct init --windsurf</code></td>
        <td>Wires <code>~/.codeium/windsurf/mcp_config.json</code> and <code>~/.codeium/windsurf/memories/global_rules.md</code>.</td>
      </tr>
      <tr>
        <td><strong>Codex CLI</strong></td>
        <td><code>construct init --codex</code></td>
        <td>Wires <code>~/.codex/AGENTS.md</code> and registers <code>[mcp_servers.construct]</code> in <code>~/.codex/config.toml</code>.</td>
      </tr>
      <tr>
        <td><strong>Oh My Pi (<code>omp</code>)</strong></td>
        <td><code>construct init --omp</code></td>
        <td>Wires <code>~/.omp/agent/AGENTS.md</code>, <code>~/.omp/agent/mcp.json</code> (<code>mcpServers.construct</code>), and <code>~/.omp/agent/extensions/construct.js</code> (<code>before_agent_start</code> system prompt + thinking voice lock, <code>tool_call</code> shell guard + subagent <code>[ROM: &lt;name&gt;]</code>, and <code>/construct</code> command via <code>construct omp-hook</code>).</td>
      </tr>
    </tbody>
  </table>

  <h2 class="section-title" id="phase-gates">2. The 9 Canonical Seats &amp; Phase Gates (Including Documentation Parity)</h2>
  <p>Every Crew Bank maps 9 distinct characters onto 9 canonical engineering seats across a 4-stage pipeline:</p>
  <ol>
    <li><strong>Phase 1 -- Recon &amp; Trench Diagnostics (🔵 Seat 1A <code>recon</code> + 🟠 Seat 1B <code>diagnostics</code>):</strong> Reads the actual source contract first and traces any bug to its exact <code>file:line</code> coordinate.</li>
    <li><strong>Phase 2 -- Architecture &amp; The Alignment Gate (🟣 Seat 2 <code>architect</code>):</strong> Maps state invariants, contract boundaries, and concurrency seams, and <strong>waits for your green light</strong> before turning the Blitz seat loose.</li>
    <li><strong>Phase 3 -- Full-Depth Blitz, Parallel Overwatch &amp; Documentation Parity (🔴 Seat 3 <code>blitz</code> + 🟢 <code>forensics</code> + ⚡ <code>velocity</code> + 🛡️ <code>redteam</code> + 🎨 <code>ergonomics</code>):</strong> Implements the complete change at full depth (never a skeleton), watches the regression test fail red on the unfixed state before restoring the fix, audits security/artifacts/latency/UX, and <strong>checks and updates <code>README.md</code>, <code>docs/</code>, and CLI <code>--help</code> for documentation parity in the same pass</strong>.</li>
    <li><strong>Phase 4 -- The Archive (📓 Seat 5 <code>archivist</code>):</strong> Records the inflection point onto the sequential tape (<code>#seq</code>), updates the project state head, and reconciles open vs. resolved threads.</li>
  </ol>

  <h2 class="section-title" id="personal-comms">3. Collaborator Project Sync vs. Non-Collaborator Personal Comms (<code>@comms</code>)</h2>
  <p>Construct supports two distinct encrypted DIDComm v2 + MLS (RFC 9420) connection modes over zero-signup WebSocket relays (<code>wss://nos.lol</code>, <code>wss://relay.damus.io</code>, or self-hosted <code>construct relay</code>):</p>
  <div class="cal-grid">
    <div class="rom-card" style="margin:0;">
      <h3 style="margin-top:0;color:var(--accent);">Mode A: Project Collaboration Invite (<code>construct invite &lt;project&gt;</code>)</h3>
      <p>For teammates working on the same git repository:</p>
      <pre class="code-block"># Alice creates a project invite
construct invite acme/alpha_app

# Bob joins (auto-clones repo if missing &amp; syncs tape/gotchas)
construct join "construct://invite/eyJ...#..." --dir ~/src/alpha_app
construct sync acme/alpha_app</pre>
      <p style="font-size:13.5px;color:var(--muted);">Syncs <code>frames</code>, project <code>gotchas</code>, <code>heads</code>, and person-to-person Courier <code>messages</code> for <code>acme/alpha_app</code> while enforcing strict per-project isolation (zero bleed from your other private repos or global gotchas).</p>
    </div>
    <div class="rom-card" style="margin:0;">
      <h3 style="margin-top:0;color:var(--ok);">Mode B: Non-Collaborator Personal Comms (<code>construct invite comms</code>)</h3>
      <p>For friends or colleagues who want to exchange in-character Courier Cameos (<code>--via smeagol</code>, <code>--via death</code>, <code>--via toot</code>, <code>--via moist</code>) <strong>without sharing any git repository</strong>:</p>
      <pre class="code-block"># Alice creates a personal comms-only invite (no project repo!)
construct invite comms

# Carol joins (no --dir or workspace_root required, 0 git clone)
construct join "construct://invite/eyJ...#..."

# Send an in-character Courier message to Carol
construct msg --to carol --via smeagol "Ssshh! How is it working, precious?"</pre>
      <p style="font-size:13.5px;color:var(--muted);">The <code>@comms</code> channel enforces a hard cryptographic boundary guard in <code>src/crdt.js</code>: <strong>only</strong> <code>message</code> and <code>message_tombstone</code> operations are exported or accepted on <code>@comms</code>; any <code>frame</code>, <code>gotcha</code>, or <code>head</code> operation is rejected at the boundary.</p>
    </div>
  </div>

  <div class="footer">
    Construct Sequential Memory &amp; Multi-Bank 9-Seat Crew Engine &bull; <a href="index.html">Back to Brochure &amp; Benchmarks</a>
  </div>
</div>
</body>
</html>\n`;
}

function generateDocsSite(options = {}) {
  const outDir = options.outDir || path.resolve(__dirname, '..', 'docs');
  const crewsDir = path.join(outDir, 'crews');
  const assetsDir = path.join(outDir, 'assets');
  fs.mkdirSync(crewsDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, '.nojekyll'), '', 'utf8');
  const cssPath = path.join(assetsDir, 'style.css');
  fs.writeFileSync(cssPath, buildStylesheet(), 'utf8');

  const allMeta = packs.getAllPackMetadata();
  const allPackNames = Object.keys(allMeta);
  const romCountsByPack = {};
  const crewPages = [];

  for (const pName of allPackNames) {
    const packRoms = packs.loadPackRoms(pName);
    romCountsByPack[pName] = packRoms.length;
    const html = generateCrewPageHtml(pName, allMeta[pName], packRoms, allPackNames);
    const pagePath = path.join(crewsDir, `${pName}.html`);
    fs.writeFileSync(pagePath, html, 'utf8');
    crewPages.push(pagePath);
  }

  const indexPath = path.join(outDir, 'index.html');
  fs.writeFileSync(indexPath, generateIndexHtml(allMeta, romCountsByPack), 'utf8');

  const guidePath = path.join(outDir, 'guide.html');
  fs.writeFileSync(guidePath, generateGuideHtml(), 'utf8');

  return {
    outDir,
    indexPath,
    guidePath,
    cssPath,
    crewPages,
  };
}

module.exports = {
  generateDocsSite,
};
