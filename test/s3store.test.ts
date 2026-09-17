import { createHash } from 'node:crypto';
import { T, eq, rejects } from './helpers.ts';
import { S3ArtifactStore, S3Error, type S3RequestInit, type S3Response } from '../src/ledger/s3store.ts';

console.log('\n\x1b[1mS3 artifacts — SigV4 shelf, stubbed transport\x1b[0m');

const FIXED_NOW = new Date('2026-09-09T12:00:00.000Z');
const AK = 'AKIDTESTEXAMPLE';
const SECRET = 'secret-test-1234567890abcdef';
const BUCKET = 'artifacts';
const REGION = 'us-east-1';

const sha = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');
const toAB = (b: Buffer): ArrayBuffer => {
  const u = new Uint8Array(b.length);
  u.set(b);
  return u.buffer;
};

interface Call {
  url: string;
  init: S3RequestInit;
}

const okEmpty = (): S3Response => ({
  ok: true,
  status: 200,
  text: async () => '',
  arrayBuffer: async () => toAB(Buffer.alloc(0)),
});
const okBytes = (b: Buffer): S3Response => ({
  ok: true,
  status: 200,
  text: async () => b.toString('utf8'),
  arrayBuffer: async () => toAB(b),
});
const fail = (status: number, body: string): S3Response => ({
  ok: false,
  status,
  text: async () => body,
  arrayBuffer: async () => toAB(Buffer.from(body, 'utf8')),
});

const storeOf = (calls: Call[], respond: (url: string, init: S3RequestInit) => Promise<S3Response>, extra = {}) =>
  new S3ArtifactStore({
    bucket: BUCKET,
    region: REGION,
    credentials: { accessKeyId: AK, secretAccessKey: SECRET },
    fetchFn: async (url: string, init: S3RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    },
    now: () => new Date(FIXED_NOW),
    ...extra,
  });

const signedHeadersOf = (auth: string): string[] => auth.split('SignedHeaders=')[1]!.split(',')[0]!.split(';');

T('PUT signs SigV4: method, path, and header shape pin the canonicalization', async () => {
  const calls: Call[] = [];
  const s = storeOf(calls, async () => okEmpty());
  const body = Buffer.from('hello s3', 'utf8');
  const ref = sha(body);
  eq(await s.put(ref, body), ref, 'put returns the content key:');
  eq(calls.length, 1);
  eq(calls[0]!.init.method, 'PUT');
  eq(calls[0]!.url, `https://s3.${REGION}.amazonaws.com/${BUCKET}/${ref}`, 'path-style URL carries bucket + key:');
  const h = calls[0]!.init.headers;
  eq(h['Authorization']!.startsWith('AWS4-HMAC-SHA256 '), true, 'scheme prefix:');
  eq(
    h['Authorization']!.includes(`Credential=${AK}/20260909/${REGION}/s3/aws4_request`),
    true,
    'credential scope binds date/region/service:',
  );
  const signed = signedHeadersOf(h['Authorization']!);
  eq(signed.includes('host'), true, 'host is signed:');
  eq(signed.includes('x-amz-content-sha256'), true, 'payload hash is signed:');
  const sig = h['Authorization']!.split('Signature=')[1]!;
  eq(/^[0-9a-f]{64}$/.test(sig), true, 'signature is 64 lowercase hex:');
  eq(h['x-amz-date'], '20260909T120000Z', 'fixed clock pins the timestamp:');
  eq(h['x-amz-content-sha256'], sha(body), 'content hash covers exactly the bytes sent:');
  // Secrets ride the signature math, never the wire text: the secret must
  // appear nowhere in the recorded request, error or otherwise.
  eq(JSON.stringify(calls[0]).includes(SECRET), false, 'secret never leaves the HMAC:');
  void S3Error;
});

T('fixed clock + fixed credentials yield byte-identical Authorization headers', async () => {
  const mk = () => {
    const calls: Call[] = [];
    return { calls, s: storeOf(calls, async () => okEmpty()) };
  };
  const a = mk();
  const b = mk();
  const body = Buffer.from('deterministic bytes', 'utf8');
  const ref = sha(body);
  await a.s.put(ref, body);
  await b.s.put(ref, body);
  eq(
    a.calls[0]!.init.headers['Authorization'],
    b.calls[0]!.init.headers['Authorization'],
    'canonicalization is pinned, not just shaped:',
  );
});

T('GET round-trips bytes through the transport and verifies the hash', async () => {
  const shelf = new Map<string, Buffer>();
  const calls: Call[] = [];
  const s = storeOf(calls, async (url, init) => {
    const key = url.split('/').pop()!;
    if (init.method === 'PUT') {
      const b = Buffer.isBuffer(init.body) ? init.body : Buffer.from((init.body as Uint8Array).buffer as ArrayBuffer);
      shelf.set(key, Buffer.from(b));
      return okEmpty();
    }
    const hit = shelf.get(key);
    if (!hit) return fail(404, '<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>');
    return okBytes(hit);
  });
  const body = Buffer.from('round-trip me', 'utf8');
  const ref = sha(body);
  await s.put(ref, body);
  eq((await s.get(ref)).toString('utf8'), 'round-trip me', 'bytes survive the fake shelf:');
  const getCall = calls.find((c) => c.init.method === 'GET')!;
  eq(getCall.url, `https://s3.${REGION}.amazonaws.com/${BUCKET}/${ref}`);
  eq(
    getCall.init.headers['x-amz-content-sha256'],
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'GET signs the empty payload hash:',
  );
});

T('403 and NoSuchKey map to named [s3:...] errors, never raw statuses', async () => {
  const denied: Call[] = [];
  const d = storeOf(denied, async () => fail(403, '<Error><Code>AccessDenied</Code><Message>denied</Message></Error>'));
  const body = Buffer.from('nope', 'utf8');
  const ref = sha(body);
  await rejects(() => d.put(ref, body), 'FORBIDDEN');
  await rejects(() => d.put(ref, body), '[s3:', 'namespaced like every other refusal:');
  const missing: Call[] = [];
  const m = storeOf(missing, async () => fail(404, '<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>'));
  await rejects(() => m.get(ref), 'NOT_FOUND');
  await rejects(() => m.get(ref), '[s3:');
});

T('tampered bytes refuse loudly with CORRUPT instead of returning strange bytes', async () => {
  const calls: Call[] = [];
  const s = storeOf(calls, async () => okBytes(Buffer.from('attacker bytes', 'utf8')));
  const ref = sha(Buffer.from('original bytes', 'utf8'));
  await rejects(() => s.get(ref), 'CORRUPT', 'hash mismatch is a trust event:');
  await rejects(() => s.get(ref), '[s3:');
});

T('endpoint policy: https everywhere, http only for explicit local overrides', async () => {
  // Remote plaintext would carry Authorization in the clear — fail at
  // construction, before anything is signed.
  let code = '';
  try {
    storeOf([], async () => okEmpty(), { endpoint: 'http://s3.evil.example/' });
  } catch (e) {
    code = (e as Error).message;
  }
  eq(code.includes('BAD_ENDPOINT'), true, 'remote http refuses:');
  // Local plaintext exists for MinIO/LocalStack; the URL still signs fully.
  const calls: Call[] = [];
  const local = storeOf(calls, async () => okEmpty(), { endpoint: 'http://localhost:9000' });
  const body = Buffer.from('local dev', 'utf8');
  const ref = sha(body);
  await local.put(ref, body);
  eq(calls[0]!.url, `http://localhost:9000/${BUCKET}/${ref}`, 'override base carries bucket + key:');
  eq(calls[0]!.init.headers['Authorization']!.startsWith('AWS4-HMAC-SHA256 '), true, 'local still signs:');
  const loop: Call[] = [];
  const loopback = storeOf(loop, async () => okEmpty(), { endpoint: 'http://127.0.0.1:9000' });
  await loopback.put(ref, body);
  eq(loop[0]!.url.startsWith('http://127.0.0.1:9000/'), true, '127.0.0.1 is local too:');
});

T('session token rides x-amz-security-token and is signed; failures never echo secrets', async () => {
  const calls: Call[] = [];
  const token = 'session-token-abc';
  const s = new S3ArtifactStore({
    bucket: BUCKET,
    region: REGION,
    credentials: { accessKeyId: AK, secretAccessKey: SECRET, sessionToken: token },
    fetchFn: async (url: string, init: S3RequestInit) => {
      calls.push({ url, init });
      return fail(403, '<Error><Code>AccessDenied</Code></Error>');
    },
    now: () => new Date(FIXED_NOW),
  });
  const body = Buffer.from('token ride', 'utf8');
  const ref = sha(body);
  eq(calls.length, 0);
  let msg = '';
  try {
    await s.put(ref, body);
  } catch (e) {
    msg = (e as Error).message;
  }
  eq(msg.includes('FORBIDDEN'), true);
  eq(calls[0]!.init.headers['x-amz-security-token'], token, 'token travels in its header:');
  eq(
    signedHeadersOf(calls[0]!.init.headers['Authorization']!).includes('x-amz-security-token'),
    true,
    'and is covered by the signature:',
  );
  eq(msg.includes(SECRET), false, 'secret never in errors:');
  eq(msg.includes(token), false, 'session token never in errors:');
});

T('non-hash refs and oversized trees refuse before any byte is signed', async () => {
  const calls: Call[] = [];
  const s = storeOf(calls, async () => okEmpty(), { maxBytes: 8 });
  await rejects(() => s.put('../escape', Buffer.from('x')), 'BAD_REF', 'path tricks never reach signing:');
  await rejects(() => s.put('small.txt', Buffer.from('x')), 'BAD_REF', 'non-addressable names refuse:');
  const big = sha(Buffer.from('0123456789abcdef', 'utf8'));
  await rejects(
    () => s.put(big, Buffer.from('0123456789abcdef', 'utf8')),
    'TOO_LARGE',
    'write path bounds before signing:',
  );
  eq(calls.length, 0, 'refusals send nothing:');
});
