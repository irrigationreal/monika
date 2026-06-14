/**
 * Vitest configuration for Node.js packages (libraries, shared utilities, data layers)
 *
 * Extends base config with Node.js-specific settings.
 */
import { mergeConfig } from 'vitest/config';

import baseConfig from './base.config';

export default mergeConfig(baseConfig, {
  test: {
    environment: 'node',
  },
});
