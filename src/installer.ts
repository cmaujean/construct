'use strict';
// OpenCode V2 Integration Installer (construct init) & Upstream Self-Updater (construct upgrade).

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

    const shimDir = path.join(configDir, 'src');
    try {
      fs.mkdirSync(shimDir, { recursive: true });
      for (const baseName of ['pocket', 'store', 'mcp', 'lattice']) {
        const targetMod = path.resolve(__dirname, `${baseName}.ts`).replace(/\\/g, '/');
        const shimCode = `module.exports = require(${JSON.stringify(targetMod)});\n`;
        fs.writeFileSync(path.join(shimDir, `${baseName}.ts`), shimCode, 'utf8');
        fs.writeFileSync(path.join(shimDir, `${baseName}.js`), shimCode, 'utf8');
      }
    } catch (_) {}

    return pluginDest;
  }

  function initConstruct(options = {}, file = dbPath()) {
    const configDir = options.configDir || path.join(os.homedir(), '.config', 'opencode');
    fs.mkdirSync(configDir, { recursive: true });

    // Take an automatic pre-upgrade backup of construct.db if it exists and hasn't been backed up yet
    if (file && file !== ':memory:' && fs.existsSync(file)) {
      const bakPath = `${file}.pre-evolved.bak`;
      if (!fs.existsSync(bakPath)) {
        try {
          fs.copyFileSync(file, bakPath);
        } catch (_) {}
      }
    }

    const identity = crdt.loadOrCreateIdentity();
    if (options.rom) {
      useRom(options.rom, file);
    }

    const assimilated = [];
    if (fs.existsSync(configDir)) {
      const res = assimilateLdk(configDir, { project: 'global', rewriteAgents: false }, file);
      if (res.found) assimilated.push(res);
    }

    const pluginDest = installPluginFile(configDir);

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

    return {
      did: identity.did,
      rom: syncRes.rom.name,
      user: syncRes.user ? syncRes.user.id : null,
      detectedLogin: syncRes.detectedLogin,
      onboardingRequired: !syncRes.user,
      pluginPath: pluginDest,
      romFilePath: syncRes.path,
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

    const romFile = typeof syncRes === 'string' ? syncRes : syncRes?.path || '';
    const pluginPath = installPluginFile(configDir);

    return {
      upgraded: previousSha !== currentSha,
      updated: previousSha !== currentSha,
      previousSha,
      currentSha,
      pullOutput,
      romFile,
      pluginPath,
    };
  }

  return {
    installPluginFile,
    initConstruct,
    getCachedConstructUpstreamInDb,
    setCachedConstructUpstreamInDb,
    checkConstructUpstream,
    upgradeConstruct,
  };
}

module.exports = { createInstallerModule };
