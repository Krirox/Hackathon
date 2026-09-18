import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { openDb, migrate } from '../src/core/db.ts';
import type { Claim } from '../src/core/types.ts';
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
  const { owner } = await signupTenant(
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
  const claims: Claim[] = [];
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
    // The replacement is linked twice: once in the supersession lineage,
    // once in the evidence-history link list.
    await expect(page.getByRole('link', { name: replacementId, exact: true })).toHaveCount(2);
    await expect(page.getByRole('link', { name: replacementId, exact: true }).first()).toBeVisible();
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
      if (action === 'approve') {
        // The cited evidence changed under this review (claims[22] was
        // corrected above): approval must refuse with a diff, not silently
        // authorize the new content.
        await expect(card.getByRole('status')).toContainText('STALE_EVIDENCE');
        await expect(card.getByRole('status')).toContainText('superseded by');
        await expect(card.getByRole('status')).toContainText('Your input is preserved');
        // Re-review journey: refresh the request onto current evidence,
        // then approve the rebound version explicitly.
        await card.locator('h3 a').click();
        await expect(page.getByRole('heading', { name: 'Request evidence', exact: true })).toBeVisible();
        const refresh = page.locator('form[data-review-action="refresh-evidence"]');
        await refresh.getByRole('button').click();
        await expect(page.locator('[data-review-request="approve-me"]').getByRole('status')).toContainText(
          'Evidence refreshed to current claim replacements. Re-review before approving.',
        );
        await page.getByRole('link', { name: 'Back to console', exact: true }).click();
        const freshCard = page.locator('[data-review-request="approve-me"]');
        const freshDecision = freshCard.locator('form[data-review-action="approve"]');
        await freshDecision.getByLabel('Operator secret', { exact: true }).fill('browser-operator');
        await freshDecision.locator('[name="confirmed"]').check();
        await freshDecision.getByRole('button').click();
        await expect(freshCard.getByRole('status')).toContainText('Approved');
      } else {
        await expect(card.getByRole('status')).toContainText('Declined');
      }
      assert.equal((await coord.get(tenant, id))!.state, action === 'approve' ? 'ACCEPTED' : 'DECLINED');
      if (action === 'approve') {
        await expect(card.getByRole('status')).toContainText(
          'Approved to BEGIN work — not final-deliverable authorization or evidence of execution or measurement.',
        );
        const receipt = await ledger.getDecisionByRequest(tenant, id);
        assert.ok(receipt);
        const receiptUrl = `${origin}/console/decisions/${encodeURIComponent(receipt.id)}`;
        await card.getByRole('link', { name: 'View approval receipt', exact: true }).click();
        await expect(page).toHaveURL(receiptUrl);
        await expect(page.getByRole('heading', { name: 'Approval receipt', exact: true })).toBeVisible();
        const field = (name: string) =>
          page.locator('dt').filter({ hasText: name }).locator('xpath=following-sibling::dd[1]');
        await expect(field('Decision id')).toHaveText(receipt.id);
        const actor = `${owner.id} (${owner.email})`;
        await expect(field('Actor (decided by)')).toHaveText(actor);
        await expect(field('Approved by')).toHaveText(actor);
        await expect(page.getByText(`Signed in as ${actor}`, { exact: true })).toBeVisible();
        await expect(
          page.getByText(
            'This records approval to BEGIN work. It is not final-deliverable authorization and does not establish that execution or measurement has occurred.',
            { exact: true },
          ),
        ).toBeVisible();
        const frozen = page.getByRole('heading', { name: 'Frozen context bundle', exact: true });
        await expect(frozen).toBeVisible();
        const bundle = frozen.locator('xpath=following-sibling::pre[1]');
        await expect(bundle).toBeVisible();
        assert.deepEqual(JSON.parse(await bundle.innerText()), receipt.bundle);
        // FLOW-002: the request was refreshed onto current evidence before
        // approval, so the frozen bundle cites the replacement — never the
        // superseded version the first review saw.
        assert.deepEqual(
          receipt.bundle.claims.map((claim) => claim.id).sort(),
          claims
            .map((claim) => claim.id)
            .filter((cid) => cid !== claims[22]!.id)
            .concat([replacementId])
            .sort(),
        );
        const rebound = receipt.bundle.claims.find((claim) => claim.id === replacementId);
        assert.ok(rebound);
        assert.equal(rebound.statement, 'Metric 22: 25 ms');
        assert.ok(!receipt.bundle.claims.some((claim) => claim.id === claims[22]!.id));
        assert.equal(JSON.parse(receipt.action).approvalStage, 'begin-work');
        await page.getByRole('link', { name: id, exact: true }).click();
        await expect(page).toHaveURL(`${origin}/console/requests/${id}`);
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Request evidence', exact: true })).toBeVisible();
        const persistedLink = page.getByRole('link', { name: 'View approval receipt', exact: true });
        await expect(persistedLink).toBeVisible();
        await expect(persistedLink).toHaveAttribute('href', `/console/decisions/${encodeURIComponent(receipt.id)}`);
        await expect(persistedLink.locator('..')).toContainText(
          'approval to begin work, not final-deliverable authorization or evidence of execution or measurement.',
        );
        await page.getByRole('link', { name: 'Back to console', exact: true }).click();
      }
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
