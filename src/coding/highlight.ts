// Dependency-free keyword/string/comment highlighter for the review diff.
// Escapes HTML first, then decorates — never trusts file bytes as markup.
const KEYWORDS: Record<string, string[]> = {
  typescript:
    'const let var function return if else for while class interface type extends implements import export from new await async try catch throw switch case break continue typeof instanceof enum public private readonly void null undefined true false this super static get new'.split(
      ' ',
    ),
  tsx: 'const let var function return if else for while class interface type extends implements import export from new await async try catch throw switch case break continue typeof instanceof enum public private readonly void null undefined true false this super static get new'.split(
    ' ',
  ),
  javascript:
    'const let var function return if else for while class extends import export from new await async try catch throw switch case break continue typeof instanceof null undefined true false this super static'.split(
      ' ',
    ),
  jsx: 'const let var function return if else for while class extends import export from new await async try catch throw switch case break continue typeof instanceof null undefined true false this super static'.split(
    ' ',
  ),
  python:
    'def return if elif else for while in not and or is None True False class import from as with try except raise lambda pass yield async await self'.split(
      ' ',
    ),
  go: 'func return if else for range var const type struct interface import package new make go defer chan nil true false'.split(
    ' ',
  ),
  rust: 'fn return if else for while loop in let mut const struct enum impl trait use mod pub crate match move ref true false self Self where async await'.split(
    ' ',
  ),
  sql: 'SELECT FROM WHERE AND OR NOT INSERT INTO UPDATE DELETE CREATE TABLE ALTER DROP JOIN ON AS VALUES SET PRIMARY KEY FOREIGN REFERENCES INDEX'.split(
    ' ',
  ),
};
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function highlightLine(line: string, lang: string): string {
  const esc = escHtml(line);
  if (lang === 'text' || lang === 'markdown') return esc;
  // Comments (// # --) — line-leading only to avoid breaking URLs/strings.
  const trimmed = line.trimStart();
  if (lang === 'python' && trimmed.startsWith('#')) return `<span class="tk-c">${esc}</span>`;
  if (lang === 'sql' && trimmed.startsWith('--')) return `<span class="tk-c">${esc}</span>`;
  if (['typescript', 'tsx', 'javascript', 'jsx', 'go', 'rust'].includes(lang) && trimmed.startsWith('//'))
    return `<span class="tk-c">${esc}</span>`;
  const kws = KEYWORDS[lang] ?? KEYWORDS[lang.replace('tsx', 'typescript')] ?? [];
  if (kws.length === 0 && lang === 'json') {
    return esc.replace(/(&quot;[^&]*?&quot;)(\s*:)?/g, '<span class="tk-s">$1</span>$2');
  }
  const kwset = new Set(kws.map((k) => k.toLowerCase()));
  const isSql = lang === 'sql';
  // Tokenize on word boundaries, preserving strings.
  return esc
    .split(/(&quot;.*?&quot;|'.*?'|`.*?`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return `<span class="tk-s">${part}</span>`;
      return part.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (w) => {
        const key = isSql ? w.toUpperCase() : w;
        if (kwset.has(isSql ? key : w) || (isSql && kwset.has(key))) return `<span class="tk-k">${w}</span>`;
        if (/^\d+$/.test(w)) return `<span class="tk-n">${w}</span>`;
        return w;
      });
    })
    .join('');
}
