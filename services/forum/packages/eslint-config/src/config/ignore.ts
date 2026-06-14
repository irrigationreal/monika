import type { TSESLint } from '@typescript-eslint/utils';

export const ignoresConfig: TSESLint.FlatConfig.Config = {
  ignores: [
    '.specstory/*',
    '**/.nx/**/*',
    '**/*.config.d.ts', // Ignore generated type definitions
    '**/*.config.js', // Ignore compiled config files
    '**/*.tsbuildinfo', // Ignore TypeScript build info
    '**/*.md/**/*', // Ignore markdown code blocks that ESLint extracts
    '**/android/**/*', // Ignore Capacitor Android project
    '**/build/**',
    '**/coverage/**',
    '**/DerivedData/**', // Ignore Xcode derived data
    '**/dist-server/**',
    '**/dist/**',
    '**/examples/*',
    '**/ios/**/*', // Ignore Capacitor iOS project
    '**/node_modules/**/*', // Ensure all node_modules are ignored
    '**/public/build/**',
    '**/storybook-static/**',
    '**/test-results/**', // Ignore test output
    '**/vendor/**/*', // Ignore vendor directories
  ],
};
