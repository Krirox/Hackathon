import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { T, eq } from './helpers.ts';

console.log('\n\x1b[1mDesign tokens — one palette, one guard\x1b[0m');

/**
 * Colour literals belong in the token sheet (`theme.ts`) and nowhere else. Every
 * surface that keeps a private palette becomes a place a theme change is missed,
 * a dark-mode fix is forgotten, or a contrast check cannot reach.
 *
 * This is a ratchet, not a purge: the files below still carry their own colours,
 * and each is here for a stated reason. The assertion runs both ways, so the
 * list can only shrink by fixing a file, never by adding one.
 */
const TOKEN_SHEET = 'src/console/theme.ts';

const PENDING: Record<string, string> = {
  // The only remaining exemptions, and they are a product decision rather than
  // debt: the Buzz chat must read as Buzz/Slack, so its palette is its own and
  // must NOT be repainted by a console token change.
  'src/console/buzz.ts': 'chat surface, theme-isolated on purpose',
  'src/console/workspace-shell.ts': 'chat shell, theme-isolated on purpose',
};

// `(?<!&)` is load-bearing: `&#039;` is an HTML entity, and matching the `#039`
// inside it made this guard report a colour that does not exist — which is how a
// ratchet starts getting "temporary" entries added to it.
const HEX = /(?<!&)#[0-9A-Fa-f]{6}\b|(?<!&)#[0-9A-Fa-f]{3}\b/g;

function filesWithHex(dir: string): { file: string; count: number }[] {
  const out: { file: string; count: number }[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts')) continue;
    const file = `${dir}${dir.endsWith('/') ? '' : '/'}${entry}`.split('\\').join('/');
    if (file === TOKEN_SHEET) continue; // the sheet is where literals live
    const src = readFileSync(join(dir, entry), 'utf8');
    const count = (src.match(HEX) ?? []).length;
    if (count > 0) out.push({ file, count });
  }
  return out;
}

T('no new surface invents its own palette (ratchet)', () => {
  const console_ = filesWithHex('src/console');
  const talk = filesWithHex('src/talk');
  const offending = [...console_, ...talk];
  console.log(`    files carrying raw colour literals: ${offending.length}`);
  for (const f of offending) console.log(`      ${f.file}  (${f.count})`);

  const unexpected = offending.filter((f) => !(f.file in PENDING)).map((f) => f.file);
  eq(
    unexpected,
    [],
    'these files carry their own colours but are not on the pending list — add tokens instead of a palette:',
  );
});

T('the pending list cannot lie: a migrated file must be removed from it', () => {
  // Two-way enforcement is what makes this a burn-down rather than a graveyard.
  // If a file no longer has raw colours, leaving it listed would silently
  // re-permit a palette the next time someone edits it.
  const stillDirty = new Set(filesWithHex('src/console').map((f) => f.file));
  const stale = Object.keys(PENDING).filter((f) => f.startsWith('src/console/') && !stillDirty.has(f));
  eq(stale, [], 'these are clean now — delete them from PENDING:');
});

T('the meeting room reads the stage tokens, and the console supplies them', () => {
  // The room is dark in both themes, so its colours are a named group in
  // theme.ts rather than a local palette. Two halves matter: the page must not
  // carry literals, and the served document must actually receive the token
  // block — a `var()` that resolves to nothing renders as transparent, which no
  // type check would catch.
  const src = readFileSync('src/console/meetings.ts', 'utf8');
  eq((src.match(HEX) ?? []).length, 0, 'meetings has no colour literals:');
  eq(src.includes('var(--v-stage-'), true, 'meetings reads stage tokens:');
  // The colours it uses must all be declared, or the page silently loses them.
  const used = [...new Set((src.match(/var\((--v-stage-[a-z0-9-]+)\)/g) ?? []).map((v) => v.slice(4, -1)))];
  const sheet = readFileSync(TOKEN_SHEET, 'utf8');
  const undeclared = used.filter((token) => !sheet.includes(`${token}:`));
  eq(undeclared, [], 'every stage token the room uses is declared:');
  eq(used.length > 40, true, 'the stage palette is actually in use:');
});

T('the review surface reads the token sheet, not a private palette', () => {
  // code-review.ts was the worst offender (its own --ink/--teal plus raw hex).
  // It is the worked example for the rest of the migration, so pin it.
  const src = readFileSync('src/console/code-review.ts', 'utf8');
  const cssBlock = /const CSS = `([\s\S]*?)`;/.exec(src)?.[1] ?? '';
  eq(cssBlock.length > 0, true, 'CSS block found:');
  eq((cssBlock.match(HEX) ?? []).length, 0, 'review CSS has no colour literals:');
  eq(cssBlock.includes('var(--v-ink)'), true, 'review CSS reads theme tokens:');
  eq(cssBlock.includes('var(--font-body)'), true, 'review CSS reads the token font stack:');
});
