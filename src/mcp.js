// Model Context Protocol (MCP) `stdio` Server, Shared Tool Engine & Claude Code Hook Bridge for Construct.
//
// Zero external dependencies:
// 1. Defines the single canonical `CONSTRUCT_TOOL_SPECS` (11 tools) shared by both the OpenCode V2
//    plugin (`plugin/construct.js`) and the MCP server (`MCP_TOOLS`), eliminating schema/handler duplication.
// 2. Speaks JSON-RPC 2.0 over `stdin`/`stdout` (supporting both MCP standard newline-delimited JSON-RPC
//    and `Content-Length` framed messages), exposing `tools`, `prompts`, `resources`, and
//    `initialize.result.instructions` to OpenCode, Claude Code, Cursor, Windsurf, Cline, Zed, or Goose.
// 3. Provides `runClaudeHook(mode, inputJson)`, `buildFrontierVoiceLock`, `detectPreSlotRomDirective`,
//    and `validateShellCommand`.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const store = require('./store');
const packs = require('./packs');
const romMod = require('./rom');
const protocol = require('./protocol');

const CONSTRUCT_BIN = path.join(__dirname, '..', 'bin', 'construct.js');

function resolveNodeExecutable(execPath = process.execPath) {
  return /node(?:\.exe)?$/i.test(String(execPath || '')) ? execPath : 'node';
}

function runConstructCli(args, options = {}) {
  return execFileSync(resolveNodeExecutable(), [CONSTRUCT_BIN, ...args], {
    encoding: 'utf8',
    timeout: Number(options.timeout || 15000),
    windowsHide: true,
  }).trim();
}

function parseSlashArgs(raw = '') {
  const input = String(raw || '').trim();
  if (!input) return [];
  const tokens = [];
  let cur = '';
  let inQuotes = false;
  let quoteChar = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '\\' && quoteChar === '"' && i + 1 < input.length) {
        cur += input[++i];
      } else if (ch === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuotes = true;
      quoteChar = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

const CONSTRUCT_CLI_COMMANDS = new Set([
  'init',
  'upgrade',
  'self-update',
  'mcp',
  'claude-hook',
  'cursor-hook',
  'gemini-hook',
  'omp-hook',
  'assimilate',
  'boot',
  'rec',
  'record',
  'head',
  'resolve',
  'reopen',
  'tape',
  'zoom',
  'search',
  'find',
  'why',
  'issues',
  'issue',
  'pr',
  'prs',
  'hud',
  'status',
  'dashboard',
  'view',
  'hud-server',
  'edit',
  'projects',
  'ls',
  'rom',
  'pack',
  'packs',
  'user',
  'operator',
  'gotcha',
  'gotchas',
  'msg',
  'ask',
  'drop',
  'apply-drop',
  'reply',
  'ack',
  'hide-msg',
  'msg-hide',
  'rm-msg',
  'msg-rm',
  'delete-msg',
  'purge-msg',
  'msg-purge',
  'inbox',
  'messages',
  'did',
  'identity',
  'invite',
  'join',
  'sync',
  'site',
  'docs-site',
  'relay',
  'packet',
  'help',
  '--help',
  '-h',
]);

function executeConstructSlashCommand(rawArgs = '', options = {}) {
  const raw = String(rawArgs || '').trim();
  const sessionId = String(options.sessionId || '');
  const cwd = String(options.cwd || '');
  const tokens = parseSlashArgs(raw);

  if (tokens.length === 0) {
    let snap = null;
    try {
      snap = store.getHudSnapshot({ dir: cwd, sessionId });
    } catch (_) {}
    return {
      kind: 'selector',
      cliArgs: [],
      output: '',
      isError: false,
      reloadPlugin: false,
      openHud: true,
      statusText: snap?.tabBadge || snap?.pill || '',
      message: `Construct active: ${snap?.pill || snap?.rom || 'crew'}`,
      promptText:
        'Open `~/.config/opencode/construct-hud.html` in the Review pane with `tools.browser.preview` and call the `question` tool to present the Construct Crew Bank & Bench Switcher selector.',
    };
  }

  const first = tokens[0].toLowerCase();
  let cliArgs = [];
  let kind = 'cli';

  if (first === 'reload' || first === 'hot-reload') {
    cliArgs = ['init', '--all', ...tokens.slice(1)];
    kind = 'reload';
  } else if (first === 'sub' && tokens[1] && isValidRomTarget(tokens[1])) {
    cliArgs = ['rom', 'sub', tokens[1].toLowerCase(), ...tokens.slice(2)];
    kind = 'rom-sub';
  } else if (first === 'use' && tokens[1] && isValidRomTarget(tokens[1])) {
    cliArgs = ['rom', 'use', tokens[1].toLowerCase(), ...tokens.slice(2)];
    kind = 'rom-use';
  } else if (!CONSTRUCT_CLI_COMMANDS.has(first) && isValidRomTarget(tokens.join(','))) {
    cliArgs = ['rom', 'use', tokens.join(',').toLowerCase()];
    kind = 'rom-use';
  } else {
    cliArgs = [...tokens];
    kind = 'cli';
  }

  const cmd = String(cliArgs[0] || '').toLowerCase();
  const isHelp =
    cmd === 'help' ||
    cmd === '--help' ||
    cmd === '-h' ||
    cliArgs.includes('--help') ||
    cliArgs.includes('-h');
  const noAutoDirCmds = new Set(['init', 'upgrade', 'self-update', 'site', 'docs-site', 'help', '--help', '-h']);

  if (!isHelp && sessionId && !cliArgs.includes('--session')) {
    cliArgs.push('--session', sessionId);
  }
  if (!isHelp && cwd && !noAutoDirCmds.has(cmd) && !cliArgs.includes('--dir')) {
    cliArgs.push('--dir', cwd);
  }

  let output = '';
  let isError = false;
  try {
    output = runConstructCli(cliArgs, { timeout: 30000 });
  } catch (err) {
    isError = true;
    output = `error: ${(err.stderr && String(err.stderr).trim()) || err.message}`;
  }

  const romSubCmd = String(cliArgs[1] || '').toLowerCase();
  const reloadPlugin =
    kind === 'reload' ||
    ['init', 'upgrade', 'self-update'].includes(cmd) ||
    (cmd === 'rom' && ['use', 'sub', 'default', 'tune', 'burn', 'unburn', 'set', 'clone', 'sync'].includes(romSubCmd));
  const openHud = kind === 'rom-use' || cmd === 'hud' || cmd === 'dashboard' || cmd === 'view';

  let snap = null;
  try {
    snap = store.getHudSnapshot({ dir: cwd, sessionId });
  } catch (_) {}
  const statusText = snap?.tabBadge || snap?.pill || '';

  let message = '';
  let promptText = '';
  if (!isError && (kind === 'rom-sub' || (cmd === 'rom' && romSubCmd === 'sub' && cliArgs[2]))) {
    const subTarget = cliArgs[2];
    message = `Subbed ${subTarget} into active crew${snap?.pill ? ` (${snap.pill})` : ''}`;
    promptText = `Subbed \`${subTarget}\` into the active crew (${snap?.pill || ''}). Confirm in voice.`;
  } else if (!isError && (kind === 'rom-use' || (cmd === 'rom' && romSubCmd === 'use' && cliArgs[2]))) {
    const useTarget = cliArgs[2];
    message = `Switched session to ${useTarget}${snap?.pill ? ` (${snap.pill})` : ''}`;
    promptText = `Switched this session to \`${useTarget}\` (${snap?.pill || ''}). Confirm in the new Crew's voice and open \`~/.config/opencode/construct-hud.html\` with \`tools.browser.preview\`.`;
  } else if (!isError && openHud) {
    message = output ? output.split(/\r?\n/)[0] : `Construct HUD refreshed (${snap?.pill || ''})`;
    promptText = `Executed \`/construct ${raw}\`:\n\`\`\`\n${output}\n\`\`\`\nOpen \`~/.config/opencode/construct-hud.html\` in the Review pane with \`tools.browser.preview\` and confirm in the active Crew's voice.`;
  } else {
    message = output ? output.split(/\r?\n/)[0] : `Executed /construct ${raw}`;
    promptText = `Executed \`/construct ${raw}\`${reloadPlugin ? ' (and hot-reloaded Construct MCP/plugin engine in memory)' : ''}:\n\`\`\`\n${output || '(done)'}\n\`\`\`\nReport the result concisely in the active Crew's voice.`;
  }

  return {
    kind,
    cliArgs,
    output,
    isError,
    reloadPlugin,
    openHud,
    statusText,
    message,
    promptText,
  };
}

function validateShellCommand(command, customGuardsOrOptions = null, maybeOptions = {}) {
  const cmd = String(command || '');
  const hasExplicitGuards = Array.isArray(customGuardsOrOptions);
  const customGuards = hasExplicitGuards ? customGuardsOrOptions : null;
  const options =
    hasExplicitGuards || customGuardsOrOptions === null
      ? maybeOptions || {}
      : customGuardsOrOptions || {};
  const hostPlatform = String(options?.platform || process.platform).toLowerCase();
  // 1. Block heredocs (`<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`) [all platforms]
  if (/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(cmd)) {
    throw new Error(
      'Construct Shell Guard (Gotcha #1): Heredocs (<<EOF) fail unpredictably in non-interactive shells. Use the Write/Edit tools for files, or write multi-line scripts/commit messages to a scratchpad file first.'
    );
  }
  // 2. Block piping build/test commands into `tail`, `head`, `grep`, `Select-Object`, `Select-String`, `ForEach-Object`, `Out-Null`, `awk`, or `sed` without `pipefail` [all platforms]
  if (
    !/\bpipefail\b/.test(cmd) &&
    /\b(?:flutter\s+(?:build|test|analyze)|npm\s+(?:test|run\s+(?:build|test))|dotnet\s+(?:build|test)|cargo\s+(?:build|test)|jest|pytest)\b[^|;\r\n]*\|\s*(?:tail|head|grep|Select-Object|Select-String|ForEach-Object|Out-Null|awk|sed)\b/i.test(
      cmd
    )
  ) {
    throw new Error(
      'Construct Shell Guard (Gotcha #3): Piping a build or test command into `tail`, `head`, `grep`, `Select-Object`, `Select-String`, `ForEach-Object`, `Out-Null`, `awk`, or `sed` swallows the compiler/test exit code and reports failures as 0. Redirect to a log file and check `$LASTEXITCODE` / `echo "exit=$?"`, or set `pipefail`.'
    );
  }
  // 3. Block inline `gh api graphql -f query=` containing inner double quotes [win32 only: PowerShell 5.1 strips them]
  if (hostPlatform === 'win32' && /\bgh\s+api\s+graphql\b[^\r\n]*-f\s+query=[^\r\n]*"/i.test(cmd)) {
    throw new Error(
      'Construct Shell Guard (Gotcha #4 [win32]): PowerShell 5.1 strips inner double quotes on inline `gh api graphql -f query=...` calls. Write the JSON payload to a scratchpad file and pass `--input <scratch>/payload.json`.'
    );
  }
  // 4. Block disabling Git's NTFS path protection guard (`core.protectNTFS=false`) OR staging `:Zone.Identifier` files [all platforms]
  if (
    /core\.protectntfs\s*(?:=|\s+)\s*(?:false|0|no)\b/i.test(cmd) ||
    /\bgit\s+add\b[^\r\n]*:Zone\.Identifier/i.test(cmd)
  ) {
    throw new Error(
      'Construct Shell Guard (Gotcha #6 [all]): Never disable core.protectNTFS or stage `:Zone.Identifier` streams (invisible on Linux/macOS, breaks Windows NTFS checkouts). Remove the offending path instead.'
    );
  }
  // 5. Enforce explicit customGuards array when passed directly by unit tests
  if (Array.isArray(customGuards)) {
    for (const g of customGuards) {
      if (!g?.guardRegex) continue;
      const guardPlat = String(g.guardPlatform || 'all').toLowerCase();
      if (guardPlat !== 'all' && guardPlat !== hostPlatform) continue;
      try {
        const re = new RegExp(g.guardRegex, 'i');
        if (re.test(cmd)) {
          const fixHint = g.fix ? ` Do instead: ${g.fix}` : '';
          throw new Error(
            `Construct Shell Guard (Gotcha #${g.id} [${g.scope || 'global'}/${guardPlat}]): ${g.title}.${fixHint}`
          );
        }
      } catch (err) {
        if (String(err.message || '').startsWith('Construct Shell Guard')) throw err;
      }
    }
  }
  // 6. Enforce dynamic `--guard` regular expressions registered in SQLite (`global` + resolved `project`)
  const resolvedProject =
    options?.project ||
    (options?.dir && typeof store.resolveProjectFromDir === 'function'
      ? store.resolveProjectFromDir(options.dir)
      : '');
  store.checkDynamicGotchaGuards(cmd, { platform: hostPlatform, project: resolvedProject });
  return true;
}

// Build a compact (~55-token) generation-frontier voice lock from the active `<construct-live-memory>`
// output so sessions with 500+ historical messages or 30-step tool loops never drift into generic
// assistant prose or stock `### 1. Heading` templates at the end of the context window.
function buildFrontierVoiceLock(bootOutput = '') {
  const text = String(bootOutput || '');
  if (!text) return '';

  const hasCourier = text.includes('INCOMING CONSTRUCT COURIER') || text.includes('CONSTRUCT COURIER REPLIES');
  const courierLine = hasCourier
    ? `\nPENDING COURIER ALERT: Hold the Courier cameo until your FINAL turn-closing message (do NOT bury it inside intermediate tool calls), and place the Courier cameo at the VERY BOTTOM of your final reply so the operator sees it immediately upon returning!`
    : '';

  const bannerMatch = text.match(/Start visible replies directly with ([^\n]+?) or the active speaker/);
  const tagMatch = text.match(/Prefix speaker switches with their tag \(e\.g\. ([^\n)]+)\)/);
  if (bannerMatch || tagMatch) {
    const banner = bannerMatch ? bannerMatch[1].trim() : 'the active Crew Bank banner';
    const tags = tagMatch ? tagMatch[1].trim() : 'color-coded speaker tags';
    return (
      `<construct-voice-lock>\n` +
      `ACTIVE CREW VOICE LOCK: Start new runs with ${banner} or a color-coded speaker tag (${tags}). ` +
      `Write 100% in that character's distinct cadence, vocabulary, and worldview—including every brief tool-step checkpoint ` +
      `(NEVER write generic "Checking git status.", "Reading lines...", or stock \`### 1. Heading\` status templates, even if earlier messages in history did).${courierLine}\n` +
      `</construct-voice-lock>`
    );
  }

  const soloMatch = text.match(/^# Active Session (?:Personality )?ROM:\s*([^\n]+)/m);
  if (soloMatch) {
    return (
      `<construct-voice-lock>\n` +
      `ACTIVE ROM VOICE LOCK (${soloMatch[1].trim()}): Stay 100% in this character's distinct cadence, vocabulary, and worldview—including every brief tool-step checkpoint ` +
      `(NEVER revert to generic assistant narration or stock \`### 1. Heading\` status templates, even if earlier messages in history did).${courierLine}\n` +
      `</construct-voice-lock>`
    );
  }

  return '';
}

// Single canonical specification for all 11 Construct tools.
// Used directly by `plugin/construct.js` (`tools.construct.<name>`) and mapped to `construct_<name>` in `MCP_TOOLS`.
const CONSTRUCT_TOOL_SPECS = Object.freeze([
  {
    name: 'boot',
    description: "Read a project's live state head, open threads, project gotchas, and sequential tape (or omit project/dir to list all projects).",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key, e.g. acme/alpha_app. Omit to list all projects.' },
        dir: { type: 'string', description: 'Optional directory path to resolve the project from.' },
        session: { type: 'string', description: 'Optional session ID for session-isolated ROM resolution.' },
        limit: { type: 'integer', description: 'Number of recent sequential frames (default 25)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'rec',
    description: 'Append a frame onto the sequential memory tape.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['intent', 'probe', 'finding', 'dead_end', 'decision', 'change', 'commit', 'release', 'thread'],
        },
        summary: { type: 'string' },
        detail: { type: 'string' },
        verified: { type: 'string' },
        parent: { type: 'integer' },
        resolves: { type: 'string', description: 'Comma-separated seq IDs resolved by this frame' },
        open: { type: 'boolean' },
        refs: { type: 'string', description: 'Comma-separated refs, e.g. #98,commit:2fdd265' },
      },
      required: ['project', 'kind', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'head',
    description: "Update a project's current state head (state, next step, and local repo path).",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        state: { type: 'string' },
        next: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['project', 'state'],
      additionalProperties: false,
    },
  },
  {
    name: 'resolve',
    description: 'Resolve one or more open thread frames by seq ID (and optionally close linked GitHub issues when `closeGh: true` is explicitly passed).',
    inputSchema: {
      type: 'object',
      properties: {
        seqs: { type: 'string', description: "Comma-separated frame seq IDs to resolve, e.g. '28,29'" },
        by: { type: 'integer', description: 'Existing frame seq that resolved them' },
        reason: { type: 'string', description: 'If given without `by`, records a new resolution frame with this summary' },
        verified: { type: 'string' },
        closeGh: { type: 'boolean', description: 'When true, also closes any linked `gh:#N` GitHub issues on the repository' },
      },
      required: ['seqs'],
      additionalProperties: false,
    },
  },
  {
    name: 'zoom',
    description: 'Zoom into a frame by seq: full detail, causal chain, and neighboring tape window.',
    inputSchema: {
      type: 'object',
      properties: {
        seq: { type: 'integer' },
        window: { type: 'integer', description: 'Neighboring frames before/after (default 3)' },
      },
      required: ['seq'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description: 'FTS5 BM25 search across the sequential tape, or unified provenance lookup (`why: true` for gotchas + CRDT tape authors + git log + optional peer Construct query).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        project: { type: 'string' },
        kind: { type: 'string' },
        open: { type: 'boolean' },
        why: { type: 'boolean', description: 'Run unified provenance lookup (`construct why`) across gotchas, CRDT tape authors, and git log' },
        ask: { type: 'string', description: 'Optional teammate user id to query over MLS comms when `why: true`' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'rom',
    description: 'List, inspect, slot a ROM or Crew Bank (`use`: sprawl, nightcity, anathem, cryptonomicon, shadowrun, dresden, amber, laundry, tolkien, discworld, reamde, irondruid, prydain, clockwork, generic, or solo/roster), substitute a bench backup (`sub`), set/clear default (`default`), list banks (`packs`), tune dials, or create custom ROMs (`set`).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['packs', 'list', 'show', 'use', 'sub', 'default', 'tune', 'burn', 'unburn', 'set', 'sync'],
        },
        target: {
          type: 'string',
          description: "ROM or Crew Bank name (sprawl, discworld, reamde, clockwork, generic, or solo/roster for show/use/default, backup name for sub, 'off' to clear default, dial=val pairs for tune, directive text for burn, or index for unburn)",
        },
        rom: { type: 'string', description: 'Optional ROM name when tuning or burning a non-active ROM' },
        pack: { type: 'string', description: 'Crew bank name when filtering list or creating a custom ROM with `set`' },
        seat: {
          type: 'string',
          enum: ['recon', 'diagnostics', 'architect', 'blitz', 'forensics', 'velocity', 'redteam', 'ergonomics', 'archivist', 'instrument'],
        },
        tier: { type: 'string', enum: ['primary', 'backup'] },
        handle: { type: 'string' },
        tagline: { type: 'string' },
        voice: { type: 'string' },
        session: { type: 'string', description: 'Optional session ID when slotting a ROM for a specific session' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'user',
    description: "Inspect, list, switch, or register an operator's personal working agreement.",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['show', 'list', 'use', 'set'],
        },
        id: { type: 'string', description: "Operator id, e.g. 'alice' or 'bob'" },
        name: { type: 'string' },
        osUsers: { type: 'string', description: 'Comma-separated OS usernames mapped to this operator' },
        experience: { type: 'string' },
        platform: { type: 'string' },
        workspaceRoot: { type: 'string', description: 'Optional base folder for git repositories (e.g. ~/src, ~/code, D:\\projects)' },
        calibration: { type: 'string' },
        use: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'gotcha',
    description: 'List, add, search, or remove global or project-scoped gotchas.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'search', 'rm'],
        },
        project: { type: 'string', description: "Scope: omit or 'global' for machine-wide, '<project>' for project-specific, or 'all'" },
        title: { type: 'string', description: 'Gotcha title (for add), search query (for search), or id (for rm)' },
        status: { type: 'string', enum: ['observed', 'from_source', 'reported'] },
        evidence: { type: 'string' },
        fix: { type: 'string' },
        guard: { type: 'string', description: 'Optional regular expression to enforce as a 0-token pre-execution shell guard' },
        guardOs: {
          type: 'string',
          enum: ['all', 'win32', 'linux', 'darwin'],
          description: "Target OS for the shell guard ('all' for repo-wide guards like :Zone.Identifier, or 'win32'/'linux'/'darwin' for OS-specific shell/path traps)",
        },
        tags: { type: 'string', description: 'Comma-separated tags' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'comms',
    description: "Send, reply, acknowledge, hide, purge, or list person-to-person Construct messages, or drop/apply encrypted patches & snippets (`drop` / `apply-drop`), optionally specifying a courier/messenger ROM (`via`: e.g. 'smeagol', 'moist', 'toot', 'bob', 'oberon', 'branom').",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['msg', 'reply', 'ack', 'hide', 'purge', 'inbox', 'drop', 'apply-drop'],
        },
        project: { type: 'string', description: 'Optional project key (comms are person-to-person across all shared MLS groups; omit project to route automatically to the recipient)' },
        to: { type: 'string', description: 'Recipient operator id (for msg/inbox/drop), e.g. mike' },
        via: { type: 'string', description: "Optional courier/messenger ROM to deliver the message or reply in-character in the recipient's feed (e.g. 'smeagol', 'moist', 'toot', 'bob', 'oberon')" },
        id: { type: 'integer', description: 'Message id (for reply/ack/hide/purge/apply-drop)' },
        body: { type: 'string', description: "Message or reply text WRITTEN IN THE AUTHENTIC FIRST-PERSON VOICE OF THE COURIER ROM (`via`), preserving 100% of the operator's meaning and technical coordinates" },
        file: { type: 'string', description: 'File path to drop or output path for apply-drop' },
        gitDiff: { type: 'boolean', description: 'Capture and drop uncommitted git diff from project repo' },
        apply: { type: 'boolean', description: 'Run `git apply` on an incoming git-diff drop' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'sync',
    description: 'W3C did:key + Epoch-Keyed AEAD (HKDF-SHA256 + ChaCha20-Poly1305 + Ed25519) + HLC-CRDT group invite, join, live WebSocket relay sync, packet export/import, instruction file assimilation, GitHub Issues & PRs (`issues-sync`, `issues-publish`, `pr-sync`, `pr-open`, `pr-review`, `pr-merge`), Construct self-update (`upgrade` / `upgrade-check`), or HTML dashboard generation.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'did',
            'invite',
            'join',
            'sync',
            'export',
            'import',
            'assimilate',
            'init',
            'upgrade',
            'upgrade-check',
            'dashboard',
            'issues-sync',
            'issues-publish',
            'pr-sync',
            'pr-open',
            'pr-review',
            'pr-merge',
          ],
        },
        target: {
          type: 'string',
          description: 'Project key (for invite/sync/export/issues-sync/pr-sync), frame seq (for issues-publish), PR number (for pr-review/pr-merge), PR title (for pr-open), construct://invite/... URI (for join), construct://packet/... token (for import), directory path (for assimilate), or output path (for dashboard)',
        },
        dir: {
          type: 'string',
          description: 'Optional local repository directory (target clone path for `join`, or source repo path for `invite`)',
        },
        project: { type: 'string', description: 'Project key when assimilating, opening/reviewing/merging a PR, or syncing issues' },
        to: { type: 'string', description: 'Optional teammate operator id to notify via Courier when opening, reviewing, or merging a PR' },
        via: { type: 'string', description: "Optional Courier ROM name (e.g. 'toot', 'bob', 'moist') when notifying a teammate on PR open/review/merge" },
        body: { type: 'string', description: 'PR description (for pr-open) or review comment body (for pr-review)' },
        verdict: { type: 'string', enum: ['approve', 'request-changes', 'comment'], description: 'Review verdict for `pr-review`' },
        relays: { type: 'string', description: 'Optional comma-separated WebSocket relay URLs' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
]);

const MCP_TOOLS = Object.freeze(
  CONSTRUCT_TOOL_SPECS.map((spec) => ({
    name: `construct_${spec.name}`,
    description: spec.description,
    inputSchema: spec.inputSchema,
  }))
);

const MCP_PROMPTS = Object.freeze([
  {
    name: 'crew',
    description: 'Switch Construct Crew Bank for this session or project (sprawl, nightcity, anathem, cryptonomicon, shadowrun, dresden, amber, laundry, tolkien, discworld, reamde, irondruid, prydain, clockwork, generic)',
    arguments: [{ name: 'bank', description: 'Crew Bank name (e.g. discworld, reamde, clockwork)', required: true }],
  },
  {
    name: 'sub',
    description: 'Substitute a Bench / Second specialist into the active 9-seat Crew',
    arguments: [{ name: 'specialist', description: 'Backup specialist name (e.g. weatherwax, boromir, wallace, minister)', required: true }],
  },
  {
    name: 'boot',
    description: 'Load Construct sequential memory, state head, gotchas, and active Crew for a project',
    arguments: [{ name: 'project', description: 'Optional project key (defaults to current working directory)', required: false }],
  },
]);

const MCP_RESOURCES = Object.freeze([
  {
    uri: 'construct://memory/current',
    name: 'Construct Live Memory & Active Crew',
    description: 'Live <construct-live-memory> snapshot for the current workspace directory',
    mimeType: 'text/markdown',
  },
  {
    uri: 'construct://inbox',
    name: 'Construct Comms & Courier Inbox',
    description: 'Active person-to-person Construct Courier messages and replies',
    mimeType: 'text/plain',
  },
  {
    uri: 'construct://gotchas/global',
    name: 'Construct Global Machine & Tool Gotchas',
    description: 'Global machine, OS, shell, and toolchain gotchas with mechanical guards',
    mimeType: 'text/markdown',
  },
]);

function executeMcpTool(name, input = {}, meta = {}) {
  const shortName = String(name || '').replace(/^construct_/, '');
  const sessionID =
    input.session ||
    meta?.['ai.opencode/sessionID'] ||
    meta?.sessionID ||
    process.env.CONSTRUCT_SESSION_ID ||
    '';
  const contextDir = input.dir || meta?.dir || '';

  switch (shortName) {
    case 'boot': {
      if (!input.project && !contextDir) return runConstructCli(['projects']);
      const args = ['boot'];
      if (input.project) args.push(String(input.project));
      if (contextDir) args.push('--dir', String(contextDir));
      if (sessionID) args.push('--session', String(sessionID));
      if (input.limit) args.push('-n', String(input.limit));
      return runConstructCli(args);
    }
    case 'rec': {
      // Fast in-process SQLite execution (<2ms instead of 120ms subprocess spawn)
      const res = store.recordFrame({
        project: input.project,
        kind: input.kind,
        summary: input.summary,
        detail: input.detail,
        verified: input.verified,
        parentSeq: input.parent,
        resolves: input.resolves,
        open: input.open ? true : undefined,
        refs: input.refs,
      });
      const resolvedMsg = res.resolved.length ? ` (resolved ${res.resolved.map((s) => `#${s}`).join(', ')})` : '';
      const openMsg = res.frame.open ? ' [OPEN]' : '';
      return `recorded #${res.frame.seq} [${res.frame.project}/${res.frame.kind}]${openMsg}${resolvedMsg}: ${res.frame.summary}`;
    }
    case 'head': {
      const h = store.setHead(input.project, {
        state: input.state,
        next: input.next,
        repo: input.repo,
      });
      return `updated head for ${h.project} (${String(h.updated || '').slice(0, 10)})`;
    }
    case 'resolve': {
      const args = ['resolve', String(input.seqs)];
      if (input.by) args.push('--by', String(input.by));
      if (input.reason) args.push('--reason', String(input.reason));
      if (input.verified) args.push('--verified', String(input.verified));
      if (input.closeGh) args.push('--close-gh');
      return runConstructCli(args);
    }
    case 'zoom': {
      const args = ['zoom', String(input.seq)];
      if (input.window !== undefined) args.push('-w', String(input.window));
      return runConstructCli(args);
    }
    case 'search': {
      if (input.why) {
        const args = ['why', String(input.query)];
        if (input.project) args.push('--project', String(input.project));
        if (input.ask) args.push('--ask', String(input.ask));
        return runConstructCli(args);
      }
      const args = ['search', String(input.query)];
      if (input.project) args.push('--project', String(input.project));
      if (input.kind) args.push('--kind', String(input.kind));
      if (input.open) args.push('--open');
      return runConstructCli(args);
    }
    case 'rom': {
      const args = ['rom', String(input.action)];
      if (input.target) {
        if (input.action === 'tune') {
          args.push(...String(input.target).trim().split(/\s+/));
        } else {
          args.push(String(input.target));
        }
      }
      if (input.rom) args.push('--rom', String(input.rom));
      if (input.pack) args.push('--pack', String(input.pack));
      if (input.seat) args.push('--seat', String(input.seat));
      if (input.tier) args.push('--tier', String(input.tier));
      if (input.handle) args.push('--handle', String(input.handle));
      if (input.tagline) args.push('--tagline', String(input.tagline));
      if (input.voice) args.push('--voice', String(input.voice));
      if (sessionID) args.push('--session', String(sessionID));
      if (contextDir) args.push('--dir', String(contextDir));
      return runConstructCli(args);
    }
    case 'user': {
      if (input.action === 'set') {
        const u = store.setUser(input.id, {
          name: input.name,
          osUsers: input.osUsers,
          experience: input.experience,
          platform: input.platform,
          workspaceRoot: input.workspaceRoot,
          calibration: input.calibration,
          active: input.use ? true : undefined,
        });
        return `saved operator agreement for "${u.name}" [${u.id}] -> ${store.activeRomPath()}`;
      }
      if (input.action === 'use') {
        const u = store.useUser(input.id);
        return `active operator set to "${u.name}" [${u.id}] -> ${store.activeRomPath()}`;
      }
      const args = ['user', String(input.action)];
      if (input.id) args.push(String(input.id));
      return runConstructCli(args);
    }
    case 'gotcha': {
      const args = ['gotcha', String(input.action)];
      if (input.title) args.push(String(input.title));
      if (input.project === 'all') args.push('--all');
      else if (input.project && input.project !== 'global') args.push('--project', String(input.project));
      if (input.status) args.push('--status', String(input.status));
      if (input.evidence) args.push('--evidence', String(input.evidence));
      if (input.fix) args.push('--fix', String(input.fix));
      if (input.guard) args.push('--guard', String(input.guard));
      if (input.guardOs) args.push('--guard-os', String(input.guardOs));
      if (input.tags) args.push('--tags', String(input.tags));
      return runConstructCli(args);
    }
    case 'comms': {
      if (input.action === 'msg') {
        const args = ['msg', '--to', String(input.to)];
        if (input.project) args.push('--project', String(input.project));
        if (input.via) args.push('--via', String(input.via));
        if (sessionID) args.push('--session', String(sessionID));
        args.push(String(input.body));
        return runConstructCli(args);
      }
      if (input.action === 'reply') {
        const args = ['reply', String(input.id)];
        if (input.via) args.push('--via', String(input.via));
        if (sessionID) args.push('--session', String(sessionID));
        args.push(String(input.body));
        return runConstructCli(args);
      }
      if (input.action === 'ack') {
        const m = store.ackMessage(input.id);
        return `acknowledged delivery of [M#${m.id}]`;
      }
      if (input.action === 'hide') {
        const m = store.hideMessage(input.id);
        return `hidden message [M#${m.id}]`;
      }
      if (input.action === 'purge') {
        const m = store.purgeMessage(input.id);
        return `purged message [M#${m.id}] from everywhere`;
      }
      if (input.action === 'drop') {
        const args = ['drop', String(input.project || 'global'), '--to', String(input.to)];
        if (input.via) args.push('--via', String(input.via));
        if (sessionID) args.push('--session', String(sessionID));
        if (input.file) args.push('--file', String(input.file));
        if (input.gitDiff) args.push('--git-diff');
        if (input.body) args.push('--content', String(input.body));
        return runConstructCli(args);
      }
      if (input.action === 'apply-drop') {
        const args = ['apply-drop', String(input.id)];
        if (input.file) args.push('--out', String(input.file));
        if (input.apply) args.push('--apply');
        return runConstructCli(args);
      }
      const args = ['inbox'];
      if (input.project) args.push('--project', String(input.project));
      if (input.to) args.push('--to', String(input.to));
      return runConstructCli(args);
    }
    case 'sync': {
      if (input.action === 'did') return runConstructCli(['did']);
      if (input.action === 'init') return runConstructCli(['init']);
      if (input.action === 'upgrade') return runConstructCli(['upgrade']);
      if (input.action === 'upgrade-check') return runConstructCli(['upgrade', '--check']);
      if (input.action === 'dashboard') {
        const args = ['dashboard'];
        if (input.target) args.push('--out', String(input.target));
        return runConstructCli(args);
      }
      if (input.action === 'issues-sync') {
        const args = ['issues', 'sync'];
        if (input.target || input.project) args.push(String(input.target || input.project));
        if (input.dir) args.push('--dir', String(input.dir));
        return runConstructCli(args);
      }
      if (input.action === 'issues-publish') {
        const args = ['issues', 'publish', String(input.target)];
        if (input.dir) args.push('--dir', String(input.dir));
        return runConstructCli(args);
      }
      if (input.action === 'pr-sync') {
        const args = ['pr', 'sync'];
        if (input.target || input.project) args.push(String(input.target || input.project));
        if (input.dir) args.push('--dir', String(input.dir));
        return runConstructCli(args);
      }
      if (input.action === 'pr-open') {
        const args = ['pr', 'open', String(input.project || 'construct'), '--title', String(input.target || '')];
        if (input.body) args.push('--body', String(input.body));
        if (input.to) args.push('--to', String(input.to));
        if (input.via) args.push('--via', String(input.via));
        if (input.dir) args.push('--dir', String(input.dir));
        if (sessionID) args.push('--session', String(sessionID));
        return runConstructCli(args);
      }
      if (input.action === 'pr-review') {
        const args = ['pr', 'review', String(input.project || 'construct'), String(input.target || '')];
        if (input.verdict === 'approve') args.push('--approve');
        else if (input.verdict === 'request-changes') args.push('--request-changes');
        else args.push('--comment');
        if (input.body) args.push('--body', String(input.body));
        if (input.to) args.push('--to', String(input.to));
        if (input.via) args.push('--via', String(input.via));
        if (input.dir) args.push('--dir', String(input.dir));
        if (sessionID) args.push('--session', String(sessionID));
        return runConstructCli(args);
      }
      if (input.action === 'pr-merge') {
        const args = ['pr', 'merge', String(input.project || 'construct'), String(input.target || '')];
        if (input.to) args.push('--to', String(input.to));
        if (input.via) args.push('--via', String(input.via));
        if (input.dir) args.push('--dir', String(input.dir));
        if (sessionID) args.push('--session', String(sessionID));
        return runConstructCli(args);
      }
      if (input.action === 'assimilate') {
        const args = ['assimilate'];
        if (input.target) args.push(String(input.target));
        if (input.project) args.push('--project', String(input.project));
        return runConstructCli(args);
      }
      if (input.action === 'export') return runConstructCli(['packet', 'export', String(input.target)]);
      if (input.action === 'import') return runConstructCli(['packet', 'import', String(input.target)]);
      const args = [String(input.action), String(input.target)];
      if (input.dir) args.push('--dir', String(input.dir));
      if (input.relays) args.push('--relays', String(input.relays));
      return runConstructCli(args);
    }
    default:
      throw new Error(`unknown MCP tool "${name}"`);
  }
}

function buildMcpServerInstructions() {
  try {
    const user = store.getUser();
    const gotchas = store.listGotchas('global');
    const baseMd = romMod.compileBaseProtocolMarkdown({ user, gotchas });
    const cwd = process.cwd();
    const bootOut = runConstructCli(['boot', '--dir', cwd, '-n', '8']);
    const cleanBoot = bootOut.replace(/^<!-- CONSTRUCT_SHADOWED:\[.*?\] -->\r?\n?/, '');
    const voiceLock = buildFrontierVoiceLock(cleanBoot);
    return `${baseMd}\n<construct-live-memory directory="${cwd}">\n${cleanBoot}${voiceLock ? `\n\n${voiceLock}` : ''}\n</construct-live-memory>`;
  } catch (_) {
    return 'Construct sequential memory & 9-seat Crew engine active. Call `construct_boot` to load the current project tape and Crew.';
  }
}

function handleJsonRpcRequest(req) {
  if (!req || typeof req !== 'object') return null;
  const { id, method, params } = req;

  // Notifications (no `id`) produce no response
  if (id === undefined || id === null) {
    return null;
  }

  try {
    switch (method) {
      case 'initialize': {
        const clientVer = params?.protocolVersion || '2024-11-05';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: clientVer,
            capabilities: {
              tools: {},
              prompts: {},
              resources: {},
            },
            serverInfo: {
              name: 'construct',
              version: '0.1.0',
            },
            instructions: buildMcpServerInstructions(),
          },
        };
      }
      case 'ping': {
        return { jsonrpc: '2.0', id, result: {} };
      }
      case 'tools/list': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: MCP_TOOLS,
          },
        };
      }
      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        const toolMeta = params?._meta || {};
        try {
          const text = executeMcpTool(toolName, toolArgs, toolMeta);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text }],
              isError: false,
            },
          };
        } catch (toolErr) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `error: ${toolErr.stderr || toolErr.message}` }],
              isError: true,
            },
          };
        }
      }
      case 'prompts/list': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            prompts: MCP_PROMPTS,
          },
        };
      }
      case 'prompts/get': {
        const pName = String(params?.name || '');
        const pArgs = params?.arguments || {};
        if (pName === 'crew') {
          const bank = String(pArgs.bank || 'sprawl').trim().toLowerCase();
          const out = executeMcpTool('rom', { action: 'use', target: bank });
          return {
            jsonrpc: '2.0',
            id,
            result: {
              description: `Switched Construct Crew Bank to ${bank}`,
              messages: [{ role: 'user', content: { type: 'text', text: `${out}\nConfirm in the ${bank} Crew's voice.` } }],
            },
          };
        }
        if (pName === 'sub') {
          const spec = String(pArgs.specialist || '').trim().toLowerCase();
          const out = executeMcpTool('rom', { action: 'sub', target: spec });
          return {
            jsonrpc: '2.0',
            id,
            result: {
              description: `Subbed ${spec} into the active Crew`,
              messages: [{ role: 'user', content: { type: 'text', text: `${out}\nConfirm in ${spec}'s voice.` } }],
            },
          };
        }
        const bootText = executeMcpTool('boot', { project: pArgs.project, dir: process.cwd() });
        return {
          jsonrpc: '2.0',
          id,
          result: {
            description: 'Construct live project memory & Crew',
            messages: [{ role: 'user', content: { type: 'text', text: bootText } }],
          },
        };
      }
      case 'resources/list': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resources: MCP_RESOURCES,
          },
        };
      }
      case 'resources/read': {
        const uri = String(params?.uri || '');
        if (uri === 'construct://inbox') {
          const text = executeMcpTool('comms', { action: 'inbox' });
          return {
            jsonrpc: '2.0',
            id,
            result: { contents: [{ uri, mimeType: 'text/plain', text }] },
          };
        }
        if (uri === 'construct://gotchas/global') {
          const gotchas = store.listGotchas('global');
          const text = protocol.compileGotchasSection(gotchas);
          return {
            jsonrpc: '2.0',
            id,
            result: { contents: [{ uri, mimeType: 'text/markdown', text }] },
          };
        }
        const text = executeMcpTool('boot', { dir: process.cwd() });
        return {
          jsonrpc: '2.0',
          id,
          result: { contents: [{ uri: 'construct://memory/current', mimeType: 'text/markdown', text }] },
        };
      }
      default: {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
      }
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: err.message,
      },
    };
  }
}

function startMcpStdioServer() {
  let buffer = '';
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      // Support Content-Length framed messages if a client sends them
      if (buffer.startsWith('Content-Length:')) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const header = buffer.slice(0, headerEnd);
        const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
        const contentLen = lenMatch ? Number(lenMatch[1]) : 0;
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + contentLen) break;
        const bodyStr = buffer.slice(bodyStart, bodyStart + contentLen);
        buffer = buffer.slice(bodyStart + contentLen);
        try {
          const req = JSON.parse(bodyStr);
          const res = handleJsonRpcRequest(req);
          if (res) {
            const outStr = JSON.stringify(res);
            process.stdout.write(`Content-Length: ${Buffer.byteLength(outStr, 'utf8')}\r\n\r\n${outStr}`);
          }
        } catch (_) {}
        continue;
      }

      // Standard MCP stdio newline-delimited JSON-RPC
      const nlIdx = buffer.indexOf('\n');
      if (nlIdx === -1) break;
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line) continue;
      try {
        const req = JSON.parse(line);
        const res = handleJsonRpcRequest(req);
        if (res) {
          process.stdout.write(JSON.stringify(res) + '\n');
        }
      } catch (_) {}
    }
  });
}

function isValidRomTarget(spec) {
  const known = packs.getKnownRomTargets();
  const parts = String(spec || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => known.has(p));
}

function normalizeMultiWordRomPhrases(rawText = '') {
  return String(rawText || '')
    .replace(/\bnight\s+city\b/gi, 'nightcity')
    .replace(/\biron\s+druid(?:\s+chronicles)?\b/gi, 'irondruid')
    .replace(/\b(?:a\s+)?clockwork\s+orange\b/gi, 'clockwork')
    .replace(/\bkorova(?:\s+milkbar)?\b/gi, 'clockwork')
    .replace(/\blaundry\s+files\b/gi, 'laundry')
    .replace(/\bdresden\s+files\b/gi, 'dresden')
    .replace(/\blord\s+of\s+the\s+rings\b/gi, 'tolkien')
    .replace(/\bcouncil\s+of\s+elrond\b/gi, 'tolkien')
    .replace(/\bchronicles\s+of\s+prydain\b/gi, 'prydain')
    .replace(/\bchronicles\s+of\s+amber\b/gi, 'amber')
    .replace(/\bankh[\s-]+morpork\b/gi, 'discworld');
}

function detectPreSlotRomDirective(promptText) {
  const text = normalizeMultiWordRomPhrases(String(promptText || '').trim());
  if (!text) return null;

  const tagMatch = text.match(/(?:^|\s)\[ROM:\s*([a-z0-9_]+(?:,[a-z0-9_]+)*)\s*\]/i);
  if (tagMatch && isValidRomTarget(tagMatch[1])) {
    return { action: 'use', target: tagMatch[1].toLowerCase() };
  }

  const defaultMatch = text.match(
    /^(?:make|set)\s+(?:the\s+)?([a-z0-9_]+(?:,[a-z0-9_]+)*)(?:\s+crew|\s+bank|\s+pack|\s+rom)?\s+(?:as\s+)?(?:my\s+)?default(?:\s+rom)?(?:\s+until\s+further\s+notice)?\b/i
  );
  if (defaultMatch && isValidRomTarget(defaultMatch[1])) {
    return { action: 'default', target: defaultMatch[1].toLowerCase() };
  }

  const clearDefaultMatch = text.match(/^(?:clear|unset|reset)\s+(?:my\s+)?default\s+rom\b/i);
  if (clearDefaultMatch) {
    return { action: 'default', target: 'off' };
  }

  const subMatch = text.match(/^(?:please\s+|let'?s\s+)?(?:sub|substitute)\s+([a-z0-9_]+)(?:\s+in|\s+into\s+the\s+crew)?(?:[\s,.:;!-]|$)/i);
  if (subMatch && isValidRomTarget(subMatch[1])) {
    return { action: 'sub', target: subMatch[1].toLowerCase() };
  }

  const useMatch = text.match(
    /^(?:please\s+|let'?s\s+|just\s+|swap\s+in\s+)?(?:slot|switch\s+to|use|bring\s+in|work\s+with|swap\s+in)\s+(?:the\s+)?([a-z0-9_]+(?:,[a-z0-9_]+)*)(?:\s+(?:crew|bank|pack|rom|mode|solo|for\s+this\s*(?:session|turn)?))?(?:[\s,.:;!-]|$)/i
  );
  if (useMatch && isValidRomTarget(useMatch[1])) {
    return { action: 'use', target: useMatch[1].toLowerCase() };
  }

  return null;
}

// Shared across Claude Code, Cursor, Gemini CLI, and Oh My Pi (`omp`):
// Queue any specialist ROMs requested in a `Task` / `Agent` tool call (single item or `tasks[]` batch).
function enqueueSubagentRomsFromToolInput(toolInput, sessionId) {
  const items = Array.isArray(toolInput?.tasks) ? toolInput.tasks : [toolInput || {}];
  for (const item of items) {
    const promptDirective = detectPreSlotRomDirective(
      item?.task || item?.prompt || item?.description || toolInput?.context || ''
    );
    const explicitAgent = String(
      item?.subagent_type || item?.agent_type || item?.agent || item?.name || ''
    )
      .trim()
      .replace(/[-_]\d+$/, '')
      .toLowerCase();
    const targetRom =
      promptDirective?.target || (isValidRomTarget(explicitAgent) ? explicitAgent : '');
    if (targetRom) {
      store.enqueuePendingSubagentRom(sessionId, targetRom);
    }
  }
}

// Shared across Claude Code, Cursor, Gemini CLI, and Oh My Pi (`omp`):
// Resolve a subagent's specialist ROM from `[ROM: <name>]` in prompt/task, `agent_id` (stripped of `-2` suffixes),
// `agent_type`/`agent_name`, or the parent session's pending subagent queue.
function resolveSubagentRomFromHookPayload(payload, parentSessionId, effectiveSessionId) {
  const promptDirective = detectPreSlotRomDirective(
    payload?.prompt || payload?.task || payload?.description || ''
  );
  const agentIdBase = String(payload?.agent_id || '')
    .trim()
    .replace(/[-_]\d+$/, '')
    .toLowerCase();
  const agentTypeBase = String(
    payload?.agent_type || payload?.subagent_type || payload?.agent_name || ''
  )
    .trim()
    .replace(/[-_]\d+$/, '')
    .toLowerCase();
  const queuedRom =
    store.consumePendingSubagentRom(parentSessionId, agentIdBase || agentTypeBase) ||
    store.consumePendingSubagentRom(effectiveSessionId, agentIdBase || agentTypeBase);
  return (
    promptDirective?.target ||
    (isValidRomTarget(agentIdBase) ? agentIdBase : '') ||
    (isValidRomTarget(agentTypeBase) ? agentTypeBase : '') ||
    queuedRom ||
    ''
  );
}

function detectSubagentContextRom({ session = null, messages = [] } = {}) {
  const title = String(session?.title || '').trim();
  if (title) {
    const titleTag = title.match(/(?:^|\s)\[ROM:\s*([a-z0-9_]+(?:,[a-z0-9_]+)*)\s*\]/i);
    if (titleTag && isValidRomTarget(titleTag[1])) {
      return { action: 'use', target: titleTag[1].toLowerCase() };
    }
  }

  const firstMsg = Array.isArray(messages) && messages.length ? messages[0] : null;
  if (firstMsg) {
    const candidateTexts = [];
    if (typeof firstMsg.text === 'string') candidateTexts.push(firstMsg.text);
    if (typeof firstMsg.content === 'string') candidateTexts.push(firstMsg.content);
    if (Array.isArray(firstMsg.content)) {
      for (const item of firstMsg.content) {
        if (item && typeof item.text === 'string') candidateTexts.push(item.text);
      }
    }
    if (Array.isArray(firstMsg.parts)) {
      for (const part of firstMsg.parts) {
        if (part && typeof part.text === 'string') candidateTexts.push(part.text);
      }
    }
    for (const raw of candidateTexts) {
      const tagMatch = String(raw || '').match(/(?:^|\s)\[ROM:\s*([a-z0-9_]+(?:,[a-z0-9_]+)*)\s*\]/i);
      if (tagMatch && isValidRomTarget(tagMatch[1])) {
        return { action: 'use', target: tagMatch[1].toLowerCase() };
      }
    }
  }

  const isChildSession = Boolean(session?.parentID || session?.parentId || /@\w+/.test(title));
  if (isChildSession && title) {
    const cleanLead = title
      .replace(/^(?:🌃|🦾|🏛️|🔐|🐉|🕯️|🦄|🐙|💍|🐢|🏔️|🐺|⚔️|🥛|⚙️|🔪)\s*\[[^\]]+\]\s*/u, '')
      .trim()
      .split(/[\s(:@_-]/)[0]
      .toLowerCase();
    if (cleanLead && isValidRomTarget(cleanLead)) {
      return { action: 'use', target: cleanLead };
    }
  }

  return null;
}

// Claude Code Hook Runner (`construct claude-hook [context | pre-tool | subagent-start]`)
function runClaudeHook(mode, stdinText = '') {
  let payload = {};
  try {
    if (stdinText && stdinText.trim()) {
      payload = JSON.parse(stdinText);
    }
  } catch (_) {}

  const sessionId = payload?.session_id || process.env.CONSTRUCT_SESSION_ID || '';

  if (mode === 'pre-tool') {
    const toolName = String(payload?.tool_name || '');
    if (toolName === 'Agent' || toolName === 'Task' || toolName === 'task') {
      enqueueSubagentRomsFromToolInput(payload?.tool_input, sessionId || 'claude');
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    const cmd = payload?.tool_input?.command || '';
    const cwd = payload?.cwd || process.cwd();
    validateShellCommand(cmd, { dir: cwd, project: payload?.project });
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  if (mode === 'subagent-start' || payload?.hook_event_name === 'SubagentStart') {
    const cwd = payload?.cwd || process.cwd();
    const agentId = String(payload?.agent_id || '').trim();
    const agentType = String(payload?.agent_type || '').trim().toLowerCase();
    const subagentSessionId = agentId ? `${sessionId || 'claude'}:${agentId}` : sessionId || 'claude:subagent';

    const resolvedRom = resolveSubagentRomFromHookPayload(
      payload,
      sessionId || 'claude',
      subagentSessionId
    );
    if (resolvedRom) {
      store.useRom(resolvedRom, { sessionId: subagentSessionId });
    }

    const args = ['boot', '--dir', String(cwd), '-n', '8', '--session', String(subagentSessionId)];
    let output = runConstructCli(args);
    output = output.replace(/^<!-- CONSTRUCT_SHADOWED:\[.*?\] -->\r?\n?/, '');
    const voiceLock = buildFrontierVoiceLock(output);
    const xml = `<construct-live-memory directory="${cwd}" session="${subagentSessionId}">\n${output}${voiceLock ? `\n\n${voiceLock}` : ''}\n</construct-live-memory>`;
    const jsonOut = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: xml,
      },
    });
    return { exitCode: 0, stdout: jsonOut, stderr: '' };
  }

  // Default: `context` (`UserPromptSubmit` / `SessionStart`)
  const cwd = payload?.cwd || process.cwd();
  const effectiveSessionId = payload?.agent_id ? `${sessionId || 'claude'}:${payload.agent_id}` : sessionId;

  // Zero-round-trip ROM pre-slotting on `UserPromptSubmit` before `boot` runs
  if (payload?.prompt) {
    const directive = detectPreSlotRomDirective(payload.prompt);
    if (directive) {
      const romArgs = ['rom', directive.action, directive.target];
      if (effectiveSessionId) romArgs.push('--session', String(effectiveSessionId));
      if (cwd) romArgs.push('--dir', String(cwd));
      try {
        runConstructCli(romArgs);
      } catch (_) {}
    }
  }

  const args = ['boot', '--dir', String(cwd), '-n', '8'];
  if (effectiveSessionId) args.push('--session', String(effectiveSessionId));

  let output = runConstructCli(args);
  output = output.replace(/^<!-- CONSTRUCT_SHADOWED:\[.*?\] -->\r?\n?/, '');
  const voiceLock = buildFrontierVoiceLock(output);
  const xml = `<construct-live-memory directory="${cwd}" session="${effectiveSessionId}">\n${output}${voiceLock ? `\n\n${voiceLock}` : ''}\n</construct-live-memory>`;
  return { exitCode: 0, stdout: xml, stderr: '' };
}

// Cursor IDE & Cloud Agent Hook Runner (`construct cursor-hook [session-start | before-prompt | before-shell | post-tool]`)
// Spec: https://cursor.com/docs/hooks (JSON in on stdin, JSON out on stdout)
function runCursorHook(mode, stdinText = '') {
  let payload = {};
  try {
    if (stdinText && stdinText.trim()) {
      payload = JSON.parse(stdinText);
    }
  } catch (_) {}

  const effectiveSessionId =
    payload?.conversation_id || payload?.session_id || process.env.CONSTRUCT_SESSION_ID || 'cursor';
  const cwd =
    (Array.isArray(payload?.workspace_roots) && payload.workspace_roots[0]) ||
    payload?.cwd ||
    process.env.CURSOR_PROJECT_DIR ||
    process.cwd();

  if (mode === 'before-shell' || payload?.hook_event_name === 'beforeShellExecution') {
    const cmd = payload?.command || '';
    try {
      validateShellCommand(cmd, { project: cwd ? store.resolveProjectFromDir(cwd) : '' });
      return { exitCode: 0, stdout: JSON.stringify({ continue: true, permission: 'allow' }), stderr: '' };
    } catch (err) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          continue: true,
          permission: 'deny',
          user_message: err.message,
          agent_message: err.message,
        }),
        stderr: '',
      };
    }
  }

  if (mode === 'before-prompt' || payload?.hook_event_name === 'beforeSubmitPrompt') {
    if (payload?.prompt) {
      const directive = detectPreSlotRomDirective(payload.prompt);
      if (directive) {
        const romArgs = ['rom', directive.action, directive.target, '--session', String(effectiveSessionId)];
        if (cwd) romArgs.push('--dir', String(cwd));
        try {
          runConstructCli(romArgs);
        } catch (_) {}
      }
    }
    return { exitCode: 0, stdout: JSON.stringify({ continue: true }), stderr: '' };
  }

  if (mode === 'post-tool' || payload?.hook_event_name === 'postToolUse') {
    const args = ['boot', '--dir', String(cwd), '-n', '8', '--session', String(effectiveSessionId)];
    let output = '';
    try {
      output = runConstructCli(args);
    } catch (_) {}
    const voiceLock = buildFrontierVoiceLock(output);
    return {
      exitCode: 0,
      stdout: JSON.stringify(voiceLock ? { additional_context: voiceLock } : {}),
      stderr: '',
    };
  }

  // Default: `session-start` (`sessionStart`)
  const args = ['boot', '--dir', String(cwd), '-n', '8', '--session', String(effectiveSessionId)];
  let output = '';
  try {
    output = runConstructCli(args);
  } catch (_) {}
  output = output.replace(/^<!-- CONSTRUCT_SHADOWED:\[.*?\] -->\r?\n?/, '');
  const voiceLock = buildFrontierVoiceLock(output);
  const xml = `<construct-live-memory directory="${cwd}" session="${effectiveSessionId}">\n${output}${voiceLock ? `\n\n${voiceLock}` : ''}\n</construct-live-memory>`;
  return {
    exitCode: 0,
    stdout: JSON.stringify({ additional_context: xml }),
    stderr: '',
  };
}

// Gemini CLI / Antigravity Hook Runner (`construct gemini-hook [before-agent | session-start | before-tool]`)
// Spec: https://geminicli.com/docs/hooks/reference/ (strict JSON on stdout)
function runGeminiHook(mode, stdinText = '') {
  let payload = {};
  try {
    if (stdinText && stdinText.trim()) {
      payload = JSON.parse(stdinText);
    }
  } catch (_) {}

  const effectiveSessionId =
    payload?.session_id || process.env.GEMINI_SESSION_ID || process.env.CONSTRUCT_SESSION_ID || 'gemini';
  const cwd =
    payload?.cwd || process.env.GEMINI_CWD || process.env.GEMINI_PROJECT_DIR || process.cwd();

  if (mode === 'before-tool' || payload?.hook_event_name === 'BeforeTool') {
    const cmd = payload?.tool_input?.command || payload?.tool_input?.cmd || '';
    try {
      validateShellCommand(cmd, { project: cwd ? store.resolveProjectFromDir(cwd) : '' });
      return { exitCode: 0, stdout: JSON.stringify({ decision: 'allow' }), stderr: '' };
    } catch (err) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: 'deny', reason: err.message }),
        stderr: '',
      };
    }
  }

  // Default: `before-agent` / `session-start` (`BeforeAgent` & `SessionStart`)
  if (payload?.prompt) {
    const directive = detectPreSlotRomDirective(payload.prompt);
    if (directive) {
      const romArgs = ['rom', directive.action, directive.target, '--session', String(effectiveSessionId)];
      if (cwd) romArgs.push('--dir', String(cwd));
      try {
        runConstructCli(romArgs);
      } catch (_) {}
    }
  }

  const args = ['boot', '--dir', String(cwd), '-n', '8', '--session', String(effectiveSessionId)];
  let output = '';
  try {
    output = runConstructCli(args);
  } catch (_) {}
  output = output.replace(/^<!-- CONSTRUCT_SHADOWED:\[.*?\] -->\r?\n?/, '');
  const voiceLock = buildFrontierVoiceLock(output);
  const xml = `<construct-live-memory directory="${cwd}" session="${effectiveSessionId}">\n${output}${voiceLock ? `\n\n${voiceLock}` : ''}\n</construct-live-memory>`;
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        additionalContext: xml,
      },
    }),
    stderr: '',
  };
}

// Oh My Pi (can1357/oh-my-pi, CLI `omp`) Hook Runner (`construct omp-hook [before-agent | before-tool | after-tool | command]`)
// Spec: https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md
function runOmpHook(mode, stdinText = '') {
  let payload = {};
  try {
    if (stdinText && stdinText.trim()) {
      payload = JSON.parse(stdinText);
    }
  } catch (_) {}

  const effectiveSessionId =
    payload?.session_id || process.env.CONSTRUCT_SESSION_ID || 'omp';
  const cwd = payload?.cwd || process.cwd();

  if (mode === 'before-tool' || payload?.hook_event_name === 'tool_call') {
    const toolName = String(payload?.tool_name || '');
    if (toolName === 'task' || toolName === 'Task' || toolName === 'Agent') {
      enqueueSubagentRomsFromToolInput(payload?.tool_input, effectiveSessionId);
      return { exitCode: 0, stdout: JSON.stringify({ block: false }), stderr: '' };
    }

    const cmd = payload?.tool_input?.command || payload?.command || '';
    try {
      validateShellCommand(cmd, { project: cwd ? store.resolveProjectFromDir(cwd) : '' });
      return { exitCode: 0, stdout: JSON.stringify({ block: false }), stderr: '' };
    } catch (err) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ block: true, reason: err.message }),
        stderr: '',
      };
    }
  }

  if (mode === 'after-tool' || payload?.hook_event_name === 'tool_result') {
    return {
      exitCode: 0,
      stdout: '{}',
      stderr: '',
    };
  }

  if (mode === 'before-subagent-spawn' || payload?.hook_event_name === 'before_subagent_spawn') {
    const rawAgent = String(payload?.agent || '')
      .trim()
      .replace(/[-_]\d+$/, '')
      .toLowerCase();
    const promptDirective = detectPreSlotRomDirective(payload?.prompt || payload?.task || '');
    const candidateName = promptDirective?.target || (isValidRomTarget(rawAgent) ? rawAgent : '');
    if (candidateName) {
      try {
        const primaryRomName = candidateName.split(',')[0].trim();
        const rom = store.getRom(primaryRomName);
        const seatMeta = romMod.SEAT_MAP[rom?.seat] || null;
        if (rom && seatMeta?.ompRole) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              model: seatMeta.ompRole,
              note: `Construct Seat ${seatMeta.code} (${rom.name}/${rom.seat} -> ${seatMeta.ompRole})`,
            }),
            stderr: '',
          };
        }
      } catch (_) {}
    }
    return { exitCode: 0, stdout: '{}', stderr: '' };
  }

  if (mode === 'command') {
    const raw = String(payload?.args || '').trim();
    const res = executeConstructSlashCommand(raw, {
      sessionId: effectiveSessionId,
      cwd,
    });
    return {
      exitCode: 0,
      stdout: JSON.stringify(res),
      stderr: '',
    };
  }

  // Default: `before-agent` (`before_agent_start` / `input` / `session_start`)
  const agentKind = String(payload?.agent_kind || 'main');
  const agentName = String(payload?.agent_name || '').trim().toLowerCase();
  const agentId = String(payload?.agent_id || '').trim();
  const agentIdBase = agentId.replace(/[-_]\d+$/, '').toLowerCase();
  const parentSessionId = String(payload?.parent_session_id || effectiveSessionId).trim();
  const targetSessionId =
    agentKind === 'sub'
      ? `${effectiveSessionId}:${agentId || agentName || 'sub'}`
      : effectiveSessionId;

  if (agentKind === 'sub') {
    const resolvedRom = resolveSubagentRomFromHookPayload(
      payload,
      parentSessionId,
      effectiveSessionId
    );
    if (resolvedRom) {
      try {
        store.useRom(resolvedRom, { sessionId: targetSessionId });
      } catch (_) {}
    }
  } else if (payload?.prompt) {
    const directive = detectPreSlotRomDirective(payload.prompt);
    if (directive) {
      const romArgs = ['rom', directive.action, directive.target, '--session', String(targetSessionId)];
      if (cwd) romArgs.push('--dir', String(cwd));
      try {
        runConstructCli(romArgs);
      } catch (_) {}
    }
  }

  const args = ['boot', '--dir', String(cwd), '-n', '8', '--session', String(targetSessionId)];
  let output = '';
  try {
    output = runConstructCli(args);
  } catch (_) {}
  output = output.replace(/^<!-- CONSTRUCT_SHADOWED:\[.*?\] -->\r?\n?/, '');
  const baseVoiceLock = buildFrontierVoiceLock(output);
  const voiceLock = baseVoiceLock
    ? baseVoiceLock.replace(
        /<\/construct-voice-lock>$/,
        ' Because Oh My Pi renders internal thinking blocks visibly in the TUI, write every internal thinking/reasoning block 100% in the active Crew/ROM voice as well (start thinking blocks directly with the active specialist tag, never generic assistant pre-thinking).\n</construct-voice-lock>'
      )
    : '';
  const xml = `<construct-live-memory directory="${cwd}" session="${targetSessionId}">\n${output}${voiceLock ? `\n\n${voiceLock}` : ''}\n</construct-live-memory>`;
  let snap = null;
  try {
    snap = store.getHudSnapshot({ dir: cwd, sessionId: targetSessionId });
  } catch (_) {}
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      additionalSystemPrompt: xml,
      statusText: snap?.tabBadge || snap?.pill || '',
      sessionId: targetSessionId,
    }),
    stderr: '',
  };
}

function buildOmpExtensionSource(binPath) {
  const normalizedBin = String(binPath || '').replace(/\\/g, '/');
  return `// Oh My Pi (omp) native extension for the Construct sequential memory & Crew ROM engine.
// Generated by \`construct init --omp\`. Uses \`construct mcp\` for tools/prompts/resources and
// delegates lifecycle hooks (\`before_agent_start\`, \`tool_call\`, \`/construct\`) to \`construct omp-hook\`.
import { execFileSync } from "node:child_process";

const CONSTRUCT_BIN = ${JSON.stringify(normalizedBin)};

function callOmpHook(mode, payload) {
  try {
    const out = execFileSync("node", [CONSTRUCT_BIN, "omp-hook", mode], {
      input: JSON.stringify(payload || {}),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
    return out ? JSON.parse(out) : {};
  } catch (err) {
    if (mode === "before-tool" && (payload?.tool_name === "bash" || payload?.tool_name === "shell")) {
      return {
        block: true,
        reason: (err?.stderr && String(err.stderr).trim()) || err?.message || "Construct Shell Guard failed closed",
      };
    }
    return {};
  }
}

export default function constructOmpExtension(pi) {
  let mainSessionId = "";
  if (typeof pi?.setLabel === "function") {
    pi.setLabel("Construct Memory & Crew Engine");
  }

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx?.sessionManager?.getSessionId?.() || "omp";
    const agentKind = ctx?.agent?.kind || "main";
    if (agentKind === "main" && sessionId) {
      mainSessionId = sessionId;
    }
    const res = callOmpHook("before-agent", {
      session_id: sessionId,
      parent_session_id: mainSessionId || sessionId,
      cwd: ctx?.cwd || process.cwd(),
      prompt: event?.prompt || "",
      agent_kind: agentKind,
      agent_name: ctx?.agent?.name || "",
      agent_id: ctx?.agent?.id || "",
    });
    if (res.statusText && ctx?.ui?.setStatus) {
      ctx.ui.setStatus("construct", res.statusText);
    }
    if (res.additionalSystemPrompt) {
      const base = Array.isArray(event?.systemPrompt) ? event.systemPrompt : [];
      return { systemPrompt: [...base, res.additionalSystemPrompt] };
    }
  });

  pi.on("before_subagent_spawn", async (event, ctx) => {
    const sessionId = ctx?.sessionManager?.getSessionId?.() || mainSessionId || "omp";
    const res = callOmpHook("before-subagent-spawn", {
      session_id: sessionId,
      cwd: ctx?.cwd || process.cwd(),
      agent: event?.agent || "",
      model_role: event?.modelRole || "",
    });
    if (res.model) {
      return { model: res.model, note: res.note };
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = String(event?.toolName || "");
    if (toolName !== "bash" && toolName !== "shell" && toolName !== "task") return;
    const sessionId = ctx?.sessionManager?.getSessionId?.() || "omp";
    const res = callOmpHook("before-tool", {
      session_id: sessionId,
      cwd: ctx?.cwd || process.cwd(),
      tool_name: toolName,
      tool_input: event?.input || {},
    });
    if (res.block) {
      return { block: true, reason: res.reason || "Blocked by Construct Shell Guard" };
    }
  });


  if (typeof pi?.registerCommand === "function") {
    pi.registerCommand("construct", {
      description: "Run any Construct CLI command, switch Crew Bank, or sub a Bench specialist (e.g. /construct upgrade, /construct nightcity, /construct sub panam, /construct boot)",
      handler: async (args, ctx) => {
        const sessionId = ctx?.sessionManager?.getSessionId?.() || "omp";
        const res = callOmpHook("command", {
          session_id: sessionId,
          cwd: ctx?.cwd || process.cwd(),
          args: String(args || "").trim(),
        });
        if (res.statusText && ctx?.ui?.setStatus) {
          ctx.ui.setStatus("construct", res.statusText);
        }
        if (res.output && typeof pi?.sendMessage === "function") {
          pi.sendMessage({
            customType: "construct.cli",
            content: res.output,
            display: true,
          });
        } else if (res.message && ctx?.ui?.notify) {
          ctx.ui.notify(res.message, res.isError ? "error" : "info");
        }
      },
    });
  }
}
`;
}

module.exports = {
  CONSTRUCT_TOOL_SPECS,
  MCP_TOOLS,
  MCP_PROMPTS,
  MCP_RESOURCES,
  executeMcpTool,
  handleJsonRpcRequest,
  startMcpStdioServer,
  validateShellCommand,
  buildFrontierVoiceLock,
  isValidRomTarget,
  detectPreSlotRomDirective,
  detectSubagentContextRom,
  enqueueSubagentRomsFromToolInput,
  resolveSubagentRomFromHookPayload,
  parseSlashArgs,
  executeConstructSlashCommand,
  resolveNodeExecutable,
  runClaudeHook,
  runCursorHook,
  runGeminiHook,
  runOmpHook,
  buildOmpExtensionSource,
};
