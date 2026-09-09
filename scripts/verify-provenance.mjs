// CI guard (TODO §0.2/§0.3): every file under src/vendor/ must carry a
// provenance header with a source URL, a full commit SHA, and an upstream
// path — and no file OUTSIDE src/vendor/ may claim to be vendored.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const walk = (d) =>
  readdirSync(d).flatMap((e) => {
    const f = join(d, e);
    return statSync(f).isDirectory() ? walk(f) : [f];
  });

const need = ['source:', 'commit:', 'upstream path:', 'WHAT WAS CHANGED AND WHY'];
const sha = /commit:\s+([0-9a-f]{40})/;
let bad = 0;

// Cross-check: every header SHA must appear in LICENSE-THIRD-PARTY.md, the
// binding pin record. A header pointing at an unpinned commit is a silent
// edit by another name.
const pins = new Set(readFileSync(join(ROOT, 'LICENSE-THIRD-PARTY.md'), 'utf8').match(/[0-9a-f]{40}/g) ?? []);

for (const f of walk(join(ROOT, 'src'))) {
  const rel = relative(ROOT, f).split(sep).join('/');
  const text = readFileSync(f, 'utf8');
  // Only the all-caps PROVENANCE marker counts — casual mentions of
  // "vendored" in ordinary comments (e.g. src/gov/raci.ts) are not claims.
  const claimsVendored = /^\/\*\*[\s\S]{0,400}PROVENANCE/.test(text);
  if (rel.startsWith('src/vendor/')) {
    const missing = need.filter((k) => !text.includes(k));
    const m = text.match(sha);
    if (!claimsVendored || missing.length > 0 || !m) {
      console.error(`MISSING/INVALID provenance header: ${rel} (needs ${missing.join(', ') || 'valid SHA'})`);
      bad++;
    } else if (!pins.has(m[1])) {
      console.error(`UNPINNED SHA in ${rel}: ${m[1]} is not in LICENSE-THIRD-PARTY.md`);
      bad++;
    }
  } else if (claimsVendored) {
    console.error(`vendored-looking file outside src/vendor/: ${rel}`);
    bad++;
  }
}

if (bad > 0) {
  console.error(`${bad} provenance violation(s)`);
  process.exit(1);
}
console.log('provenance guard: all vendored files pinned');
