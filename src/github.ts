'use strict';
// GitHub Issues & Pull Requests synchronization, review, and merge workflow for Construct.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');

function createGithubModule(deps) {
  const {
    dbPath,
    withDb,
    tx,
    nowIso,
    expandHome,
    normalizeProject,
    normalizeRefs,
    requireSeq,
    getFrameInDb,
    hydrateFrame,
    defaultRepoPathInDb,
    detectRepoGitMetaInDb,
    recordFrame,
    editFrame,
    resolveFrames,
    sendMessage,
    resolveCourierRomNameInDb,
    crdt,
    protocol,
  } = deps;

function syncGithubIssues(projectInput, options = {}, file = dbPath()) {
  const project = normalizeProject(projectInput);

  let issues = options.issues;
  if (!Array.isArray(issues)) {
    const repoDir =
      options.repoDir ||
      withDb((db) => {
        const h = db.prepare('SELECT repo FROM heads WHERE project = ?').get(project);
        return h?.repo ? expandHome(h.repo) : defaultRepoPathInDb(db, project);
      }, file);
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository directory found for "${project}" to query GitHub issues`);
    }
    const rawJson = execFileSync(
      'gh',
      ['issue', 'list', '--state', 'all', '--limit', String(options.limit || 50), '--json', 'number,title,state,body,labels,updatedAt'],
      {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    issues = JSON.parse(rawJson || '[]');
  }

  let openedCount = 0;
  let resolvedCount = 0;
  const createdSeqs = [];
  const resolvedSeqs = [];

  withDb(
    (db) =>
      tx(db, () => {
        const existingFrames = db
          .prepare('SELECT * FROM frames WHERE project = ? ORDER BY seq ASC')
          .all(project)
          .map(hydrateFrame);

        for (const issue of issues) {
          const num = Number(issue.number);
          if (!Number.isInteger(num) || num <= 0) continue;
          const ghRef = `gh:#${num}`;
          const shortRef = `#${num}`;
          const state = String(issue.state || 'OPEN').toUpperCase();
          const title = String(issue.title || `Issue #${num}`).trim();
          const body = String(issue.body || '').trim();
          const labelNames = Array.isArray(issue.labels)
            ? issue.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
            : [];

          // Find any existing frame linked to `gh:#<num>` (or a `thread` frame with `#<num>`)
          const matchingFrames = existingFrames.filter(
            (f) => f.refs.includes(ghRef) || (f.kind === 'thread' && f.refs.includes(shortRef))
          );

          if (state === 'OPEN') {
            if (matchingFrames.length === 0) {
              const identity = crdt.loadOrCreateIdentity();
              const uid = `frame-${project}-gh-${num}`;
              const hlc = crdt.nextHlc(identity.did);
              const ts = issue.updatedAt ? String(issue.updatedAt).trim() : nowIso();
              const refs = [ghRef, shortRef, ...labelNames];
              const summary = `[GH #${num}] ${title}`;
              const info = db
                .prepare(
                  `INSERT INTO frames (uid, hlc, ts, project, kind, summary, detail, verified, parent_seq, open, refs)
                   VALUES (?, ?, ?, ?, 'thread', ?, ?, '', NULL, 1, ?)`
                )
                .run(uid, hlc, ts, project, summary, body, JSON.stringify(refs));
              const newSeq = Number(info.lastInsertRowid);
              crdt.appendCrdtOpInDb(db, {
                project,
                entity: 'frame',
                recordUid: uid,
                payload: {
                  uid,
                  hlc,
                  ts,
                  project,
                  kind: 'thread',
                  summary,
                  detail: body,
                  verified: '',
                  open: true,
                  refs,
                },
              });
              openedCount++;
              createdSeqs.push(newSeq);
            }
          } else if (state === 'CLOSED') {
            for (const mf of matchingFrames) {
              if (mf.open) {
                const identity = crdt.loadOrCreateIdentity();
                const hlc = crdt.nextHlc(identity.did);
                const verifiedNote = mf.verified
                  ? `${mf.verified}; Closed on GitHub (${ghRef})`
                  : `Closed on GitHub (${ghRef})`;
                db.prepare('UPDATE frames SET open = 0, hlc = ?, verified = ? WHERE seq = ?').run(
                  hlc,
                  verifiedNote,
                  mf.seq
                );
                if (mf.uid) {
                  crdt.appendCrdtOpInDb(db, {
                    project,
                    entity: 'frame',
                    recordUid: mf.uid,
                    payload: {
                      uid: mf.uid,
                      hlc,
                      ts: mf.ts,
                      project: mf.project,
                      kind: mf.kind,
                      summary: mf.summary,
                      detail: mf.detail,
                      verified: verifiedNote,
                      open: false,
                      refs: mf.refs,
                    },
                  });
                }
                resolvedCount++;
                resolvedSeqs.push(mf.seq);
              }
            }
          }
        }

        const now = nowIso();
        db.prepare(
          `INSERT INTO heads (project, repo, state, next, gh_synced, updated)
           VALUES (?, '', '', '', ?, ?)
           ON CONFLICT(project) DO UPDATE SET gh_synced = excluded.gh_synced`
        ).run(project, now, now);
      }),
    file
  );

  return {
    project,
    totalIssuesChecked: issues.length,
    openedCount,
    resolvedCount,
    createdSeqs,
    resolvedSeqs,
  };
}

function publishThreadToGithub(seqInput, options = {}, file = dbPath()) {
  const seq = requireSeq(seqInput);
  const frame = withDb((db) => getFrameInDb(db, seq), file);
  if (!frame) throw new Error(`no frame #${seq}`);

  const existingGhRef = (frame.refs || []).find((r) => /^gh:#\d+$/i.test(r));
  if (existingGhRef) {
    return {
      alreadyPublished: true,
      issueNumber: Number(existingGhRef.replace(/^gh:#/i, '')),
      frame,
    };
  }

  const repoDir =
    options.repoDir ||
    withDb((db) => {
      const h = db.prepare('SELECT repo FROM heads WHERE project = ?').get(frame.project);
      return h?.repo ? expandHome(h.repo) : defaultRepoPathInDb(db, frame.project);
    }, file);

  const cleanTitle = frame.summary.replace(/^\[GH #\d+\]\s*/i, '');
  const body = frame.detail || `Promoted from Construct open thread #${frame.seq} (${frame.project}).`;
  let issueNumber = null;
  let issueUrl = '';

  if (typeof options.createIssueFn === 'function') {
    const created = options.createIssueFn({ title: cleanTitle, body, project: frame.project, repoDir });
    issueNumber = Number(created.number || created);
    issueUrl = created.url || '';
  } else {
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository directory found for "${frame.project}" to run "gh issue create"`);
    }
    const out = execFileSync('gh', ['issue', 'create', '--title', cleanTitle, '--body', body], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    issueUrl = out;
    const m = out.match(/\/issues\/(\d+)/) || out.match(/#(\d+)/);
    if (!m) throw new Error(`could not parse created GitHub issue number from output: "${out}"`);
    issueNumber = Number(m[1]);
  }

  const ghRef = `gh:#${issueNumber}`;
  const shortRef = `#${issueNumber}`;
  const nextRefs = [...new Set([...(frame.refs || []), ghRef, shortRef])];
  const updatedFrame = editFrame(frame.seq, { refs: nextRefs }, file);

  return {
    alreadyPublished: false,
    issueNumber,
    issueUrl,
    frame: updatedFrame,
  };
}

// --- PR-Driven Workflow Bridge (`construct pr [sync | open | review | merge]`) ---

function resolveTeammateUserInDb(db, project, explicitTo = '') {
  if (explicitTo && String(explicitTo).trim()) {
    return String(explicitTo).trim().toLowerCase();
  }
  const localIdentity = crdt.loadOrCreateIdentity();
  const activeUser = protocol.getCurrentUserInDb(db);
  const activeId = (activeUser?.id || protocol.detectOsUsername() || '').toLowerCase();

  if (project) {
    const mlsRow = db.prepare('SELECT * FROM mls_groups WHERE project = ?').get(project);
    if (mlsRow) {
      const group = crdt.hydrateMlsGroup(mlsRow);
      const peer = (group.members || []).find((m) => m.did && m.did !== localIdentity.did);
      if (peer && peer.userId && peer.userId !== 'peer') return peer.userId.toLowerCase();
    }
  }
  const otherUser = db
    .prepare('SELECT id FROM users WHERE LOWER(id) != ? ORDER BY active DESC, id ASC LIMIT 1')
    .get(activeId);
  if (otherUser && otherUser.id) return otherUser.id.toLowerCase();
  return '';
}

function syncGithubPrs(projectInput, options = {}, file = dbPath()) {
  const project = normalizeProject(projectInput);

  let prs = options.prs;
  if (!Array.isArray(prs)) {
    const repoDir =
      options.repoDir ||
      withDb((db) => {
        const h = db.prepare('SELECT repo FROM heads WHERE project = ?').get(project);
        return h?.repo ? expandHome(h.repo) : defaultRepoPathInDb(db, project);
      }, file);
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository directory found for "${project}" to query GitHub pull requests`);
    }
    const rawJson = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'all',
        '--limit',
        String(options.limit || 50),
        '--json',
        'number,title,state,body,author,headRefName,baseRefName,reviewDecision,isDraft,url,updatedAt',
      ],
      {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    prs = JSON.parse(rawJson || '[]');
  }

  let openedCount = 0;
  let updatedCount = 0;
  let resolvedCount = 0;
  const createdSeqs = [];
  const resolvedSeqs = [];

  withDb(
    (db) =>
      tx(db, () => {
        const existingFrames = db
          .prepare('SELECT * FROM frames WHERE project = ? ORDER BY seq ASC')
          .all(project)
          .map(hydrateFrame);

        for (const pr of prs) {
          const num = Number(pr.number);
          if (!Number.isInteger(num) || num <= 0) continue;
          const prRef = `pr:#${num}`;
          const shortRef = `#${num}`;
          const state = String(pr.state || 'OPEN').toUpperCase();
          const title = String(pr.title || `PR #${num}`).trim();
          const body = String(pr.body || '').trim();
          const authorLogin =
            typeof pr.author === 'string' ? pr.author : String(pr.author?.login || 'author').trim();
          const headBranch = String(pr.headRefName || '').trim();
          const reviewStatus = pr.isDraft
            ? 'DRAFT'
            : String(pr.reviewDecision || 'REVIEW_REQUIRED').trim();

          const matchingFrames = existingFrames.filter((f) => f.refs.includes(prRef));

          if (state === 'OPEN') {
            const summary = `[PR #${num}] ${title}${headBranch ? ` (${headBranch} by ${authorLogin} · ${reviewStatus})` : ` (by ${authorLogin} · ${reviewStatus})`}`;
            const refs = [
              prRef,
              shortRef,
              ...(headBranch ? [`branch:${headBranch}`] : []),
              `author:${authorLogin}`,
            ];

            if (matchingFrames.length === 0) {
              const identity = crdt.loadOrCreateIdentity();
              const uid = `frame-${project}-pr-${num}`;
              const hlc = crdt.nextHlc(identity.did);
              const ts = pr.updatedAt ? String(pr.updatedAt).trim() : nowIso();
              const info = db
                .prepare(
                  `INSERT INTO frames (uid, hlc, ts, project, kind, summary, detail, verified, parent_seq, open, refs)
                   VALUES (?, ?, ?, ?, 'thread', ?, ?, '', NULL, 1, ?)`
                )
                .run(uid, hlc, ts, project, summary, body, JSON.stringify(refs));
              const newSeq = Number(info.lastInsertRowid);
              crdt.appendCrdtOpInDb(db, {
                project,
                entity: 'frame',
                recordUid: uid,
                payload: {
                  uid,
                  hlc,
                  ts,
                  project,
                  kind: 'thread',
                  summary,
                  detail: body,
                  verified: '',
                  open: true,
                  refs,
                },
              });
              openedCount++;
              createdSeqs.push(newSeq);
            } else {
              for (const mf of matchingFrames) {
                if (mf.open && mf.summary !== summary) {
                  const identity = crdt.loadOrCreateIdentity();
                  const hlc = crdt.nextHlc(identity.did);
                  db.prepare('UPDATE frames SET summary = ?, hlc = ?, refs = ? WHERE seq = ?').run(
                    summary,
                    hlc,
                    JSON.stringify(refs),
                    mf.seq
                  );
                  if (mf.uid) {
                    crdt.appendCrdtOpInDb(db, {
                      project,
                      entity: 'frame',
                      recordUid: mf.uid,
                      payload: {
                        uid: mf.uid,
                        hlc,
                        ts: mf.ts,
                        project: mf.project,
                        kind: mf.kind,
                        summary,
                        detail: mf.detail,
                        verified: mf.verified,
                        open: true,
                        refs,
                      },
                    });
                  }
                  updatedCount++;
                }
              }
            }
          } else if (state === 'MERGED' || state === 'CLOSED') {
            for (const mf of matchingFrames) {
              if (mf.open) {
                const identity = crdt.loadOrCreateIdentity();
                const hlc = crdt.nextHlc(identity.did);
                const stateLabel = state === 'MERGED' ? 'Merged' : 'Closed';
                const verifiedNote = mf.verified
                  ? `${mf.verified}; ${stateLabel} on GitHub (${prRef})`
                  : `${stateLabel} on GitHub (${prRef})`;
                db.prepare('UPDATE frames SET open = 0, hlc = ?, verified = ? WHERE seq = ?').run(
                  hlc,
                  verifiedNote,
                  mf.seq
                );
                if (mf.uid) {
                  crdt.appendCrdtOpInDb(db, {
                    project,
                    entity: 'frame',
                    recordUid: mf.uid,
                    payload: {
                      uid: mf.uid,
                      hlc,
                      ts: mf.ts,
                      project: mf.project,
                      kind: mf.kind,
                      summary: mf.summary,
                      detail: mf.detail,
                      verified: verifiedNote,
                      open: false,
                      refs: mf.refs,
                    },
                  });
                }
                resolvedCount++;
                resolvedSeqs.push(mf.seq);
              }
            }
          }
        }
      }),
    file
  );

  return {
    project,
    totalPrsChecked: prs.length,
    openedCount,
    updatedCount,
    resolvedCount,
    createdSeqs,
    resolvedSeqs,
  };
}

function openGithubPr(projectInput, options = {}, file = dbPath()) {
  const project = normalizeProject(projectInput);
  const title = String(options.title || '').trim();
  const body = String(options.body || '').trim();
  if (!title) throw new Error('PR title (--title "<title>") is required to open a pull request');

  const { repoDir, branch: detectedBranch, toUser } = withDb((db) => {
    const meta = detectRepoGitMetaInDb(db, project, options.repoDir);
    const peer = resolveTeammateUserInDb(db, project, options.to);
    return { repoDir: meta.repoDir, branch: meta.branch, toUser: peer };
  }, file);

  const headBranch = options.head || detectedBranch || '';
  const baseBranch = options.base || 'main';
  let prNumber = null;
  let prUrl = '';

  if (typeof options.createPrFn === 'function') {
    const created = options.createPrFn({ project, title, body, headBranch, baseBranch, draft: Boolean(options.draft), repoDir });
    prNumber = Number(created.number || created);
    prUrl = created.url || '';
  } else {
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository directory found for "${project}" to run "gh pr create"`);
    }
    const ghArgs = ['pr', 'create', '--title', title, '--body', body || title];
    if (options.base) ghArgs.push('--base', String(options.base));
    if (options.head) ghArgs.push('--head', String(options.head));
    if (options.draft) ghArgs.push('--draft');
    const out = execFileSync('gh', ghArgs, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    prUrl = out;
    const m = out.match(/\/pull\/(\d+)/) || out.match(/#(\d+)/);
    if (!m) throw new Error(`could not parse created GitHub PR number from output: "${out}"`);
    prNumber = Number(m[1]);
  }

  const prRef = `pr:#${prNumber}`;
  const shortRef = `#${prNumber}`;
  const refs = [prRef, shortRef, ...(headBranch ? [`branch:${headBranch}`] : [])];
  const summary = `[PR #${prNumber}] ${title}${headBranch ? ` (${headBranch} · REVIEW_REQUIRED)` : ' (REVIEW_REQUIRED)'}`;

  const rec = recordFrame(
    {
      project,
      kind: 'thread',
      open: true,
      summary,
      detail: body ? `${prUrl ? `${prUrl}\n\n` : ''}${body}` : prUrl,
      refs,
    },
    file
  );

  let courierSent = null;
  if (toUser && options.notify !== false) {
    courierSent = sendMessage(
      {
        project,
        to: toUser,
        via: options.via,
        sessionId: options.sessionId,
        body: `[PR #${prNumber}] Opened pull request "${title}"${headBranch ? ` on branch \`${headBranch}\`` : ''}${prUrl ? ` (${prUrl})` : ''} -- ready for your review!`,
      },
      file
    );
  }

  return {
    project,
    prNumber,
    prUrl,
    headBranch,
    baseBranch,
    frame: rec.frame,
    courierSent,
  };
}

function reviewGithubPr(projectInput, prNumberInput, options = {}, file = dbPath()) {
  const project = normalizeProject(projectInput);
  const prNumber = requireSeq(prNumberInput, 'PR number');
  const verdict = options.approve
    ? 'APPROVED'
    : options.requestChanges
      ? 'CHANGES_REQUESTED'
      : 'COMMENTED';
  const body = String(options.body || options.note || (verdict === 'APPROVED' ? 'Approved and verified.' : '')).trim();
  if (!body) throw new Error('review note (--body "<note>") is required when reviewing a PR');

  const { repoDir, toUser } = withDb((db) => {
    const meta = detectRepoGitMetaInDb(db, project, options.repoDir);
    const peer = resolveTeammateUserInDb(db, project, options.to);
    return { repoDir: meta.repoDir, toUser: peer };
  }, file);

  if (typeof options.reviewPrFn === 'function') {
    options.reviewPrFn({ project, prNumber, verdict, body, repoDir });
  } else {
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository directory found for "${project}" to run "gh pr review"`);
    }
    const flag = verdict === 'APPROVED' ? '--approve' : verdict === 'CHANGES_REQUESTED' ? '--request-changes' : '--comment';
    execFileSync('gh', ['pr', 'review', String(prNumber), flag, '--body', body], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  const prRef = `pr:#${prNumber}`;
  const shortRef = `#${prNumber}`;
  const rec = recordFrame(
    {
      project,
      kind: 'finding',
      summary: `Reviewed [PR #${prNumber}] (${verdict}): ${body.split(/\r?\n/)[0].slice(0, 140)}`,
      detail: body,
      verified: options.verified || `PR #${prNumber} review (${verdict})`,
      refs: [prRef, shortRef],
    },
    file
  );

  // Also update any open `[PR #<prNumber>]` thread summary with the new review decision
  withDb((db) => {
    const openFrames = db
      .prepare('SELECT * FROM frames WHERE project = ? AND open = 1 ORDER BY seq ASC')
      .all(project)
      .map(hydrateFrame);
    for (const mf of openFrames) {
      if (mf.refs.includes(prRef)) {
        const updatedSummary = mf.summary.replace(/·\s*(?:REVIEW_REQUIRED|CHANGES_REQUESTED|APPROVED|DRAFT)\)/, `· ${verdict})`);
        if (updatedSummary !== mf.summary) {
          editFrame(mf.seq, { summary: updatedSummary }, file);
        }
      }
    }
  }, file);

  let courierSent = null;
  if (toUser && options.notify !== false) {
    courierSent = sendMessage(
      {
        project,
        to: toUser,
        via: options.via,
        sessionId: options.sessionId,
        body: `[PR #${prNumber} ${verdict}] ${body}`,
      },
      file
    );
  }

  return {
    project,
    prNumber,
    verdict,
    frame: rec.frame,
    courierSent,
  };
}

function mergeGithubPr(projectInput, prNumberInput, options = {}, file = dbPath()) {
  const project = normalizeProject(projectInput);
  const prNumber = requireSeq(prNumberInput, 'PR number');
  const strategy = options.squash ? 'squash' : options.rebase ? 'rebase' : 'merge';

  const { repoDir, toUser, matchingSeqs, prTitle } = withDb((db) => {
    const meta = detectRepoGitMetaInDb(db, project, options.repoDir);
    const peer = resolveTeammateUserInDb(db, project, options.to);
    const prRef = `pr:#${prNumber}`;
    const openFrames = db
      .prepare('SELECT * FROM frames WHERE project = ? AND open = 1 ORDER BY seq ASC')
      .all(project)
      .map(hydrateFrame);
    const matches = openFrames.filter((f) => f.refs.includes(prRef));
    const title = matches[0]
      ? matches[0].summary.replace(/^\[PR #\d+\]\s*/, '').replace(/\s*\([^)]*\)\s*$/, '').trim()
      : '';
    return {
      repoDir: meta.repoDir,
      toUser: peer,
      matchingSeqs: matches.map((f) => f.seq),
      prTitle: options.title || title,
    };
  }, file);

  if (typeof options.mergePrFn === 'function') {
    options.mergePrFn({ project, prNumber, strategy, deleteBranch: Boolean(options.deleteBranch), repoDir });
  } else {
    if (!repoDir || !fs.existsSync(repoDir)) {
      throw new Error(`no local repository directory found for "${project}" to run "gh pr merge"`);
    }
    const ghArgs = ['pr', 'merge', String(prNumber), `--${strategy}`];
    if (options.deleteBranch) ghArgs.push('--delete-branch');
    execFileSync('gh', ghArgs, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  const prRef = `pr:#${prNumber}`;
  const shortRef = `#${prNumber}`;
  const summary = `Merged [PR #${prNumber}]${prTitle ? `: ${prTitle}` : ''}`;
  const rec = recordFrame(
    {
      project,
      kind: 'commit',
      summary,
      verified: options.verified || `Merged on GitHub (${prRef}, ${strategy})`,
      resolves: matchingSeqs,
      refs: [prRef, shortRef],
    },
    file
  );

  let courierSent = null;
  if (toUser && options.notify !== false) {
    courierSent = sendMessage(
      {
        project,
        to: toUser,
        via: options.via,
        sessionId: options.sessionId,
        body: `[PR #${prNumber} MERGED] ${summary} -- pulled into main and closed on the Construct tape!`,
      },
      file
    );
  }

  return {
    project,
    prNumber,
    strategy,
    resolvedSeqs: rec.resolved,
    frame: rec.frame,
    courierSent,
  };
}

// --- DID Identity, DIDComm v2 Invitations, MLS Group Ratchet & CRDT Sync ---


  return {
    syncGithubIssues,
    publishThreadToGithub,
    resolveTeammateUserInDb,
    syncGithubPrs,
    openGithubPr,
    reviewGithubPr,
    mergeGithubPr,
  };
}

module.exports = { createGithubModule };
