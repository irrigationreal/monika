import markdownPlugin from '@eslint/markdown';
import tseslint from 'typescript-eslint';

import type { TSESLint } from '@typescript-eslint/utils';

export const markdownConfig: TSESLint.FlatConfig.Config = {
  files: ['**/*.md'],
  plugins: {
    markdown: markdownPlugin,
  },
  processor: 'markdown/markdown',
};

export const markdownTsConfig: TSESLint.FlatConfig.Config = {
  files: ['**/*.md/**/*.{ts,tsx}'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      // Explicitly disable project for markdown code blocks
      project: null,
      projectService: false,
    },
  },
  rules: {
    ...tseslint.configs.base.rules,
    ...tseslint.configs.disableTypeChecked.rules,
    '@typescript-eslint/no-unused-vars': 'off',
    'import-x/no-unresolved': 'off',
  },
};
