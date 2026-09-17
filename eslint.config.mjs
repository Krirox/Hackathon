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
);
