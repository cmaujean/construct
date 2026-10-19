// Repository Instruction File Assimilator.
//
// Scans a directory for standard AI instruction files (`AGENTS.md`, `CLAUDE.md`,
// `GEMINI.md`, `.cursorrules`, `.github/copilot-instructions.md`) and digests
// structured gotchas (`### <Gotcha>`), operator profiles (`## Who you are working with`),
// and script command tables (`| \`cmd\` | from | does |`) directly into `construct.db`.
// Optionally removes the digested files (`--remove-files`), or records their SHA-256
// hashes in `assimilated_files` so shared-repo files are shadowed in memory.
//
// Zero git pollution: Construct never writes any Construct-related files or
// `AGENTS.md` headers into target project repositories.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Parse markdown `### <Claim>` sections into structured `{ title, status, evidence, fix, created }` gotcha entries
function parseGotchasMarkdown(mdText) {
  const entries = [];
  const lines = String(mdText || '').split(/\r?\n/);
  let current = null;
  let inSkippedSection = false;
  let inBulletEntrySection = false;

  for (const rawLine of lines) {
    const h2 = rawLine.match(/^##\s+(.+)$/);
    if (h2) {
      if (current) entries.push(finalizeGotchaEntry(current));
      current = null;
      const sec = h2[1].trim();
      inSkippedSection = /^(what goes in it|why it has to be|the format|format|rules|categories that tend|the instruction|who you are working with|scratch files|model routing|verification expectations|development execution|issue creation)/i.test(
        sec
      );
      inBulletEntrySection = /^(dependencies and publishing)/i.test(sec);
      continue;
    }
    if (inSkippedSection) continue;

    const h3 = rawLine.match(/^###\s+(.+)$/);
    if (h3) {
      const heading = h3[1].trim();
      if (
        heading.startsWith('<') ||
        /^(the format|what goes in it|why it has to be|entries|categories|the instruction|the rules that fall out|the testing lesson|the lesson that is bigger|why it took|the fix, and the part|the second gate)/i.test(
          heading
        )
      ) {
        if (current && !/^(the format|what goes in it|why it has to be|entries|categories|the instruction)/i.test(heading)) {
          current.bodyLines.push(`${heading}:`);
        } else {
          current = null;
        }
        continue;
      }
      if (current) entries.push(finalizeGotchaEntry(current));
      current = {
        title: heading,
        status: 'observed',
        bodyLines: [],
        created: '',
      };
      continue;
    }

    if (inBulletEntrySection) {
      const boldBullet = rawLine.match(/^-\s+\*\*([^*]+)\*\*\s*(.*)$/);
      if (boldBullet && boldBullet[1].length > 15) {
        if (current) entries.push(finalizeGotchaEntry(current));
        current = {
          title: boldBullet[1].replace(/\.\s*$/, '').trim(),
          status: 'observed',
          bodyLines: boldBullet[2] ? [boldBullet[2]] : [],
          created: '',
        };
        continue;
      }
    }

    if (!current) continue;
    current.bodyLines.push(rawLine);
  }
  if (current) entries.push(finalizeGotchaEntry(current));
  return entries.filter((e) => e.title && (e.evidence || e.fix));
}

function finalizeGotchaEntry(raw) {
  const body = raw.bodyLines.join('\n').trim();
  let status = 'observed';
  if (/\*\*from source\*\*/i.test(body)) status = 'from_source';
  else if (/\*\*reported\*\*/i.test(body)) status = 'reported';

  let created = '';
  const dateMatch = body.match(/(?:Found|observed|Extended|merged)\s+(\d{4}-\d{2}-\d{2})/i);
  if (dateMatch) created = dateMatch[1];

  // Split into paragraphs (excluding horizontal rules `---` and trailing `Found YYYY-MM-DD...` provenance footers)
  // Preserve leading indentation so 4-space indented code blocks (`^ {4}`) are classified accurately before trimming.
  const rawParagraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^(?:\r?\n)+|\s+$/g, ''))
    .filter((p) => p.trim() && p.trim() !== '---' && !/^Found\s+\d{4}-\d{2}-\d{2}\b/i.test(p.trim()));

  const codeOrIndented = rawParagraphs.filter((p) => /^(`{3}| {4})/.test(p)).map((p) => p.trim());
  const prose = rawParagraphs.filter((p) => !/^(`{3}| {4})/.test(p)).map((p) => p.trim());

  const evidenceParts = [];
  if (prose.length > 0) evidenceParts.push(prose[0].replace(/^\*\*(observed|from source|reported)\*\*\s*[-—]*\s*/i, ''));
  if (codeOrIndented.length > 0) evidenceParts.push(codeOrIndented[0].replace(/^ {4}/gm, '').trim());

  const fixParts = prose.length > 1 ? prose.slice(1) : prose;

  return {
    title: raw.title,
    status,
    evidence: evidenceParts.join(' | ').slice(0, 600),
    fix: fixParts[fixParts.length - 1]?.slice(0, 600) || '',
    created: created || new Date().toISOString().slice(0, 10),
  };
}

// Extract an operator agreement block (`# Working with <Name>` + `## Who you are working with`) if present in an instruction file
function parseAgreementMarkdown(filePath, mdText) {
  const titleMatch = mdText.match(/^#\s+Working with\s+([A-Za-z0-9_-]+)$/m);
  const whoMatch = mdText.match(/##\s+Who you are working with\s+([\s\S]*)$/i);
  if (!titleMatch && !whoMatch) return null;

  const rawName = titleMatch ? titleMatch[1].trim() : path.basename(filePath, '.md');
  const id = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!id || id === 'template' || id === 'readme' || id === 'agents' || id === 'claude' || id === 'gemini') return null;
  const name = titleMatch ? rawName : id.charAt(0).toUpperCase() + id.slice(1);

  const platformMatch = mdText.match(/\*\*Platform:\*\*\s*(.+)$/m);
  const platform = platformMatch ? platformMatch[1].trim() : '';

  const bodyAfterWho = whoMatch ? whoMatch[1].trim() : mdText.trim();
  const whoSectionOnlyMatch = mdText.match(/##\s+Who you are working with\s+([\s\S]*?)(?=\n##\s+|\s*$)/i);
  const whoSectionText = whoSectionOnlyMatch ? whoSectionOnlyMatch[1].trim() : bodyAfterWho;

  const paragraphs = whoSectionText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const experience =
    paragraphs.find((p) => !p.startsWith('-') && !p.startsWith('*') && !p.startsWith('>')) || '';

  const calibration = experience
    ? bodyAfterWho.replace(experience, '').replace(/^\s+/, '').trim()
    : bodyAfterWho;

  return {
    id,
    name,
    osUsers: [id],
    experience: experience.replace(/\r?\n/g, ' ').trim(),
    platform,
    calibration: calibration || whoSectionText,
  };
}

// Extract script table (`| \`cmd\` | from | does |`) from markdown instruction files
function parseScriptsMarkdown(mdText) {
  const rows = [];
  for (const line of String(mdText || '').split(/\r?\n/)) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]+)\|\s*([^|]+)\|/);
    if (m) {
      rows.push(`\`${m[1].trim()}\` (${m[2].trim()}): ${m[3].trim()}`);
    }
  }
  return rows;
}

const INSTRUCTION_FILENAMES = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
]);

function discoverInstructionFiles(absDir) {
  const found = [];
  for (const rel of INSTRUCTION_FILENAMES) {
    const full = path.join(absDir, ...rel.split('/'));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      found.push({
        file: rel,
        path: full,
        content: fs.readFileSync(full, 'utf8'),
      });
    }
  }
  return found;
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function assimilateDirectory(store, targetDir, options = {}) {
  const absDir = path.resolve(targetDir);
  if (!fs.existsSync(absDir)) {
    throw new Error(`directory does not exist: ${absDir}`);
  }

  const resolvedProj =
    options.project ||
    (typeof store.resolveProjectFromDir === 'function' ? store.resolveProjectFromDir(absDir) : '');
  const scope = resolvedProj && resolvedProj !== 'global' ? store.normalizeProject(resolvedProj) : 'global';

  const instructionFiles = discoverInstructionFiles(absDir);
  const removeFiles = Boolean(options.removeFiles || options.removeLdk);

  const result = {
    scope,
    found: instructionFiles.length > 0,
    usersImported: [],
    gotchasImported: 0,
    scriptsExtracted: 0,
    instructionFiles: instructionFiles.map((f) => ({
      file: f.file,
      path: f.path,
      bytes: Buffer.byteLength(f.content, 'utf8'),
    })),
    removedInstructionFiles: [],
  };

  if (!result.found) return result;

  const existingUsersById = new Map(store.listUsers().map((u) => [u.id, u]));
  const existingGotchasByTitle = new Map(store.listGotchas(scope).map((g) => [g.title.toLowerCase(), g]));
  const scriptLines = [];

  for (const doc of instructionFiles) {
    // 1. Extract optional `# Working with <Name>` operator profile
    const parsedUser = parseAgreementMarkdown(doc.path, doc.content);
    if (parsedUser) {
      const prev = existingUsersById.get(parsedUser.id);
      const shouldUpdate =
        !prev ||
        scope === 'global' ||
        (!prev.active && parsedUser.calibration.length > (prev.calibration || '').length);
      if (shouldUpdate) {
        store.setUser(parsedUser.id, {
          name: parsedUser.name,
          osUsers: parsedUser.osUsers,
          experience: parsedUser.experience,
          platform: parsedUser.platform,
          calibration: parsedUser.calibration,
          active: existingUsersById.size === 0 ? true : undefined,
        });
        existingUsersById.set(parsedUser.id, parsedUser);
        result.usersImported.push(parsedUser.id);
      }
    }

    // 2. Extract structured `### <Gotcha>` entries
    const parsedGotchas = parseGotchasMarkdown(doc.content);
    for (const g of parsedGotchas) {
      const key = g.title.toLowerCase();
      const prev = existingGotchasByTitle.get(key);
      if (prev) {
        if (/^Found\s+\d{4}-\d{2}-\d{2}\b/i.test(String(prev.fix || '').trim()) && typeof store.removeGotcha === 'function') {
          store.removeGotcha(prev.id);
        } else {
          continue;
        }
      }
      store.addGotcha({
        scope,
        title: g.title,
        status: g.status,
        evidence: g.evidence,
        fix: g.fix,
        created: g.created,
      });
      existingGotchasByTitle.set(key, g);
      result.gotchasImported++;
    }

    // 3. Extract `| \`cmd\` | from | does |` script tables
    for (const s of parseScriptsMarkdown(doc.content)) {
      if (!scriptLines.includes(s)) scriptLines.push(s);
    }
  }

  result.scriptsExtracted = scriptLines.length;

  if (scope !== 'global') {
    if (result.gotchasImported > 0 || result.scriptsExtracted > 0 || result.usersImported.length > 0 || instructionFiles.length > 0) {
      const filesLabel = instructionFiles.length ? ` (${instructionFiles.map((f) => f.file).join(', ')})` : '';
      store.recordFrame({
        project: scope,
        kind: 'change',
        summary: `Assimilated project instructions${filesLabel} into construct: ${result.gotchasImported} gotcha(s), ${result.usersImported.length} operator agreement(s), ${result.scriptsExtracted} script command(s)`,
        detail: scriptLines.length ? `Commands:\n${scriptLines.join('\n')}` : '',
        verified: 'assimilated from repository instruction files',
      });
    }

    if (removeFiles) {
      for (const doc of instructionFiles) {
        fs.rmSync(doc.path, { force: true });
        result.removedInstructionFiles.push(doc.file);
      }
    } else if (typeof store.recordAssimilatedFiles === 'function') {
      const tracked = instructionFiles.map((f) => ({
        relPath: f.file,
        absPath: f.path,
        sha256: sha256Text(f.content),
      }));
      store.recordAssimilatedFiles(scope, tracked);
      result.shadowedFiles = tracked.map((t) => t.relPath);
    }
  }

  return result;
}

module.exports = {
  INSTRUCTION_FILENAMES,
  discoverInstructionFiles,
  parseGotchasMarkdown,
  parseAgreementMarkdown,
  parseScriptsMarkdown,
  assimilateDirectory,
};
