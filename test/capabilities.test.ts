import { T, eq, TEN, rejects } from './helpers.ts';
import { evaluateKill, silenceReview, validateContract } from '../src/capabilities/contract.ts';

console.log('\n\x1b[1mCapabilities — contracts with kill conditions\x1b[0m');

const answers = {
  observe: 'competitor releases',
  state: 'opportunity/threat register',
  triggers: 'release webhooks',
  understands: 'threat vs noise',
  influences: 'roadmap ranking',
  executes: 'briefs to product',
  measures: 'adopted opportunities',
  escalates: 'unpriced threats to COO',
  staysSilent: 'below-threshold chatter',
};

const contract = () =>
  validateContract({
    tenant: TEN,
    name: 'market',
    answers,
    outcomeMetric: 'qualified opportunities adopted',
    killCondition: 'opportunity→decision conversion below baseline 2 quarters',
    owner: 'human:priya',
  });

T('a complete contract validates; an incomplete one names the gap', async () => {
  const c = contract();
  eq(c.dead, false);
  await rejects(
    async () =>
      validateContract({
        tenant: TEN,
        name: 'thin',
        answers: { observe: 'x' },
        outcomeMetric: 'm',
        killCondition: 'k',
        owner: 'h',
      }),
    'INCOMPLETE_CONTRACT',
  );
});

T('a capability meeting its kill condition is retired, not rebranded', async () => {
  const c = contract();
  const alive = evaluateKill(c, { conversion: 0.3 }, 'conversion', 0.2);
  eq(alive.dead, false);
  const dead = evaluateKill(c, { conversion: 0.1 }, 'conversion', 0.2);
  eq(dead.dead, true);
  eq(dead.reason.includes('retire, do not rebrand'), true);
  eq(evaluateKill(c, {}, 'conversion', 0.2).dead, false, 'unmeasured is not dead:');
});

T('the silence budget names who owes a justification', async () => {
  const loud = contract();
  const quiet = { ...contract(), name: 'customer' };
  const rows = silenceReview([loud, quiet], ['market'], '2026-Q3');
  eq(rows, [
    { quarter: '2026-Q3', name: 'market', spoke: true, justificationDue: false },
    { quarter: '2026-Q3', name: 'customer', spoke: false, justificationDue: true },
  ]);
});
