import { tmpdir } from 'node:os';

/**
 * Wire types for the jcode harness API (protocol v1).
 *
 * Mirrored from upstream source, not invented:
 *   .upstream/jcode-1jehuang/crates/jcode-harness-api/src/lib.rs      (frames)
 *   .upstream/jcode-1jehuang/crates/jcode-harness-api/src/requests.rs (req tag)
 *   .upstream/jcode-1jehuang/crates/jcode-harness-api/src/events.rs   (ev tag)
 *
 * Rules taken from that source:
 *   - one JSON object per line (NDJSON)
 *   - every frame carries `v`, the protocol major version
 *   - clients MUST ignore unknown fields and skip unknown event kinds
 *   - `hello` must be the first frame on a connection
 */
export const API_VERSION_MAJOR = 1;
export const API_VERSION_MINOR = 0;

export interface ClientFrame {
  v: number;
  /** Client-chosen id echoed in acks/replies. Monotonic per connection. */
  id: number;
  req: string;
  [field: string]: unknown;
}

export interface ServerFrame {
  v: number;
  /** Request id this frame replies to; absent on streaming events. */
  reply_to?: number;
  ev: string;
  [field: string]: unknown;
}

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

/** Events we consume. Anything else is skipped, per the upstream contract. */
export type EventKind =
  | 'hello_ok'
  | 'ok'
  | 'error'
  | 'sessions'
  | 'attached'
  | 'history'
  | 'text_delta'
  | 'reasoning_delta'
  | 'tool_start'
  | 'tool_exec'
  | 'tool_done'
  | 'token_usage'
  | 'turn_done'
  | 'message_accepted'
  | 'permission_request'
  | 'session_status'
  | 'background_progress';

export interface HelloOk {
  version: number;
  server: string;
  capabilities?: string[];
}
export interface ToolDoneEvent {
  session_id: string;
  call_id: string;
  name: string;
  output: string;
  error?: string | null;
}
export interface TokenUsageEvent {
  session_id: string;
  input: number;
  output: number;
  cache_read_input?: number | null;
}
export interface PermissionRequestEvent {
  session_id: string;
  request_id: string;
  tool_name: string;
  description: string;
}
export interface SessionInfo {
  /** Verified against events.rs `pub struct SessionInfo`. It is
   * `session_id`, NOT `id` — a client that reads `.id` always gets undefined. */
  session_id: string;
  working_dir?: string | null;
  title?: string | null;
  status: string;
  [k: string]: unknown;
}

/**
 * Resolve the harness API socket path, mirroring upstream resolution
 * (verified against crates/jcode-harness-api/src/sockets.rs, not docs):
 * JCODE_API_SOCKET wins; otherwise the runtime dir holds jcode-api.sock,
 * resolved from JCODE_RUNTIME_DIR, then XDG_RUNTIME_DIR, then a temp fallback
 * namespaced per user (jcode-<user>) so two users on one box never share a
 * bridge. A client that resolves a different directory than the bridge cannot
 * connect at all — the exact bug upstream's sockets.rs exists to prevent.
 *
 * Windows branch is ours, not upstream's: Node cannot dial a Unix-socket
 * filesystem path on win32, so we use a named pipe there.
 */
export function runtimeDirFrom(
  env: NodeJS.ProcessEnv = process.env,
  tmpdir = '/tmp',
): string {
  if (env.JCODE_RUNTIME_DIR) return env.JCODE_RUNTIME_DIR;
  if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR;
  const who = env.USER ?? env.USERNAME ?? 'user';
  const discriminator = who.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'user';
  return `${tmpdir.replace(/[\\/]+$/, '')}/jcode-${discriminator}`;
}

export function socketPathFrom(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.JCODE_API_SOCKET) return env.JCODE_API_SOCKET;
  if (platform === 'win32') return '\\\\.\\pipe\\jcode-api';
  const base = runtimeDirFrom(env, env.TMPDIR ?? tmpdir());
  return `${base.replace(/[\\/]+$/, '')}/jcode-api.sock`;
}
