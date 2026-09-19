/* Hallmark · genre: modern-minimal · macrostructure: Workbench · design-system: design.md · designed-as-app
 * Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 */

/**
 * Console design system — the single source of every rendered color, radius,
 * shadow and type ramp. Dark is the default: it carries the VITAL brand
 * system from the marketing entry points (site/styles.css) — dot-matrix
 * canvas, glass panels, Outfit type, lime/champagne accents — so a visitor
 * walks home → signup → console without a visual hand-off seam. Light stays
 * as an opt-in "paper" mode and stores the same token names (a rule
 * referencing `var(--v-*)` never needs a theme branch).
 *
 * Genre: modern-minimal enterprise console. Macrostructure: Workbench —
 * left rail + stream + inspector, identical on every app page.
 *
 * Decision: the console is the logged-in continuation of a dark glass brand
 * journey, so dark glass is the default palette and light is the opt-in for
 * operators who prefer paper. Both mirror the same token names, and the
 * brand textures (dot-matrix canvas, grain, vignette, spotlight) are
 * token-driven so light mode gets a subdued version instead of a fork.
 *
 * Usage: every console HTML shell must (1) set `<html data-theme="…">` via
 * THEME_INIT_SCRIPT, (2) inline `themeStyleBlock()`, (3) render
 * `themeToggleButton()`. `themeDocument()` does all three for a full
 * document — call it at the response boundary so no page can ship without
 * tokens. Component CSS must use `var(--v-*)` tokens, never raw hex: this
 * file is the only place a literal color is allowed.
 */

export const VITAL_THEME_VERSION = 3;

/** Default theme when nothing is stored (brand: dark glass first). */
export const DEFAULT_THEME = 'dark';

/** Early paint script: applies stored theme before first render (no flash). */
export const THEME_INIT_SCRIPT = `(() => {
  try {
    const stored = localStorage.getItem('vital-theme');
    const theme = stored === 'light' || stored === 'dark' ? stored : '${DEFAULT_THEME}';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch { document.documentElement.dataset.theme = '${DEFAULT_THEME}'; }
})();`;

/**
 * Marker attribute on the shared toggle script element. `themeDocument()`
 * uses it to wire a toggle exactly once, and the script is itself
 * re-entrancy-guarded so a page that inlines it twice still flips once.
 */
export const THEME_TOGGLE_MARKER = 'data-theme-toggle-wired';

/**
 * Opt-out sentinel: a document carrying this marker is returned untouched by
 * `themeDocument()`. Used by the Workspace/chat document (see
 * `buzzDocument`), which mirrors upstream Buzz and keeps Buzz's own native
 * font stack and palette. The token block's `body` rule uses `!important`, so
 * injecting it there would silently re-font the chat and repaint its canvas —
 * the marker is what makes that impossible rather than merely unlikely.
 */
export const THEME_OPTOUT_MARKER = 'data-vital-no-theme';

/** Toggle behaviour: flips data-theme, persists, keeps colorScheme in sync. */
export const THEME_TOGGLE_SCRIPT = `(() => {
  if (window.__vitalThemeToggleWired) return;
  window.__vitalThemeToggleWired = true;
  const btns = document.querySelectorAll('[data-vital-theme-toggle]');
  const sync = (theme) => btns.forEach((b) => {
    b.setAttribute('aria-pressed', String(theme === 'light'));
    b.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    const label = b.querySelector('[data-theme-label]');
    if (label) label.textContent = theme === 'dark' ? 'Dark' : 'Light';
    const icon = b.querySelector('[data-theme-icon]');
    if (icon) icon.textContent = theme === 'dark' ? '●' : '○';
  });
  btns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const root = document.documentElement;
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      root.style.colorScheme = next;
      try { localStorage.setItem('vital-theme', next); } catch {}
      sync(next);
    });
  });
  try { sync(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'); } catch {}
})();`;

/** Google Fonts, preconnected — Outfit for text (brand face), JetBrains Mono for identifiers. */
export const THEME_FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

/**
 * The stylesheet body (no wrapping <style> tag). Exported so documents that
 * build their own <style> block — and the shared-state helpers — reuse the
 * exact same token definitions instead of re-declaring a drifting subset.
 */
export function themeCss(): string {
  return `
/* Hallmark · genre: modern-minimal · macrostructure: Workbench · design-system: design.md · designed-as-app */
:root,[data-theme="light"]{color-scheme:light;
--v-bg-0:#F7F8F6;--v-bg-1:#FFFFFF;--v-bg-2:#F2F4F1;--v-bg-3:#E9ECE8;
--v-ink:#111315;--v-ink-strong:#000000;--v-ink-2:#3F4643;--v-muted:#68706D;--v-faint:#929995;
--v-line:#E5E8E5;--v-line-strong:#D5DAD5;
--v-accent:#126B52;--v-accent-ink:#FFFFFF;--v-accent-dim:#DCEFE6;--v-accent-2:#2F8A68;
--v-fact:#278A59;--v-hypo:#D99A32;--v-pred:#5577B8;--v-risk:#D95C52;
--v-focus:#126B52;
--v-tint-good-bg:#DCEFE6;--v-tint-good-ink:#14532D;
--v-tint-warn-bg:#F9EDD3;--v-tint-warn-ink:#7A5410;
--v-tint-risk-bg:#F9DEDC;--v-tint-risk-ink:#8C2F29;
--v-tint-info-bg:#DDE6F5;--v-tint-info-ink:#2F4A7D;
--v-tint-prose-bg:#F2F4F1;
--v-input-bg:#FFFFFF;
--v-code-bg:#101418;--v-code-ink:#D7DCE0;
--v-card-shadow:0 1px 2px rgba(17,19,21,.04);
--v-card-shadow-hover:0 6px 20px rgba(17,19,21,.08);
--v-glass:rgba(0,0,0,.015);
/* Brand textures, paper-subdued: the same motifs as the site, dialed down so
   light mode reads as paper instead of glass. Dark overrides all of them. */
--v-glass-2:rgba(0,0,0,.03);--v-glass-3:rgba(255,255,255,.65);
--v-glass-border:rgba(17,19,21,.08);--v-glass-border-2:rgba(17,19,21,.14);
--v-glass-blur:16px;--v-glass-blur-sm:12px;
--v-canvas-dots:radial-gradient(rgba(17,19,21,.05) .7px,transparent .85px);
--v-vignette:radial-gradient(ellipse at 50% 32%,rgba(17,19,21,.02),transparent 42%),radial-gradient(ellipse at 50% 110%,rgba(17,19,21,.05),transparent 50%);
--v-spot:radial-gradient(520px circle at var(--mx) var(--my),rgba(17,19,21,.03),transparent 58%);
--v-shadow-bar:0 18px 40px rgba(17,19,21,.08);
--v-glow-accent:rgba(18,107,82,.35);
--v-grain-opacity:.025;
/* Pointer position for the spotlight gradient; the shell script updates them. */
--mx:50%;--my:38%;
--font-display:'Outfit',system-ui,sans-serif;--font-body:'Outfit',system-ui,sans-serif;--font-mono:'JetBrains Mono',ui-monospace,monospace;
--sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:20px;--sp-6:24px;--sp-8:32px;--sp-10:40px;--sp-12:48px;
/* ---------------------------------------------------------------- stage ----
   The meeting room is a dark stage in BOTH themes, the way a terminal is: it is
   a video surface, not a document, and a light meeting room would wash out the
   tiles around it. These are declared once, outside the dark block, because they
    must not flip with data-theme — the room has its own palette and one theme.

   Values are the ones the room shipped with, moved here unchanged so nothing is
   repainted: the point of the move is that a change to the stage is a change in
   one file, and that a page cannot quietly invent a 40th shade of near-black.
   Families: bg/void (canvas), 1-7 (raised surfaces), line* (dividers/borders),
   faint/muted*/ink* (text ramp), accent* (teal), good/warn/risk/info (status),
   and semi-transparent variants named <family>-<alpha>. */
--v-stage-void:#05080C;--v-stage-canvas:#080C10;
--v-stage-1:#0B111A;--v-stage-2:#0E1624;--v-stage-3:#0F172A;--v-stage-4:#111827;
--v-stage-5:#111B27;--v-stage-6:#131E2E;--v-stage-7:#141E2C;
--v-stage-line:#1E293B;--v-stage-line-2:#1E2B3C;--v-stage-line-3:#1F2937;--v-stage-line-strong:#334155;
--v-stage-faint:#475569;--v-stage-muted:#64748B;--v-stage-muted-2:#94A3B8;
--v-stage-ink-2:#CBD5E1;--v-stage-ink:#E2E8F0;--v-stage-ink-strong:#F8FAFC;
--v-stage-white:#FFFFFF;--v-stage-soft:#F1F5F9;
--v-stage-accent:#0F766E;--v-stage-accent-2:#0D9488;--v-stage-accent-dim:#0F5C57;
--v-stage-accent-dim-2:#115E59;--v-stage-accent-bright:#5EEAD4;
--v-stage-good:#10B981;--v-stage-good-2:#059669;--v-stage-good-bg:#F0FDF4;
--v-stage-warn:#D97706;--v-stage-warn-2:#B45309;--v-stage-warn-bg:#FEF3C7;
--v-stage-risk:#EF4444;--v-stage-risk-2:#DC2626;--v-stage-risk-ink:#FCA5A5;--v-stage-risk-dim:rgba(239, 68, 68, 0.2);
--v-stage-info:#0369A1;--v-stage-info-bg:#E0F2FE;
--v-stage-scrim:rgba(15, 23, 42, 0.75);
--v-stage-shadow:rgba(0,0,0,0.03);--v-stage-shadow-4:rgba(0,0,0,0.04);--v-stage-shadow-8:rgba(0,0,0,0.08);
--v-stage-shadow-10:rgba(0,0,0,0.1);--v-stage-shadow-50:rgba(0, 0, 0, 0.5);--v-stage-shadow-60:rgba(0, 0, 0, 0.6);
--v-stage-shadow-70:rgba(0,0,0,0.7);
--v-stage-teal-8:rgba(15, 92, 87, 0.08);--v-stage-teal-15:rgba(15, 118, 110, 0.15);
--v-stage-teal-35:rgba(13, 148, 136, 0.35);--v-stage-teal-40:rgba(13, 148, 136, 0.4);
--v-stage-teal-45:rgba(13, 148, 136, 0.45);
--v-stage-white-5:rgba(255, 255, 255, 0.05);
--v-stage-accent-bright-20:rgba(94, 234, 212, 0.2);--v-stage-accent-bright-10:rgba(94, 234, 212, 0.1);
--v-stage-good-70:rgba(16, 185, 129, 0.7);--v-stage-good-40:rgba(16, 185, 129, 0.4);
--v-stage-good-30:rgba(16, 185, 129, 0.3);--v-stage-good-15:rgba(16, 185, 129, 0.15);
--v-stage-good-8:rgba(16, 185, 129, 0.08);--v-stage-good-0:rgba(16, 185, 129, 0);
--ease-out:cubic-bezier(0.16,1,0.3,1);
--radius-sm:8px;--radius-md:10px;--radius-lg:14px;--radius-card:16px;--radius-xl:20px;--radius-pill:999px;--radius-input:10px}
[data-theme="dark"]{color-scheme:dark;
/* Brand glass palette — the values the marketing site ships, mapped onto the
   console token names so every component inherits the entry-point look. */
--v-bg-0:#111111;--v-bg-1:rgba(22,22,22,.82);--v-bg-2:rgba(255,255,255,.05);--v-bg-3:rgba(255,255,255,.09);
--v-ink:#F3F3F3;--v-ink-strong:#FFFFFF;--v-ink-2:#D6D6D6;--v-muted:#9A9A9A;--v-faint:#6A6A6A;
--v-line:rgba(255,255,255,.1);--v-line-strong:rgba(255,255,255,.22);
--v-accent:#D9FFA8;--v-accent-ink:#111111;--v-accent-dim:rgba(217,255,168,.15);--v-accent-2:#EAE4DC;
--v-fact:#9BE08C;--v-hypo:#E8C07A;--v-pred:#8AA4D8;--v-risk:#E87A70;
--v-focus:#D9FFA8;
--v-tint-good-bg:rgba(155,224,140,.12);--v-tint-good-ink:#B4E8A6;
--v-tint-warn-bg:rgba(232,192,122,.13);--v-tint-warn-ink:#F0CE93;
--v-tint-risk-bg:rgba(232,122,112,.13);--v-tint-risk-ink:#F0978D;
--v-tint-info-bg:rgba(138,164,216,.14);--v-tint-info-ink:#A9BEE8;
--v-tint-prose-bg:rgba(255,255,255,.035);
--v-input-bg:rgba(255,255,255,.05);
--v-code-bg:rgba(0,0,0,.42);--v-code-ink:#D7DCE0;
--v-card-shadow:0 12px 36px rgba(0,0,0,.6);
--v-card-shadow-hover:0 18px 44px rgba(0,0,0,.7);
--v-glass:rgba(16,16,16,.72);--v-glass-2:rgba(28,28,28,.9);--v-glass-3:rgba(255,255,255,.04);
--v-glass-border:rgba(255,255,255,.12);--v-glass-border-2:rgba(255,255,255,.28);
--v-canvas-dots:radial-gradient(rgba(255,255,255,.16) .7px,transparent .85px);
--v-vignette:radial-gradient(ellipse at 50% 32%,rgba(255,255,255,.05),transparent 42%),radial-gradient(ellipse at 50% 110%,rgba(0,0,0,.55),transparent 50%);
--v-spot:radial-gradient(520px circle at var(--mx) var(--my),rgba(255,255,255,.08),transparent 58%);
--v-shadow-bar:0 18px 40px rgba(0,0,0,.35);
--v-glow-accent:rgba(217,255,168,.4);
--v-grain-opacity:.045}
html,body{overflow-x:clip}
body{background:var(--v-bg-0)!important;background-image:var(--v-canvas-dots)!important;background-size:9px 9px!important;color:var(--v-ink)!important;font-family:var(--font-body);font-size:14px;font-weight:300;line-height:1.5;letter-spacing:-0.011em;-webkit-font-smoothing:antialiased}
/* Brand texture stack, same layering as the site: vignette sits under the
   content, grain over it, spotlight tracks the pointer (--mx/--my are set by
   the shell script). Both pseudo-elements are fixed and non-interactive. */
body::before{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;background:var(--v-vignette)}
body::after{content:'';position:fixed;inset:0;z-index:90;pointer-events:none;opacity:var(--v-grain-opacity);mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
h1,h2,h3,h4{font-style:normal;overflow-wrap:anywhere;min-width:0}
img,svg{max-width:100%}
/* ---------------------------------------------------------------- typography */
.v-page-title{font-size:clamp(26px,3.2vw,36px);font-weight:700;letter-spacing:-0.025em;line-height:1.15;margin:0}
.v-section-title{font-size:20px;font-weight:650;letter-spacing:-0.02em;margin:0}
.v-card-title{font-size:15.5px;font-weight:650;letter-spacing:-0.012em;margin:0}
.v-sub{color:var(--v-muted)!important}
.v-eyebrow{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.18em;color:var(--v-muted)}
/* Brand wordmark + eyebrow pulse, mirroring .signup-mark / .badge-pulse-dot
   on the marketing pages so entry points and console share one voice. */
.v-wordmark{font-family:var(--font-display);font-size:20px;font-weight:500;letter-spacing:.25em;color:var(--v-ink-strong);text-transform:uppercase;text-decoration:none;white-space:nowrap}
.v-wordmark sup{font-size:.5em;letter-spacing:0;margin-left:2px;color:var(--v-muted)}
.v-pulse-dot{width:6px;height:6px;border-radius:50%;background:var(--v-accent);box-shadow:0 0 10px var(--v-glow-accent);flex-shrink:0;animation:v-pulse 2.4s var(--ease-out) infinite}
@keyframes v-pulse{0%,100%{opacity:1}50%{opacity:.45}}
/* Pointer-tracked spotlight layer; the shell sets --mx/--my on :root. */
.v-spot{position:fixed;inset:0;z-index:0;pointer-events:none;background:var(--v-spot)}
.v-meta{font-size:12px;color:var(--v-faint)}
.v-mono{font-family:var(--font-mono)}
.v-num{font-variant-numeric:tabular-nums}
.v-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.v-lede{font-size:13px;color:var(--v-muted);margin:6px 0 0;max-width:78ch;line-height:1.55}
/* -------------------------------------------------------------------- layout */
.v-shell{display:flex;min-height:100vh;width:100%;background:var(--v-bg-0)}
.v-main{flex:1;min-width:0;display:flex;flex-direction:column}
.v-page{max-width:1360px;width:100%;margin:0 auto;padding:24px 32px}
.v-stack{display:grid;gap:16px}
.v-stack-sm{display:grid;gap:10px}
.v-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr))}
.v-grid-2{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))}
.v-grid-3{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))}
.v-grid-wide{display:grid;gap:16px;grid-template-columns:minmax(0,2fr) minmax(0,1fr)}
@media (max-width:1100px){.v-grid-wide{grid-template-columns:minmax(0,1fr)}}
.v-split{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.v-divider{height:1px;background:var(--v-line);border:0;margin:0}
/* ------------------------------------------------------------------ surfaces */
.v-card{background:var(--v-bg-1)!important;border:1px solid var(--v-line)!important;border-radius:var(--radius-card);box-shadow:var(--v-card-shadow);padding:20px 22px;backdrop-filter:var(--v-glass-blur);-webkit-backdrop-filter:var(--v-glass-blur)}
.v-card-flush{padding:0;overflow:hidden}
.v-card-hover{transition:border-color .15s var(--ease-out),box-shadow .15s var(--ease-out),transform .15s var(--ease-out)}
.v-card-hover:hover{border-color:var(--v-line-strong);box-shadow:var(--v-card-shadow-hover);transform:translateY(-1px)}
.v-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.v-accent-card{background:var(--v-accent)!important;color:var(--v-accent-ink)!important;border:0!important}
.v-accent-card .v-eyebrow,.v-accent-card .v-sub,.v-accent-card .v-meta{color:inherit!important;opacity:.82}
/* ----------------------------------------------------------------- KPI cards */
.v-kpi-card{position:relative;display:flex;flex-direction:column;gap:6px;min-width:0}
.v-kpi{font-size:clamp(28px,3.4vw,38px);font-weight:700;letter-spacing:-0.03em;line-height:1.05;font-variant-numeric:tabular-nums}
.v-kpi-label{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--v-muted)}
.v-kpi-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--v-muted);flex-wrap:wrap}
.v-delta{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:var(--radius-pill);background:var(--v-bg-2);color:var(--v-ink-2);border:1px solid var(--v-line)}
.v-delta-good{background:var(--v-tint-good-bg);color:var(--v-tint-good-ink);border-color:transparent}
.v-delta-warn{background:var(--v-tint-warn-bg);color:var(--v-tint-warn-ink);border-color:transparent}
.v-delta-risk{background:var(--v-tint-risk-bg);color:var(--v-tint-risk-ink);border-color:transparent}
.v-sparkline{display:block;width:100%;height:34px;overflow:visible}
.v-sparkline polyline{fill:none;stroke:var(--v-accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.v-sparkline .area{fill:var(--v-accent-dim);stroke:none}
/* --------------------------------------------------------------------- chips */
.v-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:3px 10px;border-radius:var(--radius-pill);border:1px solid var(--v-line);background:var(--v-bg-1);color:var(--v-ink-2);white-space:nowrap;line-height:1.4}
.v-badge .dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0}
.v-badge-good{background:var(--v-tint-good-bg);color:var(--v-tint-good-ink);border-color:transparent}
.v-badge-warn{background:var(--v-tint-warn-bg);color:var(--v-tint-warn-ink);border-color:transparent}
.v-badge-risk{background:var(--v-tint-risk-bg);color:var(--v-tint-risk-ink);border-color:transparent}
.v-badge-info{background:var(--v-tint-info-bg);color:var(--v-tint-info-ink);border-color:transparent}
.v-tag{display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:10.5px;font-weight:500;padding:2px 7px;border-radius:var(--radius-sm);background:var(--v-bg-2);color:var(--v-muted);border:1px solid var(--v-line)}
/* ------------------------------------------------------------------ controls */
.v-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:var(--radius-md);padding:9px 16px;font-size:13.5px;font-weight:600;cursor:pointer;border:1px solid transparent;min-height:40px;font-family:inherit;line-height:1.2;transition:filter .15s var(--ease-out),background .15s var(--ease-out),border-color .15s var(--ease-out),color .15s var(--ease-out);white-space:nowrap;text-decoration:none}
.v-btn-primary{background:var(--v-accent);color:var(--v-accent-ink)}
.v-btn-primary:hover{filter:brightness(1.07);text-decoration:none}
.v-btn-secondary{background:var(--v-bg-1);color:var(--v-ink);border-color:var(--v-line-strong)}
.v-btn-secondary:hover{border-color:var(--v-accent);color:var(--v-accent);text-decoration:none}
.v-btn-ghost{background:transparent;color:var(--v-ink-2);border-color:transparent}
.v-btn-ghost:hover{background:var(--v-bg-2);color:var(--v-ink);text-decoration:none}
.v-btn-danger{background:var(--v-tint-risk-bg);color:var(--v-tint-risk-ink)}
.v-btn-sm{min-height:32px;padding:6px 12px;font-size:12.5px;border-radius:var(--radius-sm)}
.v-btn:active{transform:translateY(1px)}
.v-btn:disabled{opacity:.55;cursor:not-allowed}
.v-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:var(--radius-md);border:1px solid var(--v-line);background:var(--v-bg-1);color:var(--v-ink-2);cursor:pointer;flex-shrink:0;transition:background .15s var(--ease-out),color .15s var(--ease-out),border-color .15s var(--ease-out)}
.v-icon-btn:hover{background:var(--v-bg-2);color:var(--v-ink);border-color:var(--v-line-strong)}
.v-input{background:var(--v-input-bg);border:1px solid var(--v-line-strong);border-radius:var(--radius-input);padding:9px 12px;font-size:13.5px;color:var(--v-ink);font-family:inherit;width:100%;transition:border-color .15s var(--ease-out),box-shadow .15s var(--ease-out)}
.v-input:focus{border-color:var(--v-accent);outline:none;box-shadow:0 0 0 3px var(--v-accent-dim)}
.v-input::placeholder{color:var(--v-faint)}
select.v-input,.v-select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--v-muted) 50%),linear-gradient(135deg,var(--v-muted) 50%,transparent 50%);background-position:calc(100% - 16px) 50%,calc(100% - 11px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:32px;cursor:pointer}
.v-search{display:flex;align-items:center;gap:9px;background:var(--v-bg-2);border:1px solid transparent;border-radius:var(--radius-md);padding:0 12px;height:38px;color:var(--v-muted);transition:background .15s var(--ease-out),border-color .15s var(--ease-out)}
.v-search:hover{border-color:var(--v-line-strong);color:var(--v-ink-2)}
.v-search input{border:0;outline:0;background:transparent;font-size:13px;color:var(--v-ink);width:100%;font-family:inherit;min-width:0}
.v-search input::placeholder{color:var(--v-faint)}
.v-search kbd{font-family:var(--font-body);font-size:10px;color:var(--v-faint);border:1px solid var(--v-line);background:var(--v-bg-1);border-radius:5px;padding:1px 5px}
/* --------------------------------------------------------------------- tabs */
.v-tabs{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.v-tab{display:inline-flex;align-items:center;gap:7px;padding:7px 14px;border-radius:var(--radius-pill);border:1px solid var(--v-line);background:var(--v-bg-1);color:var(--v-ink-2);font-size:12.5px;font-weight:600;text-decoration:none;transition:all .15s var(--ease-out);white-space:nowrap;cursor:pointer}
.v-tab:hover{border-color:var(--v-line-strong);color:var(--v-ink);text-decoration:none}
.v-tab[aria-current="page"],.v-tab[aria-current="true"],.v-tab.v-tab-active{background:var(--v-ink);border-color:var(--v-ink);color:var(--v-bg-1)}
.v-tab-count{font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:var(--radius-pill);background:var(--v-line);color:var(--v-ink-2)}
/* ------------------------------------------------- accessibility utilities */
.v-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
/* ----------------------------------------------------------- list page frame */
.v-page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.v-page-head h1{margin:4px 0 0}
.v-filterbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--v-bg-1);border:1px solid var(--v-line);border-radius:var(--radius-lg);padding:12px 14px;margin-bottom:16px;max-width:none}
.v-filterbar .v-input{flex:1;min-width:200px;width:auto}
.v-count{margin:0 0 14px}
/* Progressive disclosure inside a filter bar: the primary fields stay visible,
   the long tail opens on demand so the default view is not a wall of inputs. */
.v-disclose{position:relative}
.v-disclose>summary{list-style:none;cursor:pointer;user-select:none}
.v-disclose>summary::-webkit-details-marker{display:none}
.v-disclose>summary::after{content:'⌄';margin-left:6px;display:inline-block;transition:transform .15s var(--ease-out)}
.v-disclose[open]>summary::after{transform:rotate(180deg)}
.v-disclose[open]{flex-basis:100%}
.v-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-top:12px;padding-top:12px;border-top:1px solid var(--v-line)}
.v-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.v-field-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--v-muted)}
.v-field .v-input{flex:none;width:100%;min-width:0}
/* Monospaced literal in a table cell: an identifier, not prose. */
.v-code-pill{font-family:var(--font-mono);font-size:12px;background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:6px;padding:2px 7px;color:var(--v-ink-2);white-space:nowrap}
.v-list{list-style:none;margin:6px 0 0;padding:0}
/* Segmented control: mutually exclusive windows, one visible selection. */
.v-segmented{display:inline-flex;align-items:center;gap:2px;background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:var(--radius-input);padding:3px}
.v-segmented a{padding:6px 12px;border-radius:calc(var(--radius-input) - 3px);font-size:12.5px;font-weight:550;color:var(--v-muted);text-decoration:none;white-space:nowrap;transition:background .15s var(--ease-out),color .15s var(--ease-out)}
.v-segmented a:hover{color:var(--v-ink);background:var(--v-bg-1)}
.v-segmented a[aria-current="page"]{background:var(--v-bg-1);color:var(--v-ink);box-shadow:var(--v-card-shadow)}
.v-list-group{margin-bottom:18px}
.v-list-group:last-child{margin-bottom:0}
.v-list-group>h2{font-size:15.5px;font-weight:650;letter-spacing:-0.012em;margin:0 0 10px;display:flex;align-items:center;gap:8px}
.v-pager{display:flex;align-items:center;gap:10px;margin-top:16px;flex-wrap:wrap}
/* -------------------------------------------------------------------- table */
.v-table-wrap{overflow-x:auto;border:1px solid var(--v-line);border-radius:var(--radius-lg);background:var(--v-bg-1)}
.v-table{width:100%;border-collapse:collapse;font-size:13.5px}
.v-table th{text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--v-muted);padding:11px 16px;border-bottom:1px solid var(--v-line);white-space:nowrap;background:var(--v-bg-1)}
.v-table td{padding:13px 16px;border-bottom:1px solid var(--v-line);vertical-align:middle;color:var(--v-ink-2)}
.v-table td strong,.v-table td .v-strong{color:var(--v-ink);font-weight:600}
.v-table tbody tr:last-child td{border-bottom:0}
.v-table tbody tr{transition:background .12s var(--ease-out)}
.v-table tbody tr:hover{background:var(--v-bg-2)}
.v-table .v-num{text-align:right}
/* ----------------------------------------------------------- lists & feeds */
.v-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 2px;border-bottom:1px solid var(--v-line);min-width:0}
.v-row:last-child{border-bottom:0}
.v-row-main{display:flex;align-items:center;gap:10px;min-width:0}
.v-feed{display:grid;gap:2px}
.v-feed-item{display:flex;gap:12px;padding:11px 0;border-bottom:1px solid var(--v-line);min-width:0}
.v-feed-item:last-child{border-bottom:0}
.v-feed-icon{width:30px;height:30px;border-radius:var(--radius-sm);display:grid;place-items:center;flex-shrink:0;background:var(--v-bg-2);color:var(--v-ink-2)}
.v-feed-icon.v-feed-good{background:var(--v-tint-good-bg);color:var(--v-tint-good-ink)}
.v-feed-icon.v-feed-warn{background:var(--v-tint-warn-bg);color:var(--v-tint-warn-ink)}
.v-feed-icon.v-feed-risk{background:var(--v-tint-risk-bg);color:var(--v-tint-risk-ink)}
.v-feed-icon.v-feed-info{background:var(--v-tint-info-bg);color:var(--v-tint-info-ink)}
.v-feed-body{min-width:0;flex:1}
.v-feed-title{font-size:13px;font-weight:600;color:var(--v-ink);overflow-wrap:anywhere}
.v-feed-meta{font-size:11.5px;color:var(--v-faint);margin-top:2px}
.v-feed-time{font-size:11px;color:var(--v-faint);white-space:nowrap;font-variant-numeric:tabular-nums;padding-top:2px}
/* --------------------------------------------------------------- attention */
.v-attention{display:grid;gap:8px}
.v-attention-item{display:flex;align-items:center;gap:10px;padding:11px 13px;border-radius:var(--radius-md);border:1px solid var(--v-line);background:var(--v-bg-1);font-size:13px;color:var(--v-ink);text-decoration:none;transition:border-color .15s var(--ease-out),background .15s var(--ease-out)}
.v-attention-item:hover{border-color:var(--v-line-strong);background:var(--v-bg-2);text-decoration:none}
.v-attention-item .v-attention-count{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums}
.v-attention-risk{border-left:3px solid var(--v-risk)}
.v-attention-warn{border-left:3px solid var(--v-hypo)}
.v-attention-info{border-left:3px solid var(--v-pred)}
.v-attention-good{border-left:3px solid var(--v-fact)}
/* -------------------------------------------------------------- progress */
.v-progress{height:6px;background:var(--v-line);border-radius:var(--radius-pill);overflow:hidden}
.v-progress>i{display:block;height:100%;background:var(--v-accent);border-radius:var(--radius-pill);transition:width .3s var(--ease-out)}
.v-progress-risk>i{background:var(--v-risk)}
.v-progress-warn>i{background:var(--v-hypo)}
/* ------------------------------------------------------- breadcrumb & pager */
.v-breadcrumb{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--v-muted);min-width:0}
.v-breadcrumb a{color:var(--v-muted);text-decoration:none}
.v-breadcrumb a:hover{color:var(--v-ink)}
.v-breadcrumb .sep{color:var(--v-faint)}
.v-breadcrumb strong{color:var(--v-ink);font-weight:600}
.v-pagination{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--v-muted);flex-wrap:wrap}
.v-pagination a{color:var(--v-ink-2);text-decoration:none;padding:5px 11px;border:1px solid var(--v-line);border-radius:var(--radius-sm);background:var(--v-bg-1)}
.v-pagination a:hover{border-color:var(--v-accent);color:var(--v-accent)}
/* ------------------------------------------------------------------ avatar */
.v-avatar{width:32px;height:32px;border-radius:50%;background:var(--v-accent);color:var(--v-accent-ink);display:grid;place-items:center;font-size:11.5px;font-weight:700;flex-shrink:0;letter-spacing:0}
.v-avatar-sm{width:24px;height:24px;font-size:10px}
.v-avatar-ring{border:2px solid var(--v-bg-1);box-shadow:0 0 0 1px var(--v-line)}
/* ------------------------------------------------------------------ states */
.v-empty{border:1px dashed var(--v-line-strong);border-radius:var(--radius-card);padding:34px 24px;text-align:center;color:var(--v-muted);background:var(--v-bg-1)}
.v-empty h3{font-size:15px;color:var(--v-ink);margin:0 0 6px;font-weight:650}
.v-empty p{font-size:13px;margin:0 0 14px;line-height:1.55}
.v-skeleton{border-radius:var(--radius-sm);background:linear-gradient(90deg,var(--v-bg-2) 25%,var(--v-bg-3) 50%,var(--v-bg-2) 75%);background-size:200% 100%;animation:v-shimmer 1.4s linear infinite}
@keyframes v-shimmer{to{background-position:-200% 0}}
.v-spinner{width:15px;height:15px;border-radius:50%;border:2px solid var(--v-line-strong);border-top-color:var(--v-accent);display:inline-block;animation:v-spin .7s linear infinite;vertical-align:-2px}
@keyframes v-spin{to{transform:rotate(360deg)}}
.v-error{border:1px solid var(--v-line);border-left:3px solid var(--v-risk);border-radius:var(--radius-md);padding:13px 16px;background:var(--v-tint-risk-bg);color:var(--v-tint-risk-ink);font-size:13px}
.v-success{border:1px solid var(--v-line);border-left:3px solid var(--v-fact);border-radius:var(--radius-md);padding:13px 16px;background:var(--v-tint-good-bg);color:var(--v-tint-good-ink);font-size:13px}
/* ------------------------------------------------------------------ tooltip */
[data-vtip]{position:relative}
[data-vtip]:hover::after,[data-vtip]:focus-visible::after{content:attr(data-vtip);position:absolute;left:50%;bottom:calc(100% + 7px);transform:translateX(-50%);background:var(--v-ink);color:var(--v-bg-1);font-size:11px;font-weight:500;padding:5px 9px;border-radius:var(--radius-sm);white-space:nowrap;z-index:60;pointer-events:none;box-shadow:var(--v-card-shadow-hover)}
/* ------------------------------------------------------------------- drawer */
.v-drawer-backdrop{position:fixed;inset:0;background:rgba(10,15,20,.42);z-index:80;animation:v-fade .15s var(--ease-out)}
.v-drawer{position:fixed;top:0;right:0;bottom:0;width:min(440px,92vw);background:var(--v-bg-1);border-left:1px solid var(--v-line);z-index:81;display:flex;flex-direction:column;box-shadow:-12px 0 40px rgba(0,0,0,.14);animation:v-slide .2s var(--ease-out)}
.v-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--v-line)}
.v-drawer-body{padding:18px 20px;overflow-y:auto;flex:1}
@keyframes v-fade{from{opacity:0}}
@keyframes v-slide{from{transform:translateX(22px);opacity:.6}}
@keyframes v-rise{from{opacity:0;transform:translateY(6px)}}
.v-rise{animation:v-rise .28s var(--ease-out) both}
/* ---------------------------------------------------------------- inspector */
.v-inspector{width:288px;flex-shrink:0;border-left:1px solid var(--v-line);background:var(--v-bg-1);padding:20px 18px;overflow-y:auto}
.v-inspector h2{font-size:13px;font-weight:700;margin:0 0 12px;letter-spacing:0.01em}
.v-inspector-card{background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:var(--radius-md);padding:11px 12px}
@media (max-width:1200px){.v-inspector{display:none}}
/* ------------------------------------------------------------ compat names */
/* Legacy class names still emitted by page fragments map onto the same
   tokens, so no page needs a private palette to look native. */
.card{background:var(--v-bg-1);border:1px solid var(--v-line);border-radius:var(--radius-card);padding:20px 22px;box-shadow:var(--v-card-shadow);margin:0 0 16px}
.sub{color:var(--v-muted);font-size:12.5px;line-height:1.5}
.err{color:var(--v-risk);font-size:13px}
.badge{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:11px;font-weight:500;padding:3px 8px;border-radius:var(--radius-sm);border:1px solid var(--v-line);background:var(--v-bg-2);color:var(--v-ink-2)}
.success{border:1px solid var(--v-line);border-left:3px solid var(--v-fact);border-radius:var(--radius-md);padding:13px 16px;margin:12px 0;background:var(--v-tint-good-bg);color:var(--v-tint-good-ink);font-size:13px}
.error-summary{border:1px solid var(--v-line);border-left:3px solid var(--v-risk);border-radius:var(--radius-md);padding:13px 16px;margin:12px 0;background:var(--v-tint-risk-bg);color:var(--v-tint-risk-ink);font-size:13px}
pre{background:var(--v-bg-2);border:1px solid var(--v-line);border-radius:var(--radius-sm);padding:12px 14px;overflow-x:auto;font-family:var(--font-mono);font-size:12px;line-height:1.5}
code{font-family:var(--font-mono);font-size:12px;background:var(--v-bg-2);padding:2px 6px;border-radius:5px}
/* ---------------------------------------------------------------- misc base */
/* First focusable element on every page: lets a keyboard user jump past the
   rail and top bar straight into the task surface. */
a.skip-link,.skip-link{position:absolute;left:-9999px;top:0;z-index:200;background:var(--v-accent);color:var(--v-accent-ink)!important;padding:9px 16px;border-radius:0 0 var(--radius-sm) 0;font-size:13px;font-weight:600;text-decoration:none}
a.skip-link:focus,.skip-link:focus-visible{left:0;outline-offset:-2px}
a{color:var(--v-accent);text-decoration:none}
a:hover{text-decoration:underline}
button{font-family:var(--font-body)}
:focus-visible{outline:2px solid var(--v-focus)!important;outline-offset:2px}
::selection{background:var(--v-accent-dim);color:var(--v-ink)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.15s!important;transition-duration:.15s!important}.v-card-hover:hover{transform:none}.v-pulse-dot{animation:none}}
@media (max-width:900px){.v-page{padding:16px}.v-card{padding:16px 16px}}
[data-vital-theme-toggle]{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--v-line-strong);background:var(--v-bg-1);color:var(--v-ink);border-radius:var(--radius-pill);padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
[data-vital-theme-toggle]:hover{border-color:var(--v-accent)}
/* ============================================================ agent tasks ==
   The "Ongoing Tasks" monitor for long-running Jcode executions. Every class
   is token-only (var(--v-*)) so it inherits dark-glass default + light opt-in
   for free; per-agent real-time state is expressed via [data-state=…], never
   a color alone. See docs/agent-tasks-dashboard.md §13. */
.v-live{display:inline-flex;align-items:center;gap:7px;font-family:var(--font-mono);font-size:10.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--v-muted);border:1px solid var(--v-line);border-radius:var(--radius-pill);padding:4px 11px;background:var(--v-bg-1)}
.v-live-dot{width:7px;height:7px;border-radius:50%;background:var(--v-faint);flex-shrink:0}
.v-live[data-state="live"]{color:var(--v-tint-good-ink);border-color:transparent;background:var(--v-tint-good-bg)}
.v-live[data-state="live"] .v-live-dot{background:var(--v-fact);box-shadow:0 0 10px var(--v-glow-accent);animation:v-pulse 1.8s var(--ease-out) infinite}
.v-tasks{display:grid;gap:8px}
.v-task-row{border:1px solid var(--v-line);border-radius:var(--radius-card);background:var(--v-bg-1);overflow:hidden;transition:border-color .15s var(--ease-out),box-shadow .15s var(--ease-out)}
.v-task-row[open]{border-color:var(--v-line-strong);box-shadow:var(--v-card-shadow)}
.v-task-row>summary{list-style:none;cursor:pointer}
.v-task-row>summary::-webkit-details-marker{display:none}
.v-task-row-head{display:flex;align-items:flex-start;gap:14px;padding:14px 18px}
.v-task-row-head:hover{background:var(--v-bg-2)}
.v-task-status{flex-shrink:0;padding-top:2px}
.v-task-main{flex:1;min-width:0}
.v-task-side{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:5px}
.v-task-count{font-family:var(--font-mono);font-size:11px;color:var(--v-muted)}
.v-task-detail{border-top:1px solid var(--v-line);padding:14px 18px 16px;display:grid;gap:12px;animation:v-rise .24s var(--ease-out) both}
.v-task-detail-actions{display:flex;gap:8px}
/* Per-agent derived state dot — the honest substitute for a status column that
   does not exist in the schema. Shape + label always accompany color. */
.v-agent-dot{width:9px;height:9px;border-radius:50%;background:var(--v-faint);flex-shrink:0;display:inline-block}
.v-agent-dot[data-state="processing"]{background:var(--v-accent);box-shadow:0 0 8px var(--v-glow-accent);animation:v-pulse 1.4s var(--ease-out) infinite}
.v-agent-dot[data-state="waiting"]{background:var(--v-pred)}
.v-agent-dot[data-state="done"]{background:var(--v-fact)}
.v-agent-dot[data-state="risk"]{background:var(--v-risk)}
.v-agent-tree{display:grid;gap:2px}
.v-agent-tree-row{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:var(--radius-sm);min-width:0}
.v-agent-tree-row.is-active{background:var(--v-accent-dim)}
.v-agent-tree-row--primary{font-weight:600}
.v-agent-tree-row--depth-2{margin-left:20px;border-left:2px solid var(--v-line);border-radius:0}
.v-agent-tree-row--depth-3{margin-left:40px;border-left:2px solid var(--v-line);border-radius:0}
.v-agent-tree-row--depth-4{margin-left:60px;border-left:2px solid var(--v-line);border-radius:0}
.v-agent-tree-main{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px}
.v-agent-tree-goal{font-size:12px;color:var(--v-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.v-guardstrip{display:flex;flex-wrap:wrap;gap:8px}
.v-guard{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:11px;padding:4px 10px;border-radius:var(--radius-sm);border:1px solid var(--v-line);background:var(--v-bg-2);color:var(--v-ink-2)}
.v-guard__k{color:var(--v-muted);text-transform:uppercase;letter-spacing:.06em;font-size:9.5px}
.v-guard[data-state="warn"]{background:var(--v-tint-warn-bg);color:var(--v-tint-warn-ink);border-color:transparent}
.v-guard[data-state="risk"]{background:var(--v-tint-risk-bg);color:var(--v-tint-risk-ink);border-color:transparent}
.v-swarm-chain{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border-radius:var(--radius-md);background:var(--v-tint-prose-bg);border:1px dashed var(--v-line-strong)}
.v-swarm-label{font-family:var(--font-mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--v-muted)}
.v-swarm-hop{font-family:var(--font-mono);font-size:11px;padding:2px 8px;border-radius:var(--radius-pill);background:var(--v-bg-1);border:1px solid var(--v-line);color:var(--v-ink-2)}
.v-swarm-sep{color:var(--v-faint)}
.v-progress--hatch>i{background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.18) 0 6px,transparent 6px 12px)}
.v-progress--hatch[data-state="processing"]>i{animation:v-hatch .8s linear infinite}
@keyframes v-hatch{to{background-position:24px 0}}
@media (prefers-reduced-motion:reduce){.v-progress--hatch>i{animation:none}.v-live[data-state="live"] .v-live-dot{animation:none}.v-agent-dot[data-state="processing"]{animation:none}}
`.trim();
}

/** The token + component stylesheet as a <style> element. */
export function themeStyleBlock(): string {
  return `<style>${themeCss()}</style>`;
}

/**
 * The stage (--v-stage-*) palette, as a standalone `:root` block.
 *
 * The live meeting room is a full document that deliberately does NOT ship the
 * console stylesheet — it is a video surface, not an app page — but its CSS
 * speaks in --v-stage-* tokens. Before this existed those var() references
 * resolved to nothing and the room rendered unstyled. The room inlines this
 * block instead. Keep in sync with the stage family inside themeCss() above.
 */
export function stageTokensCss(): string {
  return `:root{
--v-stage-void:#05080C;--v-stage-canvas:#080C10;
--v-stage-1:#0B111A;--v-stage-2:#0E1624;--v-stage-3:#0F172A;--v-stage-4:#111827;
--v-stage-5:#111B27;--v-stage-6:#131E2E;--v-stage-7:#141E2C;
--v-stage-line:#1E293B;--v-stage-line-2:#1E2B3C;--v-stage-line-3:#1F2937;--v-stage-line-strong:#334155;
--v-stage-faint:#475569;--v-stage-muted:#64748B;--v-stage-muted-2:#94A3B8;
--v-stage-ink-2:#CBD5E1;--v-stage-ink:#E2E8F0;--v-stage-ink-strong:#F8FAFC;
--v-stage-white:#FFFFFF;--v-stage-soft:#F1F5F9;
--v-stage-accent:#0F766E;--v-stage-accent-2:#0D9488;--v-stage-accent-dim:#0F5C57;
--v-stage-accent-dim-2:#115E59;--v-stage-accent-bright:#5EEAD4;
--v-stage-good:#10B981;--v-stage-good-2:#059669;
--v-stage-warn:#D97706;--v-stage-warn-2:#B45309;
--v-stage-risk:#EF4444;--v-stage-risk-2:#DC2626;--v-stage-risk-ink:#FCA5A5;--v-stage-risk-dim:rgba(239, 68, 68, 0.2);
--v-stage-info:#0369A1;
--v-stage-scrim:rgba(15, 23, 42, 0.75);
--v-stage-shadow-50:rgba(0, 0, 0, 0.5);--v-stage-shadow-60:rgba(0, 0, 0, 0.6);--v-stage-shadow-70:rgba(0,0,0,0.7);
--v-stage-white-5:rgba(255, 255, 255, 0.05);
--v-stage-accent-bright-20:rgba(94, 234, 212, 0.2);--v-stage-accent-bright-10:rgba(94, 234, 212, 0.1);
--v-stage-good-70:rgba(16, 185, 129, 0.7);--v-stage-good-40:rgba(16, 185, 129, 0.4);
--v-stage-good-30:rgba(16, 185, 129, 0.3);
--ease-out:cubic-bezier(0.16,1,0.3,1);
--radius-pill:999px}`;
}

/** Small pill toggle rendered in every top bar / account cluster. */
export function themeToggleButton(): string {
  return `<button type="button" data-vital-theme-toggle aria-pressed="true" aria-label="Switch to light theme" title="Toggle light / dark theme"><span data-theme-icon aria-hidden="true">●</span><span data-theme-label>Dark</span></button>`;
}

/** Everything a document head needs before first paint: fonts, theme, tokens. */
export function themeHead(): string {
  return `${THEME_FONT_LINKS}\n<script>${THEME_INIT_SCRIPT}</script>\n${themeStyleBlock()}`;
}

/**
 * Guarantees a full HTML document carries the design system exactly once:
 * `data-theme` on <html>, the early paint script, the token block, and the
 * toggle wiring. Idempotent — a document that already inlined tokens is
 * returned unchanged (modulo the toggle script, which is wired defensively).
 *
 * Fragments (no <html>) and non-HTML bodies are returned untouched, so this
 * is safe to run at the response boundary over every page producer in
 * src/console without each one having to remember the token block.
 */
export function themeDocument(html: string): string {
  if (!/<html[\s>]/i.test(html)) return html;
  // Surfaces that own their own look (the Buzz chat) opt out entirely.
  if (html.includes(THEME_OPTOUT_MARKER)) return html;
  let out = html;
  const already = out.includes('--v-bg-0:');
  // 1. data-theme + color-scheme, without clobbering an existing attribute.
  out = out.replace(/<html([^>]*)>/i, (_m, attrs: string) =>
    /data-theme=/.test(attrs) ? `<html${attrs}>` : `<html${attrs} data-theme="${DEFAULT_THEME}">`,
  );
  // 2. Inject head payload once, immediately after <head> when present.
  //    Font links are skipped when the document already preconnects them,
  //    and the early-paint script only when it is genuinely missing.
  const fonts = out.includes('fonts.googleapis.com') ? '' : THEME_FONT_LINKS;
  const init = out.includes("localStorage.getItem('vital-theme')") ? '' : `<script>${THEME_INIT_SCRIPT}</script>`;
  const payload = `${already ? '' : `${fonts}${themeStyleBlock()}`}${init}`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, (m) => `${m}${payload}`);
  } else {
    out = out.replace(
      /<html([^>]*)>/i,
      (m) =>
        `${m}<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${payload}</head>`,
    );
  }
  // 3. Toggle wiring, once, before </body> — only when a toggle is rendered.
  if (!out.includes('data-vital-theme-toggle') || out.includes(THEME_TOGGLE_MARKER)) return out;
  const script = `<script ${THEME_TOGGLE_MARKER}>${THEME_TOGGLE_SCRIPT}</script>`;
  return out.includes('</body>') ? out.replace('</body>', `${script}</body>`) : `${out}${script}`;
}
