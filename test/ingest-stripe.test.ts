import { T, eq, TEN, NOW, fresh } from './helpers.ts';
import { stripeInvoicesCollector, ingestEvents } from '../src/ingest/collectors.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

T('stripeInvoicesCollector: fetches invoices, stages in inbox, and ingests claims into Reality Ledger', async () => {
  const { db, ledger } = await fresh();

  const seenRequests: Array<{ url: string; headers: Record<string, string> }> = [];
  const fakeInvoices = [
    {
      id: 'in_test_001',
      customer: 'cus_acme_1',
      amount_due: 4900,
      amount_paid: 4900,
      currency: 'usd',
      status: 'paid',
      created: 1711000000,
      subscription: 'sub_test_1',
    },
    {
      id: 'in_test_002',
      customer: 'cus_acme_2',
      amount_due: 12000,
      amount_paid: 0,
      currency: 'usd',
      status: 'open',
      created: 1711000500,
      subscription: null,
    },
  ];

  const fetchFn = async (url: string, init: { method: string; headers: Record<string, string> }) => {
    seenRequests.push({ url, headers: init.headers });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: fakeInvoices }),
    };
  };

  const collector = stripeInvoicesCollector({
    apiKey: 'sk_test_secret_123',
    fetchFn,
  });

  const events = await collector.poll(db, NOW, TEN);
  eq(events.length, 2, 'fetched 2 invoice events');
  eq(events[0]!.eventId, 'in_test_001');
  eq(events[0]!.uri, 'https://dashboard.stripe.com/invoices/in_test_001');
  eq(events[0]!.summary.includes('USD 49.00 (paid)'), true, 'summary formats amount correctly');

  // Verify key was passed in header only
  eq(seenRequests[0]!.headers['Authorization'], 'Bearer sk_test_secret_123', 'API key passed in Authorization header');

  // Ingest events into Reality Ledger
  const artifactDir = join(tmpdir(), `vital-stripe-test-${Date.now()}`);
  const claimIds = await ingestEvents(db, ledger, TEN, collector, events, {
    owner: 'agent:finance-agent',
    scope: 'finance',
    now: NOW,
    artifactDir,
  });

  eq(claimIds.length, 2, 'created 2 claims');

  // Verify claim in Reality Ledger
  const claim = await ledger.get(TEN, claimIds[0]!);
  eq(claim !== null, true, 'claim exists in ledger');
  eq(claim?.scope, 'finance', 'claim is in finance scope');
  eq(claim?.kind, 'OBSERVATION', 'claim is OBSERVATION kind');
  eq(claim?.provenance.sourceUri, 'https://dashboard.stripe.com/invoices/in_test_001');
  eq(claim?.statement.includes('USD 49.00'), true, 'claim statement records invoice amount');

  await db.close();
});

T('stripeInvoicesCollector: throws if API key is missing', async () => {
  const { db } = await fresh();
  let threw = false;
  try {
    const collector = stripeInvoicesCollector({ apiKey: '' });
    await collector.poll(db, NOW, TEN);
  } catch (err) {
    threw = true;
    eq((err as Error).message.includes('STRIPE_KEY'), true, 'reports STRIPE_KEY error');
  }
  eq(threw, true, 'threw error for missing key');
  await db.close();
});

T('stripeInvoicesCollector: throws cleanly on non-200 API response', async () => {
  const { db } = await fresh();
  let threw = false;
  try {
    const collector = stripeInvoicesCollector({
      apiKey: 'sk_test_fake',
      fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    });
    await collector.poll(db, NOW, TEN);
  } catch (err) {
    threw = true;
    eq((err as Error).message.includes('STRIPE_FETCH'), true, 'reports STRIPE_FETCH error');
  }
  eq(threw, true, 'threw error on 401 response');
  await db.close();
});
