import pluginVitest from '@vitest/eslint-plugin';
import pluginPlaywright from 'eslint-plugin-playwright';
import testingLibraryPlugin from 'eslint-plugin-testing-library';
import globals from 'globals';

import type { TSESLint } from '@typescript-eslint/utils';

/**
 * Shared TypeScript rule relaxations for test files
 * Use 'warn' instead of 'off' to maintain awareness while allowing flexibility for mocking
 * (ported from magus-mark)
 */
const testTypeScriptRules: TSESLint.FlatConfig.Rules = {
  '@typescript-eslint/no-explicit-any': [
    'warn',
    {
      fixToUnknown: true,
      ignoreRestArgs: true,
    },
  ],
  '@typescript-eslint/no-floating-promises': 'off',
  '@typescript-eslint/no-misused-promises': 'off',
  '@typescript-eslint/no-non-null-assertion': 'off',
  '@typescript-eslint/no-unnecessary-type-assertion': 'off',
  '@typescript-eslint/no-unsafe-argument': 'warn',
  '@typescript-eslint/no-unsafe-assignment': 'warn',
  '@typescript-eslint/no-unsafe-call': 'warn',
  '@typescript-eslint/no-unsafe-member-access': 'warn',
  '@typescript-eslint/no-unsafe-return': 'warn',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
  '@typescript-eslint/unbound-method': 'off',
};

/**
 * ESLint configuration for unit tests (Vitest + Vue Testing Library)
 */
export const testConfig: TSESLint.FlatConfig.Config = {
  files: [
    '**/*.test.{js,jsx,ts,tsx}',
    '**/*.spec.{js,jsx,ts,tsx}',
    '**/src/**/__tests__/**/*.{js,jsx,ts,tsx}',
    '**/src/**/__mocks__/**/*.{js,ts}',
    '**/testing/**/*.{js,jsx,ts,tsx}',
    '**/vitest.config.ts',
  ],
  languageOptions: {
    globals: {
      ...globals.jest,
      ...globals.vitest,
    },
  },
  plugins: {
    'testing-library': testingLibraryPlugin,
    vitest: pluginVitest,
  },
  settings: {},
  rules: {
    // Vitest recommended rules
    ...pluginVitest.configs.recommended.rules,

    // Vue Testing Library rules (not React!)
    ...testingLibraryPlugin.configs['flat/vue'].rules,

    // Relax TypeScript rules for tests
    ...testTypeScriptRules,

    // Testing library specific overrides
    'testing-library/no-await-sync-events': 'off',
    // Allow container queries for CSS class assertions (common in Vue component tests)
    'testing-library/no-container': 'off',
    'testing-library/no-node-access': 'off',

    // Vitest rule relaxations for practical test patterns
    // Conditional expects are often necessary when testing dynamic/locale-dependent behavior
    'vitest/no-conditional-expect': 'off',
    // Some tests verify behavior through side effects, not assertions (e.g., "does not throw")
    'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expectTypeOf'] }],
  },
};

/**
 * ESLint configuration for E2E tests (Playwright)
 */
export const playwrightConfig: TSESLint.FlatConfig.Config = {
  files: ['e2e/**/*.{test,spec}.{js,ts,jsx,tsx}', 'e2e/**/*.ts'],
  plugins: {
    playwright: pluginPlaywright,
  },
  rules: {
    // Playwright recommended rules
    ...pluginPlaywright.configs['flat/recommended'].rules,

    // Relax TypeScript rules for E2E tests
    ...testTypeScriptRules,
  },
};
