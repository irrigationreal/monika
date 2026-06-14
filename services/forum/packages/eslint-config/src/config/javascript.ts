import js from '@eslint/js';

import type { TSESLint } from '@typescript-eslint/utils';

export const jsConfig: TSESLint.FlatConfig.Config = {
  files: ['**/*.{js,mjs,cjs}'],
  rules: {
    ...js.configs.recommended.rules,
  },
};
