import type { TSESLint } from '@typescript-eslint/utils';

/**
 * ESLint configuration for Vite config files and plugins.
 *
 * Vite 7's type definitions use Node.js subpath imports that ESLint cannot resolve,
 * causing false-positive "unsafe" errors. These files are build-time only and type-safe
 * via TypeScript, so we relax these rules.
 */
export const viteConfig: TSESLint.FlatConfig.Config = {
  files: ['**/vite.config.{js,ts}', '**/vite/**/*.{js,ts}'],
  rules: {
    // Vite plugin APIs use `any` types that cannot be narrowed
    '@typescript-eslint/no-unsafe-argument': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unsafe-return': 'off',
  },
};
