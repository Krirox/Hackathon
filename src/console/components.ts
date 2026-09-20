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

function kpiIconSvg(glyph?: string, label?: string): { svg: string; bg: string; color: string } {
  const lbl = (label || '').toLowerCase();
  const g = glyph || '';
  if (lbl.includes('human') || g === '!') {
    return {
      svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4.5c1.47-1.47 4.5-2 4.5-2"/><path d="M12 9v5s3.03-.55 4.5-2c1.47-1.47 2-4.5 2-4.5"/></svg>',
      bg: 'var(--v-tint-info-bg)',
      color: 'var(--v-tint-info-ink)',
    };
  }
  if (lbl.includes('spend') || g === '$') {
    return {
      svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
      bg: 'var(--v-tint-good-bg)',
      color: 'var(--v-tint-good-ink)',
    };
  }
  if (lbl.includes('room') || g === '#') {
    return {
      svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      bg: 'var(--v-tint-info-bg)',
      color: 'var(--v-tint-info-ink)',
    };
  }
  if (lbl.includes('drift') || lbl.includes('card') || g === '~') {
    return {
      svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
      bg: 'var(--v-tint-warn-bg)',
      color: 'var(--v-tint-warn-ink)',
    };
  }
  return {
    svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    bg: 'var(--v-bg-2, rgba(0,0,0,0.04))',
    color: 'var(--v-ink, currentColor)',
  };
}

/** KPI card (Picture 1 style): soft circular icon, label, large metric, action link. */
export function kpiCard(c: KpiCard): string {
  const icon = kpiIconSvg(c.glyph, c.label);
  const linkText = c.linkLabel ? esc(c.linkLabel) : (c.href ? `${esc(c.sub)} →` : esc(c.sub));
  const linkHtml = c.href
    ? `<a href="${esc(c.href)}" class="v-kpi-link" style="color:var(--v-muted);text-decoration:none;font-size:12px;font-weight:500;display:inline-flex;align-items:center;gap:4px;transition:color .15s ease;"><span>${esc(c.sub)}</span><span style="font-size:13px;line-height:1;margin-left:2px;">→</span></a>`
    : `<span style="color:var(--v-muted);font-size:12px;">${esc(c.sub)}</span>`;

  return `<div class="v-card v-kpi-card v-card-hover" style="display:flex;flex-direction:row;align-items:flex-start;gap:14px;padding:18px 20px;border-radius:18px;position:relative;overflow:hidden;background:var(--v-bg-1);border:1px solid var(--v-line);box-shadow:var(--v-card-shadow);transition:all .2s cubic-bezier(0.16,1,0.3,1);">
    <div style="width:40px;height:40px;border-radius:50%;background:${icon.bg};color:${icon.color};display:grid;place-items:center;flex-shrink:0;margin-top:2px;">
      ${icon.svg}
    </div>
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;">
      <div class="v-sub" style="font-size:12.5px;font-weight:500;color:var(--v-muted);">${esc(c.label)}</div>
      <div style="font-size:28px;font-weight:700;letter-spacing:-0.025em;color:var(--v-ink);font-variant-numeric:tabular-nums;line-height:1.15;margin:2px 0 4px;">${esc(c.value)}</div>
      <div style="font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:6px;">
        ${linkHtml}
      </div>
    </div>
  </div>`;
}

/* Hallmark · component: console-kit · genre: modern-minimal · theme: vital-light
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass
 */

/** Section wrapper with title, subtitle, and optional action link. */
export function sectionCard(title: string, sub: string, action: string, body: string): string {
  return `<section class="v-card v-section-card" style="padding:22px 24px;border-radius:18px;background:var(--v-bg-1);border:1px solid var(--v-line);box-shadow:var(--v-card-shadow);">
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap;">
      <div style="min-width:0;">
        <h2 class="v-card-title" style="font-size:16px;font-weight:650;letter-spacing:-0.015em;color:var(--v-ink);">${esc(title)}</h2>
        <p class="v-sub" style="font-size:12.5px;color:var(--v-muted);margin:3px 0 0;line-height:1.4;">${esc(sub)}</p>
      </div>
      <div class="section-card-action" style="flex-shrink:0;">${action}</div>
    </div>
    ${body}
  </section>`;
}

/** Small status chip: dot + label, color + text (never color alone). */
export function statusChip(status: string): string {
  const s = status.toLowerCase();
  let color = 'var(--v-muted)';
  if (s.includes('halt')) color = 'var(--v-risk)';
  else if (s.includes('degrad')) color = 'var(--v-hypo)';
  else if (s.includes('health')) color = 'var(--v-fact)';
  return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:var(--v-muted);"><span style="width:6px;height:6px;border-radius:50%;background:${color};display:inline-block;"></span>${esc(status || 'unknown')}</span>`;
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
  function draw(){list.innerHTML=filtered.length?filtered.map((it,i)=>'<button type=button data-i='+i+' style="display:flex;width:100%;text-align:left;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;border:0;cursor:pointer;background:'+(i===sel?'var(--v-accent-dim)':'transparent')+';color:var(--v-ink);font-size:13px;"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+esc(it.label)+'</span><span style="font-size:11px;color:var(--v-muted);">'+esc(it.hint||'')+(it.keys?' · '+esc(it.keys):'')+'</span></button>').join(''):'<p class=v-sub style="padding:12px;font-size:12px;">No matches. Try rooms, ledger, approvals…</p>';
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
