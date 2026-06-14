/**
 * Base Vitest configuration for monorepo packages
 *
 * This provides a consistent base configuration that individual packages
 * can extend with their specific settings.
 *
 * Usage in package vitest.config.ts:
 * ```ts
 * import { mergeConfig } from 'vitest/config';
 * import baseConfig from '../../config/vitest/base.config';
 *
 * export default mergeConfig(baseConfig, {
 *   test: {
 *     // Package-specific overrides
 *   },
 * });
 * ```
 */
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

import type { ViteUserConfig } from 'vitest/config';

const baseConfig: ViteUserConfig = defineConfig({
  plugins: [
    tsconfigPaths({
      ignoreConfigErrors: true,
    }),
  ],
  test: {
    // Default to node environment, packages can override to 'happy-dom' or 'jsdom'
    environment: 'node',

    // Standard test file patterns
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.d.ts'],

    // Enable globals for cleaner test syntax (describe, it, expect, etc.)
    globals: true,

    // Reasonable default timeout
    testTimeout: 10000,

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/index.ts',
        '**/__mocks__/**',
        '**/__tests__/**',
        '**/testing/**',
      ],
    },

    // Reporter configuration
    reporters: ['default'],

    // Pool options for better performance
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
      },
    },
  },
});

export default baseConfig;
