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

export interface User {
  id: string;
  tenant: string;
  email: string;
  name: string;
  role: Role;
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

export function hashPassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new AuthError('WEAK_PASSWORD', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expected] = parts as [string, string, string];
  const actual = scryptSync(password, salt, 64).toString('hex');
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
  input: { email: string; name: string; role: Role; password: string; mustChangePassword: boolean; now: string },
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
    mustChangePassword: input.mustChangePassword,
    disabled: false,
    createdAt: input.now,
    lastLoginAt: null,
  };
  await db
    .prepare(
      'INSERT INTO users (id, tenant, email, name, role, password_hash, must_change_password, disabled, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      user.id,
      tenant,
      user.email,
      user.name,
      user.role,
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
  input: { email: string; name: string; role: Role; password: string },
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
    invitedBy: String(r.invited_by),
    status: String(r.status) as InvitationStatus,
    expiresAt: String(r.expires_at),
    acceptedAt: r.accepted_at === null || r.accepted_at === undefined ? null : String(r.accepted_at),
    acceptedUserId:
      r.accepted_user_id === null || r.accepted_user_id === undefined ? null : String(r.accepted_user_id),
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
  const existing = (await db.prepare('SELECT id, disabled FROM users WHERE tenant = ? AND email = ?').get(tenant, normalized)) as
    | { id: string; disabled: number }
    | undefined;
  if (existing) {
    if (Number(existing.disabled) === 1)
      throw new AuthError('DISABLED_USER_EXISTS', `${normalized} is disabled — reactivate the account instead`);
    throw new AuthError('DUPLICATE_USER', `${normalized} already has an active account`);
  }
  await sweepInvitations(db, tenant, now);
  const pending = (await db
    .prepare("SELECT id FROM invitations WHERE tenant = ? AND email = ? AND status = 'pending'")
    .get(tenant, normalized)) as { id: string } | undefined;
  if (pending) throw new AuthError('INVITATION_PENDING', `${normalized} already has a pending invitation — resend or revoke it`);
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
  input: { email: string; name: string; role: Role },
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
         (id, tenant, email, name, role, token_hash, invited_by, status, expires_at, accepted_at, accepted_user_id, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      )
      .run(
        invitation.id,
        invitation.tenant,
        invitation.email,
        invitation.name,
        invitation.role,
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
      `role=${invitation.role}`,
    );
    return { invitation, token };
  });
}

export async function listInvitations(db: AsyncDb, tenant: string, now: string): Promise<Invitation[]> {
  await sweepInvitations(db, tenant, now);
  const rows = await db
    .prepare('SELECT * FROM invitations WHERE tenant = ? ORDER BY created_at DESC')
    .all(tenant);
  return rows.map(rowToInvitation);
}

export async function getInvitation(db: AsyncDb, tenant: string, invitationId: string): Promise<Invitation | undefined> {
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
  if (inv.status === 'revoked') throw new AuthError('INVITATION_REVOKED', 'revoked invitations cannot be resent — create a new account');
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
  if (inv.status === 'expired') throw new AuthError('BAD_INVITATION', 'this invitation expired — ask your admin for a new one');
  return db.transaction(async () => {
    const existing = await db
      .prepare('SELECT id FROM users WHERE tenant = ? AND email = ?')
      .get(inv.tenant, inv.email);
    if (existing) throw new AuthError('DUPLICATE_USER', `${inv.email} already has an account`);
    const user = await insertUser(db, inv.tenant, {
      email: inv.email,
      name: inv.name,
      role: inv.role,
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
const OPEN_REQUEST_STATES =
  "('PROPOSED','QUEUED','ADMITTED','DEFERRED','IN_FLIGHT','ACCEPTED')";

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
  await db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
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

// ------------------------------------------------------------------- login ----

/**
 * Login under lockout. Keys the attempt counter by (tenant, ip, email) when an
 * IP is available — HTTP callers pass `ip` — else by (tenant, email).
 */
export async function login(
  db: AsyncDb,
  input: { tenant: string; email: string; password: string; ip?: string },
  now: string,
): Promise<{ user: User; session: Session; token: string }> {
  const email = input.email.trim().toLowerCase();
  const key = `${input.tenant}|${input.ip ?? '-'}|${email}`;
  const day = dayOf(now);
  const fail = async (detail: string, action = 'auth.login_failed'): Promise<never> => {
    await db.transaction(async () => {
      const row = (await db.prepare('SELECT fails FROM login_attempts WHERE key = ? AND day = ?').get(key, day)) as
        { fails: number } | undefined;
      const fails = (row?.fails ?? 0) + 1;
      const lockedUntil = fails >= LOCKOUT_THRESHOLD ? new Date(Date.parse(now) + LOCKOUT_MS).toISOString() : null;
      if (row)
        await db
          .prepare('UPDATE login_attempts SET fails = ?, locked_until = ?, updated_at = ? WHERE key = ? AND day = ?')
          .run(fails, lockedUntil, now, key, day);
      else
        await db
          .prepare('INSERT INTO login_attempts (key, day, fails, locked_until, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(key, day, fails, lockedUntil, now);
      await audit(db, input.tenant, email, action, 'login', now, detail);
    });
    throw new AuthError('BAD_CREDENTIALS', 'invalid credentials');
  };

  const attempt = (await db
    .prepare('SELECT fails, locked_until FROM login_attempts WHERE key = ? AND day = ?')
    .get(key, day)) as { fails: number; locked_until: string | null } | undefined;
  if (attempt?.locked_until && attempt.locked_until > now)
    throw new AuthError('LOCKED', `too many failed attempts — locked until ${attempt.locked_until}`);

  const user = (await db.prepare('SELECT * FROM users WHERE tenant = ? AND email = ?').get(input.tenant, email)) as
    Row | undefined;
  if (!user) await fail(`no user ${email}`);
  const u = rowToUser(user as Row);
  if (u.disabled) await fail(`disabled user ${email}`);
  if (!verifyPassword(input.password, String((user as Row).password_hash))) await fail(`bad password for ${email}`);

  await db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
  const { session, token } = await createSession(db, u, now);
  await db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, u.id);
  // NOTE: must_change_password is deliberately NOT cleared here. The flag
  // means "your next action is a password change"; only changePassword()
  // retires it, so an invited/bootstrap user is gated until they comply.
  await audit(db, input.tenant, u.id, 'auth.login', 'login', now);
  return { user: u, session, token };
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
  if (!canGrantRole(granter, granted))
    throw new AuthError('FORBIDDEN', `${granter} cannot grant the ${granted} role`);
}

/** Invited/bootstrap users must finish password change before other mutations. */
export function assertAccountActivated(user: User): void {
  if (user.mustChangePassword)
    throw new AuthError('ACTIVATION_REQUIRED', 'change your password before continuing');
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
