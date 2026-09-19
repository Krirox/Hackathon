import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AsyncDb, Row } from './db.ts';
import { ERASURE_DONE_ACTION, erasedTenantOf } from './erasure.ts';
import { applyMigrations, rollbackMigration, type Migration } from './migrations.ts';

/**
 * Identity and tenancy core (TODO V2.1.1) — the layer that makes the
 * console's "no anonymous approvals" rule enforceable: a named human is an
 * authenticated session, not a string in a request body.
 *
 * House rules applied here:
 *  - migrations go through the named journal with tested down SQL;
 *  - one session cookie format, HttpOnly + SameSite=Lax, never logged;
 *  - passwords are salted scrypt (node:crypto — no new dependency);
 *  - every security-relevant event (signup, login, lockout, logout,
 *    reset) lands in `audit_log`, which lives outside the Ledger;
 *  - no code path above this file may look up a user by email without
 *    scoping to a tenant, and sessions only ever reveal their own tenant.
 */

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[auth:${code}] ${message}`);
  }
}

export type Role = 'owner' | 'admin' | 'member';

/**
 * Department membership (the "which team is this person on" axis, orthogonal
 * to Role). The Issues board is an ENGINEERING-team surface: gatekeeping reads
 * `team === 'engineering'`, never a role, so a marketing admin and an
 * engineering admin are distinguished where roles alone cannot. Owners are
 * deliberately never special-cased here — org charts name people's team.
 */
export const TEAMS = ['engineering', 'marketing', 'finance', 'legal', 'support', 'operations'] as const;

export type Team = (typeof TEAMS)[number] | 'unassigned';

export const DEFAULT_TEAM: Team = 'unassigned';

/** Normalize stored/unknown team values; 'unassigned' is not in TEAMS on purpose — new members start without a department. */
export function parseTeam(v: unknown): Team {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  if (s === 'unassigned' || s === '') return DEFAULT_TEAM;
  return (TEAMS as readonly string[]).includes(s) ? (s as Team) : DEFAULT_TEAM;
}

/** True when this account may open the engineers-only Issues board. */
export function isEngineer(user: Pick<User, 'team'>): boolean {
  return parseTeam(user.team) === 'engineering';
}

export interface User {
  id: string;
  tenant: string;
  email: string;
  name: string;
  role: Role;
  /** Department: who the person is, not what they may approve (that's role). */
  team: Team;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export type MembershipStatus = 'active' | 'disabled' | 'pending_activation';

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface Invitation {
  id: string;
  tenant: string;
  email: string;
  name: string;
  role: Role;
  team: Team;
  invitedBy: string;
  status: InvitationStatus;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedUserId: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface OutstandingWork {
  claimCount: number;
  requestCount: number;
}

export interface Session {
  id: string;
  userId: string;
  tenant: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

export interface Tenant {
  slug: string;
  name: string;
  createdAt: string;
}

// ------------------------------------------------------------------ schema ----

/**
 * The down statements target the one shared dialect core (CREATE TABLE IF NOT
 * EXISTS / DROP TABLE IF EXISTS exist on both engines, so one SQL text serves
 * both, matching how SCHEMA/PG_SCHEMA are derived in `db.ts`).
 */
export const AUTH_MIGRATIONS: Migration[] = [
  {
    name: '0001_auth_core',
    up: `
CREATE TABLE IF NOT EXISTS tenants (
  slug      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL REFERENCES tenants(slug),
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  UNIQUE (tenant, email)
);
CREATE INDEX IF NOT EXISTS ix_users_email ON users(email);
CREATE TABLE IF NOT EXISTS login_attempts (
  key  TEXT NOT NULL,
  day  TEXT NOT NULL,
  fails INTEGER NOT NULL,
  locked_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key, day)
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  tenant      TEXT NOT NULL,
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_password_resets_user ON password_resets(user_id);
`,
    down: `
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS login_attempts;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tenants;
`,
  },
  {
    name: '0002_invitations',
    up: `
CREATE TABLE IF NOT EXISTS invitations (
  id               TEXT PRIMARY KEY,
  tenant           TEXT NOT NULL REFERENCES tenants(slug),
  email            TEXT NOT NULL,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL,
  token_hash       TEXT NOT NULL,
  invited_by       TEXT NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL DEFAULT 'pending',
  expires_at       TEXT NOT NULL,
  accepted_at      TEXT,
  accepted_user_id TEXT REFERENCES users(id),
  revoked_at       TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_invitations_tenant ON invitations(tenant);
CREATE INDEX IF NOT EXISTS ix_invitations_token ON invitations(token_hash);
CREATE INDEX IF NOT EXISTS ix_invitations_tenant_email ON invitations(tenant, email);
`,
    down: `DROP TABLE IF EXISTS invitations;`,
  },
  {
    name: '0003_mfa_email_verification',
    up: `
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
CREATE TABLE IF NOT EXISTS mfa_factors (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('totp', 'webauthn')),
  secret        TEXT,
  credential_id TEXT,
  public_key    TEXT,
  verified_at   TEXT NOT NULL,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mfa_factors_user ON mfa_factors(user_id);
`,
    down: `
ALTER TABLE users DROP COLUMN email_verified_at;
DROP TABLE IF EXISTS mfa_factors;
`,
  },
  {
    name: '0005_user_teams',
    up: `
ALTER TABLE users ADD COLUMN team TEXT NOT NULL DEFAULT 'unassigned';
ALTER TABLE invitations ADD COLUMN team TEXT NOT NULL DEFAULT 'unassigned';
CREATE INDEX IF NOT EXISTS ix_users_team ON users(tenant, team);
`,
    down: `
DROP INDEX IF EXISTS ix_users_team;
ALTER TABLE users DROP COLUMN team;
ALTER TABLE invitations DROP COLUMN team;
`,
  },
  {
    name: '0004_email_verification_mfa_recovery',
    up: `
CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_email_verifications_user ON email_verifications(user_id);
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  code_hash  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mfa_recovery_codes_user ON mfa_recovery_codes(user_id);
`,
    down: `
DROP TABLE IF EXISTS mfa_recovery_codes;
DROP TABLE IF EXISTS email_verifications;
`,
  },
];

/** Idle session lifetime. Rolling: each successful touch re-arms the full window. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Absolute cap from session creation — idle extension cannot exceed this. */
export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Pending invitation lifetime before expiry. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Failed logins before the key locks. */
export const LOCKOUT_THRESHOLD = 5;
/** How long a locked key stays locked, and when attempt counters reset. */
export const LOCKOUT_MS = 15 * 60 * 1000;
/**
 * Per-account spray cap: failed logins for one email across ALL source IPs
 * before the account locks. Higher than LOCKOUT_THRESHOLD so a single-IP
 * burst still trips first, but a distributed spray cannot exceed this many
 * guesses per window. Same window as LOCKOUT_MS.
 */
export const ACCOUNT_LOCKOUT_THRESHOLD = 20;
/** Failed second-factor attempts per account before the MFA step locks. */
export const MFA_LOCKOUT_THRESHOLD = 10;
/** Minimum accepted password length — length beats composition rules. */
export const MIN_PASSWORD_LENGTH = 12;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function installAuthSchema(db: AsyncDb, now?: string): Promise<string[]> {
  return applyMigrations(db, AUTH_MIGRATIONS, now);
}

export async function uninstallAuthSchema(db: AsyncDb, names?: string[]): Promise<void> {
  const todo = (names ?? [...AUTH_MIGRATIONS].reverse().map((m) => m.name)) as string[];
  for (const name of todo) await rollbackMigration(db, AUTH_MIGRATIONS, name);
}

// ----------------------------------------------------------------- helpers ----

/**
 * Pinned scrypt cost: explicit so a Node default change can never silently
 * weaken stored passwords. maxmem is pinned alongside N/r/p because Node
 * refuses the hash when the parameters exceed its default 32MB ceiling.
 */
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export function hashPassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new AuthError('WEAK_PASSWORD', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expected] = parts as [string, string, string];
  const actual = scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const newId = (p: string): string => `${p}_${randomBytes(16).toString('hex')}`;
/** Opaque session token (what the cookie carries) and reset token: 256 bits. */
const newToken = (): string => randomBytes(32).toString('base64url');
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function roleOf(v: unknown): Role {
  if (v === 'owner' || v === 'admin' || v === 'member') return v;
  throw new AuthError('BAD_ROLE', `unknown role ${String(v)}`);
}

export function parseRole(v: unknown): Role {
  return roleOf(v);
}

function rowToUser(r: Row): User {
  return {
    id: String(r.id),
    tenant: String(r.tenant),
    email: String(r.email),
    name: String(r.name),
    role: roleOf(r.role),
    team: parseTeam(r.team),
    mustChangePassword: Number(r.must_change_password) === 1,
    disabled: Number(r.disabled) === 1,
    createdAt: String(r.created_at),
    lastLoginAt: r.last_login_at === null || r.last_login_at === undefined ? null : String(r.last_login_at),
  };
}

function rowToSession(r: Row): Session {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    tenant: String(r.tenant),
    csrfToken: String(r.csrf_token),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
  };
}

async function audit(
  db: AsyncDb,
  tenant: string,
  actor: string,
  action: string,
  target: string,
  at: string,
  detail?: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tenant, actor, action, target, detail ?? null, at);
}

const dayOf = (at: string): string => at.slice(0, 10);

// ------------------------------------------------------------------ tenants ----

export async function signupTenant(
  db: AsyncDb,
  input: { slug: string; name: string; email: string; password: string; ownerName: string },
  now: string,
): Promise<{ tenant: Tenant; owner: User }> {
  const slug = input.slug.trim().toLowerCase();
  const email = input.email.trim().toLowerCase();
  if (!SLUG_RE.test(slug))
    throw new AuthError('BAD_SLUG', 'tenant slug must be 2-63 chars of a-z, 0-9 and hyphens, starting alphanumeric');
  if (!input.name.trim()) throw new AuthError('BAD_NAME', 'tenant name is required');
  if (!EMAIL_RE.test(email)) throw new AuthError('BAD_EMAIL', 'a valid email is required');
  if (!input.ownerName.trim()) throw new AuthError('BAD_NAME', 'owner name is required');
  if (input.password.length < MIN_PASSWORD_LENGTH)
    throw new AuthError('WEAK_PASSWORD', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  return db.transaction(async () => {
    const exists = await db.prepare('SELECT slug FROM tenants WHERE slug = ?').get(slug);
    if (exists) throw new AuthError('TENANT_EXISTS', `tenant "${slug}" already exists`);
    const erased = (await db
      .prepare('SELECT 1 AS n FROM audit_log WHERE tenant = ? AND action = ? LIMIT 1')
      .get(erasedTenantOf(slug), ERASURE_DONE_ACTION)) as { n: number } | undefined;
    if (erased) throw new AuthError('SLUG_RESERVED', `tenant slug "${slug}" was erased and cannot be reused`);
    const tenant: Tenant = { slug, name: input.name.trim(), createdAt: now };
    await db
      .prepare('INSERT INTO tenants (slug, name, created_at) VALUES (?, ?, ?)')
      .run(tenant.slug, tenant.name, now);
    const owner = await insertUser(db, tenant.slug, {
      email,
      name: input.ownerName.trim(),
      role: 'owner',
      password: input.password,
      mustChangePassword: false,
      now,
    });
    await audit(db, slug, owner.id, 'auth.tenant_created', `tenant:${slug}`, now);
    await audit(db, slug, owner.id, 'auth.user_created', `user:${owner.id}`, now, 'role=owner');
    return { tenant, owner };
  });
}

export async function getTenant(db: AsyncDb, slug: string): Promise<Tenant | undefined> {
  const r = await db.prepare('SELECT slug, name, created_at FROM tenants WHERE slug = ?').get(slug);
  if (!r) return undefined;
  return { slug: String(r.slug), name: String(r.name), createdAt: String(r.created_at) };
}

/**
 * FLOW-008: distinguish console access posture without reading implementation
 * code. `ready` means a live owner can sign in; `unclaimed` means the bound
 * tenant may still be claimed through /signup; `recovery` means accounts exist
 * but no usable owner remains (disabled owner, offboarding gap, etc.).
 */
export type TenantAccessState = 'ready' | 'unclaimed' | 'recovery';

export async function tenantAccessState(db: AsyncDb, slug: string): Promise<TenantAccessState> {
  const owners = (await db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE tenant = ? AND role = 'owner' AND disabled = 0")
    .get(slug)) as { n: number };
  if (Number(owners.n) > 0) return 'ready';
  const any = (await db.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant = ?').get(slug)) as { n: number };
  if (Number(any.n) > 0) return 'recovery';
  return 'unclaimed';
}

/**
 * Claim an ownerless tenant that already exists (account-less tenant). Refuses
 * once any member row exists so established organizations cannot be reopened
 * to anonymous claims.
 */
export async function claimTenantOwner(
  db: AsyncDb,
  input: { slug: string; email: string; password: string; ownerName: string },
  now: string,
): Promise<{ tenant: Tenant; owner: User }> {
  const slug = input.slug.trim().toLowerCase();
  const email = input.email.trim().toLowerCase();
  if (!SLUG_RE.test(slug))
    throw new AuthError('BAD_SLUG', 'tenant slug must be 2-63 chars of a-z, 0-9 and hyphens, starting alphanumeric');
  if (!EMAIL_RE.test(email)) throw new AuthError('BAD_EMAIL', 'a valid email is required');
  if (!input.ownerName.trim()) throw new AuthError('BAD_NAME', 'owner name is required');
  if (input.password.length < MIN_PASSWORD_LENGTH)
    throw new AuthError('WEAK_PASSWORD', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  return db.transaction(async () => {
    const tenant = await getTenant(db, slug);
    if (!tenant) throw new AuthError('UNKNOWN_TENANT', `tenant "${slug}" does not exist`);
    const state = await tenantAccessState(db, slug);
    if (state === 'ready') throw new AuthError('TENANT_CLAIMED', `tenant "${slug}" already has an owner`);
    if (state === 'recovery')
      throw new AuthError(
        'RECOVERY_REQUIRED',
        `tenant "${slug}" has accounts but no usable owner — contact your operator`,
      );
    const owner = await insertUser(db, slug, {
      email,
      name: input.ownerName.trim(),
      role: 'owner',
      password: input.password,
      mustChangePassword: false,
      now,
    });
    await audit(db, slug, owner.id, 'auth.tenant_claimed', `tenant:${slug}`, now);
    await audit(db, slug, owner.id, 'auth.user_created', `user:${owner.id}`, now, 'role=owner');
    return { tenant, owner };
  });
}

// -------------------------------------------------------------------- users ----

async function insertUser(
  db: AsyncDb,
  tenant: string,
  input: {
    email: string;
    name: string;
    role: Role;
    team?: Team;
    password: string;
    mustChangePassword: boolean;
    now: string;
  },
): Promise<User> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new AuthError('BAD_EMAIL', 'a valid email is required');
  if (!input.name.trim()) throw new AuthError('BAD_NAME', 'user name is required');
  const hash = hashPassword(input.password);
  const user: User = {
    id: newId('usr'),
    tenant,
    email,
    name: input.name.trim(),
    role: input.role,
    team: input.team ?? DEFAULT_TEAM,
    mustChangePassword: input.mustChangePassword,
    disabled: false,
    createdAt: input.now,
    lastLoginAt: null,
  };
  await db
    .prepare(
      'INSERT INTO users (id, tenant, email, name, role, team, password_hash, must_change_password, disabled, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      user.id,
      tenant,
      user.email,
      user.name,
      user.role,
      user.team,
      hash,
      user.mustChangePassword ? 1 : 0,
      0,
      user.createdAt,
      null,
    );
  return user;
}

/**
 * Invite-only membership: users are created by an admin/owner of an existing
 * tenant; there is no self-serve join. The invited user's first password is
 * set here and flagged `mustChangePassword`.
 */
export async function inviteUser(
  db: AsyncDb,
  tenant: string,
  input: { email: string; name: string; role: Role; team?: Team; password: string },
  by: { userId: string; role: Role },
  now: string,
): Promise<User> {
  if (by.role !== 'owner' && by.role !== 'admin')
    throw new AuthError('FORBIDDEN', 'only an owner or admin can invite users');
  assertGrantRole(by.role, input.role);
  return db.transaction(async () => {
    await assertEmailAvailable(db, tenant, input.email, now);
    const user = await insertUser(db, tenant, {
      email: input.email,
      name: input.name,
      role: input.role,
      team: input.team,
      password: input.password,
      mustChangePassword: true,
      now,
    });
    await audit(db, tenant, by.userId, 'auth.user_created', `user:${user.id}`, now, `role=${user.role} invited`);
    return user;
  });
}

function rowToInvitation(r: Row): Invitation {
  return {
    id: String(r.id),
    tenant: String(r.tenant),
    email: String(r.email),
    name: String(r.name),
    role: roleOf(r.role),
    team: parseTeam(r.team),
    invitedBy: String(r.invited_by),
    status: String(r.status) as InvitationStatus,
    expiresAt: String(r.expires_at),
    acceptedAt: r.accepted_at === null || r.accepted_at === undefined ? null : String(r.accepted_at),
    acceptedUserId: r.accepted_user_id === null || r.accepted_user_id === undefined ? null : String(r.accepted_user_id),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : String(r.revoked_at),
    createdAt: String(r.created_at),
  };
}

/** Console-facing membership label for an existing user row. */
export function membershipStatus(user: User): MembershipStatus {
  if (user.disabled) return 'disabled';
  if (user.mustChangePassword && !user.lastLoginAt) return 'pending_activation';
  return 'active';
}

async function countActiveOwners(db: AsyncDb, tenant: string): Promise<number> {
  const row = (await db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE tenant = ? AND role = 'owner' AND disabled = 0")
    .get(tenant)) as { n: number };
  return Number(row.n);
}

async function assertEmailAvailable(db: AsyncDb, tenant: string, email: string, now: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const existing = (await db
    .prepare('SELECT id, disabled FROM users WHERE tenant = ? AND email = ?')
    .get(tenant, normalized)) as { id: string; disabled: number } | undefined;
  if (existing) {
    if (Number(existing.disabled) === 1)
      throw new AuthError('DISABLED_USER_EXISTS', `${normalized} is disabled — reactivate the account instead`);
    throw new AuthError('DUPLICATE_USER', `${normalized} already has an active account`);
  }
  await sweepInvitations(db, tenant, now);
  const pending = (await db
    .prepare("SELECT id FROM invitations WHERE tenant = ? AND email = ? AND status = 'pending'")
    .get(tenant, normalized)) as { id: string } | undefined;
  if (pending)
    throw new AuthError('INVITATION_PENDING', `${normalized} already has a pending invitation — resend or revoke it`);
}

/** Mark expired pending invitations so the team page stays truthful. */
export async function sweepInvitations(db: AsyncDb, tenant: string, now: string): Promise<number> {
  const out = await db
    .prepare("UPDATE invitations SET status = 'expired' WHERE tenant = ? AND status = 'pending' AND expires_at <= ?")
    .run(tenant, now);
  return out.changes;
}

/**
 * FLOW-009: create a pending invitation. The recipient accepts out of band and
 * chooses their own password; no user row exists until acceptance.
 */
export async function createInvitation(
  db: AsyncDb,
  tenant: string,
  input: { email: string; name: string; role: Role; team?: Team },
  by: { userId: string; role: Role },
  now: string,
): Promise<{ invitation: Invitation; token: string }> {
  if (by.role !== 'owner' && by.role !== 'admin')
    throw new AuthError('FORBIDDEN', 'only an owner or admin can create accounts');
  assertGrantRole(by.role, input.role);
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new AuthError('BAD_EMAIL', 'a valid email is required');
  if (!input.name.trim()) throw new AuthError('BAD_NAME', 'user name is required');
  return db.transaction(async () => {
    await sweepInvitations(db, tenant, now);
    const expired = (await db
      .prepare("SELECT id FROM invitations WHERE tenant = ? AND email = ? AND status = 'expired'")
      .all(tenant, email)) as { id: string }[];
    for (const row of expired)
      await db.prepare("UPDATE invitations SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, row.id);
    await assertEmailAvailable(db, tenant, email, now);
    const token = newToken();
    const invitation: Invitation = {
      id: newId('inv'),
      tenant,
      email,
      name: input.name.trim(),
      role: input.role,
      team: input.team ?? DEFAULT_TEAM,
      invitedBy: by.userId,
      status: 'pending',
      expiresAt: new Date(Date.parse(now) + INVITATION_TTL_MS).toISOString(),
      acceptedAt: null,
      acceptedUserId: null,
      revokedAt: null,
      createdAt: now,
    };
    await db
      .prepare(
        `INSERT INTO invitations
         (id, tenant, email, name, role, team, token_hash, invited_by, status, expires_at, accepted_at, accepted_user_id, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      )
      .run(
        invitation.id,
        invitation.tenant,
        invitation.email,
        invitation.name,
        invitation.role,
        invitation.team,
        sha256(token),
        invitation.invitedBy,
        invitation.status,
        invitation.expiresAt,
        invitation.createdAt,
      );
    await audit(
      db,
      tenant,
      by.userId,
      'auth.invitation_created',
      `invitation:${invitation.id}`,
      now,
      `role=${invitation.role} team=${invitation.team}`,
    );
    return { invitation, token };
  });
}

export async function listInvitations(db: AsyncDb, tenant: string, now: string): Promise<Invitation[]> {
  await sweepInvitations(db, tenant, now);
  const rows = await db.prepare('SELECT * FROM invitations WHERE tenant = ? ORDER BY created_at DESC').all(tenant);
  return rows.map(rowToInvitation);
}

export async function getInvitation(
  db: AsyncDb,
  tenant: string,
  invitationId: string,
): Promise<Invitation | undefined> {
  const r = await db.prepare('SELECT * FROM invitations WHERE tenant = ? AND id = ?').get(tenant, invitationId);
  return r ? rowToInvitation(r) : undefined;
}

export async function peekInvitationByToken(db: AsyncDb, token: string, now: string): Promise<Invitation | undefined> {
  const r = (await db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(sha256(token))) as Row | undefined;
  if (!r) return undefined;
  const inv = rowToInvitation(r);
  if (inv.status === 'pending' && inv.expiresAt <= now) {
    await db.prepare("UPDATE invitations SET status = 'expired' WHERE id = ?").run(inv.id);
    return { ...inv, status: 'expired' };
  }
  return inv;
}

export async function revokeInvitation(
  db: AsyncDb,
  tenant: string,
  invitationId: string,
  by: { userId: string; role: Role },
  now: string,
): Promise<Invitation> {
  if (by.role !== 'owner' && by.role !== 'admin')
    throw new AuthError('FORBIDDEN', 'only an owner or admin can revoke invitations');
  const inv = await getInvitation(db, tenant, invitationId);
  if (!inv) throw new AuthError('UNKNOWN_INVITATION', `no invitation ${invitationId}`);
  if (inv.status === 'accepted') throw new AuthError('INVITATION_ACCEPTED', 'accepted invitations cannot be revoked');
  if (inv.status === 'revoked') return inv;
  await db.prepare("UPDATE invitations SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, invitationId);
  await audit(db, tenant, by.userId, 'auth.invitation_revoked', `invitation:${invitationId}`, now);
  return { ...inv, status: 'revoked', revokedAt: now };
}

export async function resendInvitation(
  db: AsyncDb,
  tenant: string,
  invitationId: string,
  by: { userId: string; role: Role },
  now: string,
): Promise<{ invitation: Invitation; token: string }> {
  if (by.role !== 'owner' && by.role !== 'admin')
    throw new AuthError('FORBIDDEN', 'only an owner or admin can resend invitations');
  const inv = await getInvitation(db, tenant, invitationId);
  if (!inv) throw new AuthError('UNKNOWN_INVITATION', `no invitation ${invitationId}`);
  if (inv.status === 'accepted') throw new AuthError('INVITATION_ACCEPTED', 'accepted invitations cannot be resent');
  if (inv.status === 'revoked')
    throw new AuthError('INVITATION_REVOKED', 'revoked invitations cannot be resent — create a new account');
  const token = newToken();
  const expiresAt = new Date(Date.parse(now) + INVITATION_TTL_MS).toISOString();
  await db
    .prepare(
      "UPDATE invitations SET token_hash = ?, status = 'pending', expires_at = ?, revoked_at = NULL WHERE id = ?",
    )
    .run(sha256(token), expiresAt, invitationId);
  await audit(db, tenant, by.userId, 'auth.invitation_resent', `invitation:${invitationId}`, now);
  const next = (await getInvitation(db, tenant, invitationId))!;
  return { invitation: next, token };
}

/** Accept a pending invitation and create the member's account with their chosen password. */
export async function acceptInvitation(
  db: AsyncDb,
  token: string,
  password: string,
  now: string,
): Promise<{ user: User; invitation: Invitation }> {
  const inv = await peekInvitationByToken(db, token, now);
  if (!inv) throw new AuthError('BAD_INVITATION', 'unknown or invalid invitation');
  if (inv.status === 'revoked') throw new AuthError('BAD_INVITATION', 'this invitation was revoked');
  if (inv.status === 'accepted') throw new AuthError('BAD_INVITATION', 'this invitation was already accepted');
  if (inv.status === 'expired')
    throw new AuthError('BAD_INVITATION', 'this invitation expired — ask your admin for a new one');
  return db.transaction(async () => {
    const existing = await db.prepare('SELECT id FROM users WHERE tenant = ? AND email = ?').get(inv.tenant, inv.email);
    if (existing) throw new AuthError('DUPLICATE_USER', `${inv.email} already has an account`);
    const user = await insertUser(db, inv.tenant, {
      email: inv.email,
      name: inv.name,
      role: inv.role,
      team: inv.team,
      password,
      mustChangePassword: false,
      now,
    });
    await db
      .prepare(
        "UPDATE invitations SET status = 'accepted', accepted_at = ?, accepted_user_id = ? WHERE id = ? AND status = 'pending'",
      )
      .run(now, user.id, inv.id);
    await audit(db, inv.tenant, user.id, 'auth.invitation_accepted', `invitation:${inv.id}`, now);
    await audit(db, inv.tenant, user.id, 'auth.user_created', `user:${user.id}`, now, `role=${user.role} accepted`);
    return { user, invitation: { ...inv, status: 'accepted', acceptedAt: now, acceptedUserId: user.id } };
  });
}

export async function listUsers(db: AsyncDb, tenant: string): Promise<User[]> {
  const rows = await db.prepare('SELECT * FROM users WHERE tenant = ? ORDER BY created_at').all(tenant);
  return rows.map(rowToUser);
}

export async function getUser(db: AsyncDb, tenant: string, userId: string): Promise<User | undefined> {
  const r = await db.prepare('SELECT * FROM users WHERE tenant = ? AND id = ?').get(tenant, userId);
  return r ? rowToUser(r) : undefined;
}

/** Force a password change on next login (compromise response). */
export async function flagMustChangePassword(db: AsyncDb, tenant: string, userId: string, now: string): Promise<void> {
  const out = await db
    .prepare('UPDATE users SET must_change_password = 1 WHERE tenant = ? AND id = ?')
    .run(tenant, userId);
  if (out.changes === 0) throw new AuthError('UNKNOWN_USER', `no user ${userId} in tenant ${tenant}`);
  await audit(db, tenant, 'system', 'auth.must_change_flagged', `user:${userId}`, now);
}

const ACTIVE_CLAIM_STATUSES = "('RETIRED','SUPERSEDED','STALE')";
const OPEN_REQUEST_STATES = "('PROPOSED','QUEUED','ADMITTED','DEFERRED','IN_FLIGHT','ACCEPTED')";

/** Claims and open requests accountable to this human (by email, name, or id). */
export async function countOutstandingWork(db: AsyncDb, tenant: string, user: User): Promise<OutstandingWork> {
  const owners = [user.email, user.name, user.id];
  const ph = owners.map(() => '?').join(', ');
  const claims = (await db
    .prepare(
      `SELECT COUNT(*) AS n FROM claims WHERE tenant = ? AND status NOT IN ${ACTIVE_CLAIM_STATUSES} AND owner IN (${ph})`,
    )
    .get(tenant, ...owners)) as { n: number };
  const requests = (await db
    .prepare(
      `SELECT COUNT(*) AS n FROM requests WHERE tenant = ? AND state IN ${OPEN_REQUEST_STATES} AND on_behalf_of IN (${ph})`,
    )
    .get(tenant, ...owners)) as { n: number };
  return { claimCount: Number(claims.n), requestCount: Number(requests.n) };
}

async function reassignAccountableWork(
  db: AsyncDb,
  tenant: string,
  from: User,
  to: User,
  now: string,
): Promise<{ claims: number; requests: number }> {
  const fromKeys = [from.email, from.name, from.id];
  const ph = fromKeys.map(() => '?').join(', ');
  const claims = await db
    .prepare(
      `UPDATE claims SET owner = ? WHERE tenant = ? AND status NOT IN ${ACTIVE_CLAIM_STATUSES} AND owner IN (${ph})`,
    )
    .run(to.email, tenant, ...fromKeys);
  const requests = await db
    .prepare(
      `UPDATE requests SET on_behalf_of = ? WHERE tenant = ? AND state IN ${OPEN_REQUEST_STATES} AND on_behalf_of IN (${ph})`,
    )
    .run(to.email, tenant, ...fromKeys);
  if (claims.changes + requests.changes > 0)
    await audit(
      db,
      tenant,
      'system',
      'auth.work_reassigned',
      `user:${from.id}`,
      now,
      `to=${to.email} claims=${claims.changes} requests=${requests.changes}`,
    );
  return { claims: claims.changes, requests: requests.changes };
}

/**
 * FLOW-009: disable a member, revoke every live session, and optionally hand
 * outstanding claims/requests to another active member.
 */
export async function disableUser(
  db: AsyncDb,
  tenant: string,
  userId: string,
  now: string,
  opts: { handoffToUserId?: string; actorId?: string } = {},
): Promise<{ work: OutstandingWork; reassigned: { claims: number; requests: number } }> {
  const target = await getUser(db, tenant, userId);
  if (!target) throw new AuthError('UNKNOWN_USER', `no user ${userId} in tenant ${tenant}`);
  if (target.disabled) throw new AuthError('ALREADY_DISABLED', `${target.email} is already disabled`);
  if (target.role === 'owner') {
    const owners = await countActiveOwners(db, tenant);
    if (owners <= 1) throw new AuthError('LAST_OWNER', 'transfer ownership before disabling the last owner');
  }
  const work = await countOutstandingWork(db, tenant, target);
  let reassigned = { claims: 0, requests: 0 };
  if (work.claimCount + work.requestCount > 0) {
    if (!opts.handoffToUserId)
      throw new AuthError(
        'HANDOFF_REQUIRED',
        `${target.email} owns ${work.claimCount} claim(s) and ${work.requestCount} open request(s) — choose a handoff recipient`,
      );
    const handoff = await getUser(db, tenant, opts.handoffToUserId);
    if (!handoff || handoff.disabled) throw new AuthError('BAD_HANDOFF', 'handoff recipient must be an active member');
    if (handoff.id === target.id) throw new AuthError('BAD_HANDOFF', 'cannot hand work off to the same person');
    reassigned = await reassignAccountableWork(db, tenant, target, handoff, now);
  }
  const out = await db.prepare('UPDATE users SET disabled = 1 WHERE tenant = ? AND id = ?').run(tenant, userId);
  if (out.changes === 0) throw new AuthError('UNKNOWN_USER', `no user ${userId} in tenant ${tenant}`);
  await db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND tenant = ? AND revoked_at IS NULL').run(now, userId, tenant);
  await audit(
    db,
    tenant,
    opts.actorId ?? 'system',
    'auth.user_disabled',
    `user:${userId}`,
    now,
    work.claimCount + work.requestCount > 0 ? `handoff=${opts.handoffToUserId}` : undefined,
  );
  return { work, reassigned };
}

/** FLOW-009: restore a disabled account without reviving old sessions. */
export async function reactivateUser(
  db: AsyncDb,
  tenant: string,
  userId: string,
  by: { userId: string; role: Role },
  now: string,
): Promise<User> {
  if (by.role !== 'owner' && by.role !== 'admin')
    throw new AuthError('FORBIDDEN', 'only an owner or admin can reactivate users');
  const user = await getUser(db, tenant, userId);
  if (!user) throw new AuthError('UNKNOWN_USER', `no user ${userId} in tenant ${tenant}`);
  if (!user.disabled) throw new AuthError('ALREADY_ACTIVE', `${user.email} is already active`);
  await db.prepare('UPDATE users SET disabled = 0 WHERE tenant = ? AND id = ?').run(tenant, userId);
  await audit(db, tenant, by.userId, 'auth.user_reactivated', `user:${userId}`, now);
  const next = (await getUser(db, tenant, userId))!;
  return next;
}

/** FLOW-009: authorized role change with grant-matrix enforcement. */
export async function changeUserRole(
  db: AsyncDb,
  tenant: string,
  userId: string,
  role: Role,
  by: { userId: string; role: Role },
  now: string,
): Promise<User> {
  if (by.role !== 'owner' && by.role !== 'admin')
    throw new AuthError('FORBIDDEN', 'only an owner or admin can change roles');
  assertGrantRole(by.role, role);
  const target = await getUser(db, tenant, userId);
  if (!target) throw new AuthError('UNKNOWN_USER', `no user ${userId} in tenant ${tenant}`);
  if (target.disabled) throw new AuthError('DISABLED_USER', 'reactivate the account before changing its role');
  if (target.role === 'owner' && by.role !== 'owner')
    throw new AuthError('FORBIDDEN', 'only the owner may change an owner role');
  if (target.role === 'owner' && role !== 'owner') {
    const owners = await countActiveOwners(db, tenant);
    if (owners <= 1) throw new AuthError('LAST_OWNER', 'transfer ownership before demoting the last owner');
  }
  if (role === 'owner' && by.role !== 'owner')
    throw new AuthError('FORBIDDEN', 'only the owner may grant the owner role');
  await db.prepare('UPDATE users SET role = ? WHERE tenant = ? AND id = ?').run(role, tenant, userId);
  await audit(db, tenant, by.userId, 'auth.role_changed', `user:${userId}`, now, `role=${role}`);
  const next = (await getUser(db, tenant, userId))!;
  return next;
}

/**
 * Department change (FLOW-009 adjacent): an admin/owner reassigns which team
 * a member belongs to. Grant matrix mirrors changeUserRole — admins may place
 * members anywhere; only the owner may touch an owner. No last-owner rule is
 * needed: team is orthogonal to role and never gates sign-in.
 */
export async function setUserTeam(
  db: AsyncDb,
  tenant: string,
  userId: string,
  team: Team,
  by: { userId: string; role: Role },
  now: string,
): Promise<User> {
  if (by.role !== 'owner' && by.role !== 'admin')
    throw new AuthError('FORBIDDEN', 'only an owner or admin can change team membership');
  const target = await getUser(db, tenant, userId);
  if (!target) throw new AuthError('UNKNOWN_USER', `no user ${userId} in tenant ${tenant}`);
  if (target.disabled) throw new AuthError('DISABLED_USER', 'reactivate the account before changing its team');
  if (target.role === 'owner' && by.role !== 'owner')
    throw new AuthError('FORBIDDEN', 'only the owner may change an owner team');
  const normalized = parseTeam(team);
  await db.prepare('UPDATE users SET team = ? WHERE tenant = ? AND id = ?').run(normalized, tenant, userId);
  await audit(db, tenant, by.userId, 'auth.team_changed', `user:${userId}`, now, `team=${normalized}`);
  const next = (await getUser(db, tenant, userId))!;
  return next;
}

/** FLOW-009: succession — current owner becomes admin; target becomes owner. */
export async function transferOwnership(
  db: AsyncDb,
  tenant: string,
  toUserId: string,
  by: { userId: string; role: Role },
  now: string,
): Promise<{ from: User; to: User }> {
  if (by.role !== 'owner') throw new AuthError('FORBIDDEN', 'only the owner may transfer ownership');
  const to = await getUser(db, tenant, toUserId);
  if (!to) throw new AuthError('UNKNOWN_USER', `no user ${toUserId} in tenant ${tenant}`);
  if (to.disabled) throw new AuthError('DISABLED_USER', 'hand ownership to an active member');
  if (to.id === by.userId) throw new AuthError('BAD_HANDOFF', 'you are already the owner');
  return db.transaction(async () => {
    await db.prepare("UPDATE users SET role = 'admin' WHERE tenant = ? AND id = ?").run(tenant, by.userId);
    await db.prepare("UPDATE users SET role = 'owner' WHERE tenant = ? AND id = ?").run(tenant, toUserId);
    await audit(db, tenant, by.userId, 'auth.ownership_transferred', `user:${toUserId}`, now);
    const from = (await getUser(db, tenant, by.userId))!;
    const next = (await getUser(db, tenant, toUserId))!;
    return { from, to: next };
  });
}

export type MembershipKind = 'invited' | 'active' | 'disabled';

export interface MembershipRow {
  kind: MembershipKind;
  email: string;
  name: string;
  role: Role;
  detail: string;
}

export function membershipRoster(users: User[], invitations: Invitation[], now: string): MembershipRow[] {
  const rows: MembershipRow[] = [];
  for (const inv of invitations) {
    if (inv.status === 'accepted' || inv.status === 'revoked') continue;
    let detail = `invited — acceptance link expires ${inv.expiresAt.slice(0, 10)}`;
    if (inv.status === 'expired' || (inv.status === 'pending' && inv.expiresAt <= now))
      detail = 'invitation expired — resend it or create a new account';
    rows.push({ kind: 'invited', email: inv.email, name: inv.name, role: inv.role, detail });
  }
  for (const u of users) {
    if (u.disabled) {
      rows.push({
        kind: 'disabled',
        email: u.email,
        name: u.name,
        role: u.role,
        detail: 'sign-in revoked — reactivate to restore access without restoring old sessions',
      });
    } else if (membershipStatus(u) === 'pending_activation') {
      rows.push({
        kind: 'active',
        email: u.email,
        name: u.name,
        role: u.role,
        detail: 'pending activation — a password change is required before continuing',
      });
    } else {
      rows.push({ kind: 'active', email: u.email, name: u.name, role: u.role, detail: 'active — can sign in' });
    }
  }
  return rows;
}

export interface CreateAccountNotice {
  heading: string;
  detail: string;
  button: string;
}

export function createAccountNotice(): CreateAccountNotice {
  return {
    heading: 'Create account',
    detail:
      'Creates a pending invitation. Deliver the acceptance link to this person out of band (email, chat, ticket). They choose their own password when accepting — you never set it here.',
    button: 'Create account',
  };
}

export type DuplicateCase =
  'pending_invitation' | 'expired_invitation' | 'revoked_invitation' | 'disabled_account' | 'active_account';

export interface InvitationNextStep {
  heading: string;
  detail: string;
  action: string;
}

export function invitationNextSteps(kind: DuplicateCase, email: string): InvitationNextStep {
  if (kind === 'pending_invitation')
    return {
      heading: `${email} already has a pending invitation`,
      detail: 'The acceptance link is still valid until expiry.',
      action: 'Resend the link, or revoke it and create a new account.',
    };
  if (kind === 'expired_invitation')
    return {
      heading: `${email} has an expired invitation`,
      detail: 'Expired links cannot be accepted.',
      action: 'Resend the invitation for a fresh acceptance link.',
    };
  if (kind === 'revoked_invitation')
    return {
      heading: `${email} has a revoked invitation`,
      detail: 'Revoked invitations cannot be resent.',
      action: 'Create a new account to invite them again.',
    };
  if (kind === 'disabled_account')
    return {
      heading: `${email} is disabled`,
      detail: 'Disabled accounts keep their history but cannot sign in.',
      action: 'Reactivate the account instead of inviting again.',
    };
  return {
    heading: `${email} already has an active account`,
    detail: 'This person can already sign in.',
    action: 'Change their role on the team page if their access is wrong.',
  };
}

export interface DisableConfirmation {
  person: { id: string; email: string; name: string; role: Role };
  liveSessions: number;
  sessionConsequence: string;
  accessConsequence: string;
  work: OutstandingWork;
  needsHandoff: boolean;
  lastUsableOwner: boolean;
}

export async function disableConfirmation(db: AsyncDb, tenant: string, userId: string): Promise<DisableConfirmation> {
  const target = await getUser(db, tenant, userId);
  if (!target) throw new AuthError('UNKNOWN_USER', `no user ${userId} in tenant ${tenant}`);
  const sessions = (await db
    .prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL')
    .get(userId)) as { n: number };
  const work = await countOutstandingWork(db, tenant, target);
  let lastUsableOwner = false;
  if (target.role === 'owner') lastUsableOwner = (await countActiveOwners(db, tenant)) <= 1;
  return {
    person: { id: target.id, email: target.email, name: target.name, role: target.role },
    liveSessions: Number(sessions.n),
    sessionConsequence: 'Disabling revokes every live session immediately.',
    accessConsequence:
      'They cannot sign in again until reactivated. Reactivation restores sign-in access but never restores revoked sessions.',
    work,
    needsHandoff: work.claimCount + work.requestCount > 0,
    lastUsableOwner,
  };
}

// ------------------------------------------------------------------- login ----

/**
 * Login under lockout. Keys the attempt counter by (tenant, ip, email) when an
 * IP is available — HTTP callers pass `ip` — else by (tenant, email).
 */
/**
 * FLOW-007 / FINAL-005: verify a password (with lockout + audit) WITHOUT
 * issuing a session. Used by `login()` and by the MFA-gated console login so
 * a correct password alone never mints a usable session when a second factor
 * is enrolled.
 */
export async function verifyLoginCredentials(
  db: AsyncDb,
  input: { tenant: string; email: string; password: string; ip?: string },
  now: string,
): Promise<User> {
  const email = input.email.trim().toLowerCase();
  const key = `${input.tenant}|${input.ip ?? '-'}|${email}`;
  // Second bucket without the IP: caps distributed spray at
  // ACCOUNT_LOCKOUT_THRESHOLD guesses per account per window. The `acct:`
  // prefix keeps it disjoint from per-source keys even for empty IPs.
  const accountKey = `acct:${input.tenant}|${email}`;
  const day = dayOf(now);
  const bump = async (bucketKey: string, threshold: number): Promise<string | null> => {
    const row = (await db
      .prepare('SELECT fails FROM login_attempts WHERE key = ? AND day = ?')
      .get(bucketKey, day)) as { fails: number } | undefined;
    const fails = (row?.fails ?? 0) + 1;
    const lockedUntil = fails >= threshold ? new Date(Date.parse(now) + LOCKOUT_MS).toISOString() : null;
    if (row)
      await db
        .prepare('UPDATE login_attempts SET fails = ?, locked_until = ?, updated_at = ? WHERE key = ? AND day = ?')
        .run(fails, lockedUntil, now, bucketKey, day);
    else
      await db
        .prepare('INSERT INTO login_attempts (key, day, fails, locked_until, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(bucketKey, day, fails, lockedUntil, now);
    return lockedUntil;
  };
  const lockedMessage = async (bucketKey: string): Promise<string | null> => {
    const attempt = (await db
      .prepare('SELECT fails, locked_until FROM login_attempts WHERE key = ? AND day = ?')
      .get(bucketKey, day)) as { fails: number; locked_until: string | null } | undefined;
    return attempt?.locked_until && attempt.locked_until > now ? attempt.locked_until : null;
  };
  const fail = async (detail: string, action = 'auth.login_failed'): Promise<never> => {
    await db.transaction(async () => {
      await bump(key, LOCKOUT_THRESHOLD);
      await bump(accountKey, ACCOUNT_LOCKOUT_THRESHOLD);
      await audit(db, input.tenant, email, action, 'login', now, detail);
    });
    throw new AuthError('BAD_CREDENTIALS', 'invalid credentials');
  };

  const lockedUntil = (await lockedMessage(key)) ?? (await lockedMessage(accountKey));
  if (lockedUntil)
    throw new AuthError('LOCKED', `too many failed attempts — locked until ${lockedUntil}`);

  const user = (await db.prepare('SELECT * FROM users WHERE tenant = ? AND email = ?').get(input.tenant, email)) as
    | Row
    | undefined;
  if (!user) await fail(`no user ${email}`);
  const u = rowToUser(user as Row);
  if (u.disabled) await fail(`disabled user ${email}`);
  if (!verifyPassword(input.password, String((user as Row).password_hash))) await fail(`bad password for ${email}`);

  await db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').run(accountKey);
  return u;
}

/**
 * Per-account second-factor throttle. The MFA step previously throttled by
 * IP only, so rotating source IPs gave unlimited TOTP guesses against an
 * account whose password was already known. Failures are counted per
 * (tenant, user); success clears the bucket.
 */
export async function checkMfaLockout(db: AsyncDb, tenant: string, userId: string, now: string): Promise<void> {
  const day = dayOf(now);
  const row = (await db
    .prepare('SELECT locked_until FROM login_attempts WHERE key = ? AND day = ?')
    .get(`mfa:${tenant}|${userId}`, day)) as { locked_until: string | null } | undefined;
  if (row?.locked_until && row.locked_until > now) {
    throw new AuthError('LOCKED', `too many failed attempts — locked until ${row.locked_until}`);
  }
}

export async function recordMfaFailure(db: AsyncDb, tenant: string, userId: string, now: string): Promise<void> {
  const day = dayOf(now);
  const bucketKey = `mfa:${tenant}|${userId}`;
  const row = (await db.prepare('SELECT fails FROM login_attempts WHERE key = ? AND day = ?').get(bucketKey, day)) as
    | { fails: number }
    | undefined;
  const fails = (row?.fails ?? 0) + 1;
  const lockedUntil = fails >= MFA_LOCKOUT_THRESHOLD ? new Date(Date.parse(now) + LOCKOUT_MS).toISOString() : null;
  if (row)
    await db
      .prepare('UPDATE login_attempts SET fails = ?, locked_until = ?, updated_at = ? WHERE key = ? AND day = ?')
      .run(fails, lockedUntil, now, bucketKey, day);
  else
    await db
      .prepare('INSERT INTO login_attempts (key, day, fails, locked_until, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(bucketKey, day, fails, lockedUntil, now);
  await audit(db, tenant, userId, 'auth.mfa_failed', 'login', now, `second factor rejected (${fails} recent failures)`);
}

export async function clearMfaFailures(db: AsyncDb, tenant: string, userId: string): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').run(`mfa:${tenant}|${userId}`);
}

/**
 * FLOW-007 / FINAL-005: start a session for an already-authenticated user.
 * Shared by `login()` (password only) and the MFA completion path (password +
 * second factor) so both audit and stamp `last_login_at` identically.
 */
export async function startSessionForUser(
  db: AsyncDb,
  tenant: string,
  userId: string,
  now: string,
): Promise<{ user: User; session: Session; token: string }> {
  const user = await getUser(db, tenant, userId);
  if (!user) throw new AuthError('UNKNOWN_USER', `no user ${userId} in tenant ${tenant}`);
  if (user.disabled) throw new AuthError('DISABLED_USER', 'account is disabled');
  const { session, token } = await createSession(db, user, now);
  await db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);
  // NOTE: must_change_password is deliberately NOT cleared here. The flag
  // means "your next action is a password change"; only changePassword()
  // retires it, so an invited/bootstrap user is gated until they comply.
  await audit(db, tenant, user.id, 'auth.login', 'login', now);
  return { user, session, token };
}

export async function login(
  db: AsyncDb,
  input: { tenant: string; email: string; password: string; ip?: string },
  now: string,
): Promise<{ user: User; session: Session; token: string }> {
  const u = await verifyLoginCredentials(db, input, now);
  return startSessionForUser(db, input.tenant, u.id, now);
}

/** Next rolling expiry, capped by the absolute lifetime from session creation. */
export function nextSessionExpiry(createdAt: string, now: string): string {
  const at = Date.parse(now);
  const idle = at + SESSION_TTL_MS;
  const absolute = Date.parse(createdAt) + SESSION_ABSOLUTE_TTL_MS;
  return new Date(Math.min(idle, absolute)).toISOString();
}

/** Remaining session lifetime in ms — idle rolling window capped by absolute max. */
export function sessionRemainingMs(session: Session, now: string): number {
  const at = Date.parse(now);
  const idleRemaining = Date.parse(session.expiresAt) - at;
  const absoluteRemaining = Date.parse(session.createdAt) + SESSION_ABSOLUTE_TTL_MS - at;
  return Math.min(idleRemaining, absoluteRemaining);
}

/** Verify a session token and roll its expiry forward; returns the live session. */
export async function verifySession(db: AsyncDb, token: string, now: string): Promise<Session> {
  if (!token) throw new AuthError('NO_SESSION', 'no session token presented');
  const s = (await db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(token)) as Row | undefined;
  if (!s) throw new AuthError('NO_SESSION', 'unknown session');
  const session = rowToSession(s);
  // Revocation is a timestamp; NULL/'' means live. A revoked session is
  // indistinguishable from a missing one to the caller — both are NO_SESSION.
  const revoked = (s as Row).revoked_at;
  if (revoked !== null && revoked !== undefined && revoked !== '') throw new AuthError('NO_SESSION', 'session revoked');
  const absoluteEnd = Date.parse(session.createdAt) + SESSION_ABSOLUTE_TTL_MS;
  if (Date.parse(now) >= absoluteEnd || session.expiresAt <= now) {
    await db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(session.id);
    throw new AuthError('EXPIRED_SESSION', `session expired at ${session.expiresAt}`);
  }
  const user = (await db.prepare('SELECT * FROM users WHERE id = ?').get(session.userId)) as Row | undefined;
  if (!user || Number((user as Row).disabled) === 1) {
    await db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(session.id);
    throw new AuthError('NO_SESSION', 'session user is gone or disabled');
  }
  const expiresAt = nextSessionExpiry(session.createdAt, now);
  await db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?').run(expiresAt, session.id);
  return { ...session, expiresAt };
}

/** Resolve the full user for a session — the identity every route must use. */
export async function sessionUser(db: AsyncDb, token: string, now: string): Promise<{ session: Session; user: User }> {
  const session = await verifySession(db, token, now);
  const user = (await db.prepare('SELECT * FROM users WHERE id = ?').get(session.userId)) as Row;
  const u = rowToUser(user);
  if (u.tenant !== session.tenant) throw new AuthError('TENANT_MISMATCH', 'session tenant does not match user');
  return { session, user: u };
}

export async function logout(db: AsyncDb, token: string, now: string): Promise<void> {
  const s = (await db.prepare('SELECT tenant, user_id, revoked_at FROM auth_sessions WHERE id = ?').get(token)) as
    Row | undefined;
  if (!s) return;
  if (s.revoked_at !== null && s.revoked_at !== undefined && s.revoked_at !== '') return;
  const out = await db
    .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now, token);
  if (out.changes > 0) await audit(db, String(s.tenant), String(s.user_id), 'auth.logout', 'login', now);
}

/** Revoke every session a user holds (password reset / compromise response). */
export async function revokeUserSessions(db: AsyncDb, tenant: string, userId: string, now: string): Promise<number> {
  const out = await db
    .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND tenant = ? AND revoked_at IS NULL')
    .run(now, userId, tenant);
  return out.changes;
}

/** Delete expired sessions and attempt counters; cheap, safe to call per request or on a timer. */
export async function sweepSessions(db: AsyncDb, now: string): Promise<void> {
  await db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
  await db.prepare('DELETE FROM login_attempts WHERE day < ?').run(dayOf(now));
}

// ----------------------------------------------------------------- password ----

export async function changePassword(
  db: AsyncDb,
  tenant: string,
  userId: string,
  newPassword: string,
  now: string,
): Promise<void> {
  const hash = hashPassword(newPassword);
  return db.transaction(async () => {
    const out = await db
      .prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE tenant = ? AND id = ?')
      .run(hash, tenant, userId);
    if (out.changes === 0) throw new AuthError('UNKNOWN_USER', `no user ${userId} in tenant ${tenant}`);
    await revokeUserSessions(db, tenant, userId, now);
    await audit(db, tenant, userId, 'auth.password_changed', `user:${userId}`, now);
  });
}

/** Password reset: issue a single-use token (hashed at rest), valid briefly. */
export async function requestPasswordReset(db: AsyncDb, tenant: string, email: string, now: string): Promise<string> {
  const token = await tryPasswordReset(db, tenant, email, now);
  if (!token) throw new AuthError('UNKNOWN_USER', `no user ${email} in tenant ${tenant}`);
  return token;
}

/**
 * FLOW-008: issue a reset token when the account exists; otherwise audit and
 * return null. Callers must present the same success copy either way.
 */
export async function tryPasswordReset(
  db: AsyncDb,
  tenant: string,
  email: string,
  now: string,
): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  const user = (await db.prepare('SELECT * FROM users WHERE tenant = ? AND email = ?').get(tenant, normalized)) as
    Row | undefined;
  if (!user) {
    await audit(db, tenant, normalized, 'auth.reset_requested', 'login', now, 'no matching account');
    return null;
  }
  const token = newToken();
  const expiresAt = new Date(Date.parse(now) + LOCKOUT_MS).toISOString();
  await db
    .prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), String((user as Row).id), expiresAt);
  await audit(db, tenant, String((user as Row).id), 'auth.reset_requested', `user:${String((user as Row).id)}`, now);
  return token;
}

/**
 * Operator-assisted reset: set a temporary password and force replacement at
 * next login. Revokes every live session.
 */
export async function operatorSetPassword(
  db: AsyncDb,
  tenant: string,
  userId: string,
  newPassword: string,
  now: string,
): Promise<void> {
  const hash = hashPassword(newPassword);
  return db.transaction(async () => {
    const out = await db
      .prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE tenant = ? AND id = ?')
      .run(hash, tenant, userId);
    if (out.changes === 0) throw new AuthError('UNKNOWN_USER', `no user ${userId} in tenant ${tenant}`);
    await revokeUserSessions(db, tenant, userId, now);
    await audit(db, tenant, 'operator', 'auth.password_operator_reset', `user:${userId}`, now);
  });
}

export async function confirmPasswordReset(
  db: AsyncDb,
  token: string,
  newPassword: string,
  now: string,
): Promise<void> {
  const r = (await db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(token))) as
    { user_id: string; expires_at: string; used_at: string | null } | undefined;
  if (!r) throw new AuthError('BAD_RESET_TOKEN', 'unknown reset token');
  if (r.used_at !== null && r.used_at !== '') throw new AuthError('BAD_RESET_TOKEN', 'reset token already used');
  if (r.expires_at <= now) throw new AuthError('BAD_RESET_TOKEN', 'reset token expired');
  const user = (await db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id)) as Row | undefined;
  if (!user) throw new AuthError('UNKNOWN_USER', 'reset token points at a deleted user');
  await changePassword(db, String((user as Row).tenant), r.user_id, newPassword, now);
  await db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(now, sha256(token));
}

// -------------------------------------------------------------------- roles ----

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h single-use token
export const MFA_RECENT_AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 min step-up for sensitive ops
export const MFA_TOTP_STEP_SEC = 30;
export const MFA_TOTP_DIGITS = 6;
export const MFA_RECOVERY_CODE_COUNT = 10;

/**
 * FLOW-007: email-verification lifecycle. `email_verified_at` on the user row
 * is the persistent verified flag — set once by confirming a single-use
 * token, never cleared except by an explicit address change (there is no
 * address-change flow yet, so in practice it is write-once). The 24h TTL
 * above applies to the *token*, not to the verified state: a verified
 * address stays verified.
 */
export async function requestEmailVerification(
  db: AsyncDb,
  tenant: string,
  userId: string,
  now: string,
): Promise<string> {
  const user = await getUser(db, tenant, userId);
  if (!user) throw new AuthError('UNKNOWN_USER', `no user ${userId} in tenant ${tenant}`);
  const token = newToken();
  const expiresAt = new Date(Date.parse(now) + EMAIL_VERIFICATION_TTL_MS).toISOString();
  await db
    .prepare('INSERT INTO email_verifications (token_hash, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)')
    .run(sha256(token), userId, expiresAt);
  await audit(db, tenant, userId, 'auth.email_verification_requested', `user:${userId}`, now);
  return token;
}

export async function confirmEmailVerification(db: AsyncDb, token: string, now: string): Promise<User> {
  const r = (await db.prepare('SELECT * FROM email_verifications WHERE token_hash = ?').get(sha256(token))) as
    { user_id: string; expires_at: string; used_at: string | null } | undefined;
  if (!r) throw new AuthError('BAD_VERIFICATION_TOKEN', 'unknown verification token');
  if (r.used_at !== null && r.used_at !== '') throw new AuthError('BAD_VERIFICATION_TOKEN', 'token already used');
  if (r.expires_at <= now) throw new AuthError('BAD_VERIFICATION_TOKEN', 'verification token expired');
  const user = (await db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id)) as Row | undefined;
  if (!user) throw new AuthError('UNKNOWN_USER', 'verification token points at a deleted user');
  return db.transaction(async () => {
    await db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now, r.user_id);
    await db.prepare('UPDATE email_verifications SET used_at = ? WHERE token_hash = ?').run(now, sha256(token));
    await audit(db, String((user as Row).tenant), r.user_id, 'auth.email_verified', `user:${r.user_id}`, now);
    const next = (await db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id)) as Row;
    return rowToUser(next);
  });
}

/** Persistent verified flag — true once any token was confirmed. No expiry. */
export async function isEmailVerified(db: AsyncDb, tenant: string, userId: string): Promise<boolean> {
  const user = (await db
    .prepare('SELECT email_verified_at FROM users WHERE tenant = ? AND id = ?')
    .get(tenant, userId)) as { email_verified_at: string | null } | undefined;
  const v = user?.email_verified_at;
  return v !== null && v !== undefined && v !== '';
}

/**
 * FLOW-007: gate recovery messaging on verification. Returns false for
 * unverified or unknown users — callers must not reveal which.
 */
export async function verifyEmailBeforeRecovery(
  db: AsyncDb,
  tenant: string,
  userId: string,
  _now: string,
): Promise<boolean> {
  return isEmailVerified(db, tenant, userId);
}

/**
 * FLOW-007: recovery-channel status for messaging. `verified` is false when
 * the address was never confirmed — the forgot-password page says the quiet
 * part out loud (verify first) without enumerating accounts to strangers.
 */
export async function recoveryChannelStatus(
  db: AsyncDb,
  tenant: string,
  email: string,
): Promise<{ exists: boolean; verified: boolean; userId: string | null }> {
  const normalized = email.trim().toLowerCase();
  const row = (await db
    .prepare('SELECT id, email_verified_at FROM users WHERE tenant = ? AND email = ?')
    .get(tenant, normalized)) as { id: string; email_verified_at: string | null } | undefined;
  if (!row) return { exists: false, verified: false, userId: null };
  const v = row.email_verified_at;
  return { exists: true, verified: v !== null && v !== undefined && v !== '', userId: row.id };
}

/** FLOW-007: MFA-capable identity strategy — enforcement, recovery, recent-auth policy. */
export interface MfaFactor {
  id: string;
  userId: string;
  kind: 'totp' | 'webauthn';
  verifiedAt: string;
  lastUsedAt: string | null;
}

function rowToMfaFactor(r: Row): MfaFactor {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    kind: String(r.kind) === 'webauthn' ? 'webauthn' : 'totp',
    verifiedAt: String(r.verified_at),
    lastUsedAt: r.last_used_at === null || r.last_used_at === undefined ? null : String(r.last_used_at),
  };
}

/** Supported MFA strategy, pinned for docs and tests. Passwords stay the
 *  first factor; TOTP is the supported second factor; recovery codes are the
 *  supported recovery path; sensitive operations additionally demand a fresh
 *  (≤15min) authentication regardless of MFA state. WebAuthn rows are
 *  schema-reserved for a future passkey addition — not claimed as working. */
export function mfaPolicy(): {
  firstFactor: string;
  secondFactor: string;
  recovery: string;
  recentAuthWindowMs: number;
  sensitiveOps: string[];
  webauthn: string;
} {
  return {
    firstFactor: 'password (salted scrypt, 12-char floor)',
    secondFactor: 'TOTP (RFC 6238, 30s step, ±1 window)',
    recovery: 'single-use hashed recovery codes',
    recentAuthWindowMs: MFA_RECENT_AUTH_WINDOW_MS,
    sensitiveOps: ['role-change', 'disable', 'transfer-ownership', 'reactivate', 'recovery'],
    webauthn: 'schema-reserved only — not an offered factor',
  };
}

/** Sensitive operations that demand step-up recent authentication. */
export const SENSITIVE_OPS_REQUIRING_RECENT_AUTH = [
  'role-change',
  'disable',
  'transfer-ownership',
  'reactivate',
  'recovery',
] as const;

// --- TOTP (RFC 6238, SHA-1, no new dependency) ---

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.trim().replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new AuthError('BAD_TOTP_SECRET', 'invalid base32 secret');
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** 20-byte (160-bit) secret, base32 without padding — the otpauth secret. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Uint8Array, counter: bigint, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const hmac = createHash('sha1');
  // node:crypto Hash lacks Uint8Array constructor overload typing here; feed Buffers.
  hmac.update(Buffer.from(secret));
  const mac = hmac.update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpCode(secretBase32: string, atMs: number, stepSec = MFA_TOTP_STEP_SEC): string {
  const secret = base32Decode(secretBase32);
  const counter = BigInt(Math.floor(atMs / 1000 / stepSec));
  return hotp(secret, counter, MFA_TOTP_DIGITS);
}

/** Accept codes from the adjacent 30s steps to tolerate clock skew. */
export function verifyTotpCode(secretBase32: string, code: string, atMs: number, window = 1): boolean {
  const digitsOnly = /^\d{6}$/.test(code.trim());
  if (!digitsOnly) return false;
  const want = code.trim();
  const secret = base32Decode(secretBase32);
  const center = Math.floor(atMs / 1000 / MFA_TOTP_STEP_SEC);
  for (let d = -window; d <= window; d++) {
    if (hotp(secret, BigInt(center + d), MFA_TOTP_DIGITS) === want) return true;
  }
  return false;
}

/**
 * Enroll a TOTP factor: the caller generates the secret (newTotpSecret),
 * shows the otpauth URI to the user, and only on a correct code does this
 * persist the factor. The secret is stored reversibly in the factors table —
 * it is as sensitive as a password hash input and relies on DB access
 * control (documented limitation).
 */
export async function confirmMfaEnrollment(
  db: AsyncDb,
  tenant: string,
  userId: string,
  secretBase32: string,
  code: string,
  now: string,
): Promise<MfaFactor> {
  const user = await getUser(db, tenant, userId);
  if (!user) throw new AuthError('UNKNOWN_USER', `no user ${userId} in tenant ${tenant}`);
  if (user.disabled) throw new AuthError('DISABLED_USER', 'reactivate the account before enrolling MFA');
  if (!verifyTotpCode(secretBase32, code, Date.parse(now))) throw new AuthError('BAD_TOTP_CODE', 'code not accepted');
  const factor: MfaFactor = {
    id: newId('mfa'),
    userId,
    kind: 'totp',
    verifiedAt: now,
    lastUsedAt: null,
  };
  await db
    .prepare(
      'INSERT INTO mfa_factors (id, user_id, kind, secret, credential_id, public_key, verified_at, last_used_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?)',
    )
    .run(factor.id, userId, 'totp', secretBase32, now, now);
  await audit(db, tenant, userId, 'auth.mfa_enrolled', `mfa:${factor.id}`, now, 'kind=totp');
  return factor;
}

export async function listMfaFactors(db: AsyncDb, userId: string): Promise<MfaFactor[]> {
  const rows = await db.prepare('SELECT * FROM mfa_factors WHERE user_id = ? ORDER BY created_at').all(userId);
  return rows.map(rowToMfaFactor);
}

export async function isMfaEnabled(db: AsyncDb, userId: string): Promise<boolean> {
  const row = (await db.prepare('SELECT COUNT(*) AS n FROM mfa_factors WHERE user_id = ?').get(userId)) as {
    n: number;
  };
  return Number(row.n) > 0;
}

export async function removeMfaFactor(
  db: AsyncDb,
  tenant: string,
  userId: string,
  factorId: string,
  now: string,
): Promise<void> {
  const out = await db.prepare('DELETE FROM mfa_factors WHERE id = ? AND user_id = ?').run(factorId, userId);
  if (out.changes === 0) throw new AuthError('UNKNOWN_MFA_FACTOR', `no MFA factor ${factorId}`);
  await db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL').run(userId);
  await audit(db, tenant, userId, 'auth.mfa_removed', `mfa:${factorId}`, now);
}

/** Verify a TOTP code against any enrolled TOTP factor; stamps last_used_at. */
export async function verifyMfaCode(
  db: AsyncDb,
  tenant: string,
  userId: string,
  code: string,
  now: string,
): Promise<boolean> {
  const factors = await listMfaFactors(db, userId);
  const atMs = Date.parse(now);
  for (const f of factors) {
    if (f.kind !== 'totp') continue;
    const row = (await db.prepare('SELECT secret FROM mfa_factors WHERE id = ?').get(f.id)) as {
      secret: string | null;
    };
    if (!row?.secret) continue;
    if (verifyTotpCode(row.secret, code, atMs)) {
      await db.prepare('UPDATE mfa_factors SET last_used_at = ? WHERE id = ?').run(now, f.id);
      await audit(db, tenant, userId, 'auth.mfa_verified', `mfa:${f.id}`, now);
      return true;
    }
  }
  await audit(db, tenant, userId, 'auth.mfa_failed', `user:${userId}`, now);
  return false;
}

/**
 * Issue a fresh set of single-use recovery codes. Plaintexts are returned
 * once — only hashes persist. Issuing rotates: unused prior codes are
 * discarded so there is exactly one live set.
 */
export async function generateMfaRecoveryCodes(
  db: AsyncDb,
  tenant: string,
  userId: string,
  now: string,
  count = MFA_RECOVERY_CODE_COUNT,
): Promise<string[]> {
  const user = await getUser(db, tenant, userId);
  if (!user) throw new AuthError('UNKNOWN_USER', `no user ${userId} in tenant ${tenant}`);
  const codes: string[] = [];
  for (let i = 0; i < count; i++) codes.push(randomBytes(6).toString('base64url'));
  await db.transaction(async () => {
    await db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL').run(userId);
    for (const c of codes)
      await db
        .prepare('INSERT INTO mfa_recovery_codes (code_hash, user_id, used_at, created_at) VALUES (?, ?, NULL, ?)')
        .run(sha256(c), userId, now);
    await audit(db, tenant, userId, 'auth.mfa_recovery_issued', `user:${userId}`, now, `count=${count}`);
  });
  return codes;
}

/** Consume one recovery code; each code works exactly once. */
export async function consumeMfaRecoveryCode(
  db: AsyncDb,
  tenant: string,
  userId: string,
  code: string,
  now: string,
): Promise<boolean> {
  const out = await db
    .prepare('UPDATE mfa_recovery_codes SET used_at = ? WHERE code_hash = ? AND user_id = ? AND used_at IS NULL')
    .run(now, sha256(code), userId);
  if (out.changes > 0) {
    await audit(db, tenant, userId, 'auth.mfa_recovery_used', `user:${userId}`, now);
    return true;
  }
  return false;
}

export async function countLiveRecoveryCodes(db: AsyncDb, userId: string): Promise<number> {
  const row = (await db
    .prepare('SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL')
    .get(userId)) as { n: number };
  return Number(row.n);
}

export async function assertRecentAuthForSensitiveOp(
  db: AsyncDb,
  userId: string,
  now: string,
  windowMs = MFA_RECENT_AUTH_WINDOW_MS,
  presentingSessionCreatedAt?: string,
): Promise<void> {
  // Bind to the PRESENTING session, never the user's newest one: otherwise a
  // days-old stolen session passes whenever the victim recently signed in on
  // another device. Callers without a session fall back to the newest live
  // session (legacy behaviour, still better than no check).
  const createdAt =
    presentingSessionCreatedAt ??
    (
      (await db
        .prepare(
          'SELECT created_at FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
        )
        .get(userId)) as { created_at: string } | undefined
    )?.created_at;
  if (!createdAt) throw new AuthError('REAUTH_REQUIRED', 'recent authentication required for sensitive operation');
  if (Date.parse(now) - Date.parse(createdAt) > windowMs) {
    throw new AuthError('REAUTH_REQUIRED', 'session too old; re-authenticate to proceed');
  }
}

export function atLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export function requireRole(role: Role, min: Role): void {
  if (!atLeast(role, min)) throw new AuthError('FORBIDDEN', `requires ${min} (caller is ${role})`);
}

/**
 * FLOW-007: explicit role-grant matrix. Only an owner may create another
 * owner; admins may invite members and admins; members may not grant roles.
 */
export function canGrantRole(granter: Role, granted: Role): boolean {
  if (granted === 'owner') return granter === 'owner';
  if (granted === 'admin' || granted === 'member') return granter === 'owner' || granter === 'admin';
  return false;
}

export function assertGrantRole(granter: Role, granted: Role): void {
  if (!canGrantRole(granter, granted)) throw new AuthError('FORBIDDEN', `${granter} cannot grant the ${granted} role`);
}

/** Invited/bootstrap users must finish password change before other mutations. */
export function assertAccountActivated(user: User): void {
  if (user.mustChangePassword) throw new AuthError('ACTIVATION_REQUIRED', 'change your password before continuing');
}

/** Roles an inviter may offer in UI or API — mirrors {@link canGrantRole}. */
export function grantableRoles(granter: Role): readonly Role[] {
  if (granter === 'owner') return ['member', 'admin', 'owner'];
  if (granter === 'admin') return ['member', 'admin'];
  return [];
}

/** True when the console bind address is local-only (safe default for open signup). */
export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  return ip.startsWith('127.');
}

/**
 * FLOW-007: first-owner web claiming requires deliberate setup authorization
 * whenever the caller is not loopback, or whenever a setup secret is configured.
 */
export function signupRequiresSetupSecret(ip: string | undefined, setupSecret: string | null | undefined): boolean {
  if (setupSecret) return true;
  return !isLoopbackAddress(ip);
}

export function setupSecretOk(presented: string | null | undefined, setupSecret: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(setupSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// -------------------------------------------------------------------- CSRF ----

export function csrfOk(session: Session, presented: string | null | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(session.csrfToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Cookie header fragment — SameSite=Lax, HttpOnly; Max-Age matches the DB session row. */
export function sessionCookie(token: string, now: string, secure = false, session?: Session): string {
  const maxAgeSec = session
    ? Math.max(0, Math.floor(sessionRemainingMs(session, now) / 1000))
    : Math.floor(SESSION_TTL_MS / 1000);
  const expires = new Date(Date.parse(now) + maxAgeSec * 1000).toUTCString();
  const parts = [
    `vital_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    `Expires=${expires}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const CLEAR_SESSION_COOKIE = 'vital_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

async function createSession(db: AsyncDb, user: User, now: string): Promise<{ session: Session; token: string }> {
  const token = newToken();
  const expiresAt = nextSessionExpiry(now, now);
  const session: Session = {
    id: token,
    userId: user.id,
    tenant: user.tenant,
    csrfToken: randomBytes(32).toString('hex'),
    createdAt: now,
    expiresAt,
  };
  await db
    .prepare(
      'INSERT INTO auth_sessions (id, user_id, tenant, csrf_token, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
    )
    .run(session.id, session.userId, session.tenant, session.csrfToken, now, session.expiresAt);
  return { session, token };
}
