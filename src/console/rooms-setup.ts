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
    description: 'Autonomous counterparty risk hedging, Stripe billing sync, EU AI Act compliance, and warehouse verification.',
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
    description: 'Minimal footprint. Opt in only to the specific rooms relevant to your business to avoid room clutter.',
    scopes: ['core'],
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
): Promise<string> {
  const configs: RoomConfig[] = [];
  for (const def of CANONICAL_ROOMS) {
    configs.push(await loadRoomConfig(db, tenant, def.scope));
  }

  const noticeHtml = notice
    ? `<div style="background:#064E3B;border:1px solid #10B981;color:#A7F3D0;padding:12px 16px;border-radius:8px;margin-bottom:24px;">✓ ${esc(notice)}</div>`
    : '';

  const roomCardsHtml = configs
    .map((cfg) => {
      const def = CANONICAL_ROOMS.find((r) => r.scope === cfg.scope)!;
      const isChecked = cfg.active ? 'checked' : '';
      const isCore = cfg.scope === 'core';
      const sors = cfg.connectedSoRs ?? [...def.defaultSoRs];

      return `
      <div style="border:1px solid #374151;background:#1F2937;border-radius:8px;padding:18px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <input type="checkbox" id="room_active_${esc(cfg.scope)}" name="active_${esc(cfg.scope)}" value="1" ${isChecked} ${isCore ? 'disabled checked' : ''} style="width:19px;height:19px;accent-color:#10B981;cursor:pointer;">
            <label for="room_active_${esc(cfg.scope)}" style="font-weight:600;font-size:16px;color:#F9FAFB;cursor:pointer;">
              🟢 #${esc(cfg.name)}
              <span style="font-size:12px;font-weight:normal;color:#9CA3AF;margin-left:6px;">(scope:${esc(cfg.scope)})</span>
              ${isCore ? '<span style="font-size:11px;background:#374151;color:#10B981;padding:2px 6px;border-radius:4px;margin-left:6px;">Mandatory Root</span>' : ''}
            </label>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="background:#374151;color:#D1D5DB;font-size:12px;padding:3px 8px;border-radius:4px;">🤖 ${esc(cfg.agentName)}</span>
          </div>
        </div>

        <p style="color:#D1D5DB;font-size:14px;margin:0 0 12px 0;">${esc(def.duties)}</p>

        <details style="background:#111827;border-radius:6px;padding:12px 16px;border:1px solid #374151;">
          <summary style="font-size:13px;color:#60A5FA;cursor:pointer;font-weight:600;user-select:none;">
            ⚙️ Tune Room Behavior & Mandate (Mission, Autonomy, Quotas & Data Feeds)
          </summary>
          
          <div style="margin-top:16px;display:grid;grid-template-columns:1fr;gap:16px;">
            <!-- 1. Mission Prompt -->
            <div>
              <label style="display:block;font-size:12px;font-weight:600;color:#E5E7EB;margin-bottom:6px;">
                🎯 Mission Prompt (Natural Language Mandate):
              </label>
              <textarea name="mission_${esc(cfg.scope)}" rows="2" style="width:100%;background:#1F2937;color:#F9FAFB;border:1px solid #4B5563;border-radius:4px;padding:8px;font-size:13px;font-family:monospace;box-sizing:border-box;">${esc(cfg.mission)}</textarea>
              <div style="font-size:11px;color:#9CA3AF;margin-top:4px;">Custom instruction defining the autonomous agent's mandate, constraints, and target outcomes.</div>
            </div>

            <!-- 2. Autonomy Tier -->
            <div>
              <label style="display:block;font-size:12px;font-weight:600;color:#E5E7EB;margin-bottom:6px;">
                🛡️ Autonomy Level:
              </label>
              <select name="autonomy_${esc(cfg.scope)}" style="width:100%;background:#1F2937;color:#F9FAFB;border:1px solid #4B5563;border-radius:4px;padding:8px;font-size:13px;box-sizing:border-box;">
                <option value="autonomous" ${cfg.autonomy === 'autonomous' ? 'selected' : ''}>Autonomous — Agents execute end-to-end without pausing.</option>
                <option value="guarded" ${cfg.autonomy === 'guarded' ? 'selected' : ''}>Guarded (Default) — Routine work is autonomous; yellow review gates (🟡) trigger on high spend (> $250), sensitive actions, or low confidence.</option>
                <option value="supervised" ${cfg.autonomy === 'supervised' ? 'selected' : ''}>Supervised — Every state change requires explicit human sign-off (coord.settle).</option>
              </select>
            </div>

            <!-- 3. Financial Guardrails -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;color:#E5E7EB;margin-bottom:6px;">
                  💵 Monthly Spend Ceiling ($):
                </label>
                <input type="number" name="budget_${esc(cfg.scope)}" value="${cfg.budgetCeilingDollars}" min="50" max="50000" style="width:100%;background:#1F2937;color:#F9FAFB;border:1px solid #4B5563;border-radius:4px;padding:8px;font-size:13px;box-sizing:border-box;">
                <div style="font-size:11px;color:#9CA3AF;margin-top:4px;">Hard stop limit. Breaching halts the room immediately.</div>
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;color:#E5E7EB;margin-bottom:6px;">
                  🪙 Monthly Token Quota:
                </label>
                <input type="number" name="tokens_${esc(cfg.scope)}" value="${cfg.budgetCeilingTokens}" min="100000" step="500000" style="width:100%;background:#1F2937;color:#F9FAFB;border:1px solid #4B5563;border-radius:4px;padding:8px;font-size:13px;box-sizing:border-box;">
                <div style="font-size:11px;color:#9CA3AF;margin-top:4px;">Total LLM token budget before yellow/red alerts trigger.</div>
              </div>
            </div>

            <!-- 4. Connected Systems of Record (SoR) -->
            <div>
              <label style="display:block;font-size:12px;font-weight:600;color:#E5E7EB;margin-bottom:8px;">
                🔌 Connected Systems of Record (SoR Data Feeds):
              </label>
              <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:8px;background:#1F2937;padding:10px;border-radius:6px;border:1px solid #374151;">
                ${AVAILABLE_SORS.map(
                  (sor) => `
                  <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#D1D5DB;cursor:pointer;">
                    <input type="checkbox" name="sor_${esc(cfg.scope)}_${esc(sor.id)}" value="1" ${sors.includes(sor.id) ? 'checked' : ''} style="accent-color:#10B981;">
                    <span>${esc(sor.label)}</span>
                  </label>
                `,
                ).join('')}
              </div>
              <div style="font-size:11px;color:#9CA3AF;margin-top:4px;">Selects which evidence collectors and diff streams pipe real-time ground truth into this room.</div>
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
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #111827; color: #F9FAFB; margin: 0; padding: 32px 16px; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 26px; margin: 0 0 8px 0; color: #F9FAFB; }
    p.sub { color: #9CA3AF; margin: 0 0 24px 0; font-size: 15px; line-height: 1.5; }
    .preset-btn { background: #1F2937; color: #F9FAFB; border: 1px solid #374151; padding: 12px 14px; border-radius: 6px; cursor: pointer; text-align: left; font-size: 13px; transition: all 0.15s; }
    .preset-btn:hover { background: #374151; border-color: #4B5563; }
    .submit-btn { background: #10B981; color: #064E3B; font-weight: 700; border: none; padding: 14px 28px; border-radius: 6px; cursor: pointer; font-size: 15px; }
    .submit-btn:hover { background: #059669; color: #FFFFFF; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🏛️ Vital Autonomous Room Provisioning & Tuning Wizard</h1>
    <p class="sub">
      Select active autonomous agent rooms mapped to your enterprise scopes. Define custom mandates, set autonomy guardrails (Autonomous / Guarded / Supervised), configure hard financial spend ceilings, and connect real-time data feeds.
    </p>

    ${noticeHtml}

    <!-- Quick Preset Bundles -->
    <div style="background:#1F2937;border:1px solid #374151;border-radius:8px;padding:18px;margin-bottom:28px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3 style="margin:0;font-size:15px;color:#F9FAFB;">⚡ Quick-Start Preset Bundles</h3>
        <span style="font-size:12px;color:#9CA3AF;">Click to auto-select relevant rooms</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:10px;">
        ${INDUSTRY_PRESETS.map(
          (p) => `
          <button type="button" class="preset-btn" onclick="applyPreset('${esc(p.id)}')">
            <strong style="color:#60A5FA;">${esc(p.name)}</strong>
            <div style="font-size:12px;color:#9CA3AF;margin-top:6px;line-height:1.4;">${esc(p.description)}</div>
          </button>
        `,
        ).join('')}
      </div>
    </div>

    <form method="POST" action="/setup/rooms">
      <input type="hidden" name="csrf" value="${esc(csrfToken)}">
      
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;font-size:16px;color:#F9FAFB;">📋 Room Selection & Configuration Roster</h3>
        <span style="font-size:12px;color:#9CA3AF;">Uncheck rooms to avoid workspace clutter</span>
      </div>

      ${roomCardsHtml}

      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:32px;padding-top:20px;border-top:1px solid #374151;">
        <a href="/console" style="color:#9CA3AF;text-decoration:none;font-size:14px;">← Back to Mission Control</a>
        <button type="submit" class="submit-btn">Save & Deploy Configured Rooms</button>
      </div>
    </form>
  </div>

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
    if (mission) updates.mission = mission;
    if (autonomy && ['autonomous', 'guarded', 'supervised'].includes(autonomy)) updates.autonomy = autonomy;
    if (budget > 0) updates.budgetCeilingDollars = budget;
    if (tokens > 0) updates.budgetCeilingTokens = tokens;
    if (selectedSors.length > 0) updates.connectedSoRs = selectedSors;

    await saveRoomConfig(db, tenant, { scope: def.scope, ...updates }, by);
  }
}
