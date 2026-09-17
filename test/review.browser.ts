import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { openDb, migrate } from '../src/core/db.ts';
import { installAuthSchema, signupTenant } from '../src/core/auth.ts';
import { createLedger } from '../src/ledger/ledger.ts';
import { createCoordinator } from '../src/coord/coordinator.ts';
import { OrganizationalCompiler } from '../src/compiler/compiler.ts';
import { startConsoleServer } from '../src/console/serve.ts';

// Separate from the normal suite: requires `npx playwright install chromium`.
test('F02 browser: inspect all evidence, correct a value, approve and decline', { timeout: 60000 }, async () => {
  const db = openDb(':memory:');
  await migrate(db);
  const tenant = 'review-browser';
  const now = new Date().toISOString();
  const ledger = createLedger(db);
  const coord = createCoordinator(db);
  await installAuthSchema(db, now);
  await signupTenant(
    db,
    {
      slug: tenant,
      name: 'Review',
      email: 'owner@example.test',
      password: 'browser-test-password',
      ownerName: 'Owner',
    },
    now,
  );
  const claims = [];
  for (let i = 0; i < 23; i++) {
    claims.push(
      await ledger.append({
        tenant,
        subject: 'release:metrics',
        kind: 'MEASUREMENT',
        statement: `Metric ${i}: 10 ms`,
        value: 10,
        unit: 'ms',
        confidence: 1,
        owner: 'metrics',
        scope: 'engineering',
        authorType: 'system',
        observedAt: now,
        validFrom: now,
        provenance: {
          sourceUri: `https://example.test/evidence/${i}`,
          sourceTier: 'MEASURED',
          extractor: 'test',
          extractorVersion: '1',
          retrievedAt: now,
        },
      }),
    );
  }
  for (const id of ['approve-me', 'decline-me']) {
    const admitted = await coord.submit({
      tenant,
      id,
      messageClass: 'REQUEST',
      originScope: 'product',
      targetScope: id,
      goal: id,
      claimRefs: claims.map((c) => c.id),
      deliverableSchema: 'release.v1',
      onBehalfOf: 'owner',
      bid: { humanMinutes: 1 },
      now,
    });
    assert.equal(admitted.state, 'ADMITTED');
  }
  const other = await ledger.append({
    tenant: 'other-tenant',
    subject: 'release:metrics',
    kind: 'MEASUREMENT',
    statement: 'Other tenant metric',
    value: 10,
    unit: 'ms',
    confidence: 1,
    owner: 'metrics',
    scope: 'engineering',
    authorType: 'system',
    observedAt: now,
    validFrom: now,
    provenance: {
      sourceUri: 'https://example.test/other',
      sourceTier: 'MEASURED',
      extractor: 'test',
      extractorVersion: '1',
      retrievedAt: now,
    },
  });
  const server = await startConsoleServer(db, ledger, coord, new OrganizationalCompiler(db), {
    tenant,
    operatorSecret: 'browser-operator',
  });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    await page.goto(origin);
    await page.getByLabel('work email', { exact: true }).fill('owner@example.test');
    await page.getByLabel('password', { exact: true }).fill('browser-test-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('[data-review-request="approve-me"] h3 a').click();
    await expect(page.getByRole('heading', { name: 'Evidence (23)', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Next evidence', exact: true }).click();
    await page.getByRole('link', { name: claims[22]!.id, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Claim evidence', exact: true })).toBeVisible();
    const form = page.locator('form[data-review-action="correct"]');
    await form.getByRole('textbox', { name: 'Corrected statement', exact: true }).fill('Metric 22: 25 ms');
    await form.getByRole('combobox', { name: 'Structured value', exact: true }).selectOption('number');
    await form.getByLabel('Numeric value', { exact: true }).fill('');
    await form.getByLabel('Operator secret', { exact: true }).fill('browser-operator');
    await form.locator('[name="confirmed"]').check();
    await form.getByRole('button', { name: 'Save correction', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Enter a finite numeric value');
    await form.getByLabel('Numeric value', { exact: true }).fill('25');
    await form.getByLabel('Unit', { exact: true }).fill('ms');
    await form.getByLabel('Operator secret', { exact: true }).fill('wrong');
    await form.locator('[name="confirmed"]').check();
    await form.getByRole('button', { name: 'Save correction', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('operator secret required');
    await expect(form.getByRole('button')).toBeEnabled();
    await form.getByLabel('Operator secret', { exact: true }).fill('browser-operator');
    await form.getByRole('button', { name: 'Save correction', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Correction saved.');
    await page.getByRole('link', { name: 'View corrected claim', exact: true }).click();
    const replacementId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
    const replacement = await ledger.get(tenant, replacementId);
    assert.equal(replacement!.value, 25);
    assert.equal(replacement!.unit, 'ms');
    assert.equal(replacement!.statement, 'Metric 22: 25 ms');
    assert.equal((await ledger.get(tenant, claims[22]!.id))!.status, 'SUPERSEDED');
    await page.goto(`${origin}/console/claims/${claims[22]!.id}`);
    await expect(page.locator('form[data-review-action="correct"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: replacementId, exact: true })).toBeVisible();
    assert.equal((await page.request.get(`${origin}/console/claims/${other.id}`)).status(), 404);
    await page.getByRole('link', { name: 'Back to console', exact: true }).click();
    for (const [id, action] of [
      ['approve-me', 'approve'],
      ['decline-me', 'decline'],
    ] as const) {
      const card = page.locator(`[data-review-request="${id}"]`);
      const decision = card.locator(`form[data-review-action="${action}"]`);
      if (action === 'decline')
        await decision.getByLabel('Decline reason', { exact: true }).fill('Needs further review');
      await decision.getByLabel('Operator secret', { exact: true }).fill('browser-operator');
      await decision.locator('[name="confirmed"]').check();
      await decision.getByRole('button').click();
      await expect(card.getByRole('status')).toContainText(action === 'approve' ? 'Approved' : 'Declined');
      assert.equal((await coord.get(tenant, id))!.state, action === 'approve' ? 'ACCEPTED' : 'DECLINED');
    }
    await page.reload();
    await expect(page.locator('[data-review-request]')).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
    await db.close();
  }
});
