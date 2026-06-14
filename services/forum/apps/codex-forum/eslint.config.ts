import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createESLintConfig } from '@irrigationreal/eslint-config';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default createESLintConfig(
  [
    {
      files: ['src/**/*.{ts,tsx,vue}'],
      rules: {
        'no-console': 'warn',
      },
    },
  ],
  {
    framework: 'vue',
    tests: true,
    playwright: true,
    mocks: true,
    storybook: true,
    tsconfigRootDir: __dirname,
  }
);
