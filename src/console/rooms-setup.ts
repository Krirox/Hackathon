import { CANONICAL_ROOMS, loadRoomConfig, saveRoomConfig, type RoomConfig, type RoomAutonomy } from '../talk/rooms.ts';
import type { AsyncDb } from '../core/db.ts';

export interface PresetDefinition {
  id: string;
  name: string;
  description: string;
  scopes: string[];
}

export const INDUSTRY_PRESETS: PresetDefinition[] = [
  {
    id: 'fintech',
    name: 'FinTech & Capital Markets',
    description:
      'Autonomous counterparty risk hedging, Stripe billing sync, EU AI Act compliance, and warehouse verification.',
    scopes: ['core', 'risk', 'compliance', 'finance', 'data'],
  },
  {
    id: 'saas',
    name: 'SaaS & Enterprise Product',
    description: 'User feedback clustering, growth experiments, cluster ops monitoring, and executive rollups.',
    scopes: ['core', 'product', 'business', 'infra', 'exec'],
  },
  {
    id: 'research',
    name: 'Deep Research & Intelligence',
    description: 'Real-time fact checking, competitor market crawls, and sandboxed prompt canary exploration.',
    scopes: ['core', 'facts', 'research', 'experimental'],
  },
  {
    id: 'custom',
    name: 'Custom (Modular Opt-In)',
    description:
      'Minimal footprint. Opt in only to the specific rooms relevant to your business to avoid room clutter.',
    scopes: ['core'],
  },
  {
    id: 'starter',
    name: 'Starter (General + Marketing + Eng)',
    description:
      'Default chat-first setup: general discussion, marketing (growth), and eng (infra). Add more rooms later.',
    scopes: ['general', 'business', 'infra'],
  },
  {
    id: 'all',
    name: 'Complete Autonomous Enterprise (All 12 Rooms)',
    description: 'Full multi-agent swarm across all 12 operational enterprise departments.',
    scopes: CANONICAL_ROOMS.map((r) => r.scope),
  },
];

export const AVAILABLE_SORS: { id: string; label: string; description: string }[] = [
  { id: 'warehouse', label: 'Data Warehouse', description: 'Snowflake / BigQuery canonical tables' },
  { id: 'stripe', label: 'Stripe', description: 'Invoices, subscriptions, and MRR' },
  { id: 'github', label: 'GitHub', description: 'PRs, security advisories, and code diffs' },
  { id: 'bloomberg', label: 'Bloomberg API', description: 'Market feeds, CDS, and counterparty variance' },
  { id: 'sec_edgar', label: 'SEC Edgar', description: '10-K, 10-Q, and 8-K public regulatory filings' },
  { id: 'web', label: 'Web Crawl', description: 'Deep external search & competitive intel' },
  { id: 'files', label: 'Filesystem / S3', description: 'Artifact store and local evidence files' },
];

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function renderRoomsSetupPage(
  db: AsyncDb,
  tenant: string,
  csrfToken: string,
  notice?: string,
  home = '/',
): Promise<string> {
  const configs: RoomConfig[] = [];
  for (const def of CANONICAL_ROOMS) {
    configs.push(await loadRoomConfig(db, tenant, def.scope));
  }

  const noticeHtml = notice
    ? `<div class="success" role="status" style="margin:0 0 20px;"><strong>✓ ${esc(notice)}</strong></div>`
    : '';

  const roomCardsHtml = configs
    .map((cfg) => {
      const def = CANONICAL_ROOMS.find((r) => r.scope === cfg.scope)!;
      const isChecked = cfg.active ? 'checked' : '';
      const isCore = cfg.scope === 'core';
      const sors = cfg.connectedSoRs ?? [...def.defaultSoRs];

      return `
      <div class="v-card" style="margin:0 0 14px;padding:18px 20px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:11px;min-width:0;">
            <input type="checkbox" id="room_active_${esc(cfg.scope)}" name="active_${esc(cfg.scope)}" value="1" ${isChecked} ${isCore ? 'disabled checked' : ''} style="width:17px;height:17px;accent-color:var(--v-accent);cursor:pointer;flex-shrink:0;">
            <label for="room_active_${esc(cfg.scope)}" style="cursor:pointer;min-width:0;">
              <span style="font-weight:650;font-size:15px;color:var(--v-ink);">#${esc(cfg.name)}</span>
              <span class="v-meta" style="margin-left:6px;">scope:${esc(cfg.scope)}</span>
              ${isCore ? '<span class="v-tag" style="margin-left:6px;">Mandatory root</span>' : ''}
            </label>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label class="v-meta" style="display:flex;align-items:center;gap:6px;">agent alias
              <input class="v-input" type="text" name="agentName_${esc(cfg.scope)}" value="${esc(cfg.agentName)}" pattern="[a-z0-9_-]+-agent" title="lowercase, must end in -agent" style="width:170px;font-size:12px;padding:5px 8px;">
            </label>
          </div>
        </div>

        <p class="v-sub" style="margin:0 0 12px;">${esc(def.duties)}</p>

        <details style="background:var(--v-bg-2);border-radius:var(--radius-md);padding:11px 14px;border:1px solid var(--v-line);">
          <summary style="font-size:12.5px;color:var(--v-accent);cursor:pointer;font-weight:600;user-select:none;">
            Tune room behaviour &amp; mandate — mission, autonomy, quotas and data feeds
          </summary>
          
          <div style="margin-top:16px;display:grid;grid-template-columns:1fr;gap:16px;">
            <!-- 1. Mission Prompt -->
            <div>
              <label class="v-eyebrow" style="display:block;margin-bottom:6px;">
                Mission prompt (natural-language mandate)
              </label>
              <textarea class="v-input" name="mission_${esc(cfg.scope)}" rows="2" style="font-family:var(--font-mono);font-size:12.5px;">${esc(cfg.mission)}</textarea>
              <p class="v-meta" style="margin-top:4px;">Defines the autonomous agent's mandate, constraints and target outcomes.</p>
            </div>

            <!-- 2. Autonomy Tier -->
            <div>
              <label class="v-eyebrow" style="display:block;margin-bottom:6px;">
                Autonomy level
              </label>
              <select class="v-input v-select" name="autonomy_${esc(cfg.scope)}" style="font-size:13px;">
                <option value="autonomous" ${cfg.autonomy === 'autonomous' ? 'selected' : ''}>Autonomous — Agents execute end-to-end without pausing.</option>
                <option value="guarded" ${cfg.autonomy === 'guarded' ? 'selected' : ''}>Guarded (Default) — Routine work is autonomous; yellow review gates (🟡) trigger on budget pressure, sensitive actions, or low confidence.</option>
                <option value="supervised" ${cfg.autonomy === 'supervised' ? 'selected' : ''}>Supervised — Every state change requires explicit human sign-off (coord.settle).</option>
              </select>
            </div>

            <!-- 3. Financial Guardrails -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;">
              <div>
                <label class="v-eyebrow" style="display:block;margin-bottom:6px;">
                  Monthly spend ceiling (dollars)
                </label>
                <input class="v-input" type="number" name="budget_${esc(cfg.scope)}" value="${cfg.budgetCeilingDollars}" min="50" max="50000">
                <p class="v-meta" style="margin-top:4px;">Hard stop: breaching it halts the room immediately.</p>
              </div>
              <div>
                <label class="v-eyebrow" style="display:block;margin-bottom:6px;">
                  Monthly token quota
                </label>
                <input class="v-input" type="number" name="tokens_${esc(cfg.scope)}" value="${cfg.budgetCeilingTokens}" min="100000" step="500000">
                <p class="v-meta" style="margin-top:4px;">Total model tokens before warning alerts trigger.</p>
              </div>
            </div>

            <!-- 4. Connected Systems of Record (SoR) -->
            <div>
              <label class="v-eyebrow" style="display:block;margin-bottom:8px;">
                Connected systems of record (data feeds)
              </label>
              <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(170px, 1fr));gap:8px;background:var(--v-bg-1);padding:11px 13px;border-radius:var(--radius-md);border:1px solid var(--v-line);">
                ${AVAILABLE_SORS.map(
                  (sor) => `
                  <label style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--v-ink-2);cursor:pointer;">
                    <input type="checkbox" name="sor_${esc(cfg.scope)}_${esc(sor.id)}" value="1" ${sors.includes(sor.id) ? 'checked' : ''} style="accent-color:var(--v-accent);">
                    <span>${esc(sor.label)}</span>
                  </label>
                `,
                ).join('')}
              </div>
              <p class="v-meta" style="margin-top:4px;">Selects which evidence collectors and diff streams pipe ground truth into this room.</p>
            </div>
          </div>
        </details>
      </div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Room Provisioning & Tuning Wizard · Vital</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    /* Layout only — the token system supplies every color and radius. */
    body { margin: 0; padding: 26px 16px 56px; }
    .container { max-width: 940px; margin: 0 auto; }
    .preset-btn { background: var(--v-bg-1); color: var(--v-ink); border: 1px solid var(--v-line); padding: 13px 15px; border-radius: var(--radius-md); cursor: pointer; text-align: left; font-size: 13px; font-family: inherit; transition: border-color .15s var(--ease-out), background .15s var(--ease-out); }
    .preset-btn:hover { background: var(--v-bg-2); border-color: var(--v-accent); }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>
  <main id="main" class="container">
    <nav class="v-breadcrumb" aria-label="Breadcrumb" style="margin-bottom:14px;"><a href="${esc(home)}">Console</a><span class="sep">/</span><strong>Rooms &amp; autonomy</strong></nav>
    <h1 class="v-page-title">Vital Autonomous Room Provisioning & Tuning Wizard</h1>
    <p class="sub">
      Select active autonomous agent rooms mapped to your enterprise scopes. Define custom mandates, set autonomy guardrails (Autonomous / Guarded / Supervised), configure hard financial spend ceilings, and connect real-time data feeds.
    </p>

    ${noticeHtml}

    <!-- Quick Preset Bundles -->
    <div class="v-card" style="margin:0 0 20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
        <h2 class="v-card-title">Quick-start preset bundles</h2>
        <span class="v-meta">Click to auto-select the relevant rooms</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:10px;">
        ${INDUSTRY_PRESETS.map(
          (p) => `
          <button type="button" class="preset-btn v-card-hover" onclick="applyPreset('${esc(p.id)}')">
            <strong style="color:var(--v-accent);">${esc(p.name)}</strong>
            <div class="v-meta" style="margin-top:6px;line-height:1.45;white-space:normal;">${esc(p.description)}</div>
          </button>
        `,
        ).join('')}
      </div>
    </div>

    <form method="POST" action="/setup/rooms">
      <input type="hidden" name="csrf" value="${esc(csrfToken)}">
      
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
        <h2 class="v-card-title">Room selection &amp; configuration roster</h2>
        <span class="v-meta">Uncheck rooms to keep the workspace quiet</span>
      </div>

      ${roomCardsHtml}

      <div style="border:1px dashed var(--v-line-strong);border-radius:var(--radius-md);padding:16px;margin-top:8px;">
        <h2 class="v-card-title" style="margin-bottom:8px;">Create a custom room</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));gap:8px;">
          <input class="v-input" type="text" name="newRoomId" placeholder="id (e.g. design)" style="font-size:13px;">
          <input class="v-input" type="text" name="newRoomName" placeholder="Display name" style="font-size:13px;">
          <input class="v-input" type="text" name="newRoomScope" placeholder="scope ^[a-z0-9-]{2,32}$" style="font-size:13px;">
          <input class="v-input" type="text" name="newRoomAgent" placeholder="agent (*-agent)" style="font-size:13px;">
          <input class="v-input" type="text" name="newRoomMission" placeholder="mission (optional)" style="font-size:13px;">
          <select class="v-input" name="newRoomCategory" aria-label="Room category" style="font-size:13px;">
            <option value="product">Product &amp; delivery</option>
            <option value="core">Core rooms</option>
            <option value="launch">Launch &amp; risk</option>
          </select>
        </div>
        <p class="v-meta" style="margin-top:6px;">Leave every field blank to skip. Fill the room fields to create it on save — category picks its sidebar group.</p>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:28px;padding-top:18px;border-top:1px solid var(--v-line);flex-wrap:wrap;">
        <a href="${esc(home)}" class="v-btn v-btn-ghost v-btn-sm">← Back to the console</a>
        <button type="submit" class="v-btn v-btn-primary">Save & Deploy Configured Rooms</button>
      </div>
    </form>
  </main>

  <script>
    const presets = ${JSON.stringify(INDUSTRY_PRESETS)};
    function applyPreset(id) {
      const preset = presets.find(p => p.id === id);
      if (!preset) return;
      const allCheckboxes = document.querySelectorAll('input[type="checkbox"][name^="active_"]');
      allCheckboxes.forEach(cb => {
        const scope = cb.name.replace('active_', '');
        if (scope === 'core') {
          cb.checked = true;
          return;
        }
        cb.checked = preset.scopes.includes(scope);
      });
    }
  </script>
</body>
</html>`;
}

export async function handleRoomsSetupPost(
  db: AsyncDb,
  tenant: string,
  formData: Record<string, string>,
  by = 'operator',
): Promise<void> {
  for (const def of CANONICAL_ROOMS) {
    const active = def.scope === 'core' ? true : formData[`active_${def.scope}`] === '1';
    const mission = formData[`mission_${def.scope}`];
    const autonomy = formData[`autonomy_${def.scope}`] as RoomAutonomy | undefined;
    const budget = Number(formData[`budget_${def.scope}`]);
    const tokens = Number(formData[`tokens_${def.scope}`]);

    const selectedSors = AVAILABLE_SORS.filter((s) => formData[`sor_${def.scope}_${s.id}`] === '1').map((s) => s.id);

    const updates: Partial<RoomConfig> = { active };
    const alias = (formData[`agentName_${def.scope}`] ?? '').trim().toLowerCase();
    if (alias && /^[a-z0-9_-]+-agent$/.test(alias)) updates.agentName = alias;
    if (mission) updates.mission = mission;
    if (autonomy && ['autonomous', 'guarded', 'supervised'].includes(autonomy)) updates.autonomy = autonomy;
    if (budget > 0) updates.budgetCeilingDollars = budget;
    if (tokens > 0) updates.budgetCeilingTokens = tokens;
    if (selectedSors.length > 0) updates.connectedSoRs = selectedSors;

    await saveRoomConfig(db, tenant, { scope: def.scope, ...updates }, by);
  }
}
