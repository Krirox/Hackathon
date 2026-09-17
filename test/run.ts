/**
 * Full suite entry. Imported for its side effects: each file registers its
 * tests with node:test. Run with the node test runner:
 *
 *   npm test   →  node --import tsx --test test/run.ts
 *
 * node:test supplies the reporter, per-test timeouts (see `T` in
 * helpers.ts), and the process exit code. `enableStatusWrites()` is what
 * lets this run — and only this run — update var/status.json for
 * `docs:check`.
 */
import './ledger.test.ts';
import './coord.test.ts';
import './router.test.ts';
import './compiler.test.ts';
import './gov.test.ts';
import './ingest.test.ts';
import './wedge.test.ts';
import './feature.test.ts';
import './deepresearch.test.ts';
import './evals.test.ts';
import './sense.test.ts';
import './substrate.test.ts';
import './attrib.test.ts';
import './capabilities.test.ts';
import './core.test.ts';
import './console.test.ts';
import './models.test.ts';
import './jcode.test.ts';
import './vendor.test.ts';
import './talk.test.ts';
import './auth.test.ts';
import './operator.test.ts';
import './erasure.test.ts';
import './aws.test.ts';
import './s3store.test.ts';
import './artifact.test.ts';
import { enableStatusWrites } from './helpers.ts';

enableStatusWrites();
