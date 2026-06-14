import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createESLintConfig } from '@irrigationreal/eslint-config';

import type { TSESLint } from '@typescript-eslint/utils';

const __dirname = dirname(fileURLToPath(import.meta.url));

const config: TSESLint.FlatConfig.Config[] = createESLintConfig(
  [
    {
      files: ['src/**/*.{ts,tsx,vue}'],
      rules: {
        'no-console': 'warn',
      },
    },
    {
      files: ['packages/server/src/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: 'TSEnumDeclaration',
            message:
              'Server must import shared enums from core/contracts; do not declare enums in the server package.',
          },
        ],
      },
    },
    {
      files: ['apps/codex-forum/e2e/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: 'TSInterfaceDeclaration[id.name=/Dto$/]',
            message:
              'DTOs belong in @irrigationreal/codex-forum-contracts. Import DTOs instead of redeclaring them in E2E tests.',
          },
          {
            selector: 'TSTypeAliasDeclaration[id.name=/Dto$/]',
            message:
              'DTOs belong in @irrigationreal/codex-forum-contracts. Import DTOs instead of redeclaring them in E2E tests.',
          },
        ],
      },
    },
  ],
  {
    tsconfigRootDir: __dirname,
  }
);

export default config;
