import { T, eq, rejects, TEN, NOW, fresh, base, sor } from './helpers.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import {
  installAuthSchema,
  signupTenant,
  inviteUser,
  createInvitation,
  acceptInvitation,
  setUserTeam,
  parseTeam,
  isEngineer,
  TEAMS,
  DEFAULT_TEAM,
} from '../src/core/auth.ts';
import {
  listIssues,
  createIssue,
  moveIssue,
  updateIssue,
  addComment,
  syncIssues,
  saveGitHubSyncConfig,
  getGitHubSyncConfig,
  getGitHubPushError,
  markGitHubSyncError,
  unlinkGitHubSyncConfig,
  pushUpdateToGitHub,
} from '../src/console/issues.ts';
import { isSealed, secretsKeyFromEnv } from '../src/core/secrets.ts';
import type { AsyncDb } from '../src/core/db.ts';

/**
 * The engineers-team Issues board (huly-style kanban). What these tests pin:
 *  - team is a first-class department on users/invitations (parse + defaults);
 *  - the gate is the department, never the role — an owner of another team is
 *    refused exactly like a member, an engineering member has full access;
 *  - the page, JSON sync and every mutation are gated (anonymous callers,
 *    wrong-tenant callers and non-engineers all refuse);
 *  - board mechanics: create/move/comment/sync deltas and the stale-write guard.
 */

console.log('\n\x1b[1mIssues panel — engineers team only\x1b[0m');

const OWNER = { email: 'owner@acme.test', password: 'the-console-password' };

async function seeded() {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  const { owner } = await signupTenant(
    ctx.db,
    { slug: TEN, name: 'Acme', email: OWNER.email, password: OWNER.password, ownerName: 'Ada' },
    NOW,
  );
  return { ...ctx, owner };
}

/** Invite + accept in one step: the accepted account is immediately active (no forced password change). */
async function activeMember(
  db: AsyncDb,
  owner: { id: string; role: string },
  email: string,
  role: 'member' | 'admin' | 'owner',
  team: 'engineering' | 'marketing' | 'unassigned' = 'engineering',
) {
  const { token } = await createInvitation(
    db,
    TEN,
    { email, name: email.split('@')[0]!, role, team },
    { userId: owner.id, role: owner.role as 'owner' },
    NOW,
  );
  const { user } = await acceptInvitation(db, token, 'a-long-enough-password', NOW);
  return user;
}

function engineerSession(port: number, email: string, password: string) {
  return async () => {
    const url = `http://127.0.0.1:${port}`;
    const pre = await fetch(`${url}/login`, { redirect: 'manual' });
    const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const preToken = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
    const loginRes = await fetch(`${url}/login`, {
      method: 'POST',
      headers: { cookie: preCookie },
      body: `csrf=${preToken}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
      redirect: 'manual',
    });
    const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const homeRes = await fetch(`${url}/`, { headers: { cookie }, redirect: 'manual' });
    const homeHtml = await homeRes.text();
    const csrf = homeHtml.match(/name="vital-csrf" content="([0-9a-f]+)"/)?.[1] ?? '';
    return { cookie, csrf, headers: { cookie, 'x-vital-csrf': csrf } as Record<string, string> };
  };
}

T('team defaults to unassigned and parses back from rows', async () => {
  const { owner } = await seeded();
  eq(owner.team, 'unassigned');
  eq(parseTeam('ENGINEERING'), 'engineering');
  eq(parseTeam(''), DEFAULT_TEAM);
  eq(parseTeam('astronauts'), DEFAULT_TEAM);
  eq(TEAMS.includes('engineering'), true);
});

T('invitations carry a team; accepting it lands the user on that team', async () => {
  const { db, owner } = await seeded();
  const { invitation, token } = await createInvitation(
    db,
    TEN,
    { email: 'eng@acme.test', name: 'Eng One', role: 'member', team: 'engineering' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  eq(invitation.team, 'engineering');
  const { user } = await acceptInvitation(db, token, 'a-long-enough-password', NOW);
  eq(user.team, 'engineering');
  eq(isEngineer(user), true);
});

T('inviteUser places the user on the invited team', async () => {
  const { db, owner } = await seeded();
  const marketer = await inviteUser(
    db,
    TEN,
    { email: 'mkt@acme.test', name: 'Mkt', role: 'member', team: 'marketing', password: 'a-long-enough-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  eq(marketer.team, 'marketing');
  eq(isEngineer(marketer), false);
});

T('setUserTeam is admin-gated and audited', async () => {
  const { db, owner } = await seeded();
  const member = await inviteUser(
    db,
    TEN,
    { email: 'x@acme.test', name: 'X', role: 'member', password: 'a-long-enough-password' },
    { userId: owner.id, role: owner.role },
    NOW,
  );
  const memberSessionLike = { userId: member.id, role: member.role };
  await rejects(() => setUserTeam(db, TEN, member.id, 'engineering', memberSessionLike, NOW), 'FORBIDDEN');
  const next = await setUserTeam(db, TEN, member.id, 'engineering', { userId: owner.id, role: owner.role }, NOW);
  eq(next.team, 'engineering');
  const auditRow = (await db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE tenant = ? AND action = 'auth.team_changed'")
    .get(TEN)) as { n: number };
  eq(Number(auditRow.n) >= 1, true);
});

T('board mechanics: create, move, comment, delta sync', async () => {
  const { db } = await seeded();
  const eng = { userId: 'u1', email: 'eng@acme.test' };
  const issue = await createIssue(
    db,
    TEN,
    { title: 'Set up cluster monitoring', priority: 'Low', labels: ['Devops'] },
    eng,
    NOW,
  );
  eq(issue.state, 'BACKLOG');
  eq(issue.progress, 0);

  const moved = await moveIssue(db, TEN, issue.id, { state: 'IN PROGRESS' }, NOW);
  eq(moved?.state, 'IN PROGRESS');
  const done = await moveIssue(db, TEN, issue.id, { state: 'DONE' }, NOW);
  eq(done?.progress, 100);

  const comment = await addComment(db, TEN, issue.id, 'eng@acme.test', 'monitoring agent deployed', NOW);
  eq(comment?.issueId, issue.id);

  const full = await listIssues(db, TEN);
  eq(full.issues.length, 1);
  eq(full.comments.length, 1);

  const delta = await syncIssues(db, TEN, NOW);
  eq(delta.issues.length, 1, 'the move+comment touched updated_at, so the delta contains the issue');

  const staleGuard = updateIssue(db, TEN, issue.id, { title: 'x', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }, NOW);
  await rejects(() => staleGuard, 'STALE_WRITE');
  const ok = await updateIssue(db, TEN, issue.id, { title: 'Set up cluster monitoring v2', state: 'TO DO' }, NOW);
  eq(ok?.title, 'Set up cluster monitoring v2');
  eq(ok?.state, 'TO DO');
});

T('anonymous callers are refused everywhere on the board', async () => {
  const { db, ledger, coord, comp } = await seeded();
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    // The refusal follows the route's declared surface, not the board's taste:
    // a browser is sent to the login form with a way back, an API caller gets a
    // status it can act on. Both are asserted exactly — "303 or 403" would pass
    // on the day one of them silently became the other.
    const page = await fetch(`${url}/console/issues`, { redirect: 'manual' });
    eq(page.status, 303, 'unauthenticated page → login redirect');
    const sync = await fetch(`${url}/console/issues/sync`, { redirect: 'manual' });
    eq(sync.status, 401, 'unauthenticated JSON sync → 401');
    eq(((await sync.json()) as { code: string }).code, 'SESSION_EXPIRED', 'and says why:');
    const move = await fetch(`${url}/console/issues/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'issueId=iss_x&state=DONE',
      redirect: 'manual',
    });
    eq(move.status, 401, 'unauthenticated mutation → 401');
  } finally {
    await server.close();
  }
});

T('non-engineer owner gets 403; engineer member gets the board', async () => {
  const { db, ledger, coord, comp, owner } = await seeded();
  // Owner is unassigned (never special-cased): refused.
  const engineer = await activeMember(db, owner, 'eng@acme.test', 'member', 'engineering');
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    const ownerSession = await engineerSession(server.port, OWNER.email, OWNER.password)();
    const ownerPage = await fetch(`${url}/console/issues`, {
      headers: { cookie: ownerSession.cookie },
      redirect: 'manual',
    });
    eq(ownerPage.status, 403, 'owner without the engineering team is refused');
    // And told why, in the console's own chrome — a refusal is a page, not a
    // bare JSON body in a browser tab, which is what a page route owes a person
    // who followed a link.
    const refused = await ownerPage.text();
    eq(refused.includes('engineering team only'), true, 'the refusal states the reason:');
    eq(refused.includes('id="console-rail"'), true, 'the refusal keeps the console chrome:');

    const engSession = await engineerSession(server.port, engineer.email, 'a-long-enough-password')();
    const engPage = await fetch(`${url}/console/issues`, {
      headers: { cookie: engSession.cookie },
      redirect: 'manual',
    });
    eq(engPage.status, 200);
    const html = await engPage.text();
    eq(html.includes('iss-board'), true, 'board markup renders');
    eq(html.includes('BACKLOG') && html.includes('IN PROGRESS'), true, 'kanban columns render');
    // The engineer's console rail shows the Issues link…
    eq(html.includes('href="/console/issues"'), true, 'engineer sees the Issues nav link in the shell');
    // …and the board wears the Console chrome. It used to be wrapped in the
    // *chat* shell, which deliberately injects no Console tokens (see
    // wrapInWorkspaceShell) while every rule in issues.ts is written against
    // `var(--v-*)`. Its stylesheet therefore resolved to nothing, and the rail
    // highlighted Chat while you were reading Issues.
    eq(html.includes('id="console-rail"'), true, 'the board renders the console rail');
    // …and marks Issues as the current page. The board used to ask the shell for
    // the `buzz` nav key, which the rail resolves to Chat — so reading Issues lit
    // up the Chat item.
    eq(
      /class="vc-rail-item is-active"[^>]*id="sidebar-issues-dashboard-link"/.test(html),
      true,
      'the Issues rail item is the active one:',
    );
    eq(html.includes('data-vital-no-theme'), false, 'the board is not opted out of the design system');
    eq(html.includes('--v-accent:'), true, 'the board page ships the tokens its stylesheet uses');

    // …and a marketing admin's shell (rendered on a page they CAN open) does not.
    // Mutations work with CSRF; sync returns JSON.
    const createRes = await fetch(`${url}/console/issues/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: engSession.cookie },
      body: `csrf=${engSession.csrf}&title=Board+task&state=TO+DO&priority=High`,
    });
    eq(createRes.status, 200);
    const created = (await createRes.json()) as { ok: boolean; issue: { id: string; state: string } };
    eq(created.ok, true);
    eq(created.issue.state, 'TO DO');

    const syncRes = await fetch(`${url}/console/issues/sync`, { headers: { cookie: engSession.cookie } });
    const syncJson = (await syncRes.json()) as { ok: boolean; snapshot: { issues: unknown[] } };
    eq(syncJson.ok, true);
    eq(syncJson.snapshot.issues.length >= 1, true);

    // A non-engineer hitting the sync API is refused even with a live session.
    const marketer = await activeMember(db, owner, 'mkt@acme.test', 'admin', 'marketing');
    const mktSession = await engineerSession(server.port, marketer.email, 'a-long-enough-password')();
    // The marketing admin's /team and / (home) pages render the shell
    // WITHOUT the Issues link or #dashboard channel — the nav never leaks the board to other teams.
    const mktTeamPage = await fetch(`${url}/team`, { headers: { cookie: mktSession.cookie }, redirect: 'manual' });
    eq(mktTeamPage.status, 200);
    const mktHtml = await mktTeamPage.text();
    eq(mktHtml.includes('href="/console/issues"'), false, 'no Issues nav link for other teams on team page');

    const mktHome = await fetch(`${url}/`, { headers: { cookie: mktSession.cookie }, redirect: 'manual' });
    eq(mktHome.status, 200);
    const mktHomeHtml = await mktHome.text();
    eq(mktHomeHtml.includes('href="/console/issues"'), false, 'no Issues nav link on home page for non-engineers');
    eq(mktHomeHtml.includes('id="sidebar-issues-dashboard-link"'), false, 'no #dashboard channel for non-engineers');

    // But marketing member has full standard member access to other features:
    const mktCompiler = await fetch(`${url}/console/compiler`, { headers: { cookie: mktSession.cookie }, redirect: 'manual' });
    eq(mktCompiler.status, 200, 'marketer can access projects/compiler');
    const mktAgents = await fetch(`${url}/console/human-work`, { headers: { cookie: mktSession.cookie }, redirect: 'manual' });
    eq(mktAgents.status, 200, 'marketer can access agents');
    const mktAccount = await fetch(`${url}/account`, { headers: { cookie: mktSession.cookie }, redirect: 'manual' });
    eq(mktAccount.status, 200, 'marketer can access account');
    const mktDash = await fetch(`${url}/console/dashboard`, { headers: { cookie: mktSession.cookie }, redirect: 'manual' });
    eq(mktDash.status, 200, 'marketer can access vital dashboard');
    const mktDashHtml = await mktDash.text();
    eq(mktDashHtml.includes('id="sidebar-issues-dashboard-link"'), false, 'non-engineer does not see issues in dashboard sidebar');
    eq(mktDashHtml.includes('issues-sidebar-section'), false, 'non-engineer has no issues section in view dashboard sidebar');

    // And engineer member has standard member access PLUS extra Issues capability:
    const engHome = await fetch(`${url}/`, { headers: { cookie: engSession.cookie }, redirect: 'manual' });
    eq(engHome.status, 200);
    const engHomeHtml = await engHome.text();
    eq(engHomeHtml.includes('href="/console/issues"'), true, 'engineer sees Issues link in sidebar');
    eq(engHomeHtml.includes('id="sidebar-issues-dashboard-link"'), true, 'engineer sees #dashboard link in sidebar');

    const engCompiler = await fetch(`${url}/console/compiler`, { headers: { cookie: engSession.cookie }, redirect: 'manual' });
    eq(engCompiler.status, 200, 'engineer can access projects/compiler');
    const engAgents = await fetch(`${url}/console/human-work`, { headers: { cookie: engSession.cookie }, redirect: 'manual' });
    eq(engAgents.status, 200, 'engineer can access agents');
    const engAccount = await fetch(`${url}/account`, { headers: { cookie: engSession.cookie }, redirect: 'manual' });
    eq(engAccount.status, 200, 'engineer can access account');
    const engDash = await fetch(`${url}/console/dashboard`, { headers: { cookie: engSession.cookie }, redirect: 'manual' });
    eq(engDash.status, 200, 'engineer can access vital dashboard');
    const engDashHtml = await engDash.text();
    eq(engDashHtml.includes('id="sidebar-issues-dashboard-link"'), true, 'engineer sees issues link in view dashboard sidebar');
    eq(engDashHtml.includes('issues-sidebar-section'), true, 'engineer sees issues section in view dashboard sidebar');
    eq(engDashHtml.includes('Board task'), true, 'engineer sees the created issue listed in the dashboard sidebar');

    const mktSync = await fetch(`${url}/console/issues/sync`, { headers: { cookie: mktSession.cookie } });
    eq(mktSync.status, 403, 'even an admin of another team cannot sync');
    const mktMove = await fetch(`${url}/console/issues/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: mktSession.cookie },
      body: `csrf=${mktSession.csrf}&issueId=${created.issue.id}&state=DONE`,
    });
    eq(mktMove.status, 403, 'and cannot mutate the board');

    // Bad CSRF on the engineer's own mutation is refused.
    const badCsrf = await fetch(`${url}/console/issues/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: engSession.cookie },
      body: `csrf=deadbeef&title=nope`,
    });
    eq(badCsrf.status, 403);
  } finally {
    await server.close();
  }
  void base;
  void sor;
});

T('stored GitHub tokens seal under VITAL_SECRETS_KEY and fail loudly without it', async () => {
  const { db } = await fresh();
  const previous = process.env.VITAL_SECRETS_KEY;
  try {
    // Unkeyed: legacy plaintext behaviour preserved.
    delete process.env.VITAL_SECRETS_KEY;
    eq(secretsKeyFromEnv(), null, 'no key configured:');
    await saveGitHubSyncConfig(db, TEN, 'o/r', 'ghp_plain', 'human:owner', NOW);
    const plain = await getGitHubSyncConfig(db, TEN);
    eq(plain!.token, 'ghp_plain', 'unkeyed save reads back:');
    eq(isSealed(plain!.token), false, 'unkeyed rows are plaintext:');

    // Keyed: sealed at rest, transparent on read.
    process.env.VITAL_SECRETS_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    await saveGitHubSyncConfig(db, TEN, 'o/r', 'ghp_secret', 'human:owner', NOW);
    const raw = (await db.prepare('SELECT token FROM github_project_sync WHERE tenant = ?').get(TEN)) as {
      token: string;
    };
    eq(isSealed(raw.token), true, 'sealed at rest:');
    eq(raw.token.includes('ghp_secret'), false, 'ciphertext leaks no plaintext:');
    const opened = await getGitHubSyncConfig(db, TEN);
    eq(opened!.token, 'ghp_secret', 'opens with the key:');

    // Wrong key: loud failure, never silent garbage.
    process.env.VITAL_SECRETS_KEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    let threw = '';
    try {
      await getGitHubSyncConfig(db, TEN);
    } catch (e) {
      threw = (e as Error).message;
    }
    eq(threw.includes('TOKEN_UNSEALABLE'), true, 'wrong key fails loudly:');

    // Missing key: loud failure, never unauthenticated sync.
    delete process.env.VITAL_SECRETS_KEY;
    let missing = '';
    try {
      await getGitHubSyncConfig(db, TEN);
    } catch (e) {
      missing = (e as Error).message;
    }
    eq(missing.includes('TOKEN_SEALED'), true, 'missing key fails loudly:');

    // Bad key material rejected at parse time.
    process.env.VITAL_SECRETS_KEY = 'short';
    let bad = '';
    try {
      secretsKeyFromEnv();
    } catch (e) {
      bad = (e as Error).message;
    }
    eq(bad.includes('BAD_KEY'), true, 'malformed key refused:');
  } finally {
    if (previous === undefined) delete process.env.VITAL_SECRETS_KEY;
    else process.env.VITAL_SECRETS_KEY = previous;
    await db.close();
  }
});

T('an external push failure is visible, and unlinking stops every outbound write', async () => {
  const { db } = await fresh();
  await saveGitHubSyncConfig(db, TEN, 'acme/board', 'ghp_live', 'human:owner', NOW);
  eq((await getGitHubSyncConfig(db, TEN))!.status, 'linked');

  // A push that GitHub refuses is recorded: status flips, the reason is durable,
  // and the failure is readable by the dialog that shows it.
  await markGitHubSyncError(db, TEN, {
    kind: 'issue.update',
    target: 'issue:iss_1',
    error: 'GitHub API error (401): Bad credentials',
    at: NOW,
  });
  const afterFailure = await getGitHubSyncConfig(db, TEN);
  eq(afterFailure!.status, 'error', 'a failed push is not silent:');
  const recorded = await getGitHubPushError(db, TEN);
  eq(recorded!.kind, 'issue.update');
  eq(recorded!.error.includes('401'), true, 'the reason survives for the operator:');

  // Unlink: the repo and the token are forgotten, and the record of the failure
  // goes with them — it described a link that no longer exists.
  const removed = await unlinkGitHubSyncConfig(db, TEN, 'human:owner', NOW);
  eq(removed!.repo, '', 'the repository is forgotten:');
  eq(removed!.token, null, 'and so is the credential:');
  eq(removed!.status, 'unlinked');
  eq(await getGitHubPushError(db, TEN), null, 'the stale failure clears with the link:');
  const raw = (await db.prepare('SELECT repo, token, status FROM github_project_sync WHERE tenant = ?').get(TEN)) as {
    repo: string;
    token: string | null;
    status: string;
  };
  eq(raw.token, null, 'nothing is left in the token column at rest:');
  eq(raw.status, 'unlinked');

  // Every push refuses afterwards, because the guard is the repo itself.
  const issue = await createIssue(
    db,
    TEN,
    { title: 'unlink check', description: '' },
    { userId: 'u', email: 'e@acme.test' },
    NOW,
  );
  const result = await pushUpdateToGitHub(db, TEN, issue, {
    fetchFn: (() => Promise.reject(new Error('must not be called'))) as unknown as typeof fetch,
  });
  eq(result.ok, false);
  eq(result.error, 'no repo linked', 'an unlinked tenant never reaches GitHub:');

  // Re-linking works and clears the unlinked state.
  const relinked = await saveGitHubSyncConfig(db, TEN, 'acme/board', 'ghp_new', 'human:owner', NOW);
  eq(relinked.status, 'linked');
  eq(relinked.repo, 'acme/board');
  await db.close();
});

T('the unlink route is CSRF-checked, engineer-gated, and audited', async () => {
  const ctx = await seeded();
  const { db, ledger, coord, comp, owner } = ctx;
  // The board is department-gated, not role-gated: put the owner on engineering
  // so a 403 later in this test can only mean the token or the link.
  await setUserTeam(db, TEN, owner.id, 'engineering', { userId: owner.id, role: owner.role }, NOW);
  await saveGitHubSyncConfig(db, TEN, 'acme/board', null, 'human:owner', NOW);
  const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const session = await engineerSession(server.port, OWNER.email, OWNER.password)();
    const noToken = await fetch(`${base_}/console/issues/github/unlink`, {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'csrf=',
      redirect: 'manual',
    });
    eq(noToken.status, 403, 'an unlink without the token is refused:');
    eq((await getGitHubSyncConfig(db, TEN))!.status, 'linked', 'and the link survives the refusal:');

    const unlinked = await fetch(`${base_}/console/issues/github/unlink`, {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${session.csrf}`,
      redirect: 'manual',
    });
    const unlinkedBody = await unlinked.text();
    eq(unlinked.status, 200, `unlink refused: ${unlinkedBody.slice(0, 200)}`);
    eq((JSON.parse(unlinkedBody) as { ok: boolean }).ok, true);
    eq((await getGitHubSyncConfig(db, TEN))!.status, 'unlinked');
    const audited = (await db
      .prepare("SELECT detail FROM audit_log WHERE tenant = ? AND action = 'github.unlink' ORDER BY seq DESC LIMIT 1")
      .get(TEN)) as { detail: string | null } | undefined;
    eq(audited !== undefined, true, 'the unlink is audited:');
    eq(audited!.detail, 'unlinked acme/board', 'and the audit line names what was disconnected:');

    const config = (await (
      await fetch(`${base_}/console/issues/github/config`, { headers: { cookie: session.cookie } })
    ).json()) as { config: { repo: string; status: string } | null };
    eq(config.config?.status, 'unlinked');
    eq(config.config?.repo, '');
  } finally {
    await server.close();
    await db.close();
  }
});
