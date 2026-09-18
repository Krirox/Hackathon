import { auditLinks } from '../src/ledger/export.ts';

const tests = [
  {
    target: 'request:req_1',
    detail: 'approved [claim:clm_1] [decision:dec_1] [receipt:rcpt_7] [outcome:out_3]',
    actor: 'human:priya',
  },
  {
    target: 'request:req_1',
    detail: 'approved claim clm_1 decision dec_1 receipt rcpt_7 outcome out_3',
    actor: 'human:priya',
  },
  { target: 'claim:clm_1', detail: 'FACT launch', actor: 'system:linear' },
  { target: 'decision:dec_1', detail: 'READ goal', actor: 'human:priya' },
  { target: 'ledger', detail: '3 claim(s) marked STALE', actor: 'ledger' },
  { target: 'request:req_9', detail: 'other tenant row', actor: 'human:x' },
];

for (const t of tests) {
  const links = auditLinks(t);
  console.log('target:', t.target, 'detail:', t.detail);
  console.log('  evidence:', links.evidence);
  console.log('  authorization:', links.authorization);
  console.log('  receipt:', links.receipt);
  console.log('  outcome:', links.outcome);
  console.log();
}
