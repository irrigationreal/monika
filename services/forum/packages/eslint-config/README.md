# @irrigationreal/eslint-config

Shared ESLint configuration for Magus Mark projects.

## Usage

### Installation

The package is available as a workspace dependency:

```bash
"@irrigationreal/eslint-config": "workspace:*"
```

### Using in a project

Create an `eslint.config.js` file in your project root:

```js
// eslint.config.js
import customConfig from '@irrigationreal/eslint-config';

export default [
  ...customConfig,

  // Add any project-specific overrides here
  {
    files: ['src/**/*.ts'],
    rules: {
      // Project-specific rule overrides
    },
  },
];
```

### Peer Dependencies

Ensure your project has compatible versions of:

- `eslint@^9`
- `typescript@^5.8` (or workspace-provided)

### Configuration Structure

This configuration:

1. Extends the shared configurations in `config/eslint/`
2. Provides sensible defaults for TypeScript, JavaScript, React and test files
3. Integrates with Prettier for consistent formatting
4. Includes accessibility rules (jsx-a11y)

## Included Plugins

- TypeScript ESLint (`@typescript-eslint/eslint-plugin`)
- Import Plugin (`eslint-plugin-import-x`)
- React (`eslint-plugin-react`)
- React Hooks (`eslint-plugin-react-hooks`)
- JSX Accessibility (`eslint-plugin-jsx-a11y`)
- Testing Library (`eslint-plugin-testing-library`)

## Custom Rules

### no-direct-data-import

Enforces clean architectural boundaries:

- Disallows importing `@irrigationreal/data` directly from Vue components
- Allowed in `stores/` and test files

Example violation:

```ts
// app/src/components/Foo.vue (disallowed)
import { transactionsService } from '@irrigationreal/data/api';
```

Allowed:

```ts
// app/src/stores/transactions.ts
import { transactionsService } from '@irrigationreal/data/api';
```

### no-dynamic-imports

Enforces static imports for build reliability and type safety:

- Disallows `import()` and `await import()` syntax
- Only allowed in Vue Router route definitions for lazy loading

Example violations:

```ts
// Forbidden - dynamic import
const module = await import('./some-module');

// Forbidden - conditional dynamic import
if (condition) {
  const module = await import('./conditional-module');
}
```

Allowed:

```ts
// Static imports - always use these
import MyComponent from '@/components/MyComponent.vue';

import { myFunction } from './some-module';

// Vue Router lazy routes - acceptable
const routes = [
  {
    path: '/dashboard',
    component: () => import('@/views/Dashboard.vue'),
  },
];
```
