'use strict';
// Agent Integration Installer (construct init) & Upstream Self-Updater (construct upgrade).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createInstallerModule(deps) {
  const {
    dbPath,
    withDb,
    tx,
    nowIso,
    useRom,
    syncRom,
    syncActiveRomInDb,
    assimilateLdk,
    crdt,
    romMod,
  } = deps;

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
      `model: ${seatMeta.claudeModel || 'sonnet'}`,
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
  const candidateGlobalDirs = [configDir, path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.omp', 'agent')];
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
  const binPath = path.resolve(__dirname, '..', 'bin', 'construct.js').replace(/\\/g, '/');

  // Optional Claude Code configuration (`construct init --claude` or `--all`)
  let claudeConfigured = false;
  let claudeMdPath = '';
  let claudeSettingsPath = '';
  let claudeAgentsDir = '';
  let claudeAgentsCount = 0;
  if (options.claude || options.allAgents) {
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

  // Optional Cursor IDE & Cloud Agent configuration (`construct init --cursor` or `--all`)
  let cursorConfigured = false;
  let cursorMcpPath = '';
  let cursorHooksPath = '';
  let cursorRulePath = '';
  if (options.cursor || options.allAgents) {
    const cursorDir = options.cursorDir || path.join(os.homedir(), '.cursor');
    fs.mkdirSync(path.join(cursorDir, 'rules'), { recursive: true });

    cursorMcpPath = path.join(cursorDir, 'mcp.json');
    let cursorMcp = {};
    if (fs.existsSync(cursorMcpPath)) {
      try {
        cursorMcp = JSON.parse(fs.readFileSync(cursorMcpPath, 'utf8'));
      } catch (_) {
        cursorMcp = {};
      }
    }
    cursorMcp.mcpServers = cursorMcp.mcpServers || {};
    cursorMcp.mcpServers.construct = {
      command: 'node',
      args: [binPath, 'mcp'],
    };
    fs.writeFileSync(cursorMcpPath, JSON.stringify(cursorMcp, null, 2) + '\n', 'utf8');

    cursorHooksPath = path.join(cursorDir, 'hooks.json');
    let cursorHooks = { version: 1, hooks: {} };
    if (fs.existsSync(cursorHooksPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cursorHooksPath, 'utf8'));
        if (parsed && typeof parsed === 'object') cursorHooks = parsed;
      } catch (_) {}
    }
    cursorHooks.version = 1;
    cursorHooks.hooks = cursorHooks.hooks || {};
    cursorHooks.hooks.sessionStart = [{ command: `node "${binPath}" cursor-hook session-start` }];
    cursorHooks.hooks.beforeSubmitPrompt = [{ command: `node "${binPath}" cursor-hook before-prompt` }];
    cursorHooks.hooks.beforeShellExecution = [{ command: `node "${binPath}" cursor-hook before-shell` }];
    cursorHooks.hooks.postToolUse = [{ command: `node "${binPath}" cursor-hook post-tool` }];
    fs.writeFileSync(cursorHooksPath, JSON.stringify(cursorHooks, null, 2) + '\n', 'utf8');

    cursorRulePath = path.join(cursorDir, 'rules', 'construct.mdc');
    const baseRomMd = fs.existsSync(syncRes.path) ? fs.readFileSync(syncRes.path, 'utf8') : '';
    const mdcContent = `---\ndescription: Construct Base Cartridge (Operator Agreement, Core Protocol & Global Gotchas)\nalwaysApply: true\n---\n\n${baseRomMd}`;
    fs.writeFileSync(cursorRulePath, mdcContent, 'utf8');
    cursorConfigured = true;
  }

  // Optional Gemini CLI / Antigravity configuration (`construct init --gemini` or `--all`)
  let geminiConfigured = false;
  let geminiMdPath = '';
  let geminiSettingsPath = '';
  if (options.gemini || options.allAgents) {
    const geminiDir = options.geminiDir || path.join(os.homedir(), '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    geminiMdPath = path.join(geminiDir, 'GEMINI.md');
    fs.copyFileSync(syncRes.path, geminiMdPath);

    geminiSettingsPath = path.join(geminiDir, 'settings.json');
    let gemSettings = {};
    if (fs.existsSync(geminiSettingsPath)) {
      try {
        gemSettings = JSON.parse(fs.readFileSync(geminiSettingsPath, 'utf8'));
      } catch (_) {
        gemSettings = {};
      }
    }
    gemSettings.mcpServers = gemSettings.mcpServers || {};
    gemSettings.mcpServers.construct = {
      command: 'node',
      args: [binPath, 'mcp'],
    };
    gemSettings.hooks = gemSettings.hooks || {};
    gemSettings.hooks.SessionStart = [
      {
        hooks: [{ name: 'construct-session-start', type: 'command', command: `node "${binPath}" gemini-hook session-start` }],
      },
    ];
    gemSettings.hooks.BeforeAgent = [
      {
        hooks: [{ name: 'construct-before-agent', type: 'command', command: `node "${binPath}" gemini-hook before-agent` }],
      },
    ];
    gemSettings.hooks.BeforeTool = [
      {
        matcher: 'run_shell_command|shell|bash',
        hooks: [{ name: 'construct-shell-guard', type: 'command', command: `node "${binPath}" gemini-hook before-tool` }],
      },
    ];
    fs.writeFileSync(geminiSettingsPath, JSON.stringify(gemSettings, null, 2) + '\n', 'utf8');
    geminiConfigured = true;
  }

  // Optional Windsurf (Cascade) configuration (`construct init --windsurf` or `--all`)
  let windsurfConfigured = false;
  let windsurfMcpPath = '';
  let windsurfRulesPath = '';
  if (options.windsurf || options.allAgents) {
    const windsurfDir = options.windsurfDir || path.join(os.homedir(), '.codeium', 'windsurf');
    fs.mkdirSync(path.join(windsurfDir, 'memories'), { recursive: true });

    windsurfMcpPath = path.join(windsurfDir, 'mcp_config.json');
    let wsMcp = {};
    if (fs.existsSync(windsurfMcpPath)) {
      try {
        wsMcp = JSON.parse(fs.readFileSync(windsurfMcpPath, 'utf8'));
      } catch (_) {
        wsMcp = {};
      }
    }
    wsMcp.mcpServers = wsMcp.mcpServers || {};
    wsMcp.mcpServers.construct = {
      command: 'node',
      args: [binPath, 'mcp'],
    };
    fs.writeFileSync(windsurfMcpPath, JSON.stringify(wsMcp, null, 2) + '\n', 'utf8');

    windsurfRulesPath = path.join(windsurfDir, 'memories', 'global_rules.md');
    fs.copyFileSync(syncRes.path, windsurfRulesPath);
    windsurfConfigured = true;
  }

  // Optional Codex CLI configuration (`construct init --codex` or `--all`)
  let codexConfigured = false;
  let codexMdPath = '';
  let codexConfigPath = '';
  if (options.codex || options.allAgents) {
    const codexDir = options.codexDir || path.join(os.homedir(), '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    codexMdPath = path.join(codexDir, 'AGENTS.md');
    fs.copyFileSync(syncRes.path, codexMdPath);

    codexConfigPath = path.join(codexDir, 'config.toml');
    const existingToml = fs.existsSync(codexConfigPath) ? fs.readFileSync(codexConfigPath, 'utf8') : '';
    const tomlBlock = `[mcp_servers.construct]\ncommand = "node"\nargs = ["${binPath}", "mcp"]\n`;
    if (!existingToml.includes('[mcp_servers.construct]')) {
      fs.writeFileSync(codexConfigPath, (existingToml ? existingToml.trimEnd() + '\n\n' : '') + tomlBlock, 'utf8');
    }
    codexConfigured = true;
  }

  // Optional Oh My Pi (can1357/oh-my-pi, CLI `omp`) configuration (`construct init --omp` or `--all`)
  let ompConfigured = false;
  let ompMdPath = '';
  let ompMcpPath = '';
  let ompExtensionPath = '';
  if (options.omp || options.allAgents) {
    const ompDir = options.ompDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.omp', 'agent');
    fs.mkdirSync(path.join(ompDir, 'extensions'), { recursive: true });

    ompMdPath = path.join(ompDir, 'AGENTS.md');
    fs.copyFileSync(syncRes.path, ompMdPath);

    ompMcpPath = path.join(ompDir, 'mcp.json');
    let ompMcp = {};
    if (fs.existsSync(ompMcpPath)) {
      try {
        ompMcp = JSON.parse(fs.readFileSync(ompMcpPath, 'utf8'));
      } catch (_) {
        ompMcp = {};
      }
    }
    if (!ompMcp.$schema) {
      ompMcp.$schema = 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json';
    }
    ompMcp.mcpServers = ompMcp.mcpServers || {};
    ompMcp.mcpServers.construct = {
      type: 'stdio',
      command: 'node',
      args: [binPath, 'mcp'],
    };
    fs.writeFileSync(ompMcpPath, JSON.stringify(ompMcp, null, 2) + '\n', 'utf8');

    ompExtensionPath = path.join(ompDir, 'extensions', 'construct.js');
    const mcpMod = require('./mcp');
    fs.writeFileSync(ompExtensionPath, mcpMod.buildOmpExtensionSource(binPath), 'utf8');
    ompConfigured = true;
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
    cursorConfigured,
    cursorMcpPath,
    cursorHooksPath,
    cursorRulePath,
    geminiConfigured,
    geminiMdPath,
    geminiSettingsPath,
    windsurfConfigured,
    windsurfMcpPath,
    windsurfRulesPath,
    codexConfigured,
    codexMdPath,
    codexConfigPath,
    ompConfigured,
    ompMdPath,
    ompMcpPath,
    ompExtensionPath,
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

  // If Claude Code, Cursor, Gemini CLI, Windsurf, or Codex were previously configured on this machine,
  // automatically refresh their base cartridge files and subagents on upgrade as well.
  const claudeDir = options.claudeDir || path.join(os.homedir(), '.claude');
  let claudeUpgraded = false;
  if (options.claude || fs.existsSync(path.join(claudeDir, 'agents'))) {
    try {
      const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
      if (syncRes?.path && fs.existsSync(syncRes.path)) {
        fs.copyFileSync(syncRes.path, claudeMdPath);
      }
      withDb((db) => writeClaudeSubagentsInDb(db, claudeDir), file);
      claudeUpgraded = true;
    } catch (_) {}
  }

  try {
    const cursorRule = path.join(os.homedir(), '.cursor', 'rules', 'construct.mdc');
    if (syncRes?.path && fs.existsSync(cursorRule)) {
      const baseRomMd = fs.readFileSync(syncRes.path, 'utf8');
      fs.writeFileSync(
        cursorRule,
        `---\ndescription: Construct Base Cartridge (Operator Agreement, Core Protocol & Global Gotchas)\nalwaysApply: true\n---\n\n${baseRomMd}`,
        'utf8'
      );
    }
    const geminiMd = path.join(os.homedir(), '.gemini', 'GEMINI.md');
    if (syncRes?.path && fs.existsSync(geminiMd)) fs.copyFileSync(syncRes.path, geminiMd);
    const windsurfRules = path.join(os.homedir(), '.codeium', 'windsurf', 'memories', 'global_rules.md');
    if (syncRes?.path && fs.existsSync(windsurfRules)) fs.copyFileSync(syncRes.path, windsurfRules);
    const codexMd = path.join(os.homedir(), '.codex', 'AGENTS.md');
    if (syncRes?.path && fs.existsSync(codexMd)) fs.copyFileSync(syncRes.path, codexMd);
    const ompDir = options.ompDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.omp', 'agent');
    const ompMd = path.join(ompDir, 'AGENTS.md');
    if (syncRes?.path && fs.existsSync(ompMd)) fs.copyFileSync(syncRes.path, ompMd);
    const ompExt = path.join(ompDir, 'extensions', 'construct.js');
    if (fs.existsSync(ompExt)) {
      const binPath = path.resolve(__dirname, '..', 'bin', 'construct.js').replace(/\\/g, '/');
      fs.writeFileSync(ompExt, require('./mcp').buildOmpExtensionSource(binPath), 'utf8');
    }
  } catch (_) {}

  return {
    upgraded: previousSha !== currentSha || Boolean(pullOutput),
    previousSha,
    currentSha,
    pullOutput,
    romFile: syncRes.path,
    pluginPath,
    claudeUpgraded,
  };
}


  return {
    writeClaudeSubagentsInDb,
    installPluginFile,
    initConstruct,
    getCachedConstructUpstreamInDb,
    setCachedConstructUpstreamInDb,
    checkConstructUpstream,
    upgradeConstruct,
  };
}

module.exports = { createInstallerModule };
