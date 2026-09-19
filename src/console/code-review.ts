import type { AsyncDb } from '../core/db.ts';
import {
  computeReviewFromGit, diffFile, applyHunkDecisions, gitShow, readTree, writeFileSafe,
  languageForPath, secretScan, type ChangedFile,
} from '../coding/diff.ts';
import { highlightLine } from '../coding/highlight.ts';
import {
  getReview, openReview, transitionReview, setHunkDecision, setFileDecision,
  addComment, sendCommentToAgent, recordHumanEdit, recordIteration, recordVerification,
  reviewSummary, type CodeReviewDoc,
} from '../coding/review.ts';
import { getMission } from '../coding/mission.ts';

export const esc = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
:root{--ink:#0A0F14;--teal:#0F5C57;--bg:#FAFAF8;--line:#E4E4E1;--add:#E6F4EA;--add-b:#137333;--del:#FCE8E6;--del-b:#A50E0E;--mono:'JetBrains Mono',ui-monospace,monospace}
body{font-family:'Inter',-apple-system,sans-serif;background:var(--bg);color:var(--ink);margin:0;font-size:14px}
.top{border-bottom:1px solid var(--line);background:#fff;padding:12px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.steps{display:flex;gap:6px;font-size:12px;color:#6B7280}.steps b{color:var(--teal)}.steps .done{color:#137333}
.layout{display:grid;grid-template-columns:250px 1fr 280px;gap:0;min-height:calc(100vh - 120px)}
@media(max-width:1100px){.layout{grid-template-columns:220px 1fr}.side-r{display:none}}
@media(max-width:760px){.layout{grid-template-columns:1fr}.side-l{max-height:200px;overflow:auto}}
.side-l{border-right:1px solid var(--line);background:#fff;padding:12px;overflow:auto}
.side-r{border-left:1px solid var(--line);background:#fff;padding:12px;overflow:auto;font-size:13px}
.main{padding:12px 16px;overflow:auto;min-width:0}
.diff{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#fff}
.diff.inline{grid-template-columns:1fr}
.pane{overflow:auto;min-width:0}.pane+.pane{border-left:1px solid var(--line)}
.pane h4{margin:0;padding:8px 12px;background:#F3F4F2;font-size:12px;position:sticky;top:0}
pre{margin:0;padding:8px 0;font-family:var(--mono);font-size:12.5px;line-height:1.6}
.ln{display:flex;min-width:0}.ln .no{flex:0 0 44px;text-align:right;padding-right:10px;color:#9AA0A6;user-select:none}
.ln .tx{white-space:pre-wrap;word-break:break-word;padding-right:12px;flex:1}
.ln.add{background:var(--add)}.ln.del{background:var(--del)}
.ln .mk{font-weight:700;color:var(--add-b)}.ln.del .mk{color:var(--del-b)}
.hunk{border-bottom:1px solid var(--line)}.hunk-bar{display:flex;gap:8px;align-items:center;padding:6px 10px;background:#F8FAF8;font-size:12px;position:sticky}
.hunk-bar form{display:inline}.btn{padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer;font-size:12px;font-weight:600}
.btn.pri{background:var(--teal);color:#fff;border-color:var(--teal)}.btn.dan{color:var(--del-b)}.btn:hover{filter:brightness(.96)}
.file-row{display:flex;gap:6px;align-items:center;padding:5px 8px;border-radius:6px;font-family:var(--mono);font-size:12.5px}
.file-row:hover{background:#F3F4F2}.file-row.sel{background:#E8F0EE}.st{font-weight:700;width:16px}.st.M{color:#B06000}.st.A{color:#137333}.st.D{color:#A50E0E}.st.R{color:#6B4EFF}
.card{border:1px solid var(--line);border-radius:8px;background:#fff;padding:12px;margin-bottom:12px}
.meter{display:flex;gap:14px;flex-wrap:wrap;font-size:13px}.ok{color:#137333}.bad{color:#A50E0E}.mut{color:#6B7280}
.tk-k{color:#7C3AED}.tk-s{color:#0B6E4F}.tk-c{color:#6B7280;font-style:italic}.tk-n{color:#B06000}
textarea.code{width:100%;min-height:300px;font-family:var(--mono);font-size:12.5px;border:1px solid var(--line);border-radius:8px;padding:10px}
.tabs{display:flex;gap:8px;margin:12px 0}.term{background:#101418;color:#D7DCE0;border-radius:8px;padding:12px;font-family:var(--mono);font-size:12px;white-space:pre-wrap;max-height:320px;overflow:auto}
table.meta{border-collapse:collapse;width:100%;font-size:12.5px}table.meta td{border-bottom:1px solid var(--line);padding:5px 4px;vertical-align:top}
`;

function shell(title: string, inner: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${inner}
<script>
// Sync scroll + hover link between panes; prev/next hunk nav; unsaved guard.
const L=document.getElementById('paneL'),R=document.getElementById('paneR');let lock=false;
function sync(a,b){a&&b&&a.addEventListener('scroll',()=>{if(lock)return;lock=true;b.scrollTop=a.scrollTop;b.scrollLeft=a.scrollLeft;lock=false;});}
sync(L,R);sync(R,L);
document.querySelectorAll('[data-h]').forEach(el=>{el.addEventListener('mouseenter',()=>{const h=el.getAttribute('data-h');document.querySelectorAll('[data-h="'+h+'"]').forEach(x=>x.style.outline='2px solid #0F5C57');});el.addEventListener('mouseleave',()=>{document.querySelectorAll('.ln').forEach(x=>x.style.outline='');});});
let dirty=false;document.querySelectorAll('textarea.code').forEach(t=>t.addEventListener('input',()=>{dirty=true;const d=document.getElementById('dirty');if(d)d.style.display='inline';}));
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'&&e.shiftKey){e.preventDefault();const s=document.getElementById('fsearch');if(s)s.focus();}});
function gotoHunk(d){const hs=[...document.querySelectorAll('.hunk')];if(!hs.length)return;let i=hs.findIndex(h=>h.getBoundingClientRect().top>80);if(i<0)i=0;if(d<0)i=Math.max(0,i-2);const t=hs[i];if(t)t.scrollIntoView({block:'start'});}
</script></body></html>`;
}

export interface ReviewQuery { q?: string; file?: string; mode?: string; ctx?: string; edit?: string; hunk?: string }

function loadFiles(doc: CodeReviewDoc): ChangedFile[] {
  const files = computeReviewFromGit(doc.workdir, doc.baselineRev);
  for (const f of files) for (const h of f.hunks) {
    const d = doc.hunkDecisions[h.id];
    if (d) h.decision = d === 'accepted' ? 'accepted' : 'rejected';
  }
  return files;
}

// Secret scan across the reviewed change set: file contents from the working
// tree (deleted files have nothing left to scan), pattern hits per path.
// Surfaced in the UI before any snapshot can be blessed from this review.
function scanReviewFiles(workdir: string, files: ChangedFile[]): Map<string, string[]> {
  const contents = readTree(workdir, files.filter((f) => f.status !== 'D').map((f) => f.path));
  const out = new Map<string, string[]>();
  for (const [p, c] of contents) {
    const hits = secretScan(c ?? '', p);
    if (hits.length > 0) out.set(p, hits);
  }
  return out;
}

function renderHunkSide(lines: ReturnType<typeof highlightLine>[] | string[], _orig: boolean): string { return ''; }
void renderHunkSide;

function hunkHtml(doc: CodeReviewDoc, f: ChangedFile, h: ChangedFile['hunks'][number], csrf: string, mode: string): string {
  const lang = languageForPath(f.path);
  const line = (t: string, cls: string, no: number | null, mk: string, hid: string) =>
    `<div class="ln ${cls}" data-h="${hid}"><span class="no">${no ?? ''}</span><span class="tx"><span class="mk">${mk}</span>${highlightLine(t, lang)}</span></div>`;
  let left = '', right = '';
  if (mode === 'inline') {
    for (const l of h.lines) {
      const cls = l.type === '+' ? 'add' : l.type === '-' ? 'del' : '';
      const mk = l.type === '+' ? '+' : l.type === '-' ? '−' : ' ';
      const no = l.type === '-' ? l.origNo : l.newNo;
      right += `<div class="ln ${cls}" data-h="${h.id}"><span class="no">${no ?? ''}</span><span class="tx"><span class="mk">${mk} </span>${highlightLine(l.text, lang)}</span></div>`;
    }
  } else {
    for (const l of h.lines) {
      if (l.type === '-') left += line(l.text, 'del', l.origNo, '− ', h.id);
      else if (l.type === ' ') left += line(l.text, '', l.origNo, '  ', h.id);
    }
    for (const l of h.lines) {
      if (l.type === '+') right += line(l.text, 'add', l.newNo, '+ ', h.id);
      else if (l.type === ' ') right += line(l.text, '', l.newNo, '  ', h.id);
    }
    if (f.status === 'A') left = `<div class="ln"><span class="no"></span><span class="tx mut">No file existed (new file).</span></div>`;
    if (f.status === 'D') right = `<div class="ln"><span class="no"></span><span class="tx mut">FILE DELETED — <button class="btn" form="noop">Restore via Reject below</button></span></div>`;
  }
  const decided = h.decision !== 'pending' ? ` <span class="mut">(${h.decision})</span>` : '';
  const attr = h.agentId ? esc(h.agentId) : 'Agent attribution unavailable';
  return `<div class="hunk" id="${h.id}"><div class="hunk-bar"><span>Lines ${h.origStart}–${h.origStart + h.origLength} → ${h.newStart}–${h.newStart + h.newLength} · ${h.changeType}${decided}</span>
<form method="post"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="hunk-accept"><input type="hidden" name="hunk" value="${esc(h.id)}"><input type="hidden" name="file" value="${esc(f.id)}"><button class="btn" type="submit">✓ Accept</button></form>
<form method="post"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="hunk-reject"><input type="hidden" name="hunk" value="${esc(h.id)}"><input type="hidden" name="file" value="${esc(f.id)}"><button class="btn dan" type="submit">× Reject</button></form>
<span class="mut">${attr}${h.planStepId ? ' · step ' + esc(h.planStepId) : ''}</span></div>
<div class="diff${mode === 'inline' ? ' inline' : ''}"><div class="pane" id="paneL"><h4>ORIGINAL (immutable baseline)</h4><pre>${left}</pre></div><div class="pane" id="paneR"><h4>AGENT VERSION (editable)</h4><pre>${right}</pre></div></div></div>`;
}

export async function renderReviewPage(db: AsyncDb, tenant: string, missionId: string, q: ReviewQuery, csrf: string, user: string): Promise<string> {
  const doc = await getReview(db, tenant, missionId);
  if (!doc) {
    const mission = await getMission(db, tenant, missionId).catch(() => null);
    return shell(`Review ${missionId}`, `<div class="top"><b>VITAL</b><span>${esc(missionId)}</span><span class="mut">no review opened</span></div>
<main style="padding:20px;max-width:720px"><div class="card"><h3>Open code review</h3>
<p class="mut">${mission ? `Mission: ${esc(mission.request.slice(0, 200))}` : 'Mission record not found — you can still review a working directory against a git baseline.'}</p>
<form method="post"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="open">
<label>Working directory <input name="workdir" required placeholder="/path/to/repo" style="width:100%"></label><br><br>
<label>Baseline git rev <input name="baseline" value="HEAD" style="width:100%"></label><br><br>
<button class="btn pri" type="submit">Open review</button></form></div></main>`);
  }
  const files = loadFiles(doc);
  const secretHits = scanReviewFiles(doc.workdir, files);
  const s = reviewSummary(files, doc);
  const groups = new Map<string, ChangedFile[]>();
  for (const f of files) {
    if (q.q && !f.path.toLowerCase().includes(q.q.toLowerCase())) continue;
    const g = groups.get(f.group) ?? [];
    g.push(f); groups.set(f.group, g);
  }
  const sel = files.find((f) => f.id === q.file) ?? [...groups.values()][0]?.[0] ?? null;
  const mode = q.mode === 'inline' ? 'inline' : 'side';
  const steps = ['Research', 'Plan', 'Approval', 'Execution', 'Verification', 'Code Review', 'Snapshot'];
  const stepHtml = steps.map((t) => t === 'Code Review' ? `<b>● ${t}</b>` : t === 'Snapshot' ? `<span>○ ${t}</span>` : `<span class="done">✓ ${t}</span>`).join(' · ');
  let sidebar = `<form method="get" style="margin-bottom:8px"><input id="fsearch" name="q" placeholder="Search changed files…" value="${esc(q.q ?? '')}" style="width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px"></form>`;
  for (const [g, fs] of groups) {
    sidebar += `<div class="mut" style="font-size:11px;margin:8px 0 2px">▼ ${esc(g)}</div>`;
    for (const f of fs) sidebar += `<a class="file-row${sel?.id === f.id ? ' sel' : ''}" href="?file=${f.id}&mode=${mode}${q.q ? `&q=${esc(q.q)}` : ''}"><span class="st ${f.status}">${f.status}</span><span>${esc(f.path)}${f.humanModified ? ' ●' : ''}</span></a>`;
  }
  if (files.length === 0) sidebar += `<p class="mut">No changes vs baseline.</p>`;

  let main = '';
  if (!sel) main = `<div class="card"><p class="mut">No files match. The working tree equals the baseline${q.q ? ` for filter “${esc(q.q)}”` : ''}.</p></div>`;
  else {
    const lang = languageForPath(sel.path);
    const selHits = secretHits.get(sel.path) ?? [];
    main += `<div class="card"><b style="font-family:var(--mono)">${esc(sel.path)}</b> <span class="st ${sel.status}">${sel.status} ${sel.status === 'M' ? 'Modified' : sel.status === 'A' ? 'Added' : sel.status === 'D' ? 'Deleted' : 'Renamed'}</span>
<span class="mut">+${sel.insertions} −${sel.deletions} · ${esc(lang)} · ${sel.hunks.length} hunks</span>
${selHits.length > 0 ? `<div class="bad" style="margin-top:6px">⚠ SECRET SCAN: ${selHits.map(esc).join(' · ')} — resolve before snapshot</div>` : ''}
<div class="tabs"><a class="btn" href="?file=${sel.id}&mode=side">Side-by-Side</a> <a class="btn" href="?file=${sel.id}&mode=inline">Inline</a>
<button class="btn" onclick="gotoHunk(-1)">↑ Prev</button> <button class="btn" onclick="gotoHunk(1)">↓ Next</button>
<a class="btn" href="?file=${sel.id}&mode=${mode}&edit=${sel.id}">✎ Edit file</a>
<form method="post" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="file-accept"><input type="hidden" name="file" value="${esc(sel.id)}"><button class="btn" type="submit">Accept file</button></form>
<form method="post" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="file-reject"><input type="hidden" name="file" value="${esc(sel.id)}"><button class="btn dan" type="submit">Reject file</button></form></div></div>`;
    if (q.edit === sel.id) {
      const cur = readTree(doc.workdir, [sel.path]).get(sel.path) ?? '';
      main += `<div class="card"><h3>Edit ${esc(sel.path)} <span class="mut">(agent version — baseline stays immutable)</span></h3>
<form method="post"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="save-edit"><input type="hidden" name="file" value="${esc(sel.id)}">
<textarea class="code" name="content">${esc(cur)}</textarea><br><span id="dirty" class="bad" style="display:none">● Unsaved changes</span><br>
<button class="btn pri" type="submit">Save to working tree</button> <a class="btn" href="?file=${sel.id}&mode=${mode}">Cancel</a></form></div>`;
    }
    for (const h of sel.hunks) main += hunkHtml(doc, sel, h, csrf, mode);
    // Comments for this file
    const cmts = doc.comments.filter((c) => c.file === sel.path);
    main += `<div class="card"><h3>Review comments (${cmts.length})</h3>`;
    for (const c of cmts) main += `<p><b>${esc(c.author)}</b> <span class="mut">line ${c.line ?? '?'} · ${esc(c.createdAt)} · ${c.status}</span><br>${esc(c.body)}${c.status === 'open' ? ` <form method="post" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="send-to-agent"><input type="hidden" name="comment" value="${esc(c.id)}"><button class="btn" type="submit">Send to Agent</button></form>` : ''}</p>`;
    main += `<form method="post"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="comment"><input type="hidden" name="filePath" value="${esc(sel.path)}"><input name="line" placeholder="line (optional)" style="width:120px"> <input name="body" required placeholder="Comment…" style="width:60%"><button class="btn" type="submit">Add Comment</button></form></div>`;
  }
  const ver = doc.verification.slice(-5).map((v) => `<div>${v.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'} <b>${esc(v.suite)}</b> ${v.passed}/${v.passed + v.failed} <span class="mut">${esc(v.at)}</span><div class="term">${esc(v.output.slice(0, 2000))}</div></div>`).join('') || '<p class="mut">Not run</p>';
  const right = `<div class="card"><h3>Change details</h3>${sel ? `<table class="meta"><tr><td>File</td><td style="font-family:var(--mono)">${esc(sel.path)}</td></tr><tr><td>Agent</td><td>${sel.agentIds.length ? esc(sel.agentIds.join(', ')) : 'Agent attribution unavailable'}</td></tr><tr><td>Hunks</td><td>${sel.hunks.length}</td></tr><tr><td>Human edits</td><td>${doc.humanEdits.filter((e) => e.file === sel.path).length}</td></tr></table>` : '<p class="mut">No file selected.</p>'}</div>
<div class="card"><h3>Timeline</h3>${doc.iterations.map((i) => `<div>v${i.n} ${esc(i.label)} <span class="mut">${esc(i.at)} · ${i.files}f +${i.insertions} −${i.deletions}</span></div>`).join('') || '<p class="mut">Review v1 — agent implementation.</p>'}${doc.humanEdits.slice(-6).map((e) => `<div>✎ ${esc(e.file)} <span class="mut">${esc(e.author)} ${esc(e.at)}</span></div>`).join('')}</div>
<div class="card"><h3>Tests / verification</h3>${ver}
<form method="post"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="run-tests"><button class="btn pri" type="submit">Run Tests</button></form></div>
<div class="card"><h3>Snapshot</h3><p class="mut">${doc.snapshotId ? `✓ ${esc(doc.snapshotId)} VERIFIED` : 'Not yet created — created only after review + verification.'}</p>
${!doc.snapshotId ? `<form method="post"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="create-snapshot"><button class="btn pri" type="submit">Create Verified Snapshot</button></form>` : `<a class="btn" href="?file=${sel?.id ?? ''}">New task from snapshot</a>`}</div>`;
  const dirty = `<span id="dirty" class="bad" style="display:none">● Unsaved changes</span>`;
  const body = `<div class="top"><b>VITAL</b><span style="font-family:var(--mono)">${esc(doc.missionId)}</span><b class="ok">✓ READY FOR REVIEW</b> ${dirty}
<div class="meter"><span>Files <b>${s.files}</b></span><span class="ok">+${s.insertions}</span><span class="bad">−${s.deletions}</span><span>Tests ${s.testsFailed ? `<span class="bad">${s.testsPassed}/${s.testsPassed + s.testsFailed} FAILED</span>` : `${s.testsPassed} passed`}</span><span>Human edits ${s.humanEdits}</span>${secretHits.size > 0 ? `<span class="bad">⚠ secrets in ${secretHits.size} file(s)</span>` : ''}<span>Status ${esc(doc.status)}</span></div>
<div><form method="post" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="accept-all"><button class="btn pri" type="submit">Accept All</button></form>
<form method="post" style="display:inline" onsubmit="return confirm('Reject ALL agent changes and restore baseline?')"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="reject-all"><input type="hidden" name="confirm" value="1"><button class="btn dan" type="submit">Reject All</button></form>
<span class="mut">reviewed by ${esc(user)}</span></div></div>
<div class="steps" style="padding:8px 20px;border-bottom:1px solid var(--line);background:#fff">${stepHtml}</div>
<div class="layout"><div class="side-l"><b>CHANGED FILES</b> (${files.length})${sidebar}</div><div class="main">${main}</div><div class="side-r">${right}</div></div>
<form id="noop" onsubmit="return false" style="display:none"></form>`;
  return shell(`Review ${doc.missionId}`, body);
}

// __ACTIONS__
