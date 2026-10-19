// Model Context Protocol (MCP) `stdio` Server & Claude Code Hook Bridge for Construct.
//
// Zero external dependencies: speaks JSON-RPC 2.0 over `stdin`/`stdout` (supporting
// both MCP standard newline-delimited JSON-RPC and `Content-Length` framed messages),
// exposing all 11 Construct tools (`construct_boot`, `construct_rec`, `construct_head`,
// `construct_resolve`, `construct_zoom`, `construct_search`, `construct_rom`,
// `construct_user`, `construct_gotcha`, `construct_comms`, `construct_sync`) to
// Claude Code, Cursor, Windsurf, Zed, or any MCP client.
//
// Also provides `runClaudeHook(mode, inputJson)` for Claude Code's `UserPromptSubmit` /
// `SessionStart` (`<construct-live-memory>` injection with `session_id` isolation) and
// `PreToolUse` (`Bash` shell guard).

'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const CONSTRUCT_BIN = path.join(__dirname, '..', 'bin', 'construct.js');

function runConstructCli(args) {
  return execFileSync(process.execPath, [CONSTRUCT_BIN, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  }).trim();
}

function validateShellCommand(command, options = {}) {
  const cmd = String(command || '');
  const hostPlatform = String(options?.platform || process.platform).toLowerCase();
  if (/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(cmd)) {
    throw new Error(
      'Construct Shell Guard (Gotcha #1): Heredocs (<<EOF) fail unpredictably in non-interactive shells. Use the Write/Edit tools for files, or write multi-line scripts/commit messages to a scratchpad file first.'
    );
  }
  if (
    !/\bpipefail\b/.test(cmd) &&
    /\b(?:flutter\s+(?:build|test|analyze)|npm\s+(?:test|run\s+(?:build|test))|dotnet\s+(?:build|test)|cargo\s+(?:build|test)|jest|pytest)\b[^|;\r\n]*\|\s*(?:tail|head|grep|Select-Object)\b/i.test(
      cmd
    )
  ) {
    throw new Error(
      'Construct Shell Guard (Gotcha #3): Piping a build or test command into `tail`, `head`, or `grep` swallows the compiler/test exit code and reports failures as 0. Redirect to a log file and check `$LASTEXITCODE` / `echo "exit=$?"`, or set `pipefail`.'
    );
  }
  if (hostPlatform === 'win32' && /\bgh\s+api\s+graphql\b[^\r\n]*-f\s+query=[^\r\n]*"/i.test(cmd)) {
    throw new Error(
      'Construct Shell Guard (Gotcha #4 [win32]): PowerShell 5.1 strips inner double quotes on inline `gh api graphql -f query=...` calls. Write the JSON payload to a scratchpad file and pass `--input <scratch>/payload.json`.'
    );
  }
  if (
    /core\.protectntfs\s*(?:=|\s+)\s*(?:false|0|no)\b/i.test(cmd) ||
    /\bgit\s+add\b[^\r\n]*:Zone\.Identifier/i.test(cmd)
  ) {
    throw new Error(
      'Construct Shell Guard (Gotcha #6 [all]): Never disable core.protectNTFS or stage `:Zone.Identifier` streams (invisible on Linux/macOS, breaks Windows NTFS checkouts). Remove the offending path instead.'
    );
  }
  store.checkDynamicGotchaGuards(cmd, { platform: hostPlatform, project: options?.project });
  return true;
}

const MCP_TOOLS = Object.freeze([
  {
    name: 'construct_boot',
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
    name: 'construct_rec',
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
    name: 'construct_head',
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
    name: 'construct_resolve',
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
    name: 'construct_zoom',
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
    name: 'construct_search',
    description: 'FTS5 BM25 search across the sequential tape, or unified provenance lookup (`why: true` for gotchas + frames with author attribution + git log + optional peer Construct query).',
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
    name: 'construct_rom',
    description: 'List, inspect, slot for this session (`use`), set/clear an until-further-notice default (`default`), tune, or burn directives into a Personality ROM.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['packs', 'list', 'show', 'use', 'sub', 'default', 'tune', 'burn', 'unburn', 'set', 'sync'],
        },
        target: {
          type: 'string',
          description: "ROM or Crew Bank name (sprawl, anathem, generic, or solo/roster for show/use/default, backup name for sub, 'off' to clear default, dial=val pairs for tune, directive text for burn, or index for unburn)",
        },
        rom: { type: 'string', description: 'Optional ROM name when tuning or burning a non-active ROM' },
        pack: { type: 'string', description: 'Crew bank name when filtering list or creating a custom ROM with `set`' },
        seat: { type: 'string' },
        tier: { type: 'string' },
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
    name: 'construct_user',
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
        workspaceRoot: { type: 'string', description: 'Optional base folder for git repositories' },
        calibration: { type: 'string' },
        use: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'construct_gotcha',
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
    name: 'construct_comms',
    description: "Send, reply, acknowledge, list Construct-to-Construct messages, or drop/apply encrypted patches & snippets (`drop` / `apply-drop`).",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['msg', 'reply', 'ack', 'inbox', 'drop', 'apply-drop'],
        },
        project: { type: 'string', description: 'Project key, e.g. acme/alpha_app' },
        to: { type: 'string', description: 'Recipient operator id (for msg/inbox/drop), e.g. bob' },
        via: { type: 'string', description: "Optional courier/messenger ROM to deliver the message or reply in-character (e.g. 'toot', 'bob', 'dixie', 'johnny')" },
        id: { type: 'integer', description: 'Message id (for reply/ack/apply-drop)' },
        body: { type: 'string', description: 'Message, reply text, or patch content (for drop)' },
        file: { type: 'string', description: 'File path to drop or output path for apply-drop' },
        gitDiff: { type: 'boolean', description: 'Capture and drop uncommitted git diff from project repo' },
        apply: { type: 'boolean', description: 'Run `git apply` on an incoming git-diff drop' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'construct_sync',
    description: 'DIDComm v2 + MLS (RFC 9420) + HLC-CRDT group invite, join, live WebSocket relay sync, packet export/import, instruction file assimilation, GitHub Issues <-> Threads sync (`issues-sync` / `issues-publish`), or HTML dashboard generation.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['did', 'invite', 'join', 'sync', 'export', 'import', 'assimilate', 'init', 'upgrade', 'upgrade-check', 'dashboard', 'issues-sync', 'issues-publish'],
        },
        target: {
          type: 'string',
          description: 'Project key (for invite/sync/export), construct://invite/... URI (for join), construct://packet/... token (for import), or directory path (for assimilate)',
        },
        dir: {
          type: 'string',
          description: 'Optional local repository directory (target clone path for `join`, or source repo path for `invite`)',
        },
        project: { type: 'string', description: "Project key when assimilating a repository's instruction files" },
        relays: { type: 'string', description: 'Optional comma-separated WebSocket relay URLs' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
]);

function executeMcpTool(name, input = {}) {
  switch (name) {
    case 'construct_boot': {
      if (!input.project && !input.dir) return runConstructCli(['projects']);
      const args = ['boot'];
      if (input.project) args.push(String(input.project));
      if (input.dir) args.push('--dir', String(input.dir));
      if (input.session) args.push('--session', String(input.session));
      if (input.limit) args.push('-n', String(input.limit));
      return runConstructCli(args);
    }
    case 'construct_rec': {
      const args = ['rec', String(input.project), String(input.kind), String(input.summary)];
      if (input.detail) args.push('--detail', String(input.detail));
      if (input.verified) args.push('--verified', String(input.verified));
      if (input.parent) args.push('--parent', String(input.parent));
      if (input.resolves) args.push('--resolves', String(input.resolves));
      if (input.open) args.push('--open');
      if (input.refs) args.push('--refs', String(input.refs));
      return runConstructCli(args);
    }
    case 'construct_head': {
      const args = ['head', String(input.project), '--state', String(input.state)];
      if (input.next !== undefined) args.push('--next', String(input.next));
      if (input.repo !== undefined) args.push('--repo', String(input.repo));
      return runConstructCli(args);
    }
    case 'construct_resolve': {
      const args = ['resolve', String(input.seqs)];
      if (input.by) args.push('--by', String(input.by));
      if (input.reason) args.push('--reason', String(input.reason));
      if (input.verified) args.push('--verified', String(input.verified));
      if (input.closeGh) args.push('--close-gh');
      return runConstructCli(args);
    }
    case 'construct_zoom': {
      const args = ['zoom', String(input.seq)];
      if (input.window !== undefined) args.push('-w', String(input.window));
      return runConstructCli(args);
    }
    case 'construct_search': {
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
    case 'construct_rom': {
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
      const sid = input.session || process.env.CONSTRUCT_SESSION_ID || '';
      if (sid) args.push('--session', String(sid));
      return runConstructCli(args);
    }
    case 'construct_user': {
      const args = ['user', String(input.action)];
      if (input.id) args.push(String(input.id));
      if (input.name) args.push('--name', String(input.name));
      if (input.osUsers) args.push('--os-users', String(input.osUsers));
      if (input.experience) args.push('--experience', String(input.experience));
      if (input.platform) args.push('--platform', String(input.platform));
      if (input.workspaceRoot !== undefined) args.push('--workspace-root', String(input.workspaceRoot));
      if (input.calibration) args.push('--calibration', String(input.calibration));
      if (input.use) args.push('--use');
      return runConstructCli(args);
    }
    case 'construct_gotcha': {
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
    case 'construct_comms': {
      if (input.action === 'msg') {
        const args = ['msg', String(input.project || 'global'), '--to', String(input.to)];
        if (input.via) args.push('--via', String(input.via));
        args.push(String(input.body));
        return runConstructCli(args);
      }
      if (input.action === 'reply') {
        const args = ['reply', String(input.id)];
        if (input.via) args.push('--via', String(input.via));
        args.push(String(input.body));
        return runConstructCli(args);
      }
      if (input.action === 'ack') {
        return runConstructCli(['ack', String(input.id)]);
      }
      if (input.action === 'drop') {
        const args = ['drop', String(input.project || 'global'), '--to', String(input.to)];
        if (input.via) args.push('--via', String(input.via));
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
    case 'construct_sync': {
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
            },
            serverInfo: {
              name: 'construct',
              version: '0.1.0',
            },
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
        try {
          const text = executeMcpTool(toolName, toolArgs);
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

const store = require('./store');
const packs = require('./packs');

function isValidRomTarget(spec) {
  const known = packs.getKnownRomTargets();
  const parts = String(spec || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => known.has(p));
}

function detectPreSlotRomDirective(promptText) {
  const text = String(promptText || '').trim();
  if (!text) return null;

  const tagMatch = text.match(/^\[ROM:\s*([a-z0-9_]+(?:,[a-z0-9_]+)*)\s*\]/i);
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
    /^(?:please\s+|let'?s\s+|just\s+)?(?:slot|switch\s+to|use|bring\s+in|work\s+with)\s+(?:the\s+)?([a-z0-9_]+(?:,[a-z0-9_]+)*)(?:\s+(?:crew|bank|pack|rom|mode|solo|for\s+this\s*(?:session|turn)?))?(?:[\s,.:;!-]|$)/i
  );
  if (useMatch && isValidRomTarget(useMatch[1])) {
    return { action: 'use', target: useMatch[1].toLowerCase() };
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
    if (toolName === 'Agent' || toolName === 'Task') {
      const promptDirective = detectPreSlotRomDirective(payload?.tool_input?.prompt);
      const explicitAgentType = String(payload?.tool_input?.subagent_type || '').trim().toLowerCase();
      const targetRom =
        promptDirective?.target || (isValidRomTarget(explicitAgentType) ? explicitAgentType : '');
      if (targetRom) {
        store.enqueuePendingSubagentRom(sessionId || 'claude', targetRom);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    const cmd = payload?.tool_input?.command || '';
    validateShellCommand(cmd);
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  if (mode === 'subagent-start' || payload?.hook_event_name === 'SubagentStart') {
    const cwd = payload?.cwd || process.cwd();
    const agentId = String(payload?.agent_id || '').trim();
    const agentType = String(payload?.agent_type || '').trim().toLowerCase();
    const subagentSessionId = agentId ? `${sessionId || 'claude'}:${agentId}` : sessionId || 'claude:subagent';

    const queuedRom = store.consumePendingSubagentRom(sessionId || 'claude', agentType);
    const resolvedRom = isValidRomTarget(agentType) ? agentType : queuedRom;
    if (resolvedRom) {
      store.useRom(resolvedRom, { sessionId: subagentSessionId });
    }

    const args = ['boot', '--dir', String(cwd), '-n', '8', '--session', String(subagentSessionId)];
    let output = runConstructCli(args);
    output = output.replace(/^<!-- CONSTRUCT_SHADOWED:\[.*?\] -->\r?\n?/, '');
    const xml = `<construct-live-memory directory="${cwd}" session="${subagentSessionId}">\n${output}\n</construct-live-memory>`;
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
      try {
        runConstructCli(romArgs);
      } catch (_) {}
    }
  }

  const args = ['boot', '--dir', String(cwd), '-n', '8'];
  if (effectiveSessionId) args.push('--session', String(effectiveSessionId));

  let output = runConstructCli(args);
  output = output.replace(/^<!-- CONSTRUCT_SHADOWED:\[.*?\] -->\r?\n?/, '');
  const xml = `<construct-live-memory directory="${cwd}" session="${effectiveSessionId}">\n${output}\n</construct-live-memory>`;
  return { exitCode: 0, stdout: xml, stderr: '' };
}

module.exports = {
  MCP_TOOLS,
  validateShellCommand,
  detectPreSlotRomDirective,
  executeMcpTool,
  handleJsonRpcRequest,
  startMcpStdioServer,
  runClaudeHook,
};
