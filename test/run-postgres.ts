/**
 * Postgres-only lane. Run with TEST_PG_URL set (CI does; locally it is a
 * no-op that registers nothing and exits 0):
 *
 *   TEST_PG_URL=postgres://vital:vital-ci@localhost:5432/vital npm run test:postgres
 *
 * It deliberately does not enable status writes, so it can never overwrite
 * the main suite's var/status.json.
 */
import './postgres.test.ts';
