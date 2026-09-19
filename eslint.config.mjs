// Ported from QM's eslint.config.mjs (yc-software/qm @ 60ba791, MIT):
// js recommended + ts recommended + the same strictness deltas. The
// process.env-at-the-boundary rule is deferred until we have a config
// module (TODO Arts and Sciences); process.env reads today are the documented
// boundary (protocol socket paths, test tmpdirs).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/', '.upstream/', 'docs/', 'deploy/layers/'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-control-regex': 'off',
      'no-nested-ternary': 'error',
    },
  },
  {
    // Anti-fabrication guard (src/console + src/talk render every surface a
    // human sees): rendered output may not contain hardcoded dollar amounts,
    // invented percentages, claimed verification badges, or invented
    // personas. Telemetry must be computed from real rows; demo or probe
    // content must carry the repo's synthetic labels (PROBE / SAMPLE /
    // simulated). Applies to string literals and static template chunks;
    // comments are the wrong place for data anyway. Verdict words are matched
    // UPPERCASE-only so prose like "records an audited reset token" passes.
    files: ['src/console/**/*.ts', 'src/talk/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=/(\\$\\d+\\.\\d{2})|(\\$\\d{1,3}(,\\d{3})+)|(\\$\\d{2,})/]`,
          message:
            'fabricated-telemetry: hardcoded dollar amount in rendered output. Compute it from real data (requests, room health) or mark the content synthetic (PROBE/SAMPLE).',
        },
        {
          selector: `TemplateElement[value.raw=/(\\$\\d+\\.\\d{2})|(\\$\\d{1,3}(,\\d{3})+)|(\\$\\d{2,})/]`,
          message:
            'fabricated-telemetry: hardcoded dollar amount in rendered output. Compute it from real data (requests, room health) or mark the content synthetic (PROBE/SAMPLE).',
        },
        {
          selector: `Literal[value=/\\b\\d+(\\.\\d+)?% [A-Za-z]/]`,
          message:
            'fabricated-telemetry: hardcoded percentage in rendered output. A percentage is a computation — derive it from real rows or mark the content synthetic (PROBE/SAMPLE).',
        },
        {
          selector: `TemplateElement[value.raw=/\\b\\d+(\\.\\d+)?% [A-Za-z]/]`,
          message:
            'fabricated-telemetry: hardcoded percentage in rendered output. A percentage is a computation — derive it from real rows or mark the content synthetic (PROBE/SAMPLE).',
        },
        {
          selector: `Literal[value=/(🟢|🟡|🔴|✅|✔|☑)\\s*(RECONCILED|VERIFIED|AUDITED|CERTIFIED|NOTARIZED|ATTESTED|ACCREDITED|SYNCED)|\\b(RECONCILED|NOTARIZED|ATTESTED|ACCREDITED|SYNCED)\\b/]`,
          message:
            'fabricated-telemetry: verification badge / claimed verdict without a computation. Render the computed status from a real evaluation or remove the claim.',
        },
        {
          selector: `TemplateElement[value.raw=/(🟢|🟡|🔴|✅|✔|☑)\\s*(RECONCILED|VERIFIED|AUDITED|CERTIFIED|NOTARIZED|ATTESTED|ACCREDITED|SYNCED)|\\b(RECONCILED|NOTARIZED|ATTESTED|ACCREDITED|SYNCED)\\b/]`,
          message:
            'fabricated-telemetry: verification badge / claimed verdict without a computation. Render the computed status from a real evaluation or remove the claim.',
        },
        {
          selector:
            'Literal[value=/Alex Rivera|Jordan Brooks|Maya Chen|Elena Torres|Apex Clearing|Apex Prime|Goldman Sachs|Citadel Securities|Prime Custody|Honeycomb Studios/]',
          message:
            'fabricated-telemetry: invented persona or entity in rendered output. Render real principals from the session/ledger, or label synthetic fixtures explicitly.',
        },
        {
          selector:
            'TemplateElement[value.raw=/Alex Rivera|Jordan Brooks|Maya Chen|Elena Torres|Apex Clearing|Apex Prime|Goldman Sachs|Citadel Securities|Prime Custody|Honeycomb Studios/]',
          message:
            'fabricated-telemetry: invented persona or entity in rendered output. Render real principals from the session/ledger, or label synthetic fixtures explicitly.',
        },
        {
          selector: `Literal[value=/\\d+ new messages/]`,
          message:
            'fabricated-telemetry: unread counts require read-state tracking. Render a real count or remove the element.',
        },
        {
          selector: `TemplateElement[value.raw=/\\d+ new messages/]`,
          message:
            'fabricated-telemetry: unread counts require read-state tracking. Render a real count or remove the element.',
        },
      ],
    },
  },
  {
    // Canary probes are the repo's own deliberately-synthetic fixtures — every
    // payload already carries the PROBE / synthetic label, so the rendered-
    // string rules don't apply to their definition file. The test-suite guard
    // (test/fabrication-guard.test.ts) still verifies the labeling.
    files: ['src/talk/canary.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
