import vueParser from 'vue-eslint-parser';

import vuePlugin from 'eslint-plugin-vue';
import vueA11yPlugin from 'eslint-plugin-vuejs-accessibility';
import tseslint from 'typescript-eslint';

import { noDynamicImports } from '../rules/index';

import type { TSESLint } from '@typescript-eslint/utils';

// Get TypeScript configs for Vue files - extract the actual rule configs
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- noUncheckedIndexedAccess requires assertion
const tsStrictTypeChecked = tseslint.configs.strictTypeChecked[2]!;
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- noUncheckedIndexedAccess requires assertion
const tsStylisticTypeChecked = tseslint.configs.stylisticTypeChecked[2]!;

// Extract and merge rules from vue plugin flat config array
const vueRecommendedRules = (vuePlugin.configs['flat/recommended'] as TSESLint.FlatConfig.Config[])
  .filter((config) => config.rules !== undefined)
  .reduce<TSESLint.FlatConfig.Rules>((acc, config) => ({ ...acc, ...config.rules }), {});

// Extract rules from vuejs-accessibility flat config array
const vueA11yRules = (vueA11yPlugin.configs['flat/recommended'] as TSESLint.FlatConfig.Config[])
  .filter((config) => config.rules !== undefined)
  .reduce<TSESLint.FlatConfig.Rules>((acc, config) => ({ ...acc, ...config.rules }), {});

// Get the processor from Vue plugin (needed for vue/comment-directive rule)
const vueProcessorConfig = (vuePlugin.configs['flat/recommended'] as TSESLint.FlatConfig.Config[]).find(
  (config) => config.processor !== undefined
);

/**
 * Creates the Vue ESLint configuration
 * @param tsconfigRootDir - Optional root directory for TypeScript config resolution
 */
export function createVueConfig(tsconfigRootDir?: string): TSESLint.FlatConfig.Config {
  const config: TSESLint.FlatConfig.Config = {
    files: ['**/*.vue'],
    plugins: {
      vue: vuePlugin,
      'vuejs-accessibility': vueA11yPlugin,
      '@typescript-eslint': tseslint.plugin,
      dollarwise: {
        rules: {
          'no-dynamic-imports': noDynamicImports,
        },
      },
    },
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        // Use TS parser for <script lang="ts"> blocks
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        ecmaVersion: 2024,
        sourceType: 'module',
        projectService: true,
        ...(tsconfigRootDir && { tsconfigRootDir }),
      },
    },
    rules: {
      // Vue recommended rules take precedence
      ...vueRecommendedRules,
      ...vueA11yRules,

      // Apply TypeScript rules to Vue files
      ...tsStrictTypeChecked.rules,
      ...tsStylisticTypeChecked.rules,

      // Custom TypeScript rules for Vue files
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',

      // Vue-specific overrides for TypeScript rules
      // Allow props destructuring in setup functions
      'vue/first-attribute-linebreak': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/html-indent': 'off',
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/no-setup-props-destructure': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vuejs-accessibility/form-control-has-label': 'off',
      'vuejs-accessibility/label-has-for': 'off',

      // Custom DollarWise rules
      'dollarwise/no-dynamic-imports': 'error',
    },
  };

  // Only add processor if it exists (satisfies exactOptionalPropertyTypes)
  if (vueProcessorConfig?.processor) {
    config.processor = vueProcessorConfig.processor;
  }

  return config;
}
