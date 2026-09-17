/**
 * Typed row shapes, one per table (TODO §0.5's "typed rows" item).
 *
 * These describe what the engines actually return for `SELECT *`: snake_case
 * columns, JSON stored as TEXT, INTEGER/REAL as `number`, NULLable columns as
 * `| null`. Postgres parity notes:
 *   - `BIGSERIAL` columns (`claims.seq`, `audit_log.seq`) arrive as JS numbers
 *     on sqlite and as strings on `pg`'s default BIGINT parsing — mappers
 *     coerce with `Number(...)`, so the interface stays `number`.
 *   - `skill_cards.trust_tier` comes from an additive migration (no table
 *     default), so it is `string | null`; the mapper defaults it.
 *
 * Keep these in sync with SCHEMA in `./db.ts` — the DDL is the source of truth.
 */

export type MetaRow = {
  key: string;
  value: string;
};

export type ClaimRow = {
  id: string;
  tenant: string;
  subject: string;
  kind: string;
  statement: string;
  value_json: string | null;
  unit: string | null;
  confidence: number;
  source_uri: string;
  source_tier: string;
  extractor: string;
  extractor_ver: string;
  retrieved_at: string;
  raw_ref: string | null;
  corrob_json: string | null;
  observed_at: string;
  valid_from: string;
  valid_until: string | null;
  verified_at: string | null;
  status: string;
  owner: string;
  scope: string;
  provisional: number;
  buzz_sig: string | null;
  created_at: string;
  seq: number;
};

export type ClaimLinkRow = {
  from_id: string;
  to_id: string;
  link: string;
};

export type DecisionRow = {
  id: string;
  tenant: string;
  goal: string;
  action: string;
  action_class: string;
  context_bundle: string;
  decided_by: string;
  approved_by: string | null;
  scope: string;
  autonomy: string;
  request_id: string | null;
  signed_at: string;
};

export type OutcomeRow = {
  id: string;
  tenant: string;
  decision_id: string;
  metric: string;
  predicted: number | null;
  actual: number | null;
  basis: string;
  holdout_ref: string | null;
  resolved_at: string | null;
  created_at: string;
};

export type RequestRow = {
  id: string;
  tenant: string;
  message_class: string;
  origin_scope: string;
  target_scope: string;
  goal: string;
  claim_refs: string;
  deliverable: string;
  bid_json: string;
  on_behalf_of: string;
  hop_chain: string;
  chain_claims: string;
  idem_key: string;
  stop_condition: string;
  state: string;
  spent_json: string;
  refusal_reason: string | null;
  parent_request: string | null;
  created_at: string;
  updated_at: string;
  /** Added by additive migration (F02/F03); null on unclaimed rows. */
  exec_owner: string | null;
  exec_attempt: number;
  claimed_at: string | null;
  lease_ms: number;
};

export type SkillCardRow = {
  id: string;
  tenant: string;
  intent: string;
  predicates: string;
  steps: string;
  tests: string;
  tool_grants: string;
  validated_tier: string;
  scope_json: string;
  state: string;
  version: number;
  provenance: string;
  eval_ref: string | null;
  owner: string;
  updated_at: string;
  /** Added by an additive migration; absent (null) on rows written before it. */
  trust_tier: string | null;
};

export type TraceRow = {
  id: string;
  tenant: string;
  request_id: string | null;
  scope: string;
  task_type: string;
  intent: string;
  steps: string;
  tier: string;
  outcome: string;
  cost_json: string;
  skill_card: string | null;
  router_confidence: number;
  created_at: string;
};

export type RoutingDecisionRow = {
  /** AUTOINCREMENT / BIGSERIAL. */
  id: number;
  tenant: string;
  task_type: string;
  scope: string;
  action_class: string;
  proposed: string;
  executed: string;
  policy_baseline: string;
  shadow: number;
  guards: string;
  skill_card: string | null;
  confidence: number | null;
  importance: number;
  labeled: number;
  correct_tier: string | null;
  created_at: string;
};

export type SkillTransferTestRow = {
  card_id: string;
  kind: string;
  variant: string;
  passed: number;
  score: number;
  ran_at: string;
};

export type TrustScoreRow = {
  tenant: string;
  scope: string;
  action_class: string;
  clean: number;
  total: number;
  override_rate: number;
  honey_misses: number;
  granted: number;
  frozen: number;
  updated_at: string;
};

export type HoneytaskRow = {
  id: string;
  tenant: string;
  scope: string;
  is_bad: number;
  injected: number;
  detected: number | null;
  acted_on: number | null;
  created_at: string;
  resolved_at: string | null;
};

export type EscalationRow = {
  id: string;
  tenant: string;
  scope: string;
  request_id: string | null;
  human: string;
  day: string;
  created_at: string;
};

export type EvalCaseRow = {
  id: string;
  tenant: string;
  capability: string;
  suite: string;
  input_json: string;
  expect_json: string;
  kind: string;
  created_at: string;
};

export type EvalRunRow = {
  id: string;
  tenant: string;
  suite: string;
  target: string;
  passed: number;
  failed: number;
  detail_json: string;
  ran_at: string;
};

export type AuditLogRow = {
  seq: number;
  tenant: string;
  actor: string;
  action: string;
  target: string;
  detail: string | null;
  at: string;
};

export type LedgerSeqRow = {
  tenant: string;
  next: number;
};

export type RoutingCalibrationRow = {
  tenant: string;
  task_type: string;
  tier: string;
  model: string;
  ok: number;
  total: number;
  updated_at: string;
};

export type SubjectRow = {
  id: string;
  tenant: string;
  key: string;
  display_name: string | null;
  kind: string | null;
  aliases_json: string;
  created_at: string;
};
