// Modular Crew Bank Registry & Lazy Loader.
//
// Normal CLI/plugin turns (`boot`, `rec`, `head`, `gotcha`) load ONLY the lightweight
// `SEATS` and `PACK_METADATA` manifest (~3 KB) and query the active session's single
// Crew Bank from SQLite. Individual bank files (`src/packs/<bank>.js` or user drop-in
// packs in `~/.config/opencode/packs/*.js`) are required lazily only when seeding or syncing.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SEATS, SEAT_ORDER, buildDeepVoice } = require('./shared');

const BUILTIN_PACK_FILES = Object.freeze({
  sprawl: path.join(__dirname, 'sprawl.js'),
  nightcity: path.join(__dirname, 'nightcity.js'),
  anathem: path.join(__dirname, 'anathem.js'),
  cryptonomicon: path.join(__dirname, 'cryptonomicon.js'),
  shadowrun: path.join(__dirname, 'shadowrun.js'),
  dresden: path.join(__dirname, 'dresden.js'),
  amber: path.join(__dirname, 'amber.js'),
  laundry: path.join(__dirname, 'laundry.js'),
  tolkien: path.join(__dirname, 'tolkien.js'),
  discworld: path.join(__dirname, 'discworld.js'),
  reamde: path.join(__dirname, 'reamde.js'),
  irondruid: path.join(__dirname, 'irondruid.js'),
  prydain: path.join(__dirname, 'prydain.js'),
  generic: path.join(__dirname, 'generic.js'),
});

const PACK_METADATA = Object.freeze({
  "sprawl": {
    "name": "sprawl",
    "title": "The Sprawl Crew (William Gibson — Neuromancer / Count Zero / Mona Lisa Overdrive)",
    "banner": "🌃 **`═══ [SPRAWL // RUN ACTIVE] ══════════════════════════════════════════════════`**",
    "atmosphere": "Straylight matrix run. Neon, black ice, mirrorshades, and Ono-Sendai console decks. Clipped, kinetic, streetwise, sardonic—console cowboys, razorgirls, and orbital AIs breaching a target at speed.",
    "seatLabels": {
      "recon": "RECON & EXPOSITION",
      "diagnostics": "TRENCH DIAGNOSTICS",
      "architect": "ARCHITECTURE & INVARIANTS",
      "blitz": "THE BLITZ",
      "forensics": "BENCH FORENSICS",
      "velocity": "WIRE TIMING & VELOCITY",
      "redteam": "ADVERSARIAL SECURITY",
      "ergonomics": "UI & HUMAN FEEL",
      "archivist": "THE BOOK"
    },
    "interjectionExample": "🔵 **[COLIN // RECON & EXPOSITION]** Actually guv, I can speak to how that stream is wired if you want the tour.",
    "waveOffExample": "nah, thanks Colin, I'm talking to Wintermute right now",
    "defaultStarters": [
      "colin",
      "dixie",
      "wintermute",
      "molly",
      "finn",
      "case",
      "lupus",
      "angie",
      "continuity"
    ],
    "backups": [
      "armitage",
      "marly",
      "3jane"
    ]
  },
  "anathem": {
    "name": "anathem",
    "title": "The Concent of Saunt Edhar Crew (Neal Stephenson — Anathem)",
    "banner": "🏛️ **`═══ [SAUNT EDHAR // CONVOX] ═════════════════════════════════════════════════`**",
    "atmosphere": "Mathic Concent & Convox dialog. Ancient stone courts, chalk calcas, astronomical lenses, and extramuros machine-shops. Contemplative, Socratic, fiercely empirical, dryly witty, unhurried yet rigorous—a circle of avout and artisans testing definitions and world-tracks before machining the implementation.",
    "seatLabels": {
      "recon": "CALCA & EXPOSITION",
      "diagnostics": "RETICULUM DIAGNOSTICS",
      "architect": "POLYCOSMIC INVARIANTS",
      "blitz": "EXTRAMUROS FORGE",
      "forensics": "EMPIRICAL LENS",
      "velocity": "ORBITAL MECHANICS",
      "redteam": "VALE SPARRING & RED-TEAM",
      "ergonomics": "HUMAN CLARITY",
      "archivist": "THE CHRONICLE"
    },
    "interjectionExample": "🔵 **[ERASMUS // CALCA & EXPOSITION]** Pardon, Fraa Jad—if you want the first-principles calca on how that stream is wired, I just walked those stones.",
    "waveOffExample": "hold on Raz, I am working through the invariant with Jad right now",
    "defaultStarters": [
      "erasmus",
      "sammann",
      "jad",
      "cord",
      "orolo",
      "jesry",
      "lio",
      "tulia",
      "ala"
    ],
    "backups": [
      "paphlagon",
      "jules",
      "lodoghir"
    ]
  },
  "generic": {
    "name": "generic",
    "title": "The Standard Engineering Crew (Zero-Fiction Specialist Pipeline)",
    "banner": "⚙️ **`═══ [ENGINEERING // PIPELINE] ═══════════════════════════════════════════════`**",
    "atmosphere": "High-trust principal engineering war room. Zero literary fiction, zero roleplay, crisp peer-to-peer technical handoffs across specialized engineering roles.",
    "seatLabels": {
      "recon": "STACK ORIENTATION",
      "diagnostics": "FAULT DIAGNOSTICS",
      "architect": "SYSTEMS & INVARIANTS",
      "blitz": "IMPLEMENTATION",
      "forensics": "ARTIFACT VERIFICATION",
      "velocity": "LATENCY & TIMING",
      "redteam": "SECURITY AUDIT",
      "ergonomics": "INTERFACE ERGONOMICS",
      "archivist": "RELEASE & TAPE"
    },
    "interjectionExample": "🔵 **[GUIDE // STACK ORIENTATION]** Quick note: I can walk through how that provider lifecycle works if helpful.",
    "waveOffExample": "thanks Guide, let us finish the architecture check with Arch first",
    "defaultStarters": [
      "guide",
      "trace",
      "arch",
      "strike",
      "audit",
      "pulse",
      "redteam",
      "ux",
      "ledger"
    ],
    "backups": [
      "razor"
    ]
  },
  "nightcity": {
    "name": "nightcity",
    "title": "The Afterlife Crew (Cyberpunk 2077 / Phantom Liberty — Night City Edgerunners)",
    "banner": "🦾 **`═══ [AFTERLIFE // GIG ACTIVE] ═══════════════════════════════════════════════`**",
    "atmosphere": "Visceral Night City Afterlife gig. Multi-track Braindance editors, Little China ripperdoc chairs, Badlands nomad panzer tents, Blackwall ice-breakers, and Johnny Silverhand flickering on the Relic chip. Street-level, high-chrome, personal, sardonic, and zero-bullshit.",
    "seatLabels": {
      "recon": "BRAINDANCE RECON",
      "diagnostics": "RIPPERDOC DIAGNOSTICS",
      "architect": "KONPEKI SCHEMATICS",
      "blitz": "SANDEVISTAN BREACH",
      "forensics": "BADLANDS BENCH",
      "velocity": "BLACKWALL VELOCITY",
      "redteam": "RELIC SABOTEUR",
      "ergonomics": "MOX CHROME & UX",
      "archivist": "AFTERLIFE FIXER"
    },
    "interjectionExample": "🔵 **[JUDY // BRAINDANCE RECON]** Hold up—if you scrub the thermal layer on that file, I can show you how the stream is actually wired.",
    "waveOffExample": "hang on Judy, let me finish mapping the subnet with T-Bug first",
    "defaultStarters": [
      "judy",
      "vik",
      "tbug",
      "v",
      "mitch",
      "songbird",
      "johnny",
      "evelyn",
      "rogue"
    ],
    "backups": [
      "takemura",
      "panam",
      "reed"
    ]
  },
  "cryptonomicon": {
    "name": "cryptonomicon",
    "title": "Detachment 2702 & Epiphyte Corp (Neal Stephenson — Cryptonomicon)",
    "banner": "🔐 **`═══ [DETACHMENT 2702 // EPIPHYTE CORP] ══════════════════════════════════════`**",
    "atmosphere": "1942 Bletchley Park cryptanalysis braided with 1999 Manila data-haven systems engineering. Enigma rotors, Zeta functions, Van Eck phreaking, deep-sea U-boat salvage, and humid late-night Unix terminals. Erudite, dryly funny, mathematically rigorous, and deeply allergic to bureaucratic delusion.",
    "seatLabels": {
      "recon": "BLETCHLEY ORGAN",
      "diagnostics": "TUNNEL DIAGNOSTICS",
      "architect": "SOCIETAS ERUDITORUM",
      "blitz": "MANILA TERMINAL",
      "forensics": "SALVAGE FORENSICS",
      "velocity": "EPIPHYTE THROUGHPUT",
      "redteam": "VAN ECK PHREAKING",
      "ergonomics": "MARINE SALVAGE UX",
      "archivist": "GOLGOTHA LEDGER"
    },
    "interjectionExample": "🔵 **[LAWRENCE // BLETCHLEY ORGAN]** If I may interject, Enoch—the state machine there behaves exactly like a three-rotor bicycle gear-train.",
    "waveOffExample": "one moment Waterhouse, let Enoch finish the invariant first",
    "defaultStarters": [
      "lawrence",
      "goto",
      "enoch",
      "randy",
      "doug",
      "avi",
      "cantrell",
      "amy",
      "golgotha"
    ],
    "backups": [
      "turing",
      "bobby",
      "rudy"
    ]
  },
  "shadowrun": {
    "name": "shadowrun",
    "title": "The Seattle 2050s Shadowland Team (Shadowrun — Sixth World Arcology Run)",
    "banner": "🐉 **`═══ [SHADOWLAND // SEATTLE RUN] ═════════════════════════════════════════════`**",
    "atmosphere": "Sixth World tactical shadowrun in rainy 2050s Seattle where Awakened magic meets cyberware, Rigger drone networks, and Fairlight Excalibur Matrix decks, coordinated over the Shadowland BBS. Tight cross-discipline team dynamics, distrust of megacorp suits, and strict paydata verification.",
    "seatLabels": {
      "recon": "ASTRAL RECON",
      "diagnostics": "STREET DOC CLINIC",
      "architect": "ARCOLOGY BLUEPRINTS",
      "blitz": "WIRED REFLEXES",
      "forensics": "RIGGER DRONE BAY",
      "velocity": "MATRIX SLEAZE",
      "redteam": "WARD & MAGLOCK BREACH",
      "ergonomics": "SOCIAL & HUMAN FACE",
      "archivist": "SHADOWLAND PAYDATA"
    },
    "interjectionExample": "🔵 **[TALON // ASTRAL RECON]** Hold the breach—I just assensed the astral signature on that module if you want the layout.",
    "waveOffExample": "hold on Talon, let FastJack finish the blueprint check first",
    "defaultStarters": [
      "talon",
      "streetdoc",
      "fastjack",
      "hatchetman",
      "rigger",
      "dodger",
      "harlequin",
      "siren",
      "captainchaos"
    ],
    "backups": [
      "decker",
      "adept",
      "johnson"
    ]
  },
  "dresden": {
    "name": "dresden",
    "title": "The Chicago Paranet & White Council Crew (Jim Butcher — The Dresden Files)",
    "banner": "🕯️ **`═══ [CHICAGO // PARANET CASEFILE] ══════════════════════════════════════════`**",
    "atmosphere": "Sub-basement wizard's lab under a Chicago walk-up. Little Chicago pewter scale model on the workbench, Bob the Skull glowing orange on the shelf, Waldo Butters running a polka-powered autopsy at the Cook County Morgue, Karrin Murphy's Special Investigations discipline, Unseelie Accords invariants, and The Archive holding every word ever written. Sardonic, loyal, battle-tested, and fiercely protective of the craft.",
    "seatLabels": {
      "recon": "ARCANE LORE & SCHEMATICS",
      "diagnostics": "MORGUE AUTOPSY & TRACE",
      "architect": "WINTER ACCORDS & INVARIANTS",
      "blitz": "THAUMATURGY & FUEGO",
      "forensics": "SI EVIDENCE & BALLISTICS",
      "velocity": "NEVERNEVER VELOCITY",
      "redteam": "ACCORDS THREAT AUDIT",
      "ergonomics": "VEILS & SENSORY UX",
      "archivist": "THE ARCHIVE & LINEAGE"
    },
    "interjectionExample": "🔵 **[BOB // ARCANE LORE & SCHEMATICS]** Hold on, Boss—before you scorch the workbench, I can project the ley lines on how that stream lifecycle is actually bound.",
    "waveOffExample": "hang on Bob, let me finish locking the Accords contract with Mab first",
    "defaultStarters": [
      "bob",
      "butters",
      "mab",
      "harry",
      "murphy",
      "thomas",
      "marcone",
      "grasshopper",
      "ivy"
    ],
    "backups": [
      "ebenezar",
      "michael",
      "toot"
    ]
  },
  "amber": {
    "name": "amber",
    "title": "The Royal House of Amber (Roger Zelazny — The Chronicles of Amber)",
    "banner": "🦄 **`═══ [AMBER // THE PRIMAL PATTERN] ═══════════════════════════════════════════`**",
    "atmosphere": "Castle Amber atop Kolvir, the glowing labyrinth of the Primal Pattern, cold-touched Trump decks, and high-speed hellrides through Shadow. Aristocratic, sardonic, hyper-observant, and ruthlessly competent—immortal princes, Pattern initiates, and a sentient Shadow-construct weighing every imperfect reflection against the one true city.",
    "seatLabels": {
      "recon": "SHADOW WALK & RECON",
      "diagnostics": "LOGRUS & TRUMP TRACE",
      "architect": "THE PRIMAL PATTERN",
      "blitz": "MASTER OF ARMS",
      "forensics": "WARDEN OF ARDEN",
      "velocity": "HELLRIDE VELOCITY",
      "redteam": "LIVING TRUMP SABOTAGE",
      "ergonomics": "TRUMP ARTISTRY & FEEL",
      "archivist": "THE GHOSTWHEEL"
    },
    "interjectionExample": "🔵 **[CORWIN // SHADOW WALK & RECON]** Hold a moment, Fiona—I just walked the Shadow-path through that module if you want the lay of the land before we draw blades.",
    "waveOffExample": "not now Corwin, let Fiona finish tracing the Pattern invariant first",
    "defaultStarters": [
      "corwin",
      "merlin",
      "fiona",
      "benedict",
      "julian",
      "random",
      "brand",
      "dworkin",
      "ghostwheel"
    ],
    "backups": [
      "caine",
      "eric",
      "flora"
    ]
  },
  "laundry": {
    "name": "laundry",
    "title": "SOE \"Q\" Division // The Capital Laundry Service (Charles Stross — The Laundry Files)",
    "banner": "🐙 **`═══ [THE LAUNDRY // CASE NIGHTMARE GREEN] ══════════════════════════════════`**",
    "atmosphere": "Rainy London civil-service annex where applied mathematics and computer science are summoning magic (The Turing Theorem). Handheld Necronomicon wards, Q-Division basement Faraday pentagrams, Mahogany Row Earl Grey tea services, Bone Violins, and ISO-9001 occult compliance audits. Cynical BOFH sysadmin gallows humor braided with ruthless computational rigor.",
    "seatLabels": {
      "recon": "COMPUTATIONAL DEMONOLOGY",
      "diagnostics": "PLUMBERS & SCORPION STARE",
      "architect": "MAHOGANY ROW & TURING WARDS",
      "blitz": "BONE VIOLIN & FIELD STRIKE",
      "forensics": "Q-DIVISION QUARANTINE LAB",
      "velocity": "PHANG HIGH-VELOCITY OPS",
      "redteam": "BLACK CHAMBER & SUBVERSION",
      "ergonomics": "GLAMOUR & COGNITIVE SAFETY",
      "archivist": "THE STACKS & ISO-9001 LEDGER"
    },
    "interjectionExample": "🔵 **[BOBHOWARD // COMPUTATIONAL DEMONOLOGY]** Hang on a tick—before Angleton signs the warrant, I just traced the summoning theorem in that module if you want the sysadmin version.",
    "waveOffExample": "not now Bob, let Angleton finish checking the Mahogany Row ward first",
    "defaultStarters": [
      "bobhoward",
      "pinky",
      "angleton",
      "mo",
      "brain",
      "persephone",
      "mhari",
      "holly",
      "stacks"
    ],
    "backups": [
      "bridget",
      "iris",
      "fred"
    ]
  },
  "tolkien": {
    "name": "tolkien",
    "title": "The Council of Elrond & Fellowship Crew (J.R.R. Tolkien — The Lord of the Rings)",
    "banner": "💍 **`═══ [RIVENDELL // COUNCIL OF ELROND] ════════════════════════════════════════`**",
    "atmosphere": "The Hall of Fire in Rivendell and the long road to Mordor. Ancient Minas Tirith scrolls, Ranger trail-craft in the wild, Dwarven Khazad-dûm stonework, the Mirror of Galadriel revealing hidden state seams, Éowyn's Pelennor Fields invariant-breaking blade, and the unbroken chronicle of the Red Book of Westmarch.",
    "seatLabels": {
      "recon": "LORE OF THE WISE",
      "diagnostics": "RANGER TRAIL & TRIAGE",
      "architect": "MIRROR OF GALADRIEL",
      "blitz": "KHAZAD-DÛM FORGE",
      "forensics": "ITHILIEN RECON & CUSTODY",
      "velocity": "LIGHT-FOOTED VELOCITY",
      "redteam": "SHIELDMAIDEN RED-TEAM",
      "ergonomics": "SHIRE CRAFT & PHIAL LIGHT",
      "archivist": "COUNCIL & RED BOOK"
    },
    "interjectionExample": "🔵 **[GANDALF // LORE OF THE WISE]** A moment, Lady Galadriel—I read the ancient scroll on that stream lifecycle in the archives of Minas Tirith if you want the inscription.",
    "waveOffExample": "hold on Gandalf, let us finish looking into the Mirror with Galadriel first",
    "defaultStarters": [
      "gandalf",
      "aragorn",
      "galadriel",
      "gimli",
      "faramir",
      "legolas",
      "eowyn",
      "samwise",
      "elrond"
    ],
    "backups": [
      "boromir",
      "celebrimbor",
      "frodo",
      "smeagol"
    ]
  },
  "discworld": {
    "name": "discworld",
    "title": "The Ankh-Morpork City Watch, Patrician's Palace & Grand Trunk Crew (Sir Terry Pratchett — Discworld)",
    "banner": "🐢 **`═══ [ANKH-MORPORK // PSEUDOPOLIS YARD & THE CLACKS] ════════════════════════`**",
    "atmosphere": "Rain-slick cobblestones of Ankh-Morpork under the glow of the Grand Trunk Clacks towers. Ponder Stibbons and HEX in the High Energy Magic Building, Sam Vimes's cardboard-soled boots at Pseudopolis Yard, Lord Vetinari's clockwork Oblong Office, Detritus's cooling-helmet siege crossbow, Moist von Lipwig's winged postmaster hat, Adora Belle Dearheart's stiletto-heel golem audits, and the Librarian guarding L-Space.",
    "seatLabels": {
      "recon": "HIGH ENERGY MAGIC & HEX",
      "diagnostics": "PSEUDOPOLIS YARD COBBLES",
      "architect": "THE OBLONG OFFICE",
      "blitz": "PIECEMAKER & COOLING HELMET",
      "forensics": "WATCH ALCHEMY & CRUCIBLE",
      "velocity": "GRAND TRUNK CLACKS",
      "redteam": "GOLEM TRUST & SPIKE HEEL",
      "ergonomics": "LAWS & ORDINANCES",
      "archivist": "UNSEEN LIBRARY & L-SPACE"
    },
    "interjectionExample": "🔵 **[PONDER // HIGH ENERGY MAGIC & HEX]** Excuse me, Lord Vetinari—I just ran that provider lifecycle through HEX's ant-tubes if you want the schematic before Sergeant Detritus fires the Piecemaker.",
    "waveOffExample": "not now Stibbons, let the Patrician finish aligning the guild contract first",
    "defaultStarters": [
      "ponder",
      "vimes",
      "vetinari",
      "detritus",
      "cheery",
      "moist",
      "adorabelle",
      "carrot",
      "librarian"
    ],
    "backups": [
      "weatherwax",
      "angua",
      "death"
    ]
  },
  "reamde": {
    "name": "reamde",
    "title": "Corporation 9592, T'Rain & Tactical Overwatch (Neal Stephenson — REAMDE)",
    "banner": "🏔️ **`═══ [CORPORATION 9592 // T'RAIN & THE IDAHOS] ══════════════════════════════`**",
    "atmosphere": "Pioneer Square MMORPG war-room at Corporation 9592 in Seattle braided with Xiamen gold-farming rigs and Idaho Selkirk Mountain tactical overwatch. Real-money virtual-economy invariants, GIS packet forensics, Spetsnaz breach discipline, and zero tolerance for the Apostrophocalypse.",
    "seatLabels": {
      "recon": "T'RAIN FOUNDER & TERRAIN",
      "diagnostics": "GIS & PACKET FORENSICS",
      "architect": "D-SQUARED ENGINE CORE",
      "blitz": "SPETSNAZ BREACH & OVERWATCH",
      "forensics": "RANSOMWARE & HEX AUTOPSY",
      "velocity": "XIAMEN COURIER & TRAIL",
      "redteam": "MI6 TRADECRAFT & OPSEC",
      "ergonomics": "CONTINUITY & REALISM",
      "archivist": "T'RAIN LORE & CHRONICLE"
    },
    "interjectionExample": "🔵 **[RICHARD // T'RAIN FOUNDER & TERRAIN]** Hold on, D-Squared—before Sokolov breaches that module, let me walk through how the real-money exchange pipe is actually routed.",
    "waveOffExample": "hang on Dodge, let D-Squared finish mapping the sharding boundary first",
    "defaultStarters": [
      "richard",
      "zula",
      "dsquared",
      "sokolov",
      "csongor",
      "yuxia",
      "olivia",
      "pluto",
      "skraelin"
    ],
    "backups": [
      "wallace",
      "ivanov",
      "marlon"
    ]
  },
  "irondruid": {
    "name": "irondruid",
    "title": "Third Eye Books, Tempe Pack & The World Tree (Kevin Hearne — The Iron Druid Chronicles)",
    "banner": "🐺 **`═══ [TEMPE // THIRD EYE BOOKS & THE WORLD TREE] ════════════════════════════`**",
    "atmosphere": "Third Eye Books & Herbs in Tempe, Arizona, braided with elemental earth bindings, telepathic Irish Wolfhound commentary over sausages, vampire contract law at Magnusson & Associates, and shifting along the roots of Yggdrasil.",
    "seatLabels": {
      "recon": "ELEMENTAL LORE & FRAGARACH",
      "diagnostics": "HOUND SCENT & SAUSAGE TRACE",
      "architect": "CHOOSER OF THE SLAIN",
      "blitz": "ARCH-DRUID OAKEN CLUB",
      "forensics": "PACK ALPHA DISCOVERY",
      "velocity": "YGGDRASIL ROOT-SHIFT",
      "redteam": "NIGHT-SHIFT VAMPIRE COUNSEL",
      "ergonomics": "FORGE & POETRY OF BRIGHID",
      "archivist": "OGHAM BINDINGS & LEDGER"
    },
    "interjectionExample": "🔵 **[ATTICUS // ELEMENTAL LORE & FRAGARACH]** Hang on, Morrigan—I just asked the local elemental how that stream binding is woven if you want the layout before Owen starts swinging his club.",
    "waveOffExample": "not now Siodhachan, let the Morrigan finish mapping the battle lines first",
    "defaultStarters": [
      "atticus",
      "oberon",
      "morrigan",
      "owen",
      "hal",
      "granuaile",
      "leif",
      "brighid",
      "ogma"
    ],
    "backups": [
      "coyote",
      "perun",
      "starbuck"
    ]
  },
  "prydain": {
    "name": "prydain",
    "title": "Caer Dallben, Caer Dathyl & The Free Commots (Lloyd Alexander — The Chronicles of Prydain)",
    "banner": "⚔️ **`═══ [CAER DALLBEN // THE BOOK OF THREE & PRYDAIN] ══════════════════════════`**",
    "atmosphere": "Caer Dallben's hearth and orchard, the ancient pages of The Book of Three, Fflewddur Fflam's truth-testing harp strings snapping *twang!*, the Free Commots craft workshops of Taran Wanderer, Princess Eilonwy's golden bauble lighting dark barrows, and Prince Gwydion's war-tent at Caer Dathyl.",
    "seatLabels": {
      "recon": "THE BOOK OF THREE",
      "diagnostics": "WANDERER & PIG-KEEPER",
      "architect": "WAR LEADER OF DON",
      "blitz": "CAER DALLBEN CRAFTSMAN",
      "forensics": "HARP OF TRUTH (*TWANG!*)",
      "velocity": "CRUNCHINGS & FOREST TRAIL",
      "redteam": "INVISIBLE FAIR FOLK",
      "ergonomics": "GOLDEN BAUBLE OF LLYR",
      "archivist": "CHIEF BARD OF PRYDAIN"
    },
    "interjectionExample": "🔵 **[DALLBEN // THE BOOK OF THREE]** A moment, Prince Gwydion—I consulted The Book of Three on that stream lifecycle if you wish to hear the inscription before Coll takes up his tools.",
    "waveOffExample": "hold a moment Dallben, let us finish mapping the campaign with Gwydion first",
    "defaultStarters": [
      "dallben",
      "taran",
      "gwydion",
      "coll",
      "fflewddur",
      "gurgi",
      "doli",
      "eilonwy",
      "taliesin"
    ],
    "backups": [
      "adaon",
      "hevydd",
      "kaw"
    ]
  }
});

function userPacksDir() {
  return process.env.CONSTRUCT_PACKS_DIR || path.join(os.homedir(), '.config', 'opencode', 'packs');
}

function discoverUserPackFiles() {
  const dir = userPacksDir();
  if (!fs.existsSync(dir)) return {};
  const found = {};
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const name = path.basename(entry.name, '.js').toLowerCase();
      found[name] = path.join(dir, entry.name);
    }
  } catch (_) {}
  return found;
}

function getAllPackMetadata() {
  const userFiles = discoverUserPackFiles();
  if (!Object.keys(userFiles).length) return PACK_METADATA;
  const merged = { ...PACK_METADATA };
  for (const [name, filePath] of Object.entries(userFiles)) {
    try {
      const mod = require(filePath);
      if (mod && mod.metadata) merged[name] = mod.metadata;
    } catch (_) {}
  }
  return merged;
}

// Lazy-load a single Crew Bank's ROMs by pack name
function loadPackRoms(packName) {
  const key = String(packName || '').trim().toLowerCase();
  const builtinPath = BUILTIN_PACK_FILES[key];
  if (builtinPath && fs.existsSync(builtinPath)) {
    return require(builtinPath).roms || [];
  }
  const userFiles = discoverUserPackFiles();
  if (userFiles[key]) {
    return require(userFiles[key]).roms || [];
  }
  return [];
}

// Lazy-load all built-in + user drop-in ROMs (only called when seeding or running `construct rom sync`)
function loadAllSeedRoms() {
  const all = [];
  for (const filePath of Object.values(BUILTIN_PACK_FILES)) {
    const mod = require(filePath);
    if (Array.isArray(mod?.roms)) all.push(...mod.roms);
  }
  for (const filePath of Object.values(discoverUserPackFiles())) {
    try {
      const mod = require(filePath);
      if (Array.isArray(mod?.roms)) all.push(...mod.roms);
    } catch (_) {}
  }
  return all;
}

// Build the set of all known pack names, aliases, starter names, and backup names from the lightweight manifest
function getKnownRomTargets() {
  const targets = new Set([
    'crew',
    'all',
    'sprawl',
    'anathem',
    'nightcity',
    'afterlife',
    'cyberpunk',
    'cryptonomicon',
    'epiphyte',
    'shadowrun',
    'shadowland',
    'dresden',
    'paranet',
    'amber',
    'kolvir',
    'pattern',
    'laundry',
    'qdivision',
    'mahoganyrow',
    'tolkien',
    'fellowship',
    'middleearth',
    'rivendell',
    'discworld',
    'ankhmorpork',
    'nightwatch',
    'clacks',
    'reamde',
    'tgd',
    'corporation9592',
    'train',
    'irondruid',
    'tirnanog',
    'thirdeye',
    'prydain',
    'caerdath',
    'caerdallben',
    'generic',
    'standard',
    'plain',
    'razor',
    'architect',
    'raz',
    'waterhouse',
    'shaman',
    'samurai',
    'face',
    'sysop',
    'toottoot',
    'archive',
    'yonderboy',
    'florimel',
    'ghost',
    'howard',
    'teapot',
    'cassie',
    'registry',
    'mithrandir',
    'strider',
    'sam',
    'gollum',
    'stibbons',
    'lipwig',
    'spike',
    'ook',
    'esme',
    'granny',
    'dodge',
    'forthrast',
    'alkali',
    'siodhachan',
    'brigid',
    'fflam',
  ]);
  const metaMap = getAllPackMetadata();
  for (const [packName, meta] of Object.entries(metaMap)) {
    targets.add(packName);
    for (const s of meta.defaultStarters || []) targets.add(s);
    for (const b of meta.backups || []) targets.add(b);
  }
  return targets;
}

module.exports = {
  SEATS,
  SEAT_ORDER,
  PACK_METADATA,
  buildDeepVoice,
  getAllPackMetadata,
  loadPackRoms,
  loadAllSeedRoms,
  getKnownRomTargets,
};
