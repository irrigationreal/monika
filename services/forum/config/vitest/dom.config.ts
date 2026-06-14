/**
 * Vitest configuration for DOM-based packages (Vue components, design systems)
 *
 * Extends base config with happy-dom environment for fast DOM testing.
 */
import { mergeConfig } from 'vitest/config';

import baseConfig from './base.config';

export default mergeConfig(baseConfig, {
  test: {
    environment: 'happy-dom',
  },
});
