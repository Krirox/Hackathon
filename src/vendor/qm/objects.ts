/**
 * PROVENANCE — vendored, not written.
 *   source:        https://github.com/yc-software/qm
 *   commit:        60ba79195dc84aa85a23f238749656e11c88696c (2026-09-08)
 *   upstream path: src/util/objects.ts (16 lines)
 *   license:       MIT — see LICENSE-THIRD-PARTY.md
 *
 * WHAT WAS CHANGED AND WHY
 *   Nothing. Verbatim copy: zero imports, zero coupling. Vendored so
 *   `ship-gate.ts` keeps its exact `contentPart` (canonical-JSON) semantics
 *   without dragging in `triggers/trigger-store.ts` (which pulls
 *   `directory/person.ts` and a Postgres-backed `durable-map.ts`).
 */
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function canonicalJson(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(value, (_k, v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      }),
    );
  });
}
