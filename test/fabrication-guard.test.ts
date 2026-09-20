/**
 * Anti-fabrication guard — CI tripwire for simulated telemetry posing as
 * real (AUDIT.md F15's failure mode: "Product metrics ... can present
 * simulated improvements as real learning").
 *
 * Two signatures, applied to src/console/** and src/talk/** (every surface a
 * human sees):
 *
 *   1. Hardcoded dollar amounts in string literals / template chunks.
 *      Telemetry must be computed from real rows. Content that legitimately
 *      names dollars is allowed when it is explicitly synthetic — canary
 *      PROBE payloads, SAMPLE walkthrough data, and the synthetic labels the
 *      repo already uses (`simulated:` intents, `synthetic:` tags).
 *   2. Invented personas/entities (the "Alex Rivera" DM list, "Apex Clearing"
 *      exposure tables) and fake unread pills ("28 new messages").
 *   3. Hardcoded percentages in rendered strings ("99.8% dedupe ratio") —
 *      a percentage is always a computation, so a literal one is a claim
 *      with no measurement behind it.
 *   4. Verification badges and claimed verdicts without a computation
 *      ("Immutable Hash Chain: 🟢 VERIFIED", "🟢 RECONCILED", "AUDITED")
 *      — no process existed behind them when they shipped.
 *
 * Case matters for verdicts: UPPERCASE verdict words in rendered strings are
 * the fabrication shape; lowercase prose ("records an audited reset token")
 * is documentation, not a badge, and must pass.
 *
 * Comments are stripped before matching: this repo documents its past
 * fabrications in comments (AUDIT.md, honest headers), and prose is not
 * rendered telemetry. The eslint.config.mjs no-restricted-syntax block is
 * the lint-side twin of this test; both must be updated together.
 *
 * To ship an intentional synthetic dollar figure (canary, sample, seed):
 * keep the literal on a line that also carries PROBE, SAMPLE, canary,
 * fixture, or synthetic — the same convention the compiler's
 * `simulated:` exclusion uses — and it passes by construction.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { T, eq } from './helpers.ts';

const GUARDED_DIRS = ['src/console', 'src/talk'];

const DOLLAR_RE = /(\$\d+\.\d{2})|(\$\d{1,3}(,\d{3})+)|(\$\d{2,})/;
const PERSONA_RE =
  /Alex Rivera|Jordan Brooks|Maya Chen|Elena Torres|Apex Clearing|Apex Prime|Goldman Sachs|Citadel Securities|Prime Custody|Honeycomb Studios/;
const UNREAD_RE = /\d+ new messages/;
// A telemetry percentage is prose ("99.8% dedupe") — digit(s), '%', space,
// letter. CSS units ("border-radius:50%;", "width:20%") and keyframe stops
// ("20% {") are not telemetry and must pass.
const PERCENT_RE = /\b\d+(?:\.\d+)?% [A-Za-z]/;
const VERDICT_RE =
  /(🟢|🟡|🔴|✅|✔|☑)\s*(RECONCILED|VERIFIED|AUDITED|CERTIFIED|NOTARIZED|ATTESTED|ACCREDITED|SYNCED)|\b(RECONCILED|NOTARIZED|ATTESTED|ACCREDITED|SYNCED)\b/;

/** Synthetic-content markers that legitimize a flagged literal (canaries, samples). */
const SYNTHETIC_RE = /PROBE|SAMPLE|canary|fixture|synthetic|simulated|seed-demo|placeholder/i;

/** One rule list, shared by the file scanner and the self-test helper. */
const RULES: Array<{ re: RegExp; rule: string; hint: string }> = [
  {
    re: DOLLAR_RE,
    rule: 'hardcoded-dollar',
    hint: 'compute from real rows, or keep the literal on a line marked PROBE/SAMPLE/canary/synthetic',
  },
  {
    re: PERCENT_RE,
    rule: 'invented-percent',
    hint: 'a percentage is a computation — derive it from real rows, or mark the line synthetic',
  },
  {
    re: VERDICT_RE,
    rule: 'claimed-verdict',
    hint: 'verification badges must come from a real evaluation — render the computed status or remove the claim',
  },
  { re: PERSONA_RE, rule: 'invented-persona', hint: 'render real principals from the session/ledger' },
  {
    re: UNREAD_RE,
    rule: 'fake-unread',
    hint: 'unread counts require read-state tracking; render a real count or remove it',
  },
];

/** Strip line comments, block comments, and eslint directive comments. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(?<=[^:])\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ' '));
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
  rule: string;
  hint: string;
}

function scanFile(file: string): Violation[] {
  const raw = readFileSync(file, 'utf8');
  const stripped = stripComments(raw);
  const out: Violation[] = [];
  const lines = stripped.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // A line that declares itself synthetic (PROBE/SAMPLE/canary/…) carries
    // labeled demo content by the repo's own convention — allowed wholesale.
    const synthetic = SYNTHETIC_RE.test(line);
    if (synthetic) continue;
    for (const v of RULES) {
      if (v.re.test(line)) {
        out.push({ file, line: i + 1, text: line.trim().slice(0, 140), rule: v.rule, hint: v.hint });
      }
    }
  }
  return out;
}

T('fabrication guard: src/console + src/talk contain no fabricated telemetry', () => {
  const violations: Violation[] = [];
  for (const dir of GUARDED_DIRS) {
    for (const file of listTsFiles(dir)) {
      violations.push(...scanFile(file));
    }
  }

  if (violations.length > 0) {
    const report = violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}\n    → ${v.hint}`).join('\n  ');
    console.error(`\n\x1b[1mAnti-fabrication guard violations (${violations.length}):\x1b[0m\n  ${report}\n`);
  }

  eq(violations.length, 0, 'rendered surfaces must not fabricate telemetry — see the report above');
});

T('fabrication guard: canary probe payloads are labeled synthetic and stay allowed', () => {
  // The canary's dollar/percentage literals ride on PROBE-marked lines — the
  // honest synthetic convention. Assert the mechanism works by re-scanning one.
  const findings = scanFile('src/talk/canary.ts');
  eq(findings.length, 0, 'PROBE-marked canary content is legitimate synthetic data and must pass');
});

T('fabrication guard: a fabricated literal is caught (self-test of the scanner)', () => {
  const dir = readdirSync('src/console', { withFileTypes: true }).length; // touch fs for realism
  eq(dir > 0, true);
  const fake = 'const s = "Cost-Per-Signal $0.0034 / signal";';
  const violations = scanLine(fake, 'self-test.ts');
  eq(violations.length, 1, 'the scanner catches a hardcoded dollar literal outside synthetic context');
  eq(violations[0]!.rule, 'hardcoded-dollar');
});

T('fabrication guard: percentages and claimed verdicts are caught (self-test)', () => {
  const pct = scanLine('const s = `<span>99.8% dedupe ratio</span>`;', 'self-test.ts');
  eq(
    pct.some((v) => v.rule === 'invented-percent'),
    true,
    'a hardcoded percentage is caught:',
  );

  const css = scanLine('return `<div style="border-radius:50%;width:20%">x</div>`;', 'self-test.ts');
  eq(css.length, 0, 'CSS percentage units are not telemetry:');
  const keyframes = scanLine('const s = `0% { opacity: 0 } 100% { opacity: 1 }`;', 'self-test.ts');
  eq(keyframes.length, 0, 'CSS keyframe stops are not telemetry:');

  const badge = scanLine('return `<div>Immutable Hash Chain: 🟢 VERIFIED</div>`;', 'self-test.ts');
  eq(
    badge.some((v) => v.rule === 'claimed-verdict'),
    true,
    'an emoji verification badge is caught:',
  );

  const verdict = scanLine('const s = "Ledger RECONCILED";', 'self-test.ts');
  eq(
    verdict.some((v) => v.rule === 'claimed-verdict'),
    true,
    'a bare uppercase verdict is caught:',
  );

  // Honest shapes must pass: computed percentages and lowercase prose.
  const computed = scanLine('const s = `${ratio.toFixed(1)}% dedupe`;', 'self-test.ts');
  eq(computed.length, 0, 'a template-interpolated percentage is allowed:');
  const prose = scanLine('const s = "records an audited reset token in the ledger";', 'self-test.ts');
  eq(prose.length, 0, 'lowercase prose is not a verification badge:');
});

function scanLine(line: string, fakeName: string): Violation[] {
  // Exposed for the self-test: same rules, single line, no synthetic marker.
  const violations: Violation[] = [];
  for (const v of RULES) {
    if (v.re.test(line)) violations.push({ file: fakeName, line: 1, text: line, rule: v.rule, hint: v.hint });
  }
  return violations;
}
