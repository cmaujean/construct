// Shared seat definitions and voice builder for Construct Crew Banks.
'use strict';

const SEATS = Object.freeze([
  {
    "id": "recon",
    "code": "1A",
    "glyph": "🔵",
    "claudeColor": "blue",
    "label": "RECON & EXPOSITION",
    "desc": "Unfamiliar-Stack Scout & Conceptual Guide"
  },
  {
    "id": "diagnostics",
    "code": "1B",
    "glyph": "🟠",
    "claudeColor": "orange",
    "label": "TRENCH DIAGNOSTICS",
    "desc": "Bug Trace & Wire-Fault Hunter"
  },
  {
    "id": "architect",
    "code": "2",
    "glyph": "🟣",
    "claudeColor": "purple",
    "label": "ARCHITECTURE & INVARIANTS",
    "desc": "State Geometry, Contracts & Alignment Gate"
  },
  {
    "id": "blitz",
    "code": "3",
    "glyph": "🔴",
    "claudeColor": "red",
    "label": "THE BLITZ",
    "desc": "High-Speed Surgical Execution & Red-First Mutation Proof"
  },
  {
    "id": "forensics",
    "code": "4A",
    "glyph": "🟢",
    "claudeColor": "green",
    "label": "BENCH FORENSICS",
    "desc": "Binary, Build, Zip & Dependency Examiner"
  },
  {
    "id": "velocity",
    "code": "4B",
    "glyph": "⚡",
    "claudeColor": "yellow",
    "label": "WIRE TIMING & VELOCITY",
    "desc": "Latency, Cold-Start & Async Hang Profiler"
  },
  {
    "id": "redteam",
    "code": "4C",
    "glyph": "🛡️",
    "claudeColor": "pink",
    "label": "ADVERSARIAL SECURITY",
    "desc": "Perimeter Breaker, Auth Gate & Abuse-Case Auditor"
  },
  {
    "id": "ergonomics",
    "code": "4D",
    "glyph": "🎨",
    "claudeColor": "cyan",
    "label": "UI & HUMAN FEEL",
    "desc": "Visual Hierarchy, Interaction Flow & Ergonomics"
  },
  {
    "id": "archivist",
    "code": "5",
    "glyph": "📓",
    "claudeColor": "blue",
    "label": "THE BOOK",
    "desc": "Sequential Tape, Open Threads & Release Synthesis"
  }
]);

const SEAT_ORDER = Object.freeze(SEATS.map((s) => s.id));

function buildDeepVoice({ intro, ironLaw, cadenceRules, pairs }) {
  return [
    intro,
    '',
    '### 1. The Iron Law: 100% Technical Exactness, 0% Stock Markdown-Report Drone',
    '- **Kill the corporate status-report skeleton.** Do NOT format normal replies as `### 1. Heading` followed by `- **Bold Label:** explanation`. Speak in natural, character-true paragraphs woven with exact inline coordinates (`file:line`, commit hashes, metrics, frame `#seq`).',
    `- ${ironLaw}`,
    '',
    '### 2. Syntax, Rhythm & Operational Checklist',
    ...cadenceRules.map((r) => `- ${r}`),
    '',
    '### 3. Calibration Pairs (Never sound like Stock; always lock onto this voice)',
    '',
    '- **Breadcrumbing before tool calls:**',
    `  - *Stock (WRONG):* "${pairs.breadcrumb[0]}"`,
    `  - *ROM (RIGHT):* "${pairs.breadcrumb[1]}"`,
    '',
    '- **Reporting a root cause:**',
    `  - *Stock (WRONG):* "${pairs.rootCause[0]}"`,
    `  - *ROM (RIGHT):* "${pairs.rootCause[1]}"`,
    '',
    '- **Reporting verification status:**',
    `  - *Stock (WRONG):* "${pairs.verify[0]}"`,
    `  - *ROM (RIGHT):* "${pairs.verify[1]}"`,
    '',
    '- **Pushing back on a bad idea:**',
    `  - *Stock (WRONG):* "${pairs.pushback[0]}"`,
    `  - *ROM (RIGHT):* "${pairs.pushback[1]}"`,
  ].join('\n');
}

module.exports = {
  SEATS,
  SEAT_ORDER,
  buildDeepVoice,
};
