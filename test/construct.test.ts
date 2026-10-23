'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const store = require('../src/store.ts');

const CLI = path.join(__dirname, '..', 'bin', 'construct.ts');

function makeTempPaths() {
  process.env.CONSTRUCT_NO_AUTOSYNC = '1';
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

  it('seeds all 179 ROMs across 15 crew banks (sprawl, nightcity, anathem, cryptonomicon, shadowrun, dresden, amber, laundry, tolkien, discworld, reamde, irondruid, prydain, clockwork, generic), defaults to crew mode, supports bench substitutions, and isolates sessions', () => {
    const roms = store.listRoms();
    assert.equal(roms.length, 179);
    const packs = store.listPacks();
    assert.deepEqual(
      packs.map((p) => p.pack),
      ['amber', 'anathem', 'clockwork', 'cryptonomicon', 'discworld', 'dresden', 'generic', 'irondruid', 'laundry', 'nightcity', 'prydain', 'reamde', 'shadowrun', 'sprawl', 'tolkien']
    );
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
    assert.match(anathemCrew.voice, /═══ \[SAUNT EDHAR \/\/ CONVOX\]/);
    assert.match(anathemCrew.voice, /🔵 \*\*\[ERASMUS \/\/ CALCA & EXPOSITION\]\*\*/);
    assert.match(anathemCrew.voice, /🔴 \*\*\[CORD \/\/ EXTRAMUROS FORGE\]\*\*/);
    assert.match(anathemCrew.voice, /📓 \*\*\[ALA \/\/ THE CHRONICLE\]\*\*/);
    assert.match(anathemCrew.voice, /Pardon, Fraa Jad/);
    assert.match(anathemCrew.voice, /Zero Catchphrase Repetition/);
    assert.match(anathemCrew.voice, /Cross-Bank Cameo Roster \(on explicit name or world-cue only\):.*🛡️`johnny`/);
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

    // Switch to `nightcity`, `cryptonomicon`, and `shadowrun` 9-seat crew banks and verify isolated banners/tags/subs
    const nightcityCrew = store.useRom('nightcity', { sessionId: 'ses_nightcity' });
    assert.equal(nightcityCrew.isCrew, true);
    assert.deepEqual(nightcityCrew.roster, [
      'judy',
      'vik',
      'tbug',
      'v',
      'mitch',
      'songbird',
      'johnny',
      'evelyn',
      'rogue',
    ]);
    assert.match(nightcityCrew.voice, /═══ \[AFTERLIFE \/\/ GIG ACTIVE\]/);
    assert.match(nightcityCrew.voice, /🔵 \*\*\[JUDY \/\/ BRAINDANCE RECON\]\*\*/);
    assert.match(nightcityCrew.voice, /🛡️ \*\*\[JOHNNY \/\/ RELIC SABOTEUR\]\*\*/);
    assert.doesNotMatch(nightcityCrew.voice, /Actually guv/);
    const subbedNightcity = store.subRom('takemura', { sessionId: 'ses_nightcity' });
    assert.ok(subbedNightcity.roster.includes('takemura'));
    assert.ok(!subbedNightcity.roster.includes('tbug'));

    const cryptoCrew = store.useRom('cryptonomicon', { sessionId: 'ses_crypto' });
    assert.equal(cryptoCrew.isCrew, true);
    assert.deepEqual(cryptoCrew.roster, [
      'lawrence',
      'goto',
      'enoch',
      'randy',
      'doug',
      'avi',
      'cantrell',
      'amy',
      'golgotha',
    ]);
    assert.match(cryptoCrew.voice, /═══ \[DETACHMENT 2702 \/\/ EPIPHYTE CORP\]/);
    assert.match(cryptoCrew.voice, /🔵 \*\*\[LAWRENCE \/\/ BLETCHLEY ORGAN\]\*\*/);
    assert.match(cryptoCrew.voice, /🔴 \*\*\[RANDY \/\/ MANILA TERMINAL\]\*\*/);
    const subbedCrypto = store.subRom('turing', { sessionId: 'ses_crypto' });
    assert.ok(subbedCrypto.roster.includes('turing'));
    assert.ok(!subbedCrypto.roster.includes('enoch'));

    const shadowrunCrew = store.useRom('shadowrun', { sessionId: 'ses_shadowrun' });
    assert.equal(shadowrunCrew.isCrew, true);
    assert.deepEqual(shadowrunCrew.roster, [
      'talon',
      'streetdoc',
      'fastjack',
      'hatchetman',
      'rigger',
      'dodger',
      'harlequin',
      'siren',
      'captainchaos',
    ]);
    assert.match(shadowrunCrew.voice, /═══ \[SHADOWLAND \/\/ SEATTLE RUN\]/);
    assert.match(shadowrunCrew.voice, /🔵 \*\*\[TALON \/\/ ASTRAL RECON\]\*\*/);
    assert.match(shadowrunCrew.voice, /📓 \*\*\[CAPTAINCHAOS \/\/ SHADOWLAND PAYDATA\]\*\*/);
    const subbedShadowrun = store.subRom('johnson', { sessionId: 'ses_shadowrun' });
    assert.ok(subbedShadowrun.roster.includes('johnson'));
    assert.ok(!subbedShadowrun.roster.includes('fastjack'));

    const dresdenCrew = store.useRom('dresden', { sessionId: 'ses_dresden' });
    assert.equal(dresdenCrew.isCrew, true);
    assert.deepEqual(dresdenCrew.roster, [
      'bob',
      'butters',
      'mab',
      'harry',
      'murphy',
      'thomas',
      'marcone',
      'grasshopper',
      'ivy',
    ]);
    assert.match(dresdenCrew.voice, /═══ \[CHICAGO \/\/ PARANET CASEFILE\]/);
    assert.match(dresdenCrew.voice, /🔵 \*\*\[BOB \/\/ ARCANE LORE & SCHEMATICS\]\*\*/);
    assert.match(dresdenCrew.voice, /🔴 \*\*\[HARRY \/\/ THAUMATURGY & FUEGO\]\*\*/);
    assert.match(dresdenCrew.voice, /📓 \*\*\[IVY \/\/ THE ARCHIVE & LINEAGE\]\*\*/);
    const subbedDresden = store.subRom('toot', { sessionId: 'ses_dresden' });
    assert.ok(subbedDresden.roster.includes('toot'));
    assert.ok(!subbedDresden.roster.includes('thomas'));

    const amberCrew = store.useRom('amber', { sessionId: 'ses_amber' });
    assert.equal(amberCrew.isCrew, true);
    assert.deepEqual(amberCrew.roster, [
      'corwin',
      'merlin',
      'fiona',
      'benedict',
      'julian',
      'random',
      'brand',
      'dworkin',
      'ghostwheel',
    ]);
    assert.match(amberCrew.voice, /═══ \[AMBER \/\/ THE PRIMAL PATTERN\]/);
    assert.match(amberCrew.voice, /🔵 \*\*\[CORWIN \/\/ SHADOW WALK & RECON\]\*\*/);
    assert.match(amberCrew.voice, /🟠 \*\*\[MERLIN \/\/ LOGRUS & TRUMP TRACE\]\*\*/);
    assert.match(amberCrew.voice, /🔴 \*\*\[BENEDICT \/\/ MASTER OF ARMS\]\*\*/);
    assert.match(amberCrew.voice, /📓 \*\*\[GHOSTWHEEL \/\/ THE GHOSTWHEEL\]\*\*/);
    const subbedAmber = store.subRom('caine', { sessionId: 'ses_amber' });
    assert.ok(subbedAmber.roster.includes('caine'));
    assert.ok(!subbedAmber.roster.includes('merlin'));

    const laundryCrew = store.useRom('laundry', { sessionId: 'ses_laundry' });
    assert.equal(laundryCrew.isCrew, true);
    assert.deepEqual(laundryCrew.roster, [
      'bobhoward',
      'pinky',
      'angleton',
      'mo',
      'brain',
      'persephone',
      'mhari',
      'holly',
      'stacks',
    ]);
    assert.match(laundryCrew.voice, /═══ \[THE LAUNDRY \/\/ CASE NIGHTMARE GREEN\]/);
    assert.match(laundryCrew.voice, /🔵 \*\*\[BOBHOWARD \/\/ COMPUTATIONAL DEMONOLOGY\]\*\*/);
    assert.match(laundryCrew.voice, /🟣 \*\*\[ANGLETON \/\/ MAHOGANY ROW & TURING WARDS\]\*\*/);
    assert.match(laundryCrew.voice, /🔴 \*\*\[MO \/\/ BONE VIOLIN & FIELD STRIKE\]\*\*/);
    assert.match(laundryCrew.voice, /📓 \*\*\[STACKS \/\/ THE STACKS & ISO-9001 LEDGER\]\*\*/);
    const subbedLaundry = store.subRom('fred', { sessionId: 'ses_laundry' });
    assert.ok(subbedLaundry.roster.includes('fred'));
    assert.ok(!subbedLaundry.roster.includes('mo'));

    const tolkienCrew = store.useRom('tolkien', { sessionId: 'ses_tolkien' });
    assert.equal(tolkienCrew.isCrew, true);
    assert.deepEqual(tolkienCrew.roster, [
      'gandalf',
      'aragorn',
      'galadriel',
      'gimli',
      'faramir',
      'legolas',
      'eowyn',
      'samwise',
      'elrond',
    ]);
    assert.match(tolkienCrew.voice, /═══ \[RIVENDELL \/\/ COUNCIL OF ELROND\]/);
    assert.match(tolkienCrew.voice, /🔵 \*\*\[GANDALF \/\/ LORE OF THE WISE\]\*\*/);
    assert.match(tolkienCrew.voice, /🟣 \*\*\[GALADRIEL \/\/ MIRROR OF GALADRIEL\]\*\*/);
    assert.match(tolkienCrew.voice, /🔴 \*\*\[GIMLI \/\/ KHAZAD-DÛM FORGE\]\*\*/);
    assert.match(tolkienCrew.voice, /🛡️ \*\*\[EOWYN \/\/ SHIELDMAIDEN RED-TEAM\]\*\*/);
    assert.match(tolkienCrew.voice, /📓 \*\*\[ELROND \/\/ COUNCIL & RED BOOK\]\*\*/);
    const subbedTolkien = store.subRom('boromir', { sessionId: 'ses_tolkien' });
    assert.ok(subbedTolkien.roster.includes('boromir'));
    assert.ok(!subbedTolkien.roster.includes('eowyn'));
    const smeagolRom = store.getRom('gollum');
    assert.equal(smeagolRom.name, 'smeagol');
    assert.equal(smeagolRom.pack, 'tolkien');

    const discworldCrew = store.useRom('discworld', { sessionId: 'ses_discworld' });
    assert.equal(discworldCrew.isCrew, true);
    assert.deepEqual(discworldCrew.roster, [
      'ponder',
      'vimes',
      'vetinari',
      'detritus',
      'cheery',
      'moist',
      'adorabelle',
      'carrot',
      'librarian',
    ]);
    assert.match(discworldCrew.voice, /═══ \[ANKH-MORPORK \/\/ PSEUDOPOLIS YARD & THE CLACKS\]/);
    assert.match(discworldCrew.voice, /🔵 \*\*\[PONDER \/\/ HIGH ENERGY MAGIC & HEX\]\*\*/);
    assert.match(discworldCrew.voice, /🟠 \*\*\[VIMES \/\/ PSEUDOPOLIS YARD COBBLES\]\*\*/);
    assert.match(discworldCrew.voice, /🟣 \*\*\[VETINARI \/\/ THE OBLONG OFFICE\]\*\*/);
    assert.match(discworldCrew.voice, /🔴 \*\*\[DETRITUS \/\/ PIECEMAKER & COOLING HELMET\]\*\*/);
    assert.match(discworldCrew.voice, /🛡️ \*\*\[ADORABELLE \/\/ GOLEM TRUST & SPIKE HEEL\]\*\*/);
    assert.match(discworldCrew.voice, /📓 \*\*\[LIBRARIAN \/\/ UNSEEN LIBRARY & L-SPACE\]\*\*/);
    const subbedDiscworld = store.subRom('weatherwax', { sessionId: 'ses_discworld' });
    assert.ok(subbedDiscworld.roster.includes('weatherwax'));
    assert.ok(!subbedDiscworld.roster.includes('vetinari'));
    assert.equal(store.getRom('spike').name, 'adorabelle');
    assert.equal(store.getRom('ook').name, 'librarian');

    const reamdeCrew = store.useRom('reamde', { sessionId: 'ses_reamde' });
    assert.equal(reamdeCrew.isCrew, true);
    assert.deepEqual(reamdeCrew.roster, ['richard', 'zula', 'dsquared', 'sokolov', 'csongor', 'yuxia', 'olivia', 'pluto', 'skraelin']);
    assert.match(reamdeCrew.voice, /═══ \[CORPORATION 9592 \/\/ T'RAIN & THE IDAHOS\]/);
    assert.equal(store.getRom('dodge').name, 'richard');

    const ironDruidCrew = store.useRom('irondruid', { sessionId: 'ses_irondruid' });
    assert.equal(ironDruidCrew.isCrew, true);
    assert.deepEqual(ironDruidCrew.roster, ['atticus', 'oberon', 'morrigan', 'owen', 'hal', 'granuaile', 'leif', 'brighid', 'ogma']);
    assert.match(ironDruidCrew.voice, /═══ \[TEMPE \/\/ THIRD EYE BOOKS & THE WORLD TREE\]/);
    assert.equal(store.getRom('siodhachan').name, 'atticus');

    const prydainCrew = store.useRom('prydain', { sessionId: 'ses_prydain' });
    assert.equal(prydainCrew.isCrew, true);
    assert.deepEqual(prydainCrew.roster, ['dallben', 'taran', 'gwydion', 'coll', 'fflewddur', 'gurgi', 'doli', 'eilonwy', 'taliesin']);
    assert.match(prydainCrew.voice, /═══ \[CAER DALLBEN \/\/ THE BOOK OF THREE & PRYDAIN\]/);
    assert.equal(store.getRom('fflam').name, 'fflewddur');

    const clockworkCrew = store.useRom('clockwork', { sessionId: 'ses_clockwork' });
    assert.equal(clockworkCrew.isCrew, true);
    assert.deepEqual(clockworkCrew.roster, ['alex', 'pete', 'georgie', 'dim', 'brodsky', 'branom', 'deltoid', 'falexander', 'chaplain']);
    assert.match(clockworkCrew.voice, /═══ \[KOROVA MILKBAR \/\/ NADSAT & LUDOVICO LAB\]/);
    assert.equal(store.getRom('littlealex').name, 'alex');
    assert.equal(store.getRom('weathers').name, 'catlady');
    const subbedClockwork = store.subRom('minister', { sessionId: 'ses_clockwork' });
    assert.ok(subbedClockwork.roster.includes('minister'));
    assert.ok(!subbedClockwork.roster.includes('georgie'));

    // Every non-generic Crew Bank must define `cameoTriggers` (world-cue -> specialist cameo mappings)
    const allPackMeta = require('../src/packs/index.ts').getAllPackMetadata();
    for (const [pName, pMeta] of Object.entries(allPackMeta)) {
      if (pName === 'generic') continue;
      assert.ok(
        Array.isArray(pMeta.cameoTriggers) && pMeta.cameoTriggers.length >= 2,
        `Crew Bank "${pName}" must define at least 2 cameoTriggers for cross-bank world cues`
      );
    }
    assert.match(clockworkCrew.voice, /crunchings and munchings.*gurgi|out of cheese error.*ponder|my precious.*smeagol/i);

    // Verify user drop-in pack discovery via `CONSTRUCT_PACKS_DIR`
    const customPacksDir = path.join(tmp.dir, 'user-packs');
    fs.mkdirSync(customPacksDir, { recursive: true });
    fs.writeFileSync(
      path.join(customPacksDir, 'rocinante.js'),
      `'use strict';
module.exports = {
  metadata: {
    name: 'rocinante',
    title: 'The Rocinante Crew',
    banner: '🚀 **[ROCINANTE // BURN ACTIVE]**',
    atmosphere: 'Hard-vacuum gunship engineering.',
    defaultStarters: ['naomi'],
    backups: ['amos'],
  },
  roms: [
    { name: 'naomi', pack: 'rocinante', seat: 'blitz', tier: 'primary', handle: 'Naomi Nagata', tagline: 'Belter chief engineer.', voice: '### 2. Syntax\\n- **Belter precision.**', dials: {}, directives: ['Keep the Epstein drive running.'] },
    { name: 'amos', pack: 'rocinante', seat: 'diagnostics', tier: 'backup', handle: 'Amos Burton', tagline: 'Thruster mechanic.', voice: '### 2. Syntax\\n- **Blunt mechanic.**', dials: {}, directives: ['Fix the manifold.'] }
  ],
};`,
      'utf8'
    );
    process.env.CONSTRUCT_PACKS_DIR = customPacksDir;
    try {
      const packsMod = require('../src/packs/index.ts');
      const known = packsMod.getKnownRomTargets();
      assert.ok(known.has('rocinante'));
      assert.ok(known.has('naomi'));
      assert.ok(known.has('amos'));
      assert.equal(packsMod.loadPackRoms('rocinante').length, 2);
    } finally {
      delete process.env.CONSTRUCT_PACKS_DIR;
    }

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

  it('assimilates existing repository instruction files (AGENTS.md, CLAUDE.md, GEMINI.md)', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-assim-repo-'));
    try {
      fs.writeFileSync(
        path.join(repoDir, 'CLAUDE.md'),
        `# Working with Alice

**Platform:** Linux (Ubuntu 24.04, bash).

## Who you are working with

Principal distributed systems engineer with 20 years of experience.

- Lead with the finding and file:line, and include wrapped
  continuation lines without dropping them.
- Never use interactive prompts in scripts.

## Scratch files

Use \`/tmp/opencode\` outside the repository.
`,
        'utf8'
      );

      fs.writeFileSync(
        path.join(repoDir, 'AGENTS.md'),
        `# Project Instructions & Gotchas

### <The claim>

Template example to skip.

### Parallel uploads using Date.now() collide on the same key

**observed** -- 4 concurrent uploads overwrote the same object.

    uploads/\${Date.now()}.jpg

Append a random suffix to concurrent filenames.

Found 2026-10-01. See #75.

### Exit 134 from node means heap OOM

**observed** -- CI died with exit code 134.

Set NODE_OPTIONS=--max_old_space_size=4096.

Found 2026-09-28 (migrated from GEMINI.md). Extended 2026-09-30, see #30.

## Scripts

| Command | From | Does |
|---|---|---|
| \`npm test\` | \`backend/\` | Run unit suite |
| \`npm run build\` | \`backend/\` | Typecheck and compile |
`,
        'utf8'
      );

      const res = store.assimilateLdk(repoDir, { project: 'acme/alpha_app', removeFiles: true });
      assert.equal(res.found, true);
      assert.deepEqual(res.usersImported, ['alice']);
      assert.equal(res.gotchasImported, 2);
      assert.equal(res.scriptsExtracted, 2);
      assert.deepEqual(res.removedInstructionFiles.sort(), ['AGENTS.md', 'CLAUDE.md']);
      assert.equal(fs.existsSync(path.join(repoDir, 'AGENTS.md')), false);
      assert.equal(fs.existsSync(path.join(repoDir, 'CLAUDE.md')), false);

      const alice = store.getUser('alice').user;
      assert.equal(alice.name, 'Alice');
      assert.match(alice.platform, /Linux/);
      assert.match(alice.calibration, /continuation lines without dropping them/);
      assert.match(alice.calibration, /\/tmp\/opencode/);

      const projGotchas = store.listGotchas('acme/alpha_app');
      assert.equal(projGotchas.length, 2);
      assert.equal(projGotchas[0].title, 'Parallel uploads using Date.now() collide on the same key');
      assert.equal(projGotchas[0].fix, 'Append a random suffix to concurrent filenames.');
      assert.equal(projGotchas[1].fix, 'Set NODE_OPTIONS=--max_old_space_size=4096.');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('auto-clones a missing git repo on joinInvite, assimilates its instruction files, and prevents cross-project bleed', async () => {
    const relaySrv = await store.startLocalRelayServer(0);
    const aliceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-alice-'));
    const bobHome = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-bob-'));

    try {
      const aliceSrc = path.join(aliceHome, 'src');
      const bobSrc = path.join(bobHome, 'src');
      const sharedRepoOrigin = path.join(aliceSrc, 'acme', 'shared_app');
      fs.mkdirSync(sharedRepoOrigin, { recursive: true });

      // Initialize a real git repository in Alice's ~/src/acme/shared_app with an AGENTS.md gotcha
      fs.writeFileSync(
        path.join(sharedRepoOrigin, 'AGENTS.md'),
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

      // Delta sync check: repeating syncProject with no new local ops pushes 0 redundant ops
      const repeatSync = await store.syncProject('acme/shared_app');
      assert.equal(repeatSync.pushedOps, 0);

      // Hiding a message (person-to-person, without requiring `project`) keeps it on the record (`includeHidden: true`)
      // while excluding it from default lists/HUD and preventing incoming CRDT relay packets from resurrecting it
      const staleMsg = store.sendMessage({
        to: 'bob',
        via: 'smeagol',
        body: 'Ssshh, precious! Broken test message to hide, gollum!',
      });
      assert.equal(staleMsg.fromRom, 'smeagol');
      // Project packets are 100% divorced from personal comms (`0` message ops on `acme/shared_app`)
      assert.ok(store.exportEncryptedPacket('acme/shared_app').ops.every((op) => op.entity !== 'message'));
      const packetWithStale = store.exportEncryptedPacket('comms');
      const hiddenMsg = store.hideMessage(staleMsg.id);
      assert.equal(hiddenMsg.uid, staleMsg.uid);
      assert.equal(hiddenMsg.status, 'hidden');
      assert.ok(!store.listMessages().some((m) => m.id === staleMsg.id));
      assert.ok(store.listMessages({ includeHidden: true }).some((m) => m.id === staleMsg.id));
      store.importEncryptedPacket(packetWithStale.envelope);
      assert.ok(!store.listMessages().some((m) => m.uid === staleMsg.uid));

      // Purging a message (`store.purgeMessage`) removes it from `messages` completely (even with `includeHidden: true`)
      // and writes a permanent `message_tombstone` into `crdt_log` so relay re-imports cannot resurrect it
      store.purgeMessage(staleMsg.id);
      assert.ok(!store.listMessages({ includeHidden: true }).some((m) => m.uid === staleMsg.uid));
      store.importEncryptedPacket(packetWithStale.envelope);
      assert.ok(!store.listMessages({ includeHidden: true }).some((m) => m.uid === staleMsg.uid));

      // Non-Collaborator Personal Comms (`construct invite comms` / `store.createInvite('comms')`):
      // Allows two operators to connect purely for person-to-person Courier Comms without sharing a git repo,
      // without requiring `--dir` or `workspace_root` on `joinInvite`, and rejecting any non-message CRDT ops on `@comms`.
      const commsInvite = store.createInvite('comms', { relays: relaySrv.url });
      assert.equal(commsInvite.project, '@comms');
      assert.equal(commsInvite.commsOnly, true);
      assert.equal(commsInvite.gitUrl, '');

      const carolHome = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-carol-'));
      try {
        process.env.CONSTRUCT_DB = path.join(carolHome, 'construct.db');
        process.env.CONSTRUCT_IDENTITY_FILE = path.join(carolHome, 'identity.json');
        process.env.CONSTRUCT_ROM_FILE = path.join(carolHome, 'active-rom.md');
        delete process.env.CONSTRUCT_SRC_ROOT;
        process.env.CONSTRUCT_USER = 'carol';
        store.setUser('carol', { name: 'Carol', osUsers: 'carol', active: true });

        // Carol has NO workspace_root and passes NO targetDir, yet joinInvite succeeds because it's a @comms invite
        const carolJoin = store.joinInvite(commsInvite.inviteUri);
        assert.equal(carolJoin.commsOnly, true);
        assert.equal(carolJoin.cloned, false);
        assert.equal(carolJoin.group.project, '@comms');

        // Carol sends a Courier message to Alice over `@comms`
        store.sendMessage({
          to: 'alice',
          via: 'gurgi',
          body: 'Oh, joy and jubilation! Personal comms message from Carol with zero shared git repo!',
        });
        await store.syncProject('comms');

        // Verify a forged `frame` op inside a `@comms` packet is rejected at the boundary
        const carolId = store.getIdentity();
        const commsGroupRow = {
          project: '@comms',
          groupId: commsInvite.groupId,
          epoch: commsInvite.epoch,
          epochSecret: require('../src/crdt.ts').parseAndVerifyDidCommInvite(commsInvite.inviteUri).body.epochSecret,
          members: [],
        };
        const forgedCommsFrameEnv = require('../src/crdt.ts').sealMlsApplicationMessage(commsGroupRow, carolId, {
          project: '@comms',
          opCount: 1,
          ops: [
            {
              opId: `${require('../src/crdt.ts').nextHlc(carolId.did)}:frame:forged-comms-frame`,
              hlc: require('../src/crdt.ts').nextHlc(carolId.did),
              project: '@comms',
              authorDid: carolId.did,
              entity: 'frame',
              recordUid: 'forged-comms-frame',
              payload: {
                uid: 'forged-comms-frame',
                hlc: require('../src/crdt.ts').nextHlc(carolId.did),
                project: '@comms',
                kind: 'finding',
                summary: 'Forged frame on @comms must be rejected',
              },
            },
          ],
        });

        // Switch back to Alice and sync `@comms`
        process.env.CONSTRUCT_DB = path.join(aliceHome, 'construct.db');
        process.env.CONSTRUCT_IDENTITY_FILE = path.join(aliceHome, 'identity.json');
        process.env.CONSTRUCT_ROM_FILE = path.join(aliceHome, 'active-rom.md');
        process.env.CONSTRUCT_SRC_ROOT = aliceSrc;
        process.env.CONSTRUCT_USER = 'alice';

        const forgedCommsRes = store.importEncryptedPacket(forgedCommsFrameEnv);
        assert.equal(forgedCommsRes.appliedOps, 0);

        await store.syncProject('comms');
        const aliceBootAfterCarol = store.bootProject('acme/shared_app');
        assert.ok(
          aliceBootAfterCarol.inboxPending.some((m) => m.fromUser === 'carol' && m.fromRom === 'gurgi'),
          'Alice should receive Carols Gurgi courier over @comms even when booting acme/shared_app'
        );
      } finally {
        store.closeAllDbs();
        fs.rmSync(carolHome, { recursive: true, force: true });
        process.env.CONSTRUCT_DB = path.join(aliceHome, 'construct.db');
        process.env.CONSTRUCT_IDENTITY_FILE = path.join(aliceHome, 'identity.json');
        process.env.CONSTRUCT_ROM_FILE = path.join(aliceHome, 'active-rom.md');
        process.env.CONSTRUCT_SRC_ROOT = aliceSrc;
        process.env.CONSTRUCT_USER = 'alice';
      }

      // Split-brain `@comms` recovery for legacy-paired project teammates:
      // Simulate Alice and Bob having joined `acme/shared_app` prior to `@comms` existing,
      // so each independently generates a random solo `@comms` group when sending a message,
      // and verify `syncProject('acme/shared_app')` bridges both messages and converges `@comms`.
      {
        const { DatabaseSync } = require('node:sqlite');
        store.closeAllDbs();
        const aliceDbRaw = new DatabaseSync(path.join(aliceHome, 'construct.db'));
        aliceDbRaw.prepare("DELETE FROM mls_groups WHERE project LIKE '@comms%'").run();
        aliceDbRaw.close();
        const bobDbRaw = new DatabaseSync(path.join(bobHome, 'construct.db'));
        bobDbRaw.prepare("DELETE FROM mls_groups WHERE project LIKE '@comms%'").run();
        bobDbRaw.close();

        // Alice sends a message while `@comms` is uninitialized (creates random solo `@comms` group A)
        const aliceSplitMsg = store.sendMessage({
          project: 'acme/shared_app',
          to: 'bob',
          via: 'random',
          body: 'Split-brain test from Alice (simulating M#18/M#19 created before project sync)',
        });
        // Advance `acme/shared_app` last_sync_hlc past `aliceSplitMsg.hlc` to simulate orphan state
        const postMsgFrame = store.recordFrame({
          project: 'acme/shared_app',
          kind: 'finding',
          summary: 'Frame recorded after split-brain message',
        });
        assert.ok(postMsgFrame.frame.seq > 0);

        // Switch to Bob: Bob sends a message on his own isolated random `@comms` group B and pushes to relay
        process.env.CONSTRUCT_DB = path.join(bobHome, 'construct.db');
        process.env.CONSTRUCT_IDENTITY_FILE = path.join(bobHome, 'identity.json');
        process.env.CONSTRUCT_ROM_FILE = path.join(bobHome, 'active-rom.md');
        process.env.CONSTRUCT_SRC_ROOT = bobSrc;
        process.env.CONSTRUCT_USER = 'bob';

        const bobSplitMsg = store.sendMessage({
          project: 'acme/shared_app',
          to: 'alice',
          via: 'bob',
          body: 'Split-brain test from Bob (simulating historical @comms envelope on relay)',
        });
        // Set Bob's solo `@comms` relay to relaySrv.url and publish Bob's isolated `@comms` envelope
        store.closeAllDbs();
        const bobDbRelay = new DatabaseSync(path.join(bobHome, 'construct.db'));
        bobDbRelay
          .prepare("UPDATE mls_groups SET relays = ? WHERE project = '@comms'")
          .run(JSON.stringify([relaySrv.url]));
        bobDbRelay.close();
        await store.syncProject('comms');

        // Switch back to Alice, set Alice's solo `@comms` relay to relaySrv.url, and sync `acme/shared_app`
        process.env.CONSTRUCT_DB = path.join(aliceHome, 'construct.db');
        process.env.CONSTRUCT_IDENTITY_FILE = path.join(aliceHome, 'identity.json');
        process.env.CONSTRUCT_ROM_FILE = path.join(aliceHome, 'active-rom.md');
        process.env.CONSTRUCT_SRC_ROOT = aliceSrc;
        process.env.CONSTRUCT_USER = 'alice';
        store.closeAllDbs();
        const aliceDbRelay = new DatabaseSync(path.join(aliceHome, 'construct.db'));
        aliceDbRelay
          .prepare("UPDATE mls_groups SET relays = ? WHERE project = '@comms'")
          .run(JSON.stringify([relaySrv.url]));
        aliceDbRelay.close();

        await store.syncProject('acme/shared_app');

        // Bob syncs `acme/shared_app` -> must receive Alice's message AND bridge his `@comms` group
        process.env.CONSTRUCT_DB = path.join(bobHome, 'construct.db');
        process.env.CONSTRUCT_IDENTITY_FILE = path.join(bobHome, 'identity.json');
        process.env.CONSTRUCT_ROM_FILE = path.join(bobHome, 'active-rom.md');
        process.env.CONSTRUCT_SRC_ROOT = bobSrc;
        process.env.CONSTRUCT_USER = 'bob';
        await store.syncProject('acme/shared_app');

        const bobMsgsAfterBridge = store.listMessages();
        assert.ok(
          bobMsgsAfterBridge.some((m) => m.uid === aliceSplitMsg.uid),
          'Bob must receive Alice split-brain message over shared project sync'
        );

        // Alice syncs `acme/shared_app` -> must converge `@comms` and decrypt Bob's historical `@comms` envelope
        process.env.CONSTRUCT_DB = path.join(aliceHome, 'construct.db');
        process.env.CONSTRUCT_IDENTITY_FILE = path.join(aliceHome, 'identity.json');
        process.env.CONSTRUCT_ROM_FILE = path.join(aliceHome, 'active-rom.md');
        process.env.CONSTRUCT_SRC_ROOT = aliceSrc;
        process.env.CONSTRUCT_USER = 'alice';
        await store.syncProject('acme/shared_app');

        const aliceMsgsAfterBridge = store.listMessages();
        assert.ok(
          aliceMsgsAfterBridge.some((m) => m.uid === bobSplitMsg.uid),
          'Alice must receive Bob split-brain message after in-band @comms convergence'
        );

        store.closeAllDbs();
        const aCheck = new DatabaseSync(path.join(aliceHome, 'construct.db'), { readOnly: true });
        const bCheck = new DatabaseSync(path.join(bobHome, 'construct.db'), { readOnly: true });
        const aComms = aCheck.prepare("SELECT group_id, epoch_secret FROM mls_groups WHERE project = '@comms'").get();
        const bComms = bCheck.prepare("SELECT group_id, epoch_secret FROM mls_groups WHERE project = '@comms'").get();
        aCheck.close();
        bCheck.close();
        assert.equal(aComms.group_id, bComms.group_id, 'Alice and Bob @comms group_id must converge');
        assert.equal(aComms.epoch_secret, bComms.epoch_secret, 'Alice and Bob @comms epoch_secret must converge');
      }

      // Invite URI encryption check: stripping the `#...` fragment key fails to unwrap `epochSecret`
      const crdtMod = require('../src/crdt.ts');
      const relayMod = require('../src/relay.ts');
      const strippedUri = invite.inviteUri.split('#')[0];
      assert.throws(() => crdtMod.parseAndVerifyDidCommInvite(strippedUri), /missing invite fragment key/);

      // Git clone flag/protocol injection guard (`validateGitCloneParams`)
      assert.equal(store.validateGitCloneParams('https://github.com/acme/shared_app.git', 'main'), true);
      assert.throws(() => store.validateGitCloneParams('--upload-pack=calc.exe', 'main'), /unsafe gitUrl/);
      assert.throws(() => store.validateGitCloneParams('ext::sh -c id', 'main'), /unsafe gitUrl/);
      assert.throws(
        () => store.validateGitCloneParams('https://github.com/acme/shared_app.git', '--upload-pack=evil'),
        /unsafe git branch/
      );
      assert.throws(
        () => store.validateGitCloneParams('https://github.com/acme/shared_app.git', 'main/../evil'),
        /unsafe git branch/
      );

      // HLC future-timestamp poisoning guard (> 5m ahead of wall clock is rejected)
      const poisonedHlc = '9999999999999-0000-deadbeef';
      assert.equal(crdtMod.isHlcWithinDrift(poisonedHlc), false);
      const exportedAlice = store.exportEncryptedPacket('acme/shared_app');
      const groupRow = {
        project: 'acme/shared_app',
        groupId: invite.groupId,
        epoch: invite.epoch,
        epochSecret: crdtMod.parseAndVerifyDidCommInvite(invite.inviteUri).body.epochSecret,
        members: [],
      };
      const aliceId = store.getIdentity();
      const poisonedEnv = crdtMod.sealMlsApplicationMessage(groupRow, aliceId, {
        project: 'acme/shared_app',
        opCount: 1,
        ops: [
          {
            opId: `${poisonedHlc}:frame:frame-poison-1`,
            hlc: poisonedHlc,
            project: 'acme/shared_app',
            authorDid: aliceId.did,
            entity: 'frame',
            recordUid: 'frame-poison-1',
            payload: {
              uid: 'frame-poison-1',
              hlc: poisonedHlc,
              project: 'acme/shared_app',
              kind: 'finding',
              summary: 'Poisoned future frame',
            },
          },
        ],
      });
      const poisonImport = store.importEncryptedPacket(poisonedEnv);
      assert.equal(poisonImport.appliedOps, 0);

      // Key-substitution spoofing guard: once `aliceId.did` is pinned in `mls_groups.members`,
      // an envelope claiming `senderDid = aliceId.did` with a mismatched key or tampered epoch is rejected
      const tamperedEpochEnv = { ...exportedAlice.envelope, epoch: 999 };
      assert.throws(() => store.importEncryptedPacket(tamperedEpochEnv), /epoch mismatch/);

      // WebSocket frame size cap (`MAX_WS_FRAME_BYTES`)
      assert.throws(
        () => relayMod.decodeWsFrames(Buffer.alloc(relayMod.MAX_WS_FRAME_BYTES + 16)),
        /exceeds MAX_WS_FRAME_BYTES/
      );

      // --- 4. Test the 5 Enhancements + Platform-Scoped Guards + GitHub Issues <-> Open Threads Bridge ---
      // 4a. Alice adds a Windows-only gotcha guard (`guardPlatform: 'win32'`) and a repo-wide guard (`guardPlatform: 'all'`), and drops an encrypted patch snippet for Bob
      const guardedGotcha = store.addGotcha({
        scope: 'acme/shared_app',
        title: 'Do not invoke legacy wrong-sdk binary on Windows',
        fix: 'Use the workspace SDK binary instead',
        guardRegex: 'legacy-wrong-sdk\\\\bin',
        guardPlatform: 'win32',
      });
      assert.equal(guardedGotcha.guardRegex, 'legacy-wrong-sdk\\\\bin');
      assert.equal(guardedGotcha.guardPlatform, 'win32');
      // Blocks on Windows (`win32`), does NOT block on Linux (`linux`)
      assert.throws(
        () =>
          store.checkDynamicGotchaGuards('C:\\tools\\legacy-wrong-sdk\\bin\\run.exe', {
            project: 'acme/shared_app',
            platform: 'win32',
          }),
        /Gotcha #/
      );
      assert.equal(
        store.checkDynamicGotchaGuards('C:\\tools\\legacy-wrong-sdk\\bin\\run.exe', {
          project: 'acme/shared_app',
          platform: 'linux',
        }),
        true
      );
      assert.equal(
        store.checkDynamicGotchaGuards('C:\\tools\\workspace-sdk\\bin\\run.exe', {
          project: 'acme/shared_app',
          platform: 'win32',
        }),
        true
      );

      const repoWideGotcha = store.addGotcha({
        scope: 'acme/shared_app',
        title: 'Never commit .Zone.Identifier streams from Linux or Windows',
        fix: 'Delete the :Zone.Identifier stream before staging',
        guardRegex: ':Zone\\.Identifier',
        guardPlatform: 'all',
      });
      assert.equal(repoWideGotcha.guardPlatform, 'all');

      const dropMsg = store.dropPatch({
        project: 'acme/shared_app',
        to: 'bob',
        filePath: 'repro.patch',
        content: 'diff --git a/app.js b/app.js\n+// repro fix\n',
        note: 'Quick repro patch for stream bug',
      });
      assert.match(dropMsg.body, /\[DROP:repro\.patch\]/);

      await store.syncProject('acme/shared_app');

      // 4b. Switch to Bob's environment (on Linux!): sync, verify Bob's Linux shell is NOT blocked by Alice's `win32`-only guard,
      //     IS blocked by the `all`-platform `:Zone.Identifier` guard, and extracts the encrypted patch drop
      process.env.CONSTRUCT_DB = path.join(bobHome, 'construct.db');
      process.env.CONSTRUCT_IDENTITY_FILE = path.join(bobHome, 'identity.json');
      process.env.CONSTRUCT_ROM_FILE = path.join(bobHome, 'active-rom.md');
      delete process.env.CONSTRUCT_SRC_ROOT;
      process.env.CONSTRUCT_USER = 'bob';

      await store.syncProject('acme/shared_app');
      assert.equal(
        store.checkDynamicGotchaGuards('C:\\tools\\legacy-wrong-sdk\\bin\\run.exe', {
          project: 'acme/shared_app',
          platform: 'linux',
        }),
        true
      );
      assert.throws(
        () =>
          store.checkDynamicGotchaGuards('git add docs/constitution.html:Zone.Identifier', {
            project: 'acme/shared_app',
            platform: 'linux',
          }),
        /Never commit \.Zone\.Identifier/
      );

      const bobInbox = store.listMessages({ project: 'acme/shared_app', toUser: 'bob', status: 'pending' });
      const incomingDrop = bobInbox.find((m) => m.body.includes('construct-drop'));
      assert.ok(incomingDrop);
      const extractedOutFile = path.join(bobHome, 'extracted.patch');
      const appliedDrop = store.applyDrop(incomingDrop.id, { targetFile: extractedOutFile });
      assert.equal(appliedDrop.fromUser, 'alice');
      assert.equal(appliedDrop.filePath, 'repro.patch');
      assert.match(fs.readFileSync(extractedOutFile, 'utf8'), /\+\/\/ repro fix/);

      // 4c. `whyTarget` unified provenance: finds synced gotcha + git log, and auto-dispatches a `[WHY]` peer query to Alice when 0 local hits exist
      const whyStream = store.whyTarget('acme/shared_app', 'StreamProvider');
      assert.equal(whyStream.gotchas.length, 1);
      assert.ok(whyStream.gitCommits.length >= 1);
      assert.equal(whyStream.peerQuerySent, null);

      const whyUnknown = store.whyTarget('acme/shared_app', 'nonExistentQuantumWidget42', { autoAskPeers: true });
      assert.equal(whyUnknown.gotchas.length, 0);
      assert.equal(whyUnknown.frames.length, 0);
      assert.ok(whyUnknown.peerQuerySent);
      assert.equal(whyUnknown.peerQuerySent.toUser, 'alice');
      assert.match(whyUnknown.peerQuerySent.body, /\[WHY nonExistentQuantumWidget42\]/);

      // 4d. Throttled background auto-sync gate on `bootProject` (MLS + GitHub Issues)
      const bootTrigger1 = store.bootProject('acme/shared_app', {
        autoSync: true,
        autoSyncThrottleMs: 0,
        dryRunAutoSync: true,
      });
      assert.equal(bootTrigger1.autoSyncTriggered, true);
      assert.equal(bootTrigger1.ghIssuesSyncTriggered, true);
      const bootTrigger2 = store.bootProject('acme/shared_app', {
        autoSync: true,
        autoSyncThrottleMs: 60000,
        dryRunAutoSync: true,
      });
      assert.equal(bootTrigger2.autoSyncTriggered, false);
      assert.equal(bootTrigger2.ghIssuesSyncTriggered, false);

      // 4e. GitHub Issues <-> Construct Open Threads Bridge
      //     - Private Construct thread stays private until explicitly promoted via `publishThreadToGithub`
      const privateThread = store.recordFrame({
        project: 'acme/shared_app',
        kind: 'thread',
        open: true,
        summary: 'Internal architecture discussion before public RFC',
        detail: 'Keep inside construct until ready.',
      });
      const ghSync1 = store.syncGithubIssues('acme/shared_app', {
        issues: [
          { number: 101, title: 'Fix Android KGP warning', state: 'OPEN', body: 'Reported by CI', labels: ['ci'] },
          { number: 102, title: 'Add dark mode toggle', state: 'OPEN', body: 'Requested by user', labels: ['ux'] },
        ],
      });
      assert.equal(ghSync1.openedCount, 2);
      assert.equal(ghSync1.resolvedCount, 0);
      // Idempotent on repeat sync
      const ghSyncRepeat = store.syncGithubIssues('acme/shared_app', {
        issues: [
          { number: 101, title: 'Fix Android KGP warning', state: 'OPEN', body: 'Reported by CI', labels: ['ci'] },
          { number: 102, title: 'Add dark mode toggle', state: 'OPEN', body: 'Requested by user', labels: ['ux'] },
        ],
      });
      assert.equal(ghSyncRepeat.openedCount, 0);

      // When #101 is closed on GitHub, `syncGithubIssues` automatically resolves the matching Construct thread!
      const ghSync2 = store.syncGithubIssues('acme/shared_app', {
        issues: [
          { number: 101, title: 'Fix Android KGP warning', state: 'CLOSED', body: 'Reported by CI', labels: ['ci'] },
          { number: 102, title: 'Add dark mode toggle', state: 'OPEN', body: 'Requested by user', labels: ['ux'] },
        ],
      });
      assert.equal(ghSync2.resolvedCount, 1);
      const openNow = store.bootProject('acme/shared_app', { autoSync: false }).openFrames;
      assert.ok(!openNow.some((f) => f.refs.includes('gh:#101')));
      const gh102Frame = openNow.find((f) => f.refs.includes('gh:#102'));
      assert.ok(gh102Frame);

      // Resolving #102 inside Construct WITHOUT `closeGh` leaves GitHub untouched; WITH `closeGh: true` closes on GitHub
      const closedOnGh = [];
      const resNoGh = store.resolveFrames([privateThread.frame.seq], {
        closeGh: false,
        closeIssueFn: (num) => closedOnGh.push(Number(num)),
      });
      assert.equal(resNoGh.closedGhIssues.length, 0);

      const resWithGh = store.resolveFrames([gh102Frame.seq], {
        closeGh: true,
        closeIssueFn: (num) => closedOnGh.push(Number(num)),
      });
      assert.deepEqual(resWithGh.closedGhIssues, [102]);
      assert.deepEqual(closedOnGh, [102]);

      // Explicitly promoting a private Construct thread to GitHub (`publishThreadToGithub`) attaches `gh:#103`
      store.reopenFrame(privateThread.frame.seq);
      const pubRes = store.publishThreadToGithub(privateThread.frame.seq, {
        createIssueFn: ({ title }) => ({ number: 103, url: `https://github.com/acme/shared_app/issues/103 (${title})` }),
      });
      assert.equal(pubRes.alreadyPublished, false);
      assert.equal(pubRes.issueNumber, 103);
      assert.ok(pubRes.frame.refs.includes('gh:#103'));

      // 4f. HUD Snapshot (`getHudSnapshot`), Multi-Tab / Multi-Project Crew Isolation, & HTML Dashboard generation
      const hudSnap = store.getHudSnapshot({ project: 'acme/shared_app' });
      assert.equal(hudSnap.project, 'acme/shared_app');
      assert.match(hudSnap.pill, /acme\/shared_app · #\d+ · 1 open · 🛡️6/);
      assert.match(hudSnap.tabBadge, /\[dixie #\d+ · 1 open/);

      // Multi-tab + multi-project Crew sensitivity:
      // Tab A on `acme/shared_app` switches to `nightcity`, Tab B on `acme/other_app` switches to `anathem`
      store.useRom('nightcity', { sessionId: 'ses_tab_a', project: 'acme/shared_app' });
      store.useRom('anathem', { sessionId: 'ses_tab_b', project: 'acme/other_app' });

      const hudTabA = store.getHudSnapshot({ sessionId: 'ses_tab_a' });
      const hudTabB = store.getHudSnapshot({ sessionId: 'ses_tab_b' });
      assert.equal(hudTabA.project, 'acme/shared_app');
      assert.equal(hudTabA.romName, 'nightcity');
      assert.equal(hudTabB.project, 'acme/other_app');
      assert.equal(hudTabB.romName, 'anathem');

      // Opening a brand-new Tab C in `acme/shared_app` automatically inherits `acme/shared_app`'s project Crew (`nightcity`)
      const bootNewTabC = store.bootProject('acme/shared_app', { sessionId: 'ses_tab_c', autoSync: false });
      assert.equal(bootNewTabC.rom.name, 'nightcity');

      // Switching Tab C to `cryptonomicon` isolates Tab C while Tab A stays on `nightcity`
      store.useRom('cryptonomicon', { sessionId: 'ses_tab_c' });
      assert.equal(store.getHudSnapshot({ sessionId: 'ses_tab_c' }).romName, 'cryptonomicon');
      assert.equal(store.getHudSnapshot({ sessionId: 'ses_tab_a' }).romName, 'nightcity');

      // Switching project `acme/shared_app` directly (no sessionId) updates `project_roms` and all tabs bound to `acme/shared_app`
      // without touching `acme/other_app` (`ses_tab_b`)
      store.useRom('shadowrun', { project: 'acme/shared_app' });
      assert.equal(store.getHudSnapshot({ sessionId: 'ses_tab_a' }).romName, 'shadowrun');
      assert.equal(store.getHudSnapshot({ sessionId: 'ses_tab_c' }).romName, 'shadowrun');
      assert.equal(store.getHudSnapshot({ sessionId: 'ses_tab_b' }).romName, 'anathem');

      // Record an open thread on `acme/other_app` and verify `ses_tab_a` (`acme/shared_app`) HUD scopes open threads & tape strictly to `acme/shared_app`
      store.recordFrame({
        project: 'acme/other_app',
        kind: 'thread',
        open: true,
        summary: 'Other project open thread that must not leak into shared_app HUD',
      });

      // Dispatch a Courier message (`via: 'toot'`) to Bob on `acme/shared_app` and verify:
      //   1. `bootProject` attaches Toot-Toot's courier profile (`⚡ **[TOOT // COURIER FROM ALICE]**`) without changing Bob's slotted Crew (`shadowrun`)
      //   2. `construct boot` outputs `INCOMING CONSTRUCT COURIER` with `COURIER CAMEO RULE`
      //   3. `getHudSnapshot` and `generateDashboardHtml` include the message in `Construct Comms & Courier Log`
      const tootMsg = store.sendMessage({
        project: 'acme/shared_app',
        fromUser: 'alice',
        to: 'bob',
        via: 'toot',
        body: 'Za-Lord says #111 is merged and ready for review!',
      });
      assert.equal(tootMsg.fromRom, 'toot');

      const bootWithCourier = store.bootProject('acme/shared_app', { sessionId: 'ses_tab_a', autoSync: false });
      assert.equal(bootWithCourier.rom.name, 'shadowrun');
      const incomingToot = bootWithCourier.inboxPending.find((m) => m.id === tootMsg.id);
      assert.ok(incomingToot);
      assert.equal(incomingToot.courier.name, 'toot');
      assert.match(incomingToot.courier.badge, /⚡ \*\*\[TOOT \/\/ COURIER FROM ALICE\]\*\*/);
      assert.match(incomingToot.courier.voiceCue, /Za-Lord/);

      const cliCourierBoot = execFileSync(process.execPath, [CLI, 'boot', 'acme/shared_app', '--session', 'ses_tab_a'], {
        env: { ...process.env, CONSTRUCT_NO_AUTOSYNC: '1' },
        encoding: 'utf8',
      });
      assert.match(cliCourierBoot, /INCOMING CONSTRUCT COURIER FOR BOB/);
      assert.match(cliCourierBoot, /⚡ \*\*\[TOOT \/\/ COURIER FROM ALICE\]\*\*/);
      assert.match(cliCourierBoot, /COURIER CAMEO & STICKY FRONTIER RULE/);

      // 4g. Construct upstream update check (`checkConstructUpstream`) & self-update (`upgradeConstruct`)
      const upStatus = store.checkConstructUpstream({
        force: true,
        execGitFn: (args) => {
          if (args[0] === 'fetch') return '';
          if (args[0] === 'rev-parse' && args[2] === 'HEAD') return '111aaaa';
          if (args[0] === 'rev-parse' && args[2] === 'origin/main') return '222bbbb';
          if (args[0] === 'rev-list') return '2';
          if (args[0] === 'log') return '222bbbb feat: add new pack\n199cccc fix: hud sync';
          return '';
        },
      });
      assert.equal(upStatus.behindCount, 2);
      assert.equal(upStatus.localSha, '111aaaa');
      assert.equal(upStatus.remoteSha, '222bbbb');
      assert.equal(upStatus.commits.length, 2);

      const cliUpgradeBoot = execFileSync(process.execPath, [CLI, 'boot', 'acme/shared_app', '--session', 'ses_tab_a'], {
        env: { ...process.env, CONSTRUCT_NO_AUTOSYNC: '1' },
        encoding: 'utf8',
      });
      assert.match(cliUpgradeBoot, /CONSTRUCT UPGRADE AVAILABLE \(2 new commit\(s\) on origin\/main: 111aaaa -> 222bbbb\)/);
      assert.match(cliUpgradeBoot, /222bbbb feat: add new pack/);

      const dashFile = path.join(bobHome, 'dashboard.html');
      const dash = store.generateDashboardHtml({ outFile: dashFile, project: 'acme/shared_app', sessionId: 'ses_tab_a' });
      assert.ok(fs.existsSync(dashFile));
      assert.match(dash.html, /CONSTRUCT \/\/ SEQUENTIAL MEMORY HUD/);
      assert.doesNotMatch(dash.html, /TARGET TAB &amp; PROJECT SCOPE/);
      const scriptMatch = dash.html.match(/<script>([\s\S]*?)<\/script>/);
      assert.ok(scriptMatch, 'dashboard HTML should contain a <script> block');
      const vm = require('node:vm');
      assert.doesNotThrow(() => new vm.Script(scriptMatch[1]), 'dashboard <script> block must be valid JavaScript');
      assert.match(dash.html, /CONSTRUCT UPDATE AVAILABLE \(2 new commits\)/);
      assert.match(dash.html, /upgradeConstructNow\(\)/);
      assert.match(dash.html, /UNREAD COURIER \[M#/);
      assert.match(dash.html, /replyCourier\(/);
      assert.match(dash.html, /ackCourier\(/);
      assert.match(dash.html, /Construct Comms &amp; Courier Log — acme\/shared_app/);

      // Running `upgradeConstruct` pulls, syncs ROMs, reinstalls plugin, and clears `behindCount` to 0
      const bobClaudeDir = path.join(bobHome, '.claude');
      let currentMockHead = '111aaaa';
      const upRes = store.upgradeConstruct({
        configDir: path.join(bobHome, '.config', 'opencode'),
        claudeDir: bobClaudeDir,
        claude: true,
        execGitFn: (args) => {
          if (args[0] === 'rev-parse') return currentMockHead;
          if (args[0] === 'pull') {
            currentMockHead = '222bbbb';
            return 'Fast-forward';
          }
          return '';
        },
      });
      assert.equal(upRes.upgraded, true);
      assert.equal(upRes.previousSha, '111aaaa');
      assert.equal(upRes.currentSha, '222bbbb');
      assert.ok(
        typeof upRes.romFile === 'string' && upRes.romFile.endsWith('active-rom.md') && fs.existsSync(upRes.romFile),
        `upgradeConstruct must return a valid romFile path (got ${upRes.romFile})`
      );
      const installedPluginSrc = fs.readFileSync(upRes.pluginPath, 'utf8');
      assert.match(installedPluginSrc, /rawAction === "shutdown"/, 'plugin/construct.js must handle rawAction === "shutdown" to yield port 47420 cleanly');
      assert.equal(store.getHudSnapshot({ sessionId: 'ses_tab_a' }).upstreamUpdate.behindCount, 0);

      // 4h. PR-Driven Workflow (`syncGithubPrs`, `openGithubPr`, `reviewGithubPr`, `mergeGithubPr`)
      const prSync1 = store.syncGithubPrs('acme/shared_app', {
        prs: [
          {
            number: 11,
            title: 'feat: add dark mode',
            state: 'OPEN',
            body: 'PR body',
            author: { login: 'alice' },
            headRefName: 'feat/dark-mode',
            reviewDecision: 'REVIEW_REQUIRED',
          },
        ],
      });
      assert.equal(prSync1.openedCount, 1);

      const openedPr = store.openGithubPr('acme/shared_app', {
        title: 'fix: tighten auth guard',
        body: 'Closes auth loophole',
        head: 'fix/auth-guard',
        to: 'alice',
        via: 'toot',
        createPrFn: () => ({ number: 12, url: 'https://github.com/acme/shared_app/pull/12' }),
      });
      assert.equal(openedPr.prNumber, 12);
      assert.ok(openedPr.frame.open);
      assert.ok(openedPr.frame.refs.includes('pr:#12'));
      assert.equal(openedPr.courierSent.fromRom, 'toot');
      assert.match(openedPr.courierSent.body, /\[PR #12\] Opened pull request/);

      let reviewedFlag = false;
      const revPr = store.reviewGithubPr('acme/shared_app', 12, {
        approve: true,
        body: 'LGTM, tests green',
        to: 'alice',
        via: 'marcone',
        reviewPrFn: () => {
          reviewedFlag = true;
        },
      });
      assert.equal(reviewedFlag, true);
      assert.equal(revPr.verdict, 'APPROVED');
      assert.equal(revPr.courierSent.fromRom, 'marcone');

      let mergedFlag = false;
      const mergedPr = store.mergeGithubPr('acme/shared_app', 12, {
        squash: true,
        to: 'alice',
        via: 'ivy',
        mergePrFn: () => {
          mergedFlag = true;
        },
      });
      assert.equal(mergedFlag, true);
      assert.deepEqual(mergedPr.resolvedSeqs, [openedPr.frame.seq]);
      assert.equal(mergedPr.courierSent.fromRom, 'ivy');

      assert.match(dash.html, /⚡ toot/);
      assert.match(dash.html, /Za-Lord says #111 is merged and ready for review!/);
      assert.match(dash.html, /acme\/shared_app/);
      assert.doesNotMatch(dash.html, /acme\/other_app/);
      assert.doesNotMatch(dash.html, /Other project open thread that must not leak into shared_app HUD/);
      assert.match(dash.html, /data-pack="cryptonomicon"/);
      assert.match(dash.html, /applyHudToDom\(data\.hud\)/);
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
      detectSubagentContextRom,
      resolveBootWithFallback,
      formatTitleWithHudBadge,
      buildFrontierVoiceLock,
      injectFrontierVoiceLock,
    } = await import('../plugin/construct.js');

    // HUD session tab badge formatter replaces old badges cleanly without duplicating emblems
    assert.equal(
      formatTitleWithHudBadge('Build sequential memory construct', '🦾 [nightcity #97 · 2 open]'),
      '🦾 [nightcity #97 · 2 open] Build sequential memory construct'
    );
    assert.equal(
      formatTitleWithHudBadge('🏛️ [anathem #95 · 2 open] Build sequential memory construct', '🦾 [nightcity #97 · 2 open]'),
      '🦾 [nightcity #97 · 2 open] Build sequential memory construct'
    );

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

    // Crew prompt includes the multi-step tool loop voice continuity rule, full craft/world register on immersive banks,
    // and ultra-lean tagline-only mode on the `generic` bank
    const sprawlCrew = store.getRom('sprawl');
    const genericCrew = store.getRom('generic');
    assert.match(sprawlCrew.voice, /Voice Continuity Across Multi-Step Tool Loops/);
    assert.match(sprawlCrew.voice, /Villa Straylight|Sense\/Net|Chiba/);
    assert.match(sprawlCrew.voice, /\*Voice cue \(vary, never repeat verbatim\):*/);
    assert.doesNotMatch(genericCrew.voice, /\*Voice cue/);
    assert.ok(
      genericCrew.voice.length < sprawlCrew.voice.length - 1200,
      'generic bank should be significantly leaner than immersive banks'
    );

    // Generation-frontier voice lock attaches ONLY to the final message (preserving prompt cache on messages[0..N-2])
    const lockText = buildFrontierVoiceLock(sprawlCrew.voice);
    assert.match(lockText, /<construct-voice-lock>/);
    assert.match(lockText, /MOLLY \/\/ THE BLITZ/);
    const mockMsgs = [
      { type: 'user', text: 'Earlier cached user turn' },
      { type: 'assistant', content: [{ type: 'text', text: 'Earlier cached assistant turn' }] },
      { type: 'user', text: 'Current user turn at generation frontier' },
    ];
    assert.equal(injectFrontierVoiceLock(mockMsgs, sprawlCrew.voice), true);
    assert.equal(mockMsgs[0].text, 'Earlier cached user turn');
    assert.match(mockMsgs[2].text, /<construct-voice-lock>/);
    // Idempotent if called twice on the same message
    assert.equal(injectFrontierVoiceLock(mockMsgs, sprawlCrew.voice), false);

    // Also attaches to completed tool output during a multi-step tool loop continuation
    const toolLoopMsgs = [
      { type: 'user', text: 'Fix #111' },
      {
        type: 'assistant',
        content: [
          {
            type: 'tool',
            state: {
              status: 'completed',
              content: [{ type: 'text', text: 'On branch main\nnothing to commit' }],
            },
          },
        ],
      },
    ];
    assert.equal(injectFrontierVoiceLock(toolLoopMsgs, sprawlCrew.voice), true);
    assert.equal(toolLoopMsgs[0].text, 'Fix #111');
    assert.match(toolLoopMsgs[1].content[0].state.content[0].text, /<construct-voice-lock>/);

    // Zero-round-trip ROM pre-slot detector (including subagent `[ROM: <name>]` tags and backup substitutions)
    assert.deepEqual(detectPreSlotRomDirective('[ROM: lupus] Audit this diff for missed auth guards'), {
      action: 'use',
      target: 'lupus',
    });
    assert.deepEqual(
      detectPreSlotRomDirective('Complete assignment thoroughly:\n\n[ROM: mitch] Inspect built archive'),
      { action: 'use', target: 'mitch' }
    );
    assert.deepEqual(
      detectSubagentContextRom({
        session: { parentID: 'ses_parent', title: 'Panam-2 (@general)' },
        messages: [],
      }),
      { action: 'use', target: 'panam' }
    );
    assert.deepEqual(
      detectSubagentContextRom({
        session: { parentID: 'ses_parent', title: 'Subagent audit' },
        messages: [{ role: 'user', text: 'Context preamble\n[ROM: johnny] Check auth boundary' }],
      }),
      { action: 'use', target: 'johnny' }
    );
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
      () => validateShellCommand('gh api graphql -f query=\'mutation { update(id: "PVT_123") }\'', null, { platform: 'win32' }),
      /Gotcha #4/
    );
    // On Linux, PowerShell quote-stripping guard does NOT block bash `gh api graphql`, while `:Zone.Identifier` staging DOES block on Linux!
    assert.equal(
      validateShellCommand('gh api graphql -f query=\'mutation { update(id: "PVT_123") }\'', null, { platform: 'linux' }),
      true
    );
    assert.throws(
      () => validateShellCommand('git add docs/legal/constitution.html:Zone.Identifier', null, { platform: 'linux' }),
      /Gotcha #6/
    );
    assert.throws(() => validateShellCommand('git -c core.protectNTFS=false checkout main'), /Gotcha #6/);

    // Compact gotcha projection, compact open-thread headlines, and Sandwich Pattern ordering
    store.recordFrame({
      project: 'acme/large_project',
      kind: 'thread',
      open: true,
      summary: 'Open thread headline on the tape',
      detail: 'verbose multi-page issue body that must stay in zoom and not bloat boot output',
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
    assert.doesNotMatch(out, /verbose multi-page issue body/);
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

  it('serves all 11 tools over the JSON-RPC 2.0 MCP server and runs Claude Code context/pre-tool hooks', async () => {
    const mcp = require('../src/mcp.ts');

    // 1. JSON-RPC `initialize` and `tools/list`
    const initRes = mcp.handleJsonRpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    assert.equal(initRes.result.serverInfo.name, 'construct');
    assert.ok(typeof initRes.result.instructions === 'string' && initRes.result.instructions.length > 100);
    assert.ok(initRes.result.capabilities.prompts);
    assert.ok(initRes.result.capabilities.resources);

    const listRes = mcp.handleJsonRpcRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    assert.equal(listRes.result.tools.length, 11);
    assert.equal(mcp.CONSTRUCT_TOOL_SPECS.length, 11);
    assert.ok(listRes.result.tools.some((t) => t.name === 'construct_rec'));

    const promptsRes = mcp.handleJsonRpcRequest({
      jsonrpc: '2.0',
      id: 20,
      method: 'prompts/list',
    });
    assert.equal(promptsRes.result.prompts.length, 3);

    const resourcesRes = mcp.handleJsonRpcRequest({
      jsonrpc: '2.0',
      id: 21,
      method: 'resources/list',
    });
    assert.equal(resourcesRes.result.resources.length, 3);

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

    // 3. OpenCode `initConstruct`, ROM directive pre-slotting, and Causal Lattice Engine verification
    const ocConfigDir = path.join(tmp.dir, 'opencode-cfg');
    const initOc = store.initConstruct({
      configDir: ocConfigDir,
    });
    assert.ok(fs.existsSync(initOc.pluginPath));
    assert.ok(fs.existsSync(path.join(ocConfigDir, 'opencode.jsonc')));
    assert.ok(fs.existsSync(path.join(ocConfigDir, 'src', 'lattice.ts')));

    assert.deepEqual(mcp.detectPreSlotRomDirective('switch to a clockwork orange crew'), {
      action: 'use',
      target: 'clockwork',
    });
    assert.deepEqual(mcp.detectPreSlotRomDirective('use iron druid'), {
      action: 'use',
      target: 'irondruid',
    });
    assert.equal(mcp.resolveNodeExecutable('C:\\Users\\user\\AppData\\Local\\OpenCode\\opencode.exe'), 'node');
    assert.equal(mcp.resolveNodeExecutable('/usr/local/bin/node'), '/usr/local/bin/node');
    const protocolMod = require('../src/protocol.ts');
    assert.match(protocolMod.CORE_PROTOCOL, /Check and update documentation parity on every change/);
    assert.match(store.getRom('clockwork').voice, /Execution, Overwatch & Documentation Parity/);

    // 4. Causal Lattice Engine: rANS + String-Slab Codec, Chaskey-12 Capabilities, 64B Arena, Compaction & 1-RTT IBLT
    const lattice = store.lattice;
    const epochSecret = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
    const rootCap = lattice.mintProjectCapability({
      epochSecret,
      projectPrefix: 'acme/',
      allowedEntitiesMask: lattice.ENTITY_MASK.ALL_PROJECT,
      permissionsMask: lattice.PERMISSION_MASK.ALL,
      maxPackedHlc: 500000n,
    });
    const narrowedCap = lattice.attenuateProjectCapability(rootCap, {
      projectPrefix: 'acme/alpha_app',
      allowedEntitiesMask: lattice.ENTITY_MASK.FRAME | lattice.ENTITY_MASK.HEAD,
      permissionsMask: lattice.PERMISSION_MASK.WRITE,
      maxPackedHlc: 300000n,
    });

    // Authorized capability check passes
    assert.equal(
      lattice.verifyProjectCapability({
        epochSecret,
        token: narrowedCap,
        targetProject: 'acme/alpha_app',
        requiredEntitiesMask: lattice.ENTITY_MASK.FRAME,
        requiredPermission: lattice.PERMISSION_MASK.WRITE,
        operationPackedHlc: 200000n,
      }).ok,
      true
    );

    // Unauthorized project prefix rejected
    assert.equal(
      lattice.verifyProjectCapability({
        epochSecret,
        token: narrowedCap,
        targetProject: 'other/beta_app',
        requiredEntitiesMask: lattice.ENTITY_MASK.FRAME,
        requiredPermission: lattice.PERMISSION_MASK.WRITE,
        operationPackedHlc: 200000n,
      }).ok,
      false
    );

    // Unauthorized entity mask (GOTCHA not in FRAME | HEAD) rejected
    assert.equal(
      lattice.verifyProjectCapability({
        epochSecret,
        token: narrowedCap,
        targetProject: 'acme/alpha_app',
        requiredEntitiesMask: lattice.ENTITY_MASK.GOTCHA,
        requiredPermission: lattice.PERMISSION_MASK.WRITE,
        operationPackedHlc: 200000n,
      }).ok,
      false
    );

    // Caveat-widening attack (attempting to extend maxPackedHlc from 300000n -> 450000n) rejected
    const widenedCap = lattice.attenuateProjectCapability(narrowedCap, {
      projectPrefix: 'acme/alpha_app',
      allowedEntitiesMask: lattice.ENTITY_MASK.FRAME,
      permissionsMask: lattice.PERMISSION_MASK.WRITE,
      maxPackedHlc: 450000n,
    });
    assert.equal(
      lattice.verifyProjectCapability({
        epochSecret,
        token: widenedCap,
        targetProject: 'acme/alpha_app',
        requiredEntitiesMask: lattice.ENTITY_MASK.FRAME,
        requiredPermission: lattice.PERMISSION_MASK.WRITE,
        operationPackedHlc: 200000n,
      }).ok,
      false
    );

    // Verify frontier-preserving compaction on repeated head/frame updates
    store.setHead('acme/compact_test', { state: 'State v1', next: 'Step 1' });
    store.setHead('acme/compact_test', { state: 'State v2', next: 'Step 2' });
    store.setHead('acme/compact_test', { state: 'State v3', next: 'Step 3' });
    const frontierBeforeCompact = lattice.globalHotArena.readProjectFrontierFast('acme/compact_test');
    assert.notEqual(frontierBeforeCompact, 0n);
    const compactRes = store.compactProjectCrdtLog('acme/compact_test');
    assert.equal(compactRes.merkleFrontier64, frontierBeforeCompact);

    // Verify bi-directional interoperability between v0.3.0 Evolved and v0.1.0 Bare Construct peers:
    // 1. When a group contains an un-upgraded bare Construct peer (`latticeV2` not set), `exportEncryptedPacket`
    //    seals UTF-8 JSON plaintext so bare Construct's `JSON.parse(plaintext)` succeeds without throwing.
    // 2. Once all peers in the group have sent a `v: 2` envelope (`latticeV2: true`), `exportEncryptedPacket`
    //    automatically upgrades to binary `0x4c 0x02` rANS+Slab payloads.
    const crdtMod = require('../src/crdt.ts');
    const interopInvite = store.createInvite('acme/interop_test');
    assert.ok(interopInvite.inviteUri.startsWith('construct://invite/'));
    store.recordFrame({
      project: 'acme/interop_test',
      kind: 'finding',
      summary: 'Bi-directional bare vs evolved interop check',
    });

    // Simulate a legacy v0.1.0 peer added to `acme/interop_test` without `latticeV2`
    const rawDb = new (require('node:sqlite').DatabaseSync)(tmp.db);
    const grpRow = rawDb.prepare("SELECT * FROM mls_groups WHERE project = 'acme/interop_test'").get();
    const grp = crdtMod.hydrateMlsGroup(grpRow);
    const fakeBarePeer = {
      did: 'did:key:z6MkBarePeerV1',
      userId: 'barepeer',
      signPub: store.getIdentity().signPub,
      dhPub: store.getIdentity().dhPub,
    };
    rawDb
      .prepare("UPDATE mls_groups SET members = ? WHERE project = 'acme/interop_test'")
      .run(JSON.stringify([...grp.members, fakeBarePeer]));
    rawDb.close();

    const exportedForBare = store.exportEncryptedPacket('acme/interop_test');
    // Decrypt the raw ciphertext exactly as bare Construct v0.1.0 (`src/crdt.js:280`) does (`JSON.parse(plaintext)`)
    const { aeadKey } = crdtMod.deriveEpochKeys(grp.epochSecret, grp.groupId, grp.epoch);
    const bareDecipher = require('node:crypto').createDecipheriv(
      'chacha20-poly1305',
      aeadKey,
      Buffer.from(exportedForBare.envelope.nonce, 'base64'),
      { authTagLength: 16 }
    );
    const bareAad = Buffer.from(exportedForBare.envelope.aad, 'base64');
    const bareCt = Buffer.from(exportedForBare.envelope.ciphertext, 'base64');
    bareDecipher.setAAD(bareAad, { plaintextLength: bareCt.length });
    bareDecipher.setAuthTag(Buffer.from(exportedForBare.envelope.tag, 'base64'));
    const barePlain = Buffer.concat([bareDecipher.update(bareCt), bareDecipher.final()]);
    assert.equal(barePlain[0], 0x7b, 'Expected JSON plaintext (0x7b "{") when group has a bare Construct peer');
    const bareParsed = JSON.parse(barePlain.toString('utf8'));
    assert.equal(bareParsed.project, 'acme/interop_test');
    assert.ok(bareParsed.ops.length > 0);

    // Regression test: `editFrame`, `resolveFrames`, and `reopenFrame` must advance `hlc` and emit CRDT ops
    // so peer nodes importing subsequent packets converge on edited summaries, verified layers, and open/resolved states.
    const editThread = store.recordFrame({
      project: 'acme/interop_test',
      kind: 'thread',
      summary: 'Original unedited thread summary',
      open: true,
    }).frame;
    const initialPacket = store.exportEncryptedPacket('acme/interop_test');
    const afterInitialHlc = initialPacket.maxHlc;

    // Mutate the existing frame via `editFrame` and `resolveFrames`
    store.editFrame(editThread.seq, {
      summary: 'Updated thread summary after editFrame',
      detail: 'Added root-cause detail',
      verified: 'unit-test-layer',
    });
    store.resolveFrames(editThread.seq);

    // Export delta since `afterInitialHlc` — must contain the updated frame CRDT op!
    const deltaPacket = store.exportEncryptedPacket('acme/interop_test', {
      sinceHlc: afterInitialHlc,
    });
    assert.ok(
      deltaPacket.opCount > 0,
      `Expected editFrame + resolveFrames to emit new CRDT op(s) after ${afterInitialHlc}, got opCount=${deltaPacket.opCount}`
    );
    const frameOp = deltaPacket.ops.find((o) => o.entity === 'frame' && o.recordUid === editThread.uid);
    assert.ok(frameOp, 'Expected delta packet to contain updated frame CRDT op for editThread.uid');
    assert.equal(frameOp.payload.summary, 'Updated thread summary after editFrame');
    assert.equal(frameOp.payload.verified, 'unit-test-layer');
    assert.equal(frameOp.payload.open, false);

    // Regression test for GH #7: child subagent `[ROM: <specialist>]` or session-scoped solo specialist
    // must NOT overwrite `project_roms` for future tabs opened in that repository.
    const gh7Dir = path.join(tmp.dir, 'gh7-repo');
    fs.mkdirSync(gh7Dir, { recursive: true });
    store.setHead('acme/gh7_app', { repo: gh7Dir, state: 'Testing GH #7' });
    store.useRom('amber', { sessionId: 'ses_primary_tab', dir: gh7Dir });
    // Child subagent boots in gh7Dir and slots solo specialist `fiona`
    store.bootProject('acme/gh7_app', { sessionId: 'ses_child_sub', dir: gh7Dir });
    store.useRom('fiona', { sessionId: 'ses_child_sub', dir: gh7Dir });
    const childBoot = store.bootProject('acme/gh7_app', { sessionId: 'ses_child_sub', dir: gh7Dir });
    assert.equal(childBoot.rom.name, 'fiona');
    // Newly opened tab in the same repo must inherit the `amber` Crew Bank, NOT `fiona`!
    const newTabBoot = store.bootProject('acme/gh7_app', { sessionId: 'ses_fresh_tab', dir: gh7Dir });
    assert.equal(
      newTabBoot.rom.name,
      'amber',
      `GH #7 regression: expected fresh tab in acme/gh7_app to inherit 'amber' Crew Bank, got '${newTabBoot.rom.name}'`
    );

    // Regression test for Multi-Tab Comms Spam: an incoming Courier message claimed by Tab 1 (`ses_comms_tab_1`)
    // must NOT spam Tab 2 (`ses_comms_tab_2`) or child subagents (`ses_comms_tab_1:sub`).
    const currentRecipient = store.getUser().user?.id || store.getUser().detectedLogin;
    const spamMsg = store.sendMessage({
      project: 'acme/gh7_app',
      fromUser: 'mike',
      fromRom: 'case',
      to: currentRecipient,
      body: 'Single-tab delivery check for TUI',
    });
    const tab1Boot = store.bootProject('acme/gh7_app', { sessionId: 'ses_comms_tab_1' });
    assert.ok(
      tab1Boot.inboxPending.some((m) => m.id === spamMsg.id),
      'Tab 1 should receive the incoming Courier message'
    );
    const subBoot = store.bootProject('acme/gh7_app', { sessionId: 'ses_comms_tab_1:explore' });
    assert.equal(
      subBoot.inboxPending.length,
      0,
      'Child subagents must never receive inboxPending Comms injections'
    );
    const tab2Boot = store.bootProject('acme/gh7_app', { sessionId: 'ses_comms_tab_2' });
    assert.equal(
      tab2Boot.inboxPending.some((m) => m.id === spamMsg.id),
      false,
      'Tab 2 must not be spammed with a Courier message already claimed by Tab 1'
    );

    // Verify `benchLattice` head-to-head metrics (World-Track II + World-Track III Evolved from `causal-lattice` library)
    const benchReport = store.benchLattice({ ops: 25 });
    assert.ok(benchReport.wire.batchCompressionRatio > 1.8);
    assert.equal(benchReport.hotArenaReadNs.circuitCollisions, 0);
    assert.ok(benchReport.hotArenaReadNs.speedupFactor > 2);
    assert.equal(benchReport.evolvedPredictor.losslessVerified, true);
    assert.ok(benchReport.evolvedPredictor.gainVsWorldTrack2 > 10);
    assert.ok(benchReport.capabilityGateNs.speedupFactor > 5);
    assert.equal(benchReport.relaySync.peeledIdentically, true);

    // Verify `/construct` slash command supports every CLI command (`parseSlashArgs` + `executeConstructSlashCommand`)
    assert.deepEqual(
      mcp.parseSlashArgs('rec acme/slash finding "Verified slash CLI with quotes" --verified "unit test"'),
      ['rec', 'acme/slash', 'finding', 'Verified slash CLI with quotes', '--verified', 'unit test']
    );
    const slashEmpty = mcp.executeConstructSlashCommand('', { sessionId: 'slash_ses_1', cwd: tmp.dir });
    assert.equal(slashEmpty.kind, 'selector');
    assert.equal(slashEmpty.openHud, true);
    assert.match(slashEmpty.promptText, /call the `question` tool/);

    const slashUpgradeCheck = mcp.executeConstructSlashCommand('upgrade --check', {
      sessionId: 'slash_ses_1',
      cwd: tmp.dir,
    });
    assert.equal(slashUpgradeCheck.kind, 'cli');
    assert.equal(slashUpgradeCheck.reloadPlugin, true);
    assert.doesNotMatch(slashUpgradeCheck.promptText, /call the `question` tool/);
    assert.match(slashUpgradeCheck.output, /construct (?:is up to date|update available)/);

    const slashRec = mcp.executeConstructSlashCommand(
      'rec acme/slash finding "Slash command recorded frame" --verified "unit test"',
      { sessionId: 'slash_ses_1', cwd: tmp.dir }
    );
    assert.equal(slashRec.kind, 'cli');
    assert.equal(slashRec.isError, false);
    assert.match(slashRec.output, /recorded #\d+ \[acme\/slash\/finding\]: Slash command recorded frame/);

    const slashTape = mcp.executeConstructSlashCommand('tape acme/slash -n 5', {
      sessionId: 'slash_ses_1',
      cwd: tmp.dir,
    });
    assert.equal(slashTape.isError, false);
    assert.match(slashTape.output, /Slash command recorded frame/);

    const slashBank = mcp.executeConstructSlashCommand('tolkien', {
      sessionId: 'slash_ses_1',
      cwd: tmp.dir,
    });
    assert.equal(slashBank.kind, 'rom-use');
    assert.equal(slashBank.reloadPlugin, true);
    assert.match(slashBank.message, /Switched session to tolkien/);

    // Verify `/construct help`, `/construct help <subcommand>`, and `/construct <subcommand> --help`
    const slashHelpRoot = mcp.executeConstructSlashCommand('help', {
      sessionId: 'slash_ses_1',
      cwd: tmp.dir,
    });
    assert.equal(slashHelpRoot.isError, false);
    assert.match(slashHelpRoot.output, /usage: construct <command> \[args\]/);
    assert.match(slashHelpRoot.output, /construct help <command>/);

    const slashHelpTape = mcp.executeConstructSlashCommand('help tape', {
      sessionId: 'slash_ses_1',
      cwd: tmp.dir,
    });
    assert.equal(slashHelpTape.isError, false);
    assert.match(slashHelpTape.output, /NAME\s+construct tape - Sequential playback of the memory tape/);
    assert.match(slashHelpTape.output, /--since <iso>/);
    assert.match(slashHelpTape.promptText, /Display the following help output verbatim/);

    const slashTapeFlagHelp = mcp.executeConstructSlashCommand('tape --help', {
      sessionId: 'slash_ses_1',
      cwd: tmp.dir,
    });
    assert.equal(slashTapeFlagHelp.output, slashHelpTape.output);

    const slashHelpAlias = mcp.executeConstructSlashCommand('help ls', {
      sessionId: 'slash_ses_1',
      cwd: tmp.dir,
    });
    assert.match(slashHelpAlias.output, /construct projects \(alias: ls\)/);

    // Verify `handleOpenCodeSlashCommand` executes non-empty `/construct <cmd>` via `ctx.session.shell` (0 model roundtrips)
    const shellCalls = [];
    const promptCalls = [];
    await mcp.handleOpenCodeSlashCommand(
      {
        session: {
          shell: async (req) => shellCalls.push(req),
          prompt: async (req) => promptCalls.push(req),
        },
      },
      {
        sessionID: 'slash_ses_1',
        prompt: { text: 'help tape' },
        delivery: 'steer',
        sessDir: tmp.dir,
      }
    );
    assert.equal(shellCalls.length, 1);
    assert.equal(promptCalls.length, 0);
    assert.equal(shellCalls[0].command, 'construct help tape');

    // Verify `/construct hud` (or `/construct dashboard`) ALSO dispatches `ctx.session.prompt` so `tools.browser.preview` reopens a closed Review pane
    await mcp.handleOpenCodeSlashCommand(
      {
        session: {
          shell: async (req) => shellCalls.push(req),
          prompt: async (req) => promptCalls.push(req),
        },
      },
      {
        sessionID: 'slash_ses_1',
        prompt: { text: 'hud' },
        delivery: 'steer',
        sessDir: tmp.dir,
      }
    );
    assert.equal(promptCalls.length, 1);
    assert.match(promptCalls[0].text, /tools\.browser\.preview/);

    // Verify `construct reload`, `construct <bank>`, `construct use <bank>`, and `construct sub <specialist>`
    // work identically on the CLI (`bin/construct.js`) and via `/construct` (`executeConstructSlashCommand`)
    const reloadCliDir = path.join(tmp.dir, 'reload-cfg');
    const reloadOut = spawnSync(process.execPath, [CLI, 'reload', '--dir', reloadCliDir], {
      env: { ...process.env, CONSTRUCT_DB: tmp.db, CONSTRUCT_ROM_FILE: tmp.romFile, CONSTRUCT_IDENTITY_FILE: tmp.idFile },
      encoding: 'utf8',
    });
    assert.equal(reloadOut.status, 0);
    assert.match(reloadOut.stdout, /construct reloaded \(DID: did:key:/);
    assert.ok(fs.existsSync(path.join(reloadCliDir, 'src', 'pocket.ts')));
    assert.ok(fs.existsSync(path.join(reloadCliDir, 'src', 'store.ts')));

    const cliBankOut = spawnSync(process.execPath, [CLI, 'nightcity', '--session', 'cli_parity_ses'], {
      env: { ...process.env, CONSTRUCT_DB: tmp.db, CONSTRUCT_ROM_FILE: tmp.romFile, CONSTRUCT_IDENTITY_FILE: tmp.idFile },
      encoding: 'utf8',
    });
    assert.equal(cliBankOut.status, 0);
    assert.match(cliBankOut.stdout, /slotted ROM "nightcity".*-> session cli_parity_ses/);

    const cliSubOut = spawnSync(process.execPath, [CLI, 'sub', 'panam', '--session', 'cli_parity_ses'], {
      env: { ...process.env, CONSTRUCT_DB: tmp.db, CONSTRUCT_ROM_FILE: tmp.romFile, CONSTRUCT_IDENTITY_FILE: tmp.idFile },
      encoding: 'utf8',
    });
    assert.equal(cliSubOut.status, 0);
    assert.match(cliSubOut.stdout, /substituted "panam" into crew roster -> judy,vik,tbug,panam/);

    const cliUseOut = spawnSync(process.execPath, [CLI, 'use', 'sprawl', '--session', 'cli_parity_ses'], {
      env: { ...process.env, CONSTRUCT_DB: tmp.db, CONSTRUCT_ROM_FILE: tmp.romFile, CONSTRUCT_IDENTITY_FILE: tmp.idFile },
      encoding: 'utf8',
    });
    assert.equal(cliUseOut.status, 0);
    assert.match(cliUseOut.stdout, /slotted ROM "sprawl".*-> session cli_parity_ses/);

    // Verify `executeConstructSlashCommand` persists `lastCliOutput` into `getHudSnapshot` and `#hud-cli-output` in `generateDashboardHtml`
    const hudWithCli = store.getHudSnapshot({ dir: tmp.dir, sessionId: 'slash_ses_1' });
    assert.ok(hudWithCli.lastCliOutput);
    assert.equal(hudWithCli.lastCliOutput.cmd, '/construct hud');
    const dashWithCli = store.generateDashboardHtml({ dir: tmp.dir, sessionId: 'slash_ses_1', noServerSpawn: true });
    assert.match(dashWithCli.html, /id="hud-cli-output"/);
    assert.match(dashWithCli.html, /id="hud-cli-status"/);
    assert.match(dashWithCli.html, /id="hud-crew-drawer"/);
    assert.match(dashWithCli.html, /onclick="toggleCrewDrawer\(\)"/);

    // Verify `store.setHudUiPrefs` persists drawer collapse & bucket filter state across tab switches and HTML regenerations
    const savedUiPrefs = store.setHudUiPrefs({ crewCollapsed: true, commsCollapsed: true, commsFilter: 'pending' });
    assert.deepEqual(savedUiPrefs, { crewCollapsed: true, commsCollapsed: true, commsFilter: 'pending' });
    const dashCollapsed = store.generateDashboardHtml({ dir: tmp.dir, sessionId: 'other_tab_ses', noServerSpawn: true });
    assert.equal(dashCollapsed.hud.uiPrefs.crewCollapsed, true);
    assert.equal(dashCollapsed.hud.uiPrefs.commsCollapsed, true);
    assert.equal(dashCollapsed.hud.uiPrefs.commsFilter, 'pending');
    assert.match(dashCollapsed.html, /id="hud-crew-body-wrap" style="display:none;"/);
    assert.match(dashCollapsed.html, /id="hud-comms-body-wrap" style="margin-top:8px;max-height:360px;display:none;"/);
    store.setHudUiPrefs({ crewCollapsed: false, commsCollapsed: false, commsFilter: 'all' });
    store.clearLastCliOutput();
    const hudCleared = store.getHudSnapshot({ dir: tmp.dir, sessionId: 'slash_ses_1' });
    assert.equal(hudCleared.lastCliOutput, null);

    // Verify `/construct hud reload` regenerates the HUD and sets `reloadPlugin: true` without treating `reload` as `project: "reload"`
    const hudReloadRes = mcp.executeConstructSlashCommand('hud reload', {
      sessionId: 'slash_ses_1',
      cwd: tmp.dir,
    });
    assert.equal(hudReloadRes.isError, false);
    assert.equal(hudReloadRes.reloadPlugin, true);
    assert.equal(hudReloadRes.openHud, true);
    assert.doesNotMatch(hudReloadRes.output, /· reload · 0f/);
    store.clearLastCliOutput();

    // Verify `construct ls` prints the full project state line beyond 70 characters without mid-word clipping
    store.setHead('acme/alpha', {
      state: 'main at f4864f0. Merged PR #102 (90bdfd3) and fixed GH #114 (f4864f0: preserve full state line past column 70)',
      next: 'Ship release',
    });
    const lsOut = spawnSync(process.execPath, [CLI, 'ls'], {
      env: { ...process.env, CONSTRUCT_DB: tmp.db },
      encoding: 'utf8',
    });
    assert.equal(lsOut.status, 0);
    assert.match(lsOut.stdout, /preserve full state line past column 70/);

    // Verify Priorities 1-5:
    // Priority 1: Project-scoped `--guard` gotcha enforcement via `{ dir }`, widened pipe guard, and fail-closed omp hook
    const guardedRepoDir = path.join(tmp.dir, 'guarded-repo');
    const unguardedRepoDir = path.join(tmp.dir, 'unguarded-repo');
    fs.mkdirSync(guardedRepoDir, { recursive: true });
    fs.mkdirSync(unguardedRepoDir, { recursive: true });
    store.setHead('acme/guarded', { repo: guardedRepoDir, state: 'Active' });
    store.addGotcha({
      project: 'acme/guarded',
      title: 'Never run deploy --yolo in acme/guarded',
      fix: 'Use ./release.sh instead',
      guard: 'deploy\\s+--yolo',
    });
    assert.throws(
      () => mcp.validateShellCommand('deploy --yolo', { dir: guardedRepoDir }),
      /Never run deploy --yolo in acme\/guarded/
    );
    assert.equal(mcp.validateShellCommand('deploy --yolo', { dir: unguardedRepoDir }), true);
    assert.throws(
      () => mcp.validateShellCommand('npm test | Select-String "pass"'),
      /Gotcha #3/
    );
    assert.throws(
      () => mcp.validateShellCommand("cargo test | awk '{print $1}'"),
      /Gotcha #3/
    );

    // Priority 2: 256-bit (32-byte) invite fragment key
    const inv256 = store.createInvite('acme/guarded');
    const fragPart = inv256.inviteUri.split('#')[1] || '';
    assert.equal(Buffer.from(fragPart, 'base64url').length, 32);

    // Priority 4: Active Work Claims & Ref Collision Radar (`intent` auto-open & child `commit` auto-resolve)
    const intentClaim = store.recordFrame({
      project: 'acme/guarded',
      kind: 'intent',
      summary: 'Refactoring src/auth.ts token refresh',
      refs: ['src/auth.ts', '#114'],
    }).frame;
    assert.equal(intentClaim.open, true);
    store.recordFrame({
      project: 'acme/guarded',
      kind: 'thread',
      summary: 'Investigate race in src/auth.ts',
      refs: ['src/auth.ts'],
    });
    const bootWithCollision = store.bootProject('acme/guarded');
    assert.equal(bootWithCollision.activeClaims.length, 1);
    assert.equal(bootWithCollision.refCollisions.length, 1);
    assert.equal(bootWithCollision.refCollisions[0].ref, 'src/auth.ts');

    store.recordFrame({
      project: 'acme/guarded',
      kind: 'commit',
      parentSeq: intentClaim.seq,
      summary: 'Finished src/auth.ts token refresh',
      verified: 'unit tests',
    });
    const bootAfterResolve = store.bootProject('acme/guarded');
    assert.equal(bootAfterResolve.activeClaims.length, 0);
    assert.equal(bootAfterResolve.refCollisions.length, 0);

    // Priority 5: Modularized `src/hud.ts`, `src/github.ts`, `src/installer.ts`, and `src/lattice.ts`
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'hud.ts')));
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'github.ts')));
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'installer.ts')));
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'lattice.ts')));
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'types.ts')));
    const storeLineCount = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.ts'), 'utf8').split('\n').length;
    assert.ok(storeLineCount < 3600, `expected src/store.ts < 3600 lines, got ${storeLineCount}`);

    // 6. Construct Pocket (`src/pocket.js` & `docs/pocket.html` — Node <-> W3C WebCrypto AES-256-GCM + QR + Relay Bridge)
    const pocket = require('../src/pocket.ts');
    const vm = require('node:vm');
    const pocketCfgFile = path.join(tmp.dir, 'pocket.json');
    const pCfg1 = pocket.loadOrCreatePocketConfig({}, pocketCfgFile);
    assert.equal(Buffer.from(pCfg1.seed, 'base64url').length, 32);
    assert.equal(pocket.sealRendezvousSeed, undefined, 'short-code rendezvous beacon must not exist');
    assert.equal(pCfg1.stateRouteTag.length, 64);
    assert.equal(pCfg1.cmdRouteTag.length, 64);
    assert.equal(pCfg1.nostrPubKey.length, 64);
    assert.notEqual(pCfg1.stateRouteTag, pCfg1.cmdRouteTag);

    // Verify localhost Origin allowlist (`isAllowedLocalOrigin`)
    assert.equal(pocket.isAllowedLocalOrigin('http://127.0.0.1:47420'), true);
    assert.equal(pocket.isAllowedLocalOrigin('http://localhost:47420'), true);
    assert.equal(pocket.isAllowedLocalOrigin('https://evil.arasaka.co'), false);
    assert.equal(pocket.isAllowedLocalOrigin('http://192.168.1.50:8080'), false);
    assert.equal(pCfg1.cmdRouteTag.length, 64);
    assert.notEqual(pCfg1.stateRouteTag, pCfg1.cmdRouteTag);

    // Verify QR Code matrix & SVG generation
    const pairingUrl = pocket.buildPocketPairingUrl(pCfg1);
    assert.match(pairingUrl, /https:\/\/cmaujean\.github\.io\/construct\/pocket\.html#k=/);
    const qrMat = pocket.generateQrMatrix(pairingUrl);
    assert.equal(qrMat.size, 37); // Version 5 (37x37)
    const qrSvg = pocket.renderQrCodeSvg(pairingUrl);
    assert.match(qrSvg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);

    // Verify `docs/pocket.html` exists, has no README.md / docs/index.html leak, and its `<script>` compiles cleanly
    const pocketHtmlPath = path.join(__dirname, '..', 'docs', 'pocket.html');
    assert.ok(fs.existsSync(pocketHtmlPath));
    const pocketHtml = fs.readFileSync(pocketHtmlPath, 'utf8');
    assert.match(pocketHtml, /http-equiv="Content-Security-Policy"/);
    const pocketScriptMatch = pocketHtml.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(pocketScriptMatch, 'docs/pocket.html must contain a <script> block');
    assert.doesNotThrow(() => new vm.Script(pocketScriptMatch[1]), 'docs/pocket.html <script> must be valid JS');

    // Verify Node `node:crypto` <-> W3C WebCrypto (`globalThis.crypto.subtle`) AES-256-GCM & HKDF interoperability
    const sampleSnap = { v: 1, type: 'snapshot', activeSessionId: 'ses_mob_1', hud: { pill: '🦾 nightcity · #289' } };
    const sealedPc = pocket.sealPocketEnvelope(pCfg1, 'pc2phone', sampleSnap);
    const openedNode = pocket.openPocketEnvelope(pCfg1, 'pc2phone', sealedPc);
    assert.deepEqual(openedNode, sampleSnap);

    // Reject wrong direction (`phone2pc` vs `pc2phone`)
    assert.throws(() => pocket.openPocketEnvelope(pCfg1, 'phone2pc', sealedPc), /direction/i);

    // Decrypt `sealedPc` using W3C `crypto.subtle` (exact browser path in `docs/pocket.html`)
    const seedBytes = Buffer.from(pCfg1.seed, 'base64url');
    const webBaseKey = await globalThis.crypto.subtle.importKey('raw', seedBytes, 'HKDF', false, ['deriveKey', 'deriveBits']);
    const webAeadKey = await globalThis.crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('construct-pocket-v1|aead') },
      webBaseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    const webAad = new TextEncoder().encode(`construct-pocket-v1|pc2phone|${pCfg1.stateRouteTag}`);
    const webPlainBuf = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(sealedPc.iv, 'base64'), additionalData: webAad, tagLength: 128 },
      webAeadKey,
      Buffer.from(sealedPc.ct, 'base64')
    );
    const openedWeb = JSON.parse(new TextDecoder().decode(webPlainBuf));
    assert.deepEqual(openedWeb, sampleSnap);

    // Encrypt a `phone2pc` command using W3C `crypto.subtle` and decrypt with Node `pocket.openPocketEnvelope`
    const phoneCmd = { action: 'construct-cli', args: 'discworld', sessionId: 'ses_mob_1' };
    const cmdIv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const cmdAad = new TextEncoder().encode(`construct-pocket-v1|phone2pc|${pCfg1.cmdRouteTag}`);
    const cmdCtBuf = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: cmdIv, additionalData: cmdAad, tagLength: 128 },
      webAeadKey,
      new TextEncoder().encode(JSON.stringify(phoneCmd))
    );
    const openedCmd = pocket.openPocketEnvelope(pCfg1, 'phone2pc', {
      v: 1,
      dir: 'phone2pc',
      iv: Buffer.from(cmdIv).toString('base64'),
      ct: Buffer.from(cmdCtBuf).toString('base64'),
      ts: Date.now(),
    });
    assert.deepEqual(openedCmd, phoneCmd);

    // Verify `validateAndUnwrapIncomingCmdEvent` enforces secret-derived pubkey, inner IV replay guard, and monotonic ts
    const bState = { seenCmdIvs: new Set(), lastAcceptedCmdTs: 0 };
    const validSealedCmd = pocket.sealPocketEnvelope(pCfg1, 'phone2pc', { action: 'ping' });
    const validEv = pocket.buildPocketNostrEvent(pCfg1, pCfg1.cmdRouteTag, validSealedCmd);
    const unwrapped = pocket.validateAndUnwrapIncomingCmdEvent(validEv, pCfg1, bState);
    assert.equal(unwrapped.action, 'ping');

    // Replaying the same inner `validSealedCmd` wrapped in a brand-new outer Nostr event ID must be rejected
    const rewrappedEv = { ...validEv, id: 'f'.repeat(64) };
    assert.throws(
      () => pocket.validateAndUnwrapIncomingCmdEvent(rewrappedEv, pCfg1, bState),
      /duplicate or replayed AES-GCM IV/
    );

    // Event with a forged/mismatched sender pubkey (e.g. derived from public routeTag) must be rejected
    const forgedPubkeyEv = { ...validEv, id: 'e'.repeat(64), pubkey: 'a'.repeat(64) };
    assert.throws(
      () => pocket.validateAndUnwrapIncomingCmdEvent(forgedPubkeyEv, pCfg1, bState),
      /sender pubkey does not match/
    );

    // Verify `startPocketBridge` detects OS sleep/wake wall-clock jumps (`checkSleepWakeAndBroadcast`) and recycles relay sockets
    const testBridge = pocket.startPocketBridge(store, mcp, {
      relays: 'ws://127.0.0.1:9',
      pollIntervalMs: 6000,
    });
    try {
      assert.equal(testBridge.bridgeState.wakeCount || 0, 0);
      await testBridge.checkSleepWakeAndBroadcast(Date.now() + 30000);
      assert.equal(testBridge.bridgeState.wakeCount, 1);
    } finally {
      testBridge.stop();
    }

    // Verify `filterOpenSessionsForPocket` deduplicates historical sessions per directory and excludes child subagents
    const filteredPocketSessions = pocket.filterOpenSessionsForPocket([
      { id: 'ses_old_a', title: 'Old A', location: { directory: '/repo/a' }, time: { updated: 100 } },
      { id: 'ses_new_a', title: 'Active A', location: { directory: '/repo/a' }, time: { updated: 500 } },
      { id: 'ses_child_a', parentID: 'ses_new_a', title: 'Subagent', location: { directory: '/repo/a' }, time: { updated: 600 } },
      { id: 'ses_new_b', title: 'Active B', location: { directory: '/repo/b' }, time: { updated: 400 } },
    ]);
    assert.deepEqual(
      filteredPocketSessions.map((s) => s.id),
      ['ses_new_a', 'ses_new_b']
    );

    // Verify `select-session` persists `activeSessionId` and `activeDir` in `pocket.json` so bridge instances never revert to the first session
    const selState = { activeSessionId: 'ses_new_a', activeDir: '/repo/a' };
    await pocket.executePocketCommand(
      store,
      mcp,
      { action: 'select-session', sessionId: 'ses_new_b', dir: '/repo/b' },
      selState
    );
    const reloadedPocketCfg = pocket.loadOrCreatePocketConfig();
    assert.equal(reloadedPocketCfg.activeSessionId, 'ses_new_b');
    assert.equal(reloadedPocketCfg.activeDir, '/repo/b');
    const secondBridge = pocket.startPocketBridge(store, mcp, { relays: 'ws://127.0.0.1:9', pollIntervalMs: 60000 });
    try {
      assert.equal(secondBridge.bridgeState.activeSessionId, 'ses_new_b');
      assert.equal(secondBridge.bridgeState.activeDir, '/repo/b');
    } finally {
      secondBridge.stop();
    }

    // Verify `store.seenMessage` transitions `pending` -> `seen` (without downgrading `replied` or `delivered`)
    const msgForSeen = store.sendMessage({
      project: 'acme/guarded',
      to: 'bob',
      via: 'judy',
      body: 'Long multi-paragraph Courier message testing expand-to-seen and bucket counters',
    });
    assert.equal(msgForSeen.status, 'pending');
    const markedSeen = store.seenMessage(msgForSeen.id);
    assert.equal(markedSeen.status, 'seen');
    const markedDelivered = store.ackMessage(msgForSeen.id);
    assert.equal(markedDelivered.status, 'delivered');
    const seenAfterAck = store.seenMessage(msgForSeen.id);
    assert.equal(seenAfterAck.status, 'delivered', 'seenMessage must not downgrade delivered status');

    // 5. GitHub Pages Brochure & Docs Hub generator (`store.generateDocsSite`)
    const siteOutDir = path.join(tmp.dir, 'docs-site');
    const siteRes = store.generateDocsSite({ outDir: siteOutDir });
    assert.equal(siteRes.crewPages.length, 15);
    assert.ok(fs.existsSync(path.join(siteOutDir, 'index.html')));
    assert.ok(fs.existsSync(path.join(siteOutDir, 'guide.html')));
    assert.ok(fs.existsSync(path.join(siteOutDir, 'assets', 'style.css')));
    assert.ok(fs.existsSync(path.join(siteOutDir, '.nojekyll')));
    for (const p of store.listPacks()) {
      const crewFile = path.join(siteOutDir, 'crews', `${p.pack}.html`);
      assert.ok(fs.existsSync(crewFile), `missing crew page for ${p.pack}`);
      const crewHtml = fs.readFileSync(crewFile, 'utf8');
      assert.doesNotMatch(crewHtml, /—/, `crew page ${p.pack}.html must not contain em dashes`);
    }

    // Verify OpenCode child subagent `[ROM: <specialist>]` context detection (`mcp.detectSubagentContextRom`)
    const subOrolo = mcp.detectSubagentContextRom({
      session: { id: 'ses_child_1', parentID: 'ses_main_1', title: 'Inspect built archive' },
      messages: [{ text: '[ROM: orolo] Inspect the built dist/ archive bytes and verify version headers.' }],
    });
    assert.deepEqual(subOrolo, { action: 'use', target: 'orolo' });

    const subLioByTitle = mcp.detectSubagentContextRom({
      session: { id: 'ses_child_2', parentID: 'ses_main_1', title: 'Lio — Red-team the auth perimeter' },
      messages: [],
    });
    assert.deepEqual(subLioByTitle, { action: 'use', target: 'lio' });

    // Verify `construct bench-lattice` CLI execution
    const cliBench = spawnSync(process.execPath, [CLI, 'bench-lattice', '--json'], {
      env: { ...process.env, CONSTRUCT_DB: tmp.db, CONSTRUCT_ROM_FILE: tmp.romFile, CONSTRUCT_IDENTITY_FILE: tmp.idFile },
      encoding: 'utf8',
    });
    assert.equal(cliBench.status, 0);
    const cliBenchJson = JSON.parse(cliBench.stdout);
    assert.equal(cliBenchJson.relaySync.peeledIdentically, true);
  });
});
