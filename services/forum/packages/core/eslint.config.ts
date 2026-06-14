import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createESLintConfig } from '@irrigationreal/eslint-config';

import type { TSESLint } from '@typescript-eslint/utils';

const __dirname = dirname(fileURLToPath(import.meta.url));

const config: TSESLint.FlatConfig.Config[] = createESLintConfig([], {
  tests: true,
  mocks: true,
  tsconfigRootDir: __dirname,
});

export default config;
