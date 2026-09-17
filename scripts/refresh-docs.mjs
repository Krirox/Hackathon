#!/usr/bin/env node
/**
 * Docs freshness for the one number that rots: the test count.
 *
 * `npm test` writes `var/status.json` (the machine-readable truth). This
 * script rewrites the *marked* test-count claims in README.md, idea.md and
 * TODO.md from that truth, and `--check` fails if any marked claim is stale.
 * Historical, dated phase notes are deliberately NOT marked, so they stay
 * records of what was true then rather than being silently rebased.
 *
 *   node scripts/refresh-docs.mjs          # rewrite marked spans in place
 *   node scripts/refresh-docs.mjs --check  # exit 1 if anything would change
 *
 * A doc with no marked span is an error: deleting the markers must not be
 * a way to dodge the gate.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const DOCS = ['README.md', 'idea.md', 'TODO.md'];
const STATUS = join(ROOT, 'var', 'status.json');

// Only the span between these markers is governed; everything outside is
// history and is left exactly as written.
const SPAN_RE = /<!--\s*vital:testcount\s*-->([\s\S]*?)<!--\s*\/vital:testcount\s*-->/g;
// "157/157 tests passing", "74/74 green", "181/181 GREEN".
const PAIR_RE = /(\d+)(\s*\/\s*)(\d+)(?=\s+(?:tests?|passed|passing|green|GREEN)\b)/g;
// "74 tests, real sockets", "157 tests green" (standalone).
const SINGLE_RE = /(\d+)(\s+tests\b)/g;

function fail(message) {
  console.error(`refresh-docs: ${message}`);
  process.exit(1);
}

if (!existsSync(STATUS)) {
  fail(`missing ${STATUS} — run \`npm test\` first (it writes the test count)`);
}
const status = JSON.parse(readFileSync(STATUS, 'utf8'));
const passed = Number(status?.tests?.passed);
const failed = Number(status?.tests?.failed);
if (!Number.isFinite(passed) || !Number.isFinite(failed)) {
  fail(`malformed ${STATUS}: expected { tests: { passed, failed } }`);
}
if (failed > 0) {
  fail(`${failed} test(s) failing in the last run — docs are not blessed until the suite is green`);
}
const count = String(passed);

const rewrite = (span) =>
  span
    .replace(PAIR_RE, (_, _a, sep, _b) => `${count}${sep}${count}`)
    .replace(SINGLE_RE, (_, _n, tail) => `${count}${tail}`);

let stale = [];
let changedFiles = 0;

for (const doc of DOCS) {
  const path = join(ROOT, doc);
  if (!existsSync(path)) fail(`missing doc ${doc}`);
  const original = readFileSync(path, 'utf8');
  let spans = 0;
  const next = original.replace(SPAN_RE, (whole, inner) => {
    spans += 1;
    const updated = rewrite(inner);
    return whole.replace(inner, updated);
  });
  if (spans === 0) fail(`${doc} has no <!-- vital:testcount --> span — markers removed?`);
  if (next === original) continue;
  changedFiles += 1;
  stale.push(doc);
  if (!CHECK) writeFileSync(path, next);
}

if (CHECK && stale.length > 0) {
  console.error(`refresh-docs: ${stale.length} doc(s) quote a stale test count (truth: ${count}): ${stale.join(', ')}`);
  console.error('run `npm run docs:refresh` to update the marked spans, then commit.');
  process.exit(1);
}

if (CHECK) {
  console.log(`refresh-docs: ${DOCS.length} docs match the latest green run (${count} tests).`);
} else {
  console.log(
    changedFiles === 0
      ? `refresh-docs: already current (${count} tests).`
      : `refresh-docs: updated ${stale.join(', ')} to ${count} tests.`,
  );
}
