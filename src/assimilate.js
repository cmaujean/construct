// Instruction & Dev-Docs Assimilator.
//
// Scans a directory—either global (`~/.config/opencode/`) or project-local
// (`<repo>/AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `docs/dev/`, `docs/`)—
// and digests it directly into `~/.config/opencode/construct.db`:
//   1. `agreements/<name>.md` (excluding `TEMPLATE.md`) -> `users` table
//   2. `02-gotchas.md` / `gotchas.md`                   -> `gotchas` table (global or project scope)
//   3. `03-verification.md` & `04-scripts.md`           -> project `frame` metadata in `construct.db`
//   4. Optionally removes the digested files (`--remove-files`), or records their
//      SHA-256 hashes in `assimilated_files` so shared-repo files are shadowed in memory.
//
// Zero git pollution: Construct never writes any Construct-related files or
// `AGENTS.md` headers into target project repositories. Everything lives in
// `~/.config/opencode/construct.db` and fronts sessions via the global OpenCode plugin.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Parse a markdown `02-gotchas.md` file into structured `{ title, status, evidence, fix, created }` entries
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
      inSkippedSection = /^(what goes in it|why it has to be|the format|format|rules|categories that tend|the instruction)/i.test(sec);
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
        // Keep appending to current if it's a narrative sub-heading inside an existing entry
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

    // Support top-level `- **<Bold claim>.** <rest>` gotcha entries in bullet-organized sections (e.g. vs-dev-tools)
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

// Parse an `agreements/<name>.md` file into `{ id, name, experience, platform, calibration }`
function parseAgreementMarkdown(filePath, mdText) {
  const id = path.basename(filePath, '.md').toLowerCase();
  if (id === 'template' || id === 'readme') return null;

  const titleMatch = mdText.match(/^#\s+Working with\s+(.+)$/m);
  const name = titleMatch ? titleMatch[1].trim() : id.charAt(0).toUpperCase() + id.slice(1);

  const platformMatch = mdText.match(/\*\*Platform:\*\*\s*(.+)$/m);
  const platform = platformMatch ? platformMatch[1].trim() : '';

  const whoMatch = mdText.match(/##\s+Who you are working with\s+([\s\S]*)$/i);
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

// Extract script table or key commands from `04-scripts.md`
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

function collectLdkMarkdownFiles(ldkDir, repoRoot) {
  if (!fs.existsSync(ldkDir)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const content = fs.readFileSync(full, 'utf8');
        const rel = path.relative(repoRoot, full).replace(/\\/g, '/');
        out.push({ relPath: rel, absPath: full, sha256: sha256Text(content) });
      }
    }
  };
  walk(ldkDir);
  return out;
}

function assimilateDirectory(store, targetDir, options = {}) {
  const absDir = path.resolve(targetDir);
  if (!fs.existsSync(absDir)) {
    throw new Error(`directory does not exist: ${absDir}`);
  }

  const isDirectLdk =
    fs.existsSync(path.join(absDir, '02-gotchas.md')) ||
    fs.existsSync(path.join(absDir, 'gotchas.md')) ||
    fs.existsSync(path.join(absDir, '01-working-agreement.md')) ||
    fs.existsSync(path.join(absDir, 'working-agreement.md'));

  const ldkDir = isDirectLdk
    ? absDir
    : fs.existsSync(path.join(absDir, 'docs', 'dev'))
      ? path.join(absDir, 'docs', 'dev')
      : path.join(absDir, 'docs');
  const resolvedProj =
    options.project ||
    (!isDirectLdk && typeof store.resolveProjectFromDir === 'function' ? store.resolveProjectFromDir(absDir) : '');
  const scope = resolvedProj && resolvedProj !== 'global' ? store.normalizeProject(resolvedProj) : 'global';

  const instructionFiles = discoverInstructionFiles(absDir);
  const hasLdk = fs.existsSync(ldkDir);

  const result = {
    ldkDir,
    scope,
    found: hasLdk || instructionFiles.length > 0,
    usersImported: [],
    gotchasImported: 0,
    scriptsExtracted: 0,
    instructionFiles: instructionFiles.map((f) => ({ file: f.file, path: f.path, bytes: Buffer.byteLength(f.content, 'utf8') })),
    removedLdkDir: false,
    removedInstructionFiles: [],
  };

  if (!result.found) return result;

  if (hasLdk) {
    // 1. Assimilate `agreements/*.md`
    const agreementsDir = path.join(ldkDir, 'agreements');
    if (fs.existsSync(agreementsDir)) {
      const existingUsers = new Set(store.listUsers().map((u) => u.id));
      for (const entry of fs.readdirSync(agreementsDir)) {
        if (!entry.endsWith('.md')) continue;
        const fullPath = path.join(agreementsDir, entry);
        const parsed = parseAgreementMarkdown(fullPath, fs.readFileSync(fullPath, 'utf8'));
        if (!parsed) continue;
        if (!existingUsers.has(parsed.id) || scope === 'global') {
          store.setUser(parsed.id, {
            name: parsed.name,
            osUsers: parsed.osUsers,
            experience: parsed.experience,
            platform: parsed.platform,
            calibration: parsed.calibration,
            active: existingUsers.size === 0 ? true : undefined,
          });
          result.usersImported.push(parsed.id);
        }
      }
    }

    // 2. Assimilate `02-gotchas.md` or `gotchas.md`
    const gotchasFile = fs.existsSync(path.join(ldkDir, '02-gotchas.md'))
      ? path.join(ldkDir, '02-gotchas.md')
      : path.join(ldkDir, 'gotchas.md');
    if (fs.existsSync(gotchasFile)) {
      const parsedGotchas = parseGotchasMarkdown(fs.readFileSync(gotchasFile, 'utf8'));
      const existingTitles = new Set(store.listGotchas(scope).map((g) => g.title.toLowerCase()));
      for (const g of parsedGotchas) {
        if (existingTitles.has(g.title.toLowerCase())) continue;
        store.addGotcha({
          scope,
          title: g.title,
          status: g.status,
          evidence: g.evidence,
          fix: g.fix,
          created: g.created,
        });
        existingTitles.add(g.title.toLowerCase());
        result.gotchasImported++;
      }
    }
  }

  // Also parse any `### <Gotcha>` sections or command tables inside discovered instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`)
  let scriptLines = [];
  if (hasLdk) {
    const scriptsFile = path.join(ldkDir, '04-scripts.md');
    if (fs.existsSync(scriptsFile)) {
      scriptLines = parseScriptsMarkdown(fs.readFileSync(scriptsFile, 'utf8'));
    }
  }
  for (const doc of instructionFiles) {
    const extraScripts = parseScriptsMarkdown(doc.content);
    for (const s of extraScripts) {
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

    if (options.removeLdk) {
      if (hasLdk) {
        fs.rmSync(ldkDir, { recursive: true, force: true });
        result.removedLdkDir = true;
      }
      for (const doc of instructionFiles) {
        fs.rmSync(doc.path, { force: true });
        result.removedInstructionFiles.push(doc.file);
      }
    } else if (typeof store.recordAssimilatedFiles === 'function') {
      // Shared repo mode: files remain on disk in git for non-Construct teammates;
      // record their SHA-256 hashes so Construct shadows them in `event.system` and detects future edits.
      const tracked = [
        ...instructionFiles.map((f) => ({
          relPath: f.file,
          absPath: f.path,
          sha256: sha256Text(f.content),
        })),
        ...(hasLdk ? collectLdkMarkdownFiles(ldkDir, absDir) : []),
      ];
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
