import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

import type { TSESLint } from '@typescript-eslint/utils';

export const baseConfig: TSESLint.FlatConfig.Config = {
  files: ['**/*'],
  languageOptions: {
    globals: {
      ...globals.browser,
      ...globals.es2024,
      ...globals.node,
    },
    parserOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      ecmaFeatures: {
        jsx: true,
        impliedStrict: true,
      },
    },
  },
  ...prettierConfig,
};
