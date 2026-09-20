import { createHash, createHmac } from 'node:crypto';

/**
 * S3 artifact backend (content-addressed, SigV4, no AWS SDK).
 *
 * Why this exists: raw artifacts are keyed by sha256 (see storeArtifact in
 * collectors.ts) so any backend is a dumb bytes-by-hash shelf. The
 * filesystem shelf stops at the machine boundary; this one carries the same
 * content-addressed contract to an S3-compatible bucket for deployments
 * that need shared, durable artifact storage.
 *
 * Why no AWS SDK: the repo keeps production dependencies to pg+zod, so
 * SigV4 is implemented here with node:crypto only (HMAC chain
 * kDate/kRegion/kService/kSigning over the canonical request). The signing
 * surface is PUT/GET object — the only two verbs an artifact shelf needs.
 *
 * Shape note (read before "fixing" this to `implements ArtifactStore`):
 * FilesystemArtifactStore (collectors.ts, F19) is synchronous because the
 * filesystem is. S3 speaks HTTP, which cannot be synchronous in Node, so
 * this store is async by necessity. Method names and parameter shapes mirror
 * ArtifactStore deliberately — put(ref, body) → ref, get(ref) → bytes — so
 * a future async seam accepts either backend; it does not claim the sync
 * interface because a Promise<string> is not a string and pretending
 * otherwise would lie to the typechecker.
 *
 * Single-PUT implication (no multipart, on purpose): each put is one PUT
 * Object. S3 caps a single PUT at 5 GiB, and this store caps lower via
 * maxBytes (default mirrors the filesystem 25 MB) so one artifact can never
 * turn the process into an unbounded buffer. Anything bigger refuses loudly
 * with TOO_LARGE instead of half-uploading; resumable/multipart upload for
 * giant blobs is out of scope and would be a separate, explicitly reviewed
 * addition — silent chunking is how partial artifacts get mistaken for
 * whole ones.
 *
 * Trust boundaries: endpoint, credentials, and stored bytes are all
 * untrusted until checked. The endpoint allowlist (https everywhere except
 * explicit localhost/127.0.0.1 http for MinIO/LocalStack-style overrides)
 * exists so a misconfigured endpoint cannot downgrade signing or leak the
 * Authorization header in cleartext to a remote host. Secrets travel in the
 * Authorization header only — never in error messages, never logged. Bytes
 * read back are hashed and compared to the requested key before return:
 * S3 is a network shelf, not memory, so a tampered or crossed object must
 * refuse with CORRUPT rather than poison the ledger's rawArtifactRef chain.
 *
 * Determinism: signing inputs are (method, bucket, key, payload hash,
 * timestamp, region, credentials) — no randomness, no ambient clock. Pass a
 * fixed `now` and fixed credentials and the Authorization header is
 * byte-identical across runs; the suite pins exactly that.
 */

/** Namespaced refusal, following the repo's `[module:CODE]` convention. */
export class S3Error extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[s3:${code}] ${message}`);
  }
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Fetch injection, same pattern as models.ts (tests stub the network, CI
 * spends nothing) but widened for bytes: S3 speaks octets, not JSON, so the
 * init body accepts binary and the response offers text()/arrayBuffer()
 * instead of json(). The shape stays (url, init) → { ok, status, ... } so
 * any models-style stub adapts trivially.
 */
export interface S3RequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array | Buffer;
}

export interface S3Response {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type S3FetchFn = (url: string, init: S3RequestInit) => Promise<S3Response>;

export interface S3ArtifactStoreOpts {
  bucket: string;
  region: string;
  credentials: S3Credentials;
  /** Override for MinIO/LocalStack-style targets. https required unless local (see allowlist). */
  endpoint?: string;
  fetchFn: S3FetchFn;
  /** Injected clock for signing; tests pin this for byte-identical signatures. */
  now?: () => Date;
  /** Refuse-before-buffer cap, mirroring the filesystem store's maxBytes. */
  maxBytes?: number;
}

/** Default cap, mirroring FilesystemArtifactStore so backends agree on "too big". */
export const DEFAULT_S3_MAX_BYTES = 25_000_000;

/** sha256 of the empty string — the GET payload hash (GET has no body to hash). */
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Content-addressed keys are sha256 hex digests, nothing else. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256Hex(data: string | Uint8Array): string {
  // One-shot hash: artifacts are already bounded by maxBytes before this
  // runs, so streaming buys nothing and would split the digest path in two.
  return createHash('sha256').update(data).digest('hex');
}

function toBytes(body: string | Uint8Array | Buffer): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  // Buffer.from(Uint8Array) copies — the caller's buffer stays theirs and
  // the signed payload hash always covers exactly what is sent.
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

function assertRef(ref: string): void {
  // Shape, not just traversal: the S3 shelf is content-addressed by
  // contract, so anything that is not a sha256 digest is a caller bug, and
  // anything path-shaped (/, .., \) is an escape attempt. Refuse both
  // before any byte is signed or sent. The ref itself is echoed (it is a
  // hash, not a secret); credentials never are.
  if (!SHA256_HEX.test(ref)) {
    throw new S3Error(
      'BAD_REF',
      `artifact ref "${ref}" is not a sha256 hex digest: S3 keys are content-addressed (<sha256>); refusing instead of storing under an unaddressable name`,
    );
  }
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  // UTC always: SigV4 signs a clock value, and a local-timezone signature
  // would drift with the deployer's daylight saving. Fixed format, fixed zone.
  const dateStamp = `${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  return {
    amzDate: `${dateStamp}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`,
    dateStamp,
  };
}

function resolveBase(region: string, endpoint: string | undefined): string {
  if (!endpoint) return `https://s3.${region}.amazonaws.com`;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new S3Error(
      'BAD_ENDPOINT',
      'S3 endpoint is not a parseable URL: refusing instead of signing toward garbage',
    );
  }
  const host = url.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  // Plaintext http to a remote host would carry the Authorization header in
  // the clear; local http exists only because MinIO/LocalStack live there.
  // Fail loud: a mistyped endpoint must break the deploy, not the audit.
  if (url.protocol !== 'https:' && !local) {
    throw new S3Error(
      'BAD_ENDPOINT',
      `S3 endpoint must be https:// (got "${url.protocol}//${host}"): http is allowed only for explicit localhost/127.0.0.1 overrides`,
    );
  }
  return url.origin;
}

export class S3ArtifactStore {
  private readonly bucket: string;
  private readonly region: string;
  private readonly credentials: S3Credentials;
  private readonly base: string;
  private readonly fetchFn: S3FetchFn;
  private readonly now: () => Date;
  private readonly maxBytes: number;

  constructor(opts: S3ArtifactStoreOpts) {
    // Bucket names are addressing, not secrets, so echoing them in refusals
    // is safe; the shape check still runs first so path tricks never reach
    // URL construction.
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(opts.bucket)) {
      throw new S3Error(
        'BAD_BUCKET',
        `S3 bucket "${opts.bucket}" violates bucket naming (3-63 chars, lowercase, dots/dashes): refusing instead of signing toward a shelf that cannot exist`,
      );
    }
    if (!opts.credentials?.accessKeyId || !opts.credentials?.secretAccessKey) {
      // Values deliberately absent from the message: missing-credential
      // diagnostics must never become credential exfiltration.
      throw new S3Error(
        'BAD_CREDENTIALS',
        'S3 credentials are missing accessKeyId/secretAccessKey: refusing an unsigned artifact call',
      );
    }
    if (!opts.region)
      throw new S3Error('BAD_REGION', 'S3 region is empty: the SigV4 scope needs a region to bind the signature to');
    if (!opts.fetchFn)
      throw new S3Error(
        'BAD_TRANSPORT',
        'S3 fetchFn is missing: the network is injected, never ambient, so tests stub it',
      );
    this.bucket = opts.bucket;
    this.region = opts.region;
    // Copy, not alias: the caller's credential object stays mutable theirs.
    this.credentials = {
      accessKeyId: opts.credentials.accessKeyId,
      secretAccessKey: opts.credentials.secretAccessKey,
      ...(opts.credentials.sessionToken ? { sessionToken: opts.credentials.sessionToken } : {}),
    };
    this.base = resolveBase(opts.region, opts.endpoint);
    this.fetchFn = opts.fetchFn;
    this.now = opts.now ?? (() => new Date());
    this.maxBytes = opts.maxBytes ?? DEFAULT_S3_MAX_BYTES;
  }

  /**
   * Persist bytes under their content hash. Returns the ref on 2xx; every
   * other outcome throws a named [s3:CODE] error with no key material.
   */
  async put(ref: string, body: string | Uint8Array | Buffer): Promise<string> {
    assertRef(ref);
    const bytes = toBytes(body);
    // Bound the write before signing or sending: the signature covers the
    // payload hash, so an unbounded tree would be hashed AND transmitted.
    if (bytes.length > this.maxBytes) {
      throw new S3Error(
        'TOO_LARGE',
        `artifact "${ref}" is ${bytes.length} bytes, over the ${this.maxBytes}-byte cap: single PUT only, no multipart (see note above); refusing instead of buffering an unbounded tree`,
      );
    }
    const payloadHash = sha256Hex(bytes);
    const { url, headers } = this.sign('PUT', ref, payloadHash);
    let res: S3Response;
    try {
      res = await this.fetchFn(url, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
    } catch (e) {
      // The transport's own message is safe to carry: we never put secrets
      // into headers the transport could echo, only the server could, and
      // S3 errors are XML codes, not credential dumps.
      throw new S3Error('TRANSPORT', `PUT ${this.bucket}/${ref} failed in transit: ${(e as Error).message}`);
    }
    if (!res.ok) throw await this.mapError('PUT', ref, res);
    return ref;
  }

  /**
   * Read bytes back and verify them against the key. S3 is a network shelf,
   * not memory: hash-then-compare is the whole point of content addressing,
   * and a mismatch refuses with CORRUPT rather than returning strange bytes
   * under a trusted name.
   */
  async get(ref: string): Promise<Buffer> {
    assertRef(ref);
    const { url, headers } = this.sign('GET', ref, EMPTY_HASH);
    let res: S3Response;
    try {
      res = await this.fetchFn(url, { method: 'GET', headers });
    } catch (e) {
      throw new S3Error('TRANSPORT', `GET ${this.bucket}/${ref} failed in transit: ${(e as Error).message}`);
    }
    if (!res.ok) throw await this.mapError('GET', ref, res);
    const bytes = Buffer.from(await res.arrayBuffer());
    // Refuse before hashing/returning: same cap as the write path so a
    // swollen object cannot turn verification into a memory event.
    if (bytes.length > this.maxBytes) {
      throw new S3Error(
        'TOO_LARGE',
        `artifact "${ref}" is ${bytes.length} bytes, over the ${this.maxBytes}-byte cap: refusing instead of hashing an unbounded tree`,
      );
    }
    const actual = sha256Hex(bytes);
    if (actual !== ref) {
      throw new S3Error(
        'CORRUPT',
        `artifact "${ref}" failed content verification (bytes hash to "${actual}"): tampered or crossed object; refusing instead of returning strange bytes under a trusted name`,
      );
    }
    return bytes;
  }

  /** Translate HTTP outcomes into named errors; S3 speaks XML codes, not bare statuses. */
  private async mapError(op: string, ref: string, res: S3Response): Promise<S3Error> {
    let bodyText: string;
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '';
    }
    // Absence vs denial stay distinct: a missing artifact is a cache miss,
    // a denied one is a policy event, and conflating them hides breaches.
    if (
      res.status === 404 ||
      bodyText.includes('NoSuchKey') ||
      bodyText.includes('NoSuchBucket') ||
      bodyText.includes('NotFound')
    ) {
      return new S3Error('NOT_FOUND', `${op} ${this.bucket}/${ref} → ${res.status}: no such artifact`);
    }
    if (
      res.status === 403 ||
      bodyText.includes('AccessDenied') ||
      bodyText.includes('Forbidden') ||
      bodyText.includes('InvalidAccessKeyId') ||
      bodyText.includes('SignatureDoesNotMatch')
    ) {
      return new S3Error(
        'FORBIDDEN',
        `${op} ${this.bucket}/${ref} → ${res.status}: denied (check bucket policy/IAM; credentials themselves are never logged)`,
      );
    }
    const snippet = bodyText.slice(0, 200);
    return new S3Error('S3_ERROR', `${op} ${this.bucket}/${ref} → ${res.status}${snippet ? `: ${snippet}` : ''}`);
  }

  /** SigV4-sign one object request with node:crypto only (no AWS SDK per repo policy). */
  private sign(method: string, ref: string, payloadHash: string): { url: string; headers: Record<string, string> } {
    const { amzDate, dateStamp } = amzDates(this.now());
    const url = `${this.base}/${this.bucket}/${ref}`;
    const host = new URL(url).host;
    // Canonical headers must be sorted by lowercase name with trimmed
    // values; any deviation (extra spaces, wrong order) breaks the signature
    // in ways that surface as opaque 403s, so build them mechanically.
    const canonicalHeaders: Array<[string, string]> = [
      ['host', host],
      ['x-amz-content-sha256', payloadHash],
      ['x-amz-date', amzDate],
    ];
    if (this.credentials.sessionToken) canonicalHeaders.push(['x-amz-security-token', this.credentials.sessionToken]);
    canonicalHeaders.sort((a, b) => {
      if (a[0] === b[0]) return 0;
      return a[0] < b[0] ? -1 : 1;
    });
    const signedHeaders = canonicalHeaders.map(([k]) => k).join(';');
    const canonicalHeadersStr = canonicalHeaders.map(([k, v]) => `${k}:${v.trim()}\n`).join('');
    const canonicalUri = `/${this.bucket}/${ref}`;
    const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeadersStr}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
    // The HMAC chain binds date → region → service so a signature minted
    // for one day/region/service verifies nowhere else.
    const kDate = createHmac('sha256', `AWS4${this.credentials.secretAccessKey}`).update(dateStamp, 'utf8').digest();
    const kRegion = createHmac('sha256', kDate).update(this.region, 'utf8').digest();
    const kService = createHmac('sha256', kRegion).update('s3', 'utf8').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request', 'utf8').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
    const headers: Record<string, string> = {
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (this.credentials.sessionToken) headers['x-amz-security-token'] = this.credentials.sessionToken;
    return { url, headers };
  }
}
