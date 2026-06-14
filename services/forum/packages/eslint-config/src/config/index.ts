import { baseConfig } from './base';
import { ignoresConfig } from './ignore';
import { jsConfig } from './javascript';
import { markdownConfig, markdownTsConfig } from './markdown';
import { mocksConfig } from './mocks';
import { nodeConfig } from './node';
import { createStorybookConfig } from './storybook';
import { playwrightConfig, testConfig } from './test';
import { createTsConfig } from './typescript';
import { viteConfig } from './vite';
import { createVueConfig } from './vue';

import type { TSESLint } from '@typescript-eslint/utils';

export const DEBUG: boolean = process.env['NODE_ENV'] === 'development' && process.env['DEBUG'] === 'true';

/**
 * Configuration options for the ESLint config factory
 */
export interface PackageESLintConfigOptions {
  /** Framework-specific config. Defaults to 'none'. */
  framework?: 'vue' | 'none';

  /** Include Vitest/test config. Defaults to false. */
  tests?: boolean;

  /** Include Playwright E2E config. Defaults to false. */
  playwright?: boolean;

  /** Include mocks config. Defaults to false. */
  mocks?: boolean;

  /** Include Storybook config. Defaults to false. */
  storybook?: boolean;

  /** Root directory for TypeScript config resolution. */
  tsconfigRootDir?: string;
}

/**
 * Creates an ESLint configuration with optional framework and tooling support
 * @param customConfig - Additional ESLint configuration to merge
 * @param options - Configuration options for framework and tooling inclusion
 */
export function createESLintConfig(
  customConfig: TSESLint.FlatConfig.Config[] = [],
  options: PackageESLintConfigOptions = {}
): TSESLint.FlatConfig.Config[] {
  const {
    framework = 'none',
    tests = false,
    playwright = false,
    mocks = false,
    storybook = false,
    tsconfigRootDir,
  } = options;

  const configs: TSESLint.FlatConfig.Config[] = [
    baseConfig,
    jsConfig,
    createTsConfig(tsconfigRootDir),
    // Framework configs (each receives tsconfigRootDir)
    ...(framework === 'vue' ? [createVueConfig(tsconfigRootDir)] : []),
    // Tool configs
    ...(storybook ? [createStorybookConfig(tsconfigRootDir)] : []),
    ...(tests ? [testConfig] : []),
    ...(playwright ? [playwrightConfig] : []),
    ...(mocks ? [mocksConfig] : []),
    // Always included
    viteConfig,
    markdownTsConfig,
    markdownConfig,
    nodeConfig,
    ignoresConfig,
    ...customConfig,
  ];

  if (DEBUG) {
    console.info(configs);
  }

  return configs;
}
