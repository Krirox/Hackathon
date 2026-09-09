import { T, eq, NOW, govLoop, vitals } from './helpers.ts';
import { evaluateGovernor, healthWorsened } from '../src/vendor/qm/governor.ts';
console.log('\n\x1b[1mVendored governor — quarantine/throttle/ping semantics\x1b[0m');

T('a healthy loop with no signals stays healthy and escalates nothing', async () => {
  const v = evaluateGovernor(govLoop(), vitals(), Date.parse(NOW));
  eq(v.health, 'healthy');
  eq(v.escalate, false);
  eq(v.throttle, false);
});

T('3 consecutive failed fires quarantines (budget death, loudly)', async () => {
  const v = evaluateGovernor(govLoop({ consecutiveFailedFires: 3 }), vitals(), Date.parse(NOW));
  eq(v.health, 'quarantined');
  eq(
    v.actions.some((a) => a.type === 'quarantine'),
    true,
  );
  eq(v.escalate, true, 'worsened from healthy:');
});

T('2 consecutive failures warn but do not quarantine', async () => {
  const v = evaluateGovernor(govLoop({ consecutiveFailedFires: 2 }), vitals(), Date.parse(NOW));
  eq(v.health, 'failing');
  eq(
    v.actions.some((a) => a.type === 'quarantine'),
    false,
  );
});

T('a returned-output majority throttles the playbook', async () => {
  const v = evaluateGovernor(govLoop(), vitals({ decidedOutputs: 10, returnedOutputs: 6 }), Date.parse(NOW));
  eq(v.health, 'failing');
  eq(v.throttle, true);
});

T('a dead trigger pings instead of silently stalling', async () => {
  const v = evaluateGovernor(
    govLoop({ governor: { staleFireMs: 60_000 }, lastFiredAt: Date.parse(NOW) - 600_000 }),
    vitals(),
    Date.parse(NOW),
  );
  eq(v.health, 'degraded');
  eq(
    v.actions.some((a) => a.type === 'ping'),
    true,
  );
});

T('undeclared ship actions quarantine immediately', async () => {
  const v = evaluateGovernor(govLoop(), vitals({ undeclaredShipActions: ['prod.deploy'] }), Date.parse(NOW));
  eq(v.health, 'quarantined');
});

T('healthWorsened orders the four states', async () => {
  eq(healthWorsened('healthy', 'degraded'), true);
  eq(healthWorsened('failing', 'failing'), false);
  eq(healthWorsened('quarantined', 'degraded'), false);
});
