import importXPlugin from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

import { noDynamicImports } from '../rules/index';

import type { TSESLint } from '@typescript-eslint/utils';

// TypeScript base configuration - extract the actual rule configs
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- noUncheckedIndexedAccess requires assertion
const tsStrictTypeChecked = tseslint.configs.strictTypeChecked[2]!;
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- noUncheckedIndexedAccess requires assertion
const tsStylisticTypeChecked = tseslint.configs.stylisticTypeChecked[2]!;

/**
 * Creates the TypeScript ESLint configuration
 * @param tsconfigRootDir - Optional root directory for TypeScript config resolution
 */
export function createTsConfig(tsconfigRootDir?: string): TSESLint.FlatConfig.Config {
  return {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'import-x': importXPlugin,
      dollarwise: {
        rules: {
          'no-dynamic-imports': noDynamicImports,
        },
      },
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: {
          defaultProject: 'tsconfig.json',
        },
        ...(tsconfigRootDir && { tsconfigRootDir }),
      },
    },
    settings: {
      'import-x/resolver': {
        typescript: true,
        node: true,
      },
    },
    rules: {
      ...importXPlugin.configs.recommended.rules,
      ...importXPlugin.configs.typescript.rules,

      ...tsStrictTypeChecked.rules,
      ...tsStylisticTypeChecked.rules,

      'import-x/order': 'off',

      // Custom TypeScript rules
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',

      // Strict type safety rules (ported from magus-mark)
      '@typescript-eslint/no-explicit-any': [
        'error',
        {
          fixToUnknown: false,
          ignoreRestArgs: false,
        },
      ],
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      // Prefer safer operators
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/no-unnecessary-type-conversion': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',

      // Unused variables with underscore pattern
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [{ from: 'lib', name: 'Response' }],
          allowThrowingAny: false,
          allowThrowingUnknown: false,
        },
      ],

      // Custom DollarWise rules
      'dollarwise/no-dynamic-imports': 'error',
    },
  };
}
