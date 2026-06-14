import tseslint from 'typescript-eslint';

import type { TSESLint } from '@typescript-eslint/utils';

/**
 * Creates ESLint configuration for Storybook story files
 * Relaxes certain TypeScript rules that are problematic with Storybook's Vue 3 integration
 * @param tsconfigRootDir - Optional root directory for TypeScript config resolution
 */
export function createStorybookConfig(tsconfigRootDir?: string): TSESLint.FlatConfig.Config {
  return {
    files: ['**/*.stories.{js,jsx,ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        ...(tsconfigRootDir && { tsconfigRootDir }),
      },
    },
    rules: {
      // Disable expensive type-aware rules for Storybook - stories don't need strict type checking
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unnecessary-type-arguments': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // Allow empty functions in mocks
      '@typescript-eslint/no-empty-function': 'off',

      // Allow unused vars that start with _ (common in story args)
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // Still enforce good practices for imports and exports
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  };
}
