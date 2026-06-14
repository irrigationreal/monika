import globals from 'globals';

import type { TSESLint } from '@typescript-eslint/utils';

export const nodeConfig: TSESLint.FlatConfig.Config = {
  files: [
    'eslint.config.ts',
    'eslint.config.js',
    'vite.config.ts',
    'vite.config.mts',
    'vitest.config.ts',
    'vitest.config.mts',
    'playwright.config.ts',
    'mocks/**/*.js',
    'mocks/**/*.ts',
  ],
  languageOptions: {
    globals: {
      ...globals.node,
    },
  },
};
