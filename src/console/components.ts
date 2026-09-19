/**
 * Shared console components — primitives for the operations dashboard
 * (design.md Workbench voice, brief §14 component system).
 *
 * Every primitive uses `var(--v-*)` tokens (light default, dark opt-in) and
 * renders honest fallbacks (`—`) for missing data — never invented numbers.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface KpiCard {
  label: string;
  value: string;
  sub: string;
  href?: string;
  linkLabel?: string;
  tone?: 'default' | 'accent' | 'risk' | 'good';
  glyph?: string;
}

/** KPI card (brief §6): eyebrow label, large metric, context line, action. */
export function kpiCard(c: KpiCard): string {
  const link = c.href
    ? `<a href="${esc(c.href)}" style="font-size:12px;font-weight:600;color:inherit;opacity:.85;">${esc(c.linkLabel ?? 'Inspect →')}</a>`
    : '';
  if (c.tone === 'accent') {
    return `<div class="v-card v-card-hover" style="position:relative;overflow:hidden;padding:20px;background:var(--v-accent)!important;color:var(--v-accent-ink)!important;border:0;">
    <div class="v-eyebrow" style="color:inherit;opacity:.75;display:flex;gap:6px;align-items:center;">${c.glyph ? `<span aria-hidden="true">${esc(c.glyph)}</span>` : ''}${esc(c.label)}</div>
    <div class="v-kpi" style="margin:6px 0;">${esc(c.value)}</div>
    <div style="font-size:12px;display:flex;justify-content:space-between;gap:8px;align-items:center;opacity:.9;"><span>${esc(c.sub)}</span>${link}</div>
  </div>`;
  }
  const barByTone: Record<string, string> = {
    risk: 'var(--v-risk)',
    good: 'var(--v-fact)',
    default: 'var(--v-line-strong)',
  };
  const bar = barByTone[c.tone ?? 'default'] ?? barByTone.default;
  return `<div class="v-card v-card-hover" style="position:relative;overflow:hidden;padding:20px 20px 20px 24px;">
    <div style="position:absolute;left:0;top:0;bottom:0;width:3px;background:${bar}"></div>
    <div class="v-eyebrow" style="display:flex;gap:6px;align-items:center;">${c.glyph ? `<span aria-hidden="true">${esc(c.glyph)}</span>` : ''}${esc(c.label)}</div>
    <div class="v-kpi" style="margin:6px 0;">${esc(c.value)}</div>
    <div class="v-sub" style="font-size:12px;display:flex;justify-content:space-between;gap:8px;align-items:center;"><span>${esc(c.sub)}</span>${link}</div>
  </div>`;
}

/* Hallmark · component: console-kit · genre: modern-minimal · theme: vital-light
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass
 */

/** Section wrapper with title, subtitle, and optional action link. */
export function sectionCard(title: string, sub: string, action: string, body: string): string {
  return `<section class="v-card" style="padding:20px 22px;">
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-bottom:14px;flex-wrap:wrap;">
      <div><h2 class="v-card-title">${esc(title)}</h2>
      <p class="v-sub" style="font-size:12px;margin:3px 0 0;">${esc(sub)}</p></div>
      ${action}
    </div>${body}</section>`;
}

/** Small status chip: dot + label, color + text (never color alone). */
export function statusChip(status: string): string {
  const s = status.toLowerCase();
  let color = 'var(--v-muted)';
  if (s.includes('halt')) color = 'var(--v-risk)';
  else if (s.includes('degrad')) color = 'var(--v-hypo)';
  else if (s.includes('health')) color = 'var(--v-fact)';
  return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:var(--v-muted);"><span style="width:6px;height:6px;border-radius:50%;background:${color};display:inline-block;"></span>${esc(status || '—')}</span>`;
}

export interface PaletteItem {
  label: string;
  hint: string;
  href?: string;
  run?: string;
  keys?: string;
}

/** ⌘K palette overlay + inline script. Items filter client-side by label. */
export function paletteHtml(items: PaletteItem[]): string {
  const data = JSON.stringify(items).replace(/</g, '\\u003c');
  return `<div id="vital-palette" role="dialog" aria-modal="true" aria-label="Command palette" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);backdrop-filter:blur(2px);padding:12vh 16px 16px;">
    <div class="v-card" style="max-width:560px;margin:0 auto;border-radius:14px;padding:8px;overflow:hidden;">
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--v-line);">
        <span aria-hidden="true" style="color:var(--v-muted);">⌘K</span>
        <input id="vital-palette-input" type="text" placeholder="Type a command or search rooms, claims, requests…" aria-label="Command palette" autocomplete="off"
          style="flex:1;border:0;outline:0;background:transparent;color:var(--v-ink);font-size:13.5px;">
        <kbd style="font-size:10px;color:var(--v-muted);border:1px solid var(--v-line);border-radius:4px;padding:1px 6px;">esc</kbd>
      </div>
      <div id="vital-palette-list" style="max-height:320px;overflow-y:auto;padding:6px;"></div>
      <div class="v-sub" style="padding:6px 10px;font-size:10.5px;border-top:1px solid var(--v-line);">↑↓ navigate · ↵ open · esc close</div>
    </div>
  </div>
  <script>(()=>{const ITEMS=${data};const root=document.getElementById('vital-palette');const input=document.getElementById('vital-palette-input');const list=document.getElementById('vital-palette-list');if(!root||!input||!list)return;let sel=0;let filtered=ITEMS;
  const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
  function draw(){list.innerHTML=filtered.length?filtered.map((it,i)=>'<button type=button data-i='+i+' style="display:flex;width:100%;text-align:left;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;border:0;cursor:pointer;background:'+(i===sel?'var(--v-accent-dim)':'transparent')+';color:var(--v-ink);font-size:13px;"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+esc(it.label)+'</span><span style="font-size:11px;color:var(--v-muted);">'+esc(it.hint||'')+(it.keys?' · '+esc(it.keys):'')+'</span></button>').join(''):'<p class=v-sub style="padding:12px;font-size:12px;">No matches — try rooms, ledger, approvals…</p>';
  list.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>go(Number(b.dataset.i))));}
  function go(i){const it=filtered[i];if(!it)return;close();if(it.run==='toggle-theme'){document.querySelector('[data-vital-theme-toggle]')?.click();return;}if(it.href){location.href=it.href;}}
  function open(){root.style.display='block';input.value='';filtered=ITEMS;sel=0;draw();setTimeout(()=>input.focus(),0);}
  function close(){root.style.display='none';}
  window.openVitalPalette=open;
  input.addEventListener('input',()=>{const q=input.value.toLowerCase();filtered=ITEMS.filter(it=>(it.label+' '+(it.hint||'')).toLowerCase().includes(q));sel=0;draw();});
  input.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();sel=Math.min(filtered.length-1,sel+1);draw();}else if(e.key==='ArrowUp'){e.preventDefault();sel=Math.max(0,sel-1);draw();}else if(e.key==='Enter'){e.preventDefault();go(sel);}else if(e.key==='Escape'){close();}});
  root.addEventListener('click',e=>{if(e.target===root)close();});
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();root.style.display==='block'?close():open();}else if(e.key==='/'&&!/input|textarea/i.test(document.activeElement?.tagName||'')){e.preventDefault();open();}});
  draw();})();</script>`;
}

/** Keyboard hint footer for discoverability (Huly pattern). */
export function shortcutHints(): string {
  return `<p class="v-sub" style="font-size:10.5px;margin-top:10px;">Shortcuts: <kbd>⌘K</kbd> palette · <kbd>/</kbd> search · <kbd>?</kbd> compass · <kbd>g c</kbd> chat · <kbd>g h</kbd> home</p>`;
}
