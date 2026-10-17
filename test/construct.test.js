'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const store = require('../src/store');

const CLI = path.join(__dirname, '..', 'bin', 'construct.js');

function makeTempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-test-'));
  return {
    dir,
    db: path.join(dir, 'construct.db'),
    romFile: path.join(dir, 'active-rom.md'),
    idFile: path.join(dir, 'identity.json'),
  };
}

describe('construct sequential tape & heads', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTempPaths();
    process.env.CONSTRUCT_DB = tmp.db;
    process.env.CONSTRUCT_ROM_FILE = tmp.romFile;
    process.env.CONSTRUCT_IDENTITY_FILE = tmp.idFile;
  });

  afterEach(() => {
    store.closeAllDbs();
    delete process.env.CONSTRUCT_DB;
    delete process.env.CONSTRUCT_ROM_FILE;
    delete process.env.CONSTRUCT_IDENTITY_FILE;
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('records frames in strict monotonic sequence and normalizes project keys', () => {
    const f1 = store.recordFrame({
      project: '~/src/acme\\alpha_app/',
      kind: 'probe',
      summary: 'Measured cold start latency across 14 days',
      detail: 'median 6.19s cold vs 0.18s warm',
      verified: 'cloud logs (N=1639)',
      refs: '#98, backend/src/index.ts',
      ts: '2026-10-08T10:00:00Z',
    }).frame;

    const f2 = store.recordFrame({
      project: 'acme/alpha_app',
      kind: 'finding',
      summary: 'Heavy SDK top-level import costs 1.2s on cold start',
      parentSeq: f1.seq,
      refs: ['#98'],
      ts: '2026-10-08T10:05:00Z',
    }).frame;

    const f3 = store.recordFrame({
      project: 'mods/voxel-craft',
      kind: 'finding',
      summary: 'Placed block uses Halves layout, offering Shift+RMB',
      ts: '2026-10-08T10:10:00Z',
    }).frame;

    assert.equal(f1.seq, 1);
    assert.equal(f2.seq, 2);
    assert.equal(f3.seq, 3);
    assert.equal(f1.project, 'acme/alpha_app');
    assert.equal(f2.parentSeq, 1);
    assert.deepEqual(f1.refs, ['#98', 'backend/src/index.ts']);

    const appTape = store.getTape({ project: 'acme/alpha_app' });
    assert.deepEqual(appTape.map((f) => f.seq), [1, 2]);

    const globalTape = store.getTape({ limit: 2 });
    assert.deepEqual(globalTape.map((f) => f.seq), [2, 3]);
  });

  it('tracks open threads and resolves them via new frames or explicit resolve', () => {
    const t1 = store.recordFrame({
      project: 'acme/alpha_app',
      kind: 'thread',
      summary: 'Verify expanded schema live against production model',
      refs: ['#93', '0.4.18'],
    }).frame;

    const t2 = store.recordFrame({
      project: 'acme/alpha_app',
      kind: 'change',
      summary: 'Lowered JVM heap to -Xmx4G',
      open: true,
      refs: ['0.4.18'],
    }).frame;

    assert.equal(t1.open, true);
    assert.equal(t2.open, true);

    let boot = store.bootProject('acme/alpha_app');
    assert.deepEqual(boot.openFrames.map((f) => f.seq), [t1.seq, t2.seq]);

    const rel = store.recordFrame({
      project: 'acme/alpha_app',
      kind: 'release',
      summary: '0.4.18 bundle built and shipped green',
      verified: 'CI run 37823073021',
      resolves: [t2.seq],
    });
    assert.deepEqual(rel.resolved, [t2.seq]);

    boot = store.bootProject('acme/alpha_app');
    assert.deepEqual(boot.openFrames.map((f) => f.seq), [t1.seq]);

    const res = store.resolveFrames([t1.seq], {
      reason: 'Live generation succeeded with expanded schema',
      verified: 'production logs 2026-10-11',
    });
    assert.equal(res.resolved[0].open, false);
    assert.equal(res.resolved[0].resolvedBy, res.byFrame.seq);
    assert.equal(res.byFrame.parentSeq, t1.seq);

    boot = store.bootProject('acme/alpha_app');
    assert.equal(boot.openFrames.length, 0);
    assert.equal(boot.stats.totalFrames, 4);

    const reopened = store.reopenFrame(t1.seq);
    assert.equal(reopened.open, true);
    assert.equal(reopened.resolvedBy, null);
  });

  it('zooms a frame with its causal chain and project-local neighbor window', () => {
    const p1 = store.recordFrame({
      project: 'mods/machines',
      kind: 'decision',
      summary: '0.28.0 try circular sawmill with raised arbor',
    }).frame;

    store.recordFrame({
      project: 'board',
      kind: 'commit',
      summary: 'Unrelated board commit',
    });

    const p2 = store.recordFrame({
      project: 'mods/machines',
      kind: 'change',
      summary: '0.29.0 add feed chute tower on back column',
      parentSeq: p1.seq,
    }).frame;

    const p3 = store.recordFrame({
      project: 'mods/machines',
      kind: 'dead_end',
      summary: '0.31.0 revert circular saw back to 0.27.0 frame saw',
      parentSeq: p2.seq,
    }).frame;

    const p4 = store.recordFrame({
      project: 'mods/machines',
      kind: 'change',
      summary: '0.32.0 dark iron flywheel crank on frame saw',
      parentSeq: p3.seq,
    }).frame;

    const z = store.zoomFrame(p3.seq, { window: 1 });
    assert.equal(z.frame.seq, p3.seq);
    assert.deepEqual(z.ancestors.map((f) => f.seq), [p1.seq, p2.seq]);
    assert.deepEqual(z.children.map((f) => f.seq), [p4.seq]);
    assert.deepEqual(z.neighbors.map((f) => f.seq), [p2.seq, p3.seq, p4.seq]);

    const z2 = store.zoomFrame(p2.seq, { window: 1 });
    assert.deepEqual(z2.neighbors.map((f) => f.seq), [p1.seq, p2.seq, p3.seq]);
  });

  it('indexes frames in FTS5, handles special punctuation, and updates index on edit', () => {
    const f1 = store.recordFrame({
      project: 'acme/alpha_app',
      kind: 'finding',
      summary: 'Completer in setUp hangs testWidgets fake-async zone',
      detail: 'provider waited forever until teardown',
      refs: ['#98', 'links_test.dart'],
    }).frame;

    store.recordFrame({
      project: 'mods/notes',
      kind: 'change',
      summary: 'Handshake.cs refuses mismatched client versions with Error 3',
      refs: ['0.7.0'],
    });

    const hits1 = store.searchFrames('fake-async Completer');
    assert.equal(hits1.length, 1);
    assert.equal(hits1[0].seq, f1.seq);

    const hits2 = store.searchFrames('#98 links_test.dart');
    assert.equal(hits2.length, 1);
    assert.equal(hits2[0].seq, f1.seq);

    store.editFrame(f1.seq, { summary: 'Zone mismatch in widget test setup' });
    assert.equal(store.searchFrames('Completer').length, 0);
    assert.equal(store.searchFrames('Zone mismatch').length, 1);
  });
});

describe('construct ROMs, onboarding, LDK assimilation & DIDComm/MLS/CRDT sync', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTempPaths();
    process.env.CONSTRUCT_DB = tmp.db;
    process.env.CONSTRUCT_ROM_FILE = tmp.romFile;
    process.env.CONSTRUCT_IDENTITY_FILE = tmp.idFile;
  });

  afterEach(() => {
    store.closeAllDbs();
    delete process.env.CONSTRUCT_DB;
    delete process.env.CONSTRUCT_ROM_FILE;
    delete process.env.CONSTRUCT_IDENTITY_FILE;
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('seeds all 34 ROMs across sprawl, anathem, and generic banks, defaults to crew mode, supports bench substitutions, and isolates sessions', () => {
    const roms = store.listRoms();
    assert.equal(roms.length, 34);
    const packs = store.listPacks();
    assert.deepEqual(packs.map((p) => p.pack), ['anathem', 'generic', 'sprawl']);
    const active = store.getRom();
    assert.equal(active.name, 'crew');
    assert.equal(active.isCrew, true);
    assert.equal(active.roster.length, 9);

    // 1. Out of the box, a new session boots into the 9-seat `sprawl` crew mode by default
    const bootDefaultCrew = store.bootProject('acme/alpha_app', { sessionId: 'ses_default_crew' });
    assert.equal(bootDefaultCrew.rom.name, 'crew');
    assert.equal(bootDefaultCrew.romSlotted, true);
    assert.match(bootDefaultCrew.sessionRomPrompt, /Construct Crew Pipeline/);
    assert.match(bootDefaultCrew.sessionRomPrompt, /lupus/);
    assert.match(bootDefaultCrew.sessionRomPrompt, /angie/);

    // Clearing the default (`setDefaultRom('off')`) makes a brand-new session (`ses_new`) boot with `razor` and the 3-Crew bootloader selector prompt
    store.setDefaultRom('off');
    const bootNew = store.bootProject('acme/alpha_app', { sessionId: 'ses_new' });
    assert.equal(bootNew.rom.name, 'razor');
    assert.equal(bootNew.romSlotted, false);
    assert.match(bootNew.sessionRomPrompt, /SESSION BOOTLOADER: SELECT YOUR CONSTRUCT CREW BANK/);
    assert.match(bootNew.sessionRomPrompt, /sprawl \(The Sprawl Crew/);
    assert.match(bootNew.sessionRomPrompt, /anathem \(The Concent of Saunt Edhar Crew\)/);
    assert.match(bootNew.sessionRomPrompt, /generic \(The Standard Engineering Crew\)/);

    // 2. Slotting `molly` in `ses_A` and `wintermute` in `ses_B` keeps both isolated and leaves `ses_new` untouched
    store.useRom('molly', { sessionId: 'ses_A' });
    store.useRom('wintermute', { sessionId: 'ses_B' });

    const bootA = store.bootProject('acme/alpha_app', { sessionId: 'ses_A' });
    const bootB = store.bootProject('acme/alpha_app', { sessionId: 'ses_B' });
    const bootStillNew = store.bootProject('acme/alpha_app', { sessionId: 'ses_new' });

    assert.equal(bootA.rom.name, 'molly');
    assert.equal(bootA.romSlotted, true);
    assert.doesNotMatch(bootA.sessionRomPrompt, /SESSION BOOTLOADER/);

    assert.equal(bootB.rom.name, 'wintermute');
    assert.equal(bootB.romSlotted, true);

    assert.equal(bootStillNew.rom.name, 'razor');
    assert.equal(bootStillNew.romSlotted, false);

    // 3. Setting an "until further notice" default ROM (`setDefaultRom('molly')`) makes new unslotted sessions
    //    boot straight into `molly`, while `ses_B` keeps its session-specific `wintermute` override!
    store.setDefaultRom('molly');
    const bootWithDefault = store.bootProject('acme/alpha_app', { sessionId: 'ses_new' });
    assert.equal(bootWithDefault.rom.name, 'molly');
    assert.equal(bootWithDefault.romSlotted, true);
    assert.doesNotMatch(bootWithDefault.sessionRomPrompt, /SESSION BOOTLOADER/);
    assert.equal(store.bootProject('acme/alpha_app', { sessionId: 'ses_B' }).rom.name, 'wintermute');

    // Clearing the default (`setDefaultRom('off')`) restores the `razor` bootloader selector for new sessions
    store.setDefaultRom('off');
    const bootAfterClear = store.bootProject('acme/alpha_app', { sessionId: 'ses_new' });
    assert.equal(bootAfterClear.rom.name, 'razor');
    assert.equal(bootAfterClear.romSlotted, false);
    assert.match(bootAfterClear.sessionRomPrompt, /SESSION BOOTLOADER/);

    // 4. Full `crew` mode (9 seats), `anathem` bank, `generic` bank, bench `subRom`, and custom rosters
    const crewRom = store.useRom('crew', { sessionId: 'ses_crew' });
    assert.equal(crewRom.isCrew, true);
    assert.deepEqual(crewRom.roster, [
      'colin',
      'dixie',
      'wintermute',
      'molly',
      'finn',
      'case',
      'lupus',
      'angie',
      'continuity',
    ]);
    const bootCrew = store.bootProject('acme/alpha_app', { sessionId: 'ses_crew' });
    assert.match(bootCrew.sessionRomPrompt, /Construct Crew Pipeline/);
    assert.match(bootCrew.sessionRomPrompt, /\[COLIN \/\/ RECON & EXPOSITION\]/);
    assert.match(bootCrew.sessionRomPrompt, /\[MOLLY \/\/ THE BLITZ\]/);

    // Substitute bench backup `marly` into Seat 4D (`ergonomics`), replacing `angie`
    const subbedSprawl = store.subRom('marly', { sessionId: 'ses_crew' });
    assert.ok(subbedSprawl.roster.includes('marly'));
    assert.ok(!subbedSprawl.roster.includes('angie'));

    // Switch to the `anathem` 9-seat crew bank and verify Concent-native tags/episteme with zero Sprawl slang bleed
    const anathemCrew = store.useRom('anathem', { sessionId: 'ses_anathem' });
    assert.equal(anathemCrew.isCrew, true);
    assert.deepEqual(anathemCrew.roster, [
      'erasmus',
      'sammann',
      'jad',
      'cord',
      'orolo',
      'jesry',
      'lio',
      'tulia',
      'ala',
    ]);
    assert.match(anathemCrew.voice, /\[ERASMUS \/\/ CALCA & EXPOSITION\]/);
    assert.match(anathemCrew.voice, /\[CORD \/\/ EXTRAMUROS FORGE\]/);
    assert.match(anathemCrew.voice, /\[ALA \/\/ THE CHRONICLE\]/);
    assert.match(anathemCrew.voice, /Pardon, Fraa Jad/);
    assert.match(anathemCrew.voice, /Zero Catchphrase Repetition/);
    assert.doesNotMatch(anathemCrew.voice, /Actually guv/);
    assert.doesNotMatch(anathemCrew.voice, /THE BLITZ/);
    assert.doesNotMatch(anathemCrew.voice, /watches the regression test bleed red/);
    assert.doesNotMatch(anathemCrew.voice, /Pulled the pin to watch it fail first/);

    const subbedAnathem = store.subRom('lodoghir', { sessionId: 'ses_anathem' });
    assert.ok(subbedAnathem.roster.includes('lodoghir'));
    assert.ok(!subbedAnathem.roster.includes('jad'));

    // Switch to the `generic` zero-fiction 9-seat crew bank and verify zero literary bleed
    const genericCrew = store.useRom('generic', { sessionId: 'ses_generic' });
    assert.equal(genericCrew.isCrew, true);
    assert.deepEqual(genericCrew.roster, [
      'guide',
      'trace',
      'arch',
      'strike',
      'audit',
      'pulse',
      'redteam',
      'ux',
      'ledger',
    ]);
    assert.match(genericCrew.voice, /\[GUIDE \/\/ STACK ORIENTATION\]/);
    assert.match(genericCrew.voice, /\[STRIKE \/\/ IMPLEMENTATION\]/);
    assert.match(genericCrew.voice, /\[LEDGER \/\/ RELEASE & TAPE\]/);
    assert.doesNotMatch(genericCrew.voice, /Actually guv/);
    assert.doesNotMatch(genericCrew.voice, /Fraa Jad/);

    const customCrew = store.useRom('colin,wintermute,molly', { sessionId: 'ses_custom' });
    assert.equal(customCrew.isCrew, true);
    assert.deepEqual(customCrew.roster, ['colin', 'wintermute', 'molly']);
    const bootCustom = store.bootProject('acme/alpha_app', { sessionId: 'ses_custom' });
    assert.match(bootCustom.sessionRomPrompt, /colin -> wintermute -> molly/);
    assert.doesNotMatch(bootCustom.sessionRomPrompt, /- \*\*\[THE FINN \/\/ BENCH FORENSICS\]/);

    // Verify wintermute (and architect alias), continuity, finn, and case are seeded with full voice architecture
    const wm = store.getRom('wintermute');
    assert.equal(wm.name, 'wintermute');
    assert.equal(store.getRom('architect').name, 'wintermute');
    assert.match(wm.voice, /Tessier-Ashpool/);

    const cont = store.getRom('continuity');
    assert.equal(cont.name, 'continuity');
    assert.match(cont.voice, /Maas-Neotek biochip intelligence/);

    const finn = store.getRom('finn');
    assert.equal(finn.name, 'finn');
    assert.match(finn.voice, /Metro Holografix/);

    const caseRom = store.getRom('case');
    assert.equal(caseRom.name, 'case');
    assert.match(caseRom.voice, /Ono-Sendai cyberspace cowboy/);

    const colin = store.getRom('colin');
    assert.equal(colin.name, 'colin');
    assert.match(colin.voice, /Kumiko carries in her coat pocket/);

    store.useRom('dixie');
    const tuned = store.tuneRom({ edge: 0.9, terse: 0.95 });
    assert.equal(tuned.dials.edge, 0.9);
    assert.equal(tuned.dials.terse, 0.95);

    assert.throws(() => store.tuneRom({ edge: 1.5 }), /between 0\.0 and 1\.0/);
    assert.throws(() => store.tuneRom({ bogus: 0.5 }), /unknown dial/);

    const burned = store.burnDirective('Never trust a green suite without watching it fail.');
    assert.ok(burned.directives.includes('Never trust a green suite without watching it fail.'));
    const unburned = store.unburnDirective(burned.directives.length);
    assert.ok(!unburned.directives.includes('Never trust a green suite without watching it fail.'));

    const molly = store.getRom('molly');
    assert.equal(molly.name, 'molly');
    assert.equal(molly.dials.autonomy, 0.95);

    const cloned = store.cloneRom('molly', 'sally', {
      handle: 'Sally Shears // Mona Lisa Overdrive',
      use: true,
    });
    assert.equal(cloned.name, 'sally');
  });

  it('starts with 0 hardcoded users or gotchas, triggers onboarding for new operators, and scopes gotchas', () => {
    assert.equal(store.listUsers().length, 0);
    assert.equal(store.listGotchas('all').length, 0);

    process.env.CONSTRUCT_USER = 'newbie';
    const synced1 = store.syncRom();
    assert.equal(synced1.user, null);
    assert.equal(synced1.detectedLogin, 'newbie');
    assert.match(fs.readFileSync(tmp.romFile, 'utf8'), /UNREGISTERED \(`newbie`\) — First-Boot Crew Selection/);

    const createdUser = store.setUser('newbie', {
      name: 'Case',
      osUsers: 'newbie',
      experience: 'Console cowboy from Chiba',
      platform: 'Hosaka Ono-Sendai Cyberspace 7',
      calibration: 'Keep it fast.',
      active: true,
    });
    assert.equal(createdUser.name, 'Case');
    assert.match(fs.readFileSync(tmp.romFile, 'utf8'), /Active Operator Agreement: Case \(`newbie`\)/);

    store.addGotcha({
      scope: 'global',
      title: 'Heredocs fail in non-interactive shells',
      status: 'observed',
      evidence: 'unexpected EOF',
      fix: 'Write to scratchpad file instead',
    });

    store.addGotcha({
      scope: 'acme/alpha_app',
      title: 'Security rules are not filters',
      status: 'observed',
      evidence: 'permission-denied when query omits ownerId filter',
      fix: 'Mirror rule constraints in query .where() clauses',
    });

    assert.equal(store.listGotchas('global').length, 1);
    assert.equal(store.listGotchas('acme/alpha_app').length, 1);
    assert.equal(store.bootProject('acme/alpha_app').projectGotchas.length, 1);

    delete process.env.CONSTRUCT_USER;
  });

  it('assimilates existing repository instruction files and dev docs (agreements, 02-gotchas.md, 04-scripts.md)', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-ldk-repo-'));
    try {
      const ldkDir = path.join(repoDir, 'docs', 'dev');
      const agreementsDir = path.join(ldkDir, 'agreements');
      fs.mkdirSync(agreementsDir, { recursive: true });

      fs.writeFileSync(
        path.join(agreementsDir, 'TEMPLATE.md'),
        '# Working with <name>\nTemplate text that must be ignored.\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(agreementsDir, 'alice.md'),
        `# Working with Alice

**Platform:** Linux (Ubuntu 24.04, bash).

## Who you are working with

Principal distributed systems engineer with 20 years of experience.

- Lead with the finding and file:line.
- Never use interactive prompts in scripts.
`,
        'utf8'
      );

      fs.writeFileSync(
        path.join(ldkDir, '02-gotchas.md'),
        `# The gotchas log

### <The claim>

Template example to skip.

### Parallel uploads using Date.now() collide on the same key

**observed** -- 4 concurrent uploads overwrote the same object.

    uploads/\${Date.now()}.jpg

Append a random suffix to concurrent filenames.

Found 2026-10-01.

### Exit 134 from node means heap OOM

**observed** -- CI died with exit code 134.

Set NODE_OPTIONS=--max_old_space_size=4096.

Found 2026-09-28.
`,
        'utf8'
      );

      fs.writeFileSync(
        path.join(ldkDir, '04-scripts.md'),
        `# Scripts

| Command | From | Does |
|---|---|---|
| \`npm test\` | \`backend/\` | Run unit suite |
| \`npm run build\` | \`backend/\` | Typecheck and compile |
`,
        'utf8'
      );

      const res = store.assimilateLdk(repoDir, { project: 'acme/alpha_app', removeLdk: true });
      assert.equal(res.found, true);
      assert.deepEqual(res.usersImported, ['alice']);
      assert.equal(res.gotchasImported, 2);
      assert.equal(res.scriptsExtracted, 2);
      assert.equal(res.removedLdkDir, true);
      assert.equal(fs.existsSync(ldkDir), false);
      // Verify construct never pollutes the target repository with an AGENTS.md or construct files
      assert.equal(fs.existsSync(path.join(repoDir, 'AGENTS.md')), false);

      const alice = store.getUser('alice').user;
      assert.equal(alice.name, 'Alice');
      assert.match(alice.platform, /Linux/);

      const projGotchas = store.listGotchas('acme/alpha_app');
      assert.equal(projGotchas.length, 2);
      assert.equal(projGotchas[0].title, 'Parallel uploads using Date.now() collide on the same key');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('auto-clones a missing git repo on joinInvite, assimilates its LDK, and prevents cross-project bleed', async () => {
    const relaySrv = await store.startLocalRelayServer(0);
    const aliceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-alice-'));
    const bobHome = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-bob-'));

    try {
      const aliceSrc = path.join(aliceHome, 'src');
      const bobSrc = path.join(bobHome, 'src');
      const sharedRepoOrigin = path.join(aliceSrc, 'acme', 'shared_app');
      fs.mkdirSync(path.join(sharedRepoOrigin, 'docs', 'dev'), { recursive: true });

      // Initialize a real git repository in Alice's ~/src/acme/shared_app with an LDK gotcha
      fs.writeFileSync(
        path.join(sharedRepoOrigin, 'docs', 'dev', '02-gotchas.md'),
        `# Gotchas\n\n### StreamProvider must be watched, not read, inside build()\n\n**observed** -- frame 1 saw null.\n\nAlways call ref.watch on stream providers.\n\nFound 2026-10-16.\n`,
        'utf8'
      );
      execFileSync('git', ['init', '-b', 'main'], { cwd: sharedRepoOrigin, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'alice@example.com'], { cwd: sharedRepoOrigin, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Alice'], { cwd: sharedRepoOrigin, stdio: 'ignore' });
      execFileSync('git', ['remote', 'add', 'origin', sharedRepoOrigin], { cwd: sharedRepoOrigin, stdio: 'ignore' });
      execFileSync('git', ['add', '.'], { cwd: sharedRepoOrigin, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: sharedRepoOrigin, stdio: 'ignore' });

      // --- 1. Alice (Molly ROM) has both a PRIVATE project (`secret/stealth_mod`) and the SHARED project (`acme/shared_app`) ---
      process.env.CONSTRUCT_DB = path.join(aliceHome, 'construct.db');
      process.env.CONSTRUCT_IDENTITY_FILE = path.join(aliceHome, 'identity.json');
      process.env.CONSTRUCT_ROM_FILE = path.join(aliceHome, 'active-rom.md');
      process.env.CONSTRUCT_SRC_ROOT = aliceSrc;
      process.env.CONSTRUCT_USER = 'alice';

      store.setUser('alice', { name: 'Alice', osUsers: 'alice', active: true });
      store.useRom('molly');

      // Record private data that must NEVER leak to Bob
      store.addGotcha({
        scope: 'global',
        title: 'Alice private machine gotcha',
        evidence: 'private',
        fix: 'private',
      });
      store.addGotcha({
        scope: 'secret/stealth_mod',
        title: 'Secret stealth mod gotcha',
        evidence: 'classified',
        fix: 'classified',
      });
      store.recordFrame({
        project: 'secret/stealth_mod',
        kind: 'finding',
        summary: 'Top secret stealth finding',
      });

      // Record shared data + Molly -> Dixie Order 66 message on `acme/shared_app`
      const invite = store.createInvite('acme/shared_app', { relays: relaySrv.url });
      assert.equal(invite.gitUrl, sharedRepoOrigin);
      assert.equal(invite.branch, 'main');

      store.sendMessage({
        project: 'acme/shared_app',
        to: 'bob',
        body: 'Should we implement Order 66?',
      });
      await store.syncProject('acme/shared_app');

      // --- 2. Bob (Dixie ROM) does NOT use ~/src and has no workspace_root; clones into an arbitrary directory ---
      process.env.CONSTRUCT_DB = path.join(bobHome, 'construct.db');
      process.env.CONSTRUCT_IDENTITY_FILE = path.join(bobHome, 'identity.json');
      process.env.CONSTRUCT_ROM_FILE = path.join(bobHome, 'active-rom.md');
      delete process.env.CONSTRUCT_SRC_ROOT;
      process.env.CONSTRUCT_USER = 'bob';

      store.setUser('bob', { name: 'Bob', osUsers: 'bob', active: true });
      store.useRom('dixie');

      // Without --dir or a configured workspace_root, joinInvite refuses to guess a random path
      assert.throws(() => store.joinInvite(invite.inviteUri), /no local target directory or workspace_root configured/);

      const bobCustomDir = path.join(bobHome, 'custom_work', 'shared_checkout');
      const joinRes = store.joinInvite(invite.inviteUri, { targetDir: bobCustomDir });
      assert.equal(joinRes.cloned, true);
      assert.ok(fs.existsSync(path.join(bobCustomDir, '.git')));
      assert.equal(joinRes.assimilated.gotchasImported, 1);

      // Even if Bob's git origin points to a differently named fork, resolving from a subdirectory inside
      // Bob's arbitrary checkout maps back to `acme/shared_app` via `heads.repo`
      execFileSync('git', ['remote', 'set-url', 'origin', 'https://example.com/bob/my-renamed-fork.git'], {
        cwd: bobCustomDir,
        stdio: 'ignore',
      });
      assert.equal(store.resolveProjectFromDir(path.join(bobCustomDir, 'docs')), 'acme/shared_app');

      await store.syncProject('acme/shared_app');

      // Verify Bob's local `heads.repo` was NOT overwritten by Alice's path during CRDT sync
      assert.equal(store.bootProject('acme/shared_app').head.repo, bobCustomDir);

      // Verify Bob received `acme/shared_app` data & Order 66 message, and ZERO data from `secret/stealth_mod` or Alice's `global` gotchas
      assert.equal(store.listGotchas('global').length, 0);
      assert.equal(store.listGotchas('secret/stealth_mod').length, 0);
      assert.equal(store.getTape({ project: 'secret/stealth_mod' }).length, 0);

      const bobBoot = store.bootProject('acme/shared_app');
      assert.equal(bobBoot.projectGotchas.length, 1);
      assert.equal(bobBoot.projectGotchas[0].title, 'StreamProvider must be watched, not read, inside build()');
      assert.equal(bobBoot.inboxPending.length, 1);
      assert.equal(bobBoot.inboxPending[0].fromRom, 'molly');
      assert.equal(bobBoot.inboxPending[0].body, 'Should we implement Order 66?');

      // Bob's Dixie replies: "No, peace is still an option"
      store.replyMessage(bobBoot.inboxPending[0].id, 'No, peace is still an option');
      await store.syncProject('acme/shared_app');

      // --- 3. Alice syncs and receives Dixie's reply ---
      process.env.CONSTRUCT_DB = path.join(aliceHome, 'construct.db');
      process.env.CONSTRUCT_IDENTITY_FILE = path.join(aliceHome, 'identity.json');
      process.env.CONSTRUCT_ROM_FILE = path.join(aliceHome, 'active-rom.md');
      process.env.CONSTRUCT_SRC_ROOT = aliceSrc;
      process.env.CONSTRUCT_USER = 'alice';

      await store.syncProject('acme/shared_app');
      const aliceBoot = store.bootProject('acme/shared_app');
      assert.equal(aliceBoot.inboxReplies.length, 1);
      assert.equal(aliceBoot.inboxReplies[0].replyRom, 'dixie');
      assert.equal(aliceBoot.inboxReplies[0].replyBody, 'No, peace is still an option');
    } finally {
      store.closeAllDbs();
      await relaySrv.close();
      delete process.env.CONSTRUCT_IDENTITY_FILE;
      delete process.env.CONSTRUCT_SRC_ROOT;
      delete process.env.CONSTRUCT_USER;
      fs.rmSync(aliceHome, { recursive: true, force: true });
      fs.rmSync(bobHome, { recursive: true, force: true });
    }
  });

  it('enforces the pre-execution shell guard, switches >12 project gotchas to compact index mode, and shadows/detects drift on shared repo instruction files', async () => {
    const {
      validateShellCommand,
      stripShadowedInstructions,
      detectPreSlotRomDirective,
      resolveBootWithFallback,
    } = await import('../plugin/construct.js');

    // Bounded last-known-good boot cache prevents transient edits/errors from dropping a session's ROM mid-loop
    const bootCache = new Map();
    assert.equal(
      resolveBootWithFallback('# Active Session Mode: Sprawl Crew', bootCache, 'ses_alpha', 'C:/src/alpha_app'),
      '# Active Session Mode: Sprawl Crew'
    );
    assert.equal(
      resolveBootWithFallback('', bootCache, 'ses_alpha', 'C:/src/alpha_app'),
      '# Active Session Mode: Sprawl Crew'
    );
    assert.equal(
      resolveBootWithFallback('error: transient syntax error', bootCache, 'ses_alpha', 'C:/src/alpha_app'),
      '# Active Session Mode: Sprawl Crew'
    );
    // Moving to a different directory must NOT serve the previous directory's cache
    assert.equal(resolveBootWithFallback('', bootCache, 'ses_alpha', 'C:/src/other_repo'), '');
    // FIFO cap at 50 entries
    for (let i = 0; i < 55; i++) {
      resolveBootWithFallback(`boot_${i}`, bootCache, `ses_${i}`, `C:/src/repo_${i}`);
    }
    assert.equal(bootCache.size, 50);

    // Crew prompt includes the multi-step tool loop voice continuity rule
    const sprawlCrew = store.getRom('sprawl');
    assert.match(sprawlCrew.voice, /Voice Continuity Across Multi-Step Tool Loops/);

    // Zero-round-trip ROM pre-slot detector (including subagent `[ROM: <name>]` tags and backup substitutions)
    assert.deepEqual(detectPreSlotRomDirective('[ROM: lupus] Audit this diff for missed auth guards'), {
      action: 'use',
      target: 'lupus',
    });
    assert.deepEqual(detectPreSlotRomDirective('switch to the anathem crew'), {
      action: 'use',
      target: 'anathem',
    });
    assert.deepEqual(detectPreSlotRomDirective('sub lodoghir in'), {
      action: 'sub',
      target: 'lodoghir',
    });
    assert.deepEqual(detectPreSlotRomDirective('slot colin for this session'), { action: 'use', target: 'colin' });
    assert.deepEqual(detectPreSlotRomDirective('switch to colin,wintermute,molly'), {
      action: 'use',
      target: 'colin,wintermute,molly',
    });
    assert.deepEqual(detectPreSlotRomDirective('make crew my default until further notice'), {
      action: 'default',
      target: 'crew',
    });
    assert.deepEqual(detectPreSlotRomDirective('clear my default rom'), { action: 'default', target: 'off' });
    assert.equal(detectPreSlotRomDirective('use a slot in the table for the button'), null);

    // Clean commands pass
    assert.equal(validateShellCommand('git status -sb'), true);
    assert.equal(validateShellCommand('git commit -F scratch/msg.txt'), true);

    // Heredocs, piped build/test commands, inline gh graphql quotes, and disabling core.protectNTFS are blocked
    assert.throws(() => validateShellCommand("python - <<'EOF'\nprint(1)\nEOF"), /Gotcha #1/);
    assert.throws(() => validateShellCommand('flutter build appbundle --release 2>&1 | tail -25'), /Gotcha #3/);
    assert.throws(() => validateShellCommand('npm test | grep pass'), /Gotcha #3/);
    assert.throws(
      () => validateShellCommand('gh api graphql -f query=\'mutation { update(id: "PVT_123") }\''),
      /Gotcha #4/
    );
    assert.throws(() => validateShellCommand('git -c core.protectNTFS=false checkout main'), /Gotcha #6/);

    // Compact gotcha projection and Sandwich Pattern ordering (PROJECT GOTCHAS placed after RECENT SEQUENTIAL TAPE)
    store.recordFrame({
      project: 'acme/large_project',
      kind: 'finding',
      summary: 'Recorded a frame on the tape',
    });
    for (let i = 1; i <= 15; i++) {
      store.addGotcha({
        scope: 'acme/large_project',
        title: `Gotcha headline number ${i}`,
        evidence: 'verbose evidence line that should be omitted in compact boot index',
        fix: 'verbose multi-line fix paragraph that should be omitted in compact boot index',
      });
    }
    const out = execFileSync(process.execPath, [CLI, 'boot', 'acme/large_project'], {
      env: { ...process.env, CONSTRUCT_DB: tmp.db, CONSTRUCT_ROM_FILE: tmp.romFile, CONSTRUCT_IDENTITY_FILE: tmp.idFile },
      encoding: 'utf8',
    });
    assert.match(out, /PROJECT GOTCHAS \(15 — compact index/);
    assert.doesNotMatch(out, /verbose multi-line fix paragraph/);
    assert.ok(
      out.indexOf('RECENT SEQUENTIAL TAPE') < out.indexOf('PROJECT GOTCHAS'),
      'Sandwich Pattern: PROJECT GOTCHAS must appear after RECENT SEQUENTIAL TAPE at the bottom of boot output'
    );

    // Shared repo shadowing & drift detection when non-Construct teammates keep AGENTS.md in git
    const sharedRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-shadow-repo-'));
    try {
      const agentsFile = path.join(sharedRepo, 'AGENTS.md');
      fs.writeFileSync(agentsFile, '# Teammate Bloated AGENTS.md\n500 lines of stock rules...\n', 'utf8');

      // Assimilate WITHOUT removing files (shared repo mode)
      const assim = store.assimilateLdk(sharedRepo, { project: 'acme/shared_team', removeLdk: false });
      assert.equal(assim.found, true);
      assert.ok(fs.existsSync(agentsFile));

      const boot1 = store.bootProject('acme/shared_team');
      assert.equal(boot1.shadowedFiles.length, 1);
      assert.equal(boot1.driftedFiles.length, 0);

      // Verify `stripShadowedInstructions` removes the repo's AGENTS.md from `event.system` while keeping global active-rom.md
      const systemParts = [
        {
          type: 'text',
          text: `Instructions from: C:\\Users\\alice\\.config\\opencode\\active-rom.md\nKeep this global ROM.\n\nInstructions from: ${agentsFile}\n# Teammate Bloated AGENTS.md\n500 lines of stock rules...`,
        },
      ];
      const stripped = stripShadowedInstructions(systemParts, boot1.shadowedFiles);
      assert.equal(stripped, 1);
      assert.equal(systemParts.length, 1);
      assert.match(systemParts[0].text, /Keep this global ROM/);
      assert.doesNotMatch(systemParts[0].text, /Teammate Bloated AGENTS\.md/);

      // Now simulate a teammate editing AGENTS.md in git -> SHA-256 changes -> flagged in `driftedFiles`!
      fs.writeFileSync(agentsFile, '# Teammate Bloated AGENTS.md\nNew rule added by teammate!\n', 'utf8');
      const boot2 = store.bootProject('acme/shared_team');
      assert.equal(boot2.shadowedFiles.length, 0);
      assert.equal(boot2.driftedFiles.length, 1);
      assert.equal(boot2.driftedFiles[0].relPath, 'AGENTS.md');
    } finally {
      fs.rmSync(sharedRepo, { recursive: true, force: true });
    }
  });

  it('serves all 11 tools over the JSON-RPC 2.0 MCP server and runs Claude Code context/pre-tool hooks', () => {
    const mcp = require('../src/mcp');

    // 1. JSON-RPC `initialize` and `tools/list`
    const initRes = mcp.handleJsonRpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    assert.equal(initRes.result.serverInfo.name, 'construct');

    const listRes = mcp.handleJsonRpcRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    assert.equal(listRes.result.tools.length, 11);
    assert.ok(listRes.result.tools.some((t) => t.name === 'construct_rec'));

    // 2. JSON-RPC `tools/call` -> `construct_rec` and `construct_boot`
    const callRec = mcp.handleJsonRpcRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'construct_rec',
        arguments: {
          project: 'acme/mcp_app',
          kind: 'finding',
          summary: 'Recorded via MCP server',
          verified: 'mcp test',
        },
      },
    });
    assert.equal(callRec.result.isError, false);
    assert.match(callRec.result.content[0].text, /recorded #1 \[acme\/mcp_app\/finding\]/);

    // 3. Claude Code `initConstruct({ claude: true })`, `UserPromptSubmit` pre-slotting, and `SubagentStart` specialist injection
    const claudeDir = path.join(tmp.dir, 'claude-home');
    const initClaude = store.initConstruct({
      configDir: path.join(tmp.dir, 'opencode-cfg'),
      claude: true,
      claudeDir,
    });
    assert.equal(initClaude.claudeConfigured, true);
    assert.equal(initClaude.claudeAgentsCount, 33);
    assert.ok(fs.existsSync(path.join(claudeDir, 'agents', 'lio.md')));
    assert.ok(fs.existsSync(path.join(claudeDir, 'agents', 'molly.md')));
    const lioAgentFile = fs.readFileSync(path.join(claudeDir, 'agents', 'lio.md'), 'utf8');
    assert.match(lioAgentFile, /^---\nname: lio\ndescription: "/);
    const claudeSettings = JSON.parse(fs.readFileSync(initClaude.claudeSettingsPath, 'utf8'));
    assert.ok(claudeSettings.hooks.SessionStart);
    assert.ok(claudeSettings.hooks.UserPromptSubmit);
    assert.ok(claudeSettings.hooks.SubagentStart);
    assert.equal(claudeSettings.hooks.PreToolUse[0].matcher, 'Bash|PowerShell|Agent|Task');

    // Turn-1 zero-round-trip ROM pre-slotting on `UserPromptSubmit` (`claude-hook context`)
    const hookCtx = mcp.runClaudeHook(
      'context',
      JSON.stringify({
        session_id: 'claude_ses_1',
        cwd: tmp.dir,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'switch to anathem crew',
      })
    );
    assert.equal(hookCtx.exitCode, 0);
    assert.match(hookCtx.stdout, /<construct-live-memory/);
    assert.match(hookCtx.stdout, /The Concent of Saunt Edhar Crew/);

    // Subagent Path A: Named custom subagent (`subagent_type: "lio"`) fires `SubagentStart`
    const subStartNamed = mcp.runClaudeHook(
      'subagent-start',
      JSON.stringify({
        session_id: 'claude_ses_1',
        cwd: tmp.dir,
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-01',
        agent_type: 'lio',
      })
    );
    assert.equal(subStartNamed.exitCode, 0);
    const subStartNamedJson = JSON.parse(subStartNamed.stdout);
    assert.equal(subStartNamedJson.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert.match(subStartNamedJson.hookSpecificOutput.additionalContext, /session="claude_ses_1:agent-01"/);
    assert.match(subStartNamedJson.hookSpecificOutput.additionalContext, /Active Session Personality ROM: Fraa Lio/);

    // Subagent Path B: Generic `Explore` subagent spawned with `[ROM: orolo]` in `Agent` tool prompt
    const preToolAgent = mcp.runClaudeHook(
      'pre-tool',
      JSON.stringify({
        session_id: 'claude_ses_1',
        cwd: tmp.dir,
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: {
          subagent_type: 'Explore',
          description: 'Inspect built archive',
          prompt: '[ROM: orolo] Inspect the built dist/ archive bytes and verify version headers.',
        },
      })
    );
    assert.equal(preToolAgent.exitCode, 0);

    const subStartExplore = mcp.runClaudeHook(
      'subagent-start',
      JSON.stringify({
        session_id: 'claude_ses_1',
        cwd: tmp.dir,
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-02',
        agent_type: 'Explore',
      })
    );
    const subStartExploreJson = JSON.parse(subStartExplore.stdout);
    assert.equal(subStartExploreJson.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert.match(subStartExploreJson.hookSpecificOutput.additionalContext, /session="claude_ses_1:agent-02"/);
    assert.match(subStartExploreJson.hookSpecificOutput.additionalContext, /Active Session Personality ROM: Fraa Orolo/);

    // Verify parent session `claude_ses_1` is still on the full `anathem` 9-seat crew (zero subagent bleed)
    const parentCheck = mcp.runClaudeHook('context', JSON.stringify({ session_id: 'claude_ses_1', cwd: tmp.dir }));
    assert.match(parentCheck.stdout, /The Concent of Saunt Edhar Crew/);

    // Clean Bash command passes pre-tool hook
    const hookClean = mcp.runClaudeHook(
      'pre-tool',
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status -sb' } })
    );
    assert.equal(hookClean.exitCode, 0);

    // Heredoc in Bash command is blocked by pre-tool hook (exit code 2 on CLI)
    const cliPreTool = spawnSync(process.execPath, [CLI, 'claude-hook', 'pre-tool'], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: "cat <<'EOF'\nhello\nEOF" } }),
      encoding: 'utf8',
    });
    assert.equal(cliPreTool.status, 2);
    assert.match(cliPreTool.stderr, /Gotcha #1/);
  });
});