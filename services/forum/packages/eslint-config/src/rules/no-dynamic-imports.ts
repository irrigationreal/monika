/**
 * ESLint rule to prevent dynamic imports (import() syntax)
 * Only Vue Router lazy-loaded routes are allowed to use dynamic imports
 */

import type { Rule } from 'eslint';

export const noDynamicImports: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow dynamic imports except in Vue Router route definitions',
      category: 'Best Practices',
      recommended: true,
    },
    schema: [],
    messages: {
      noDynamicImport:
        'Dynamic imports (import()) are forbidden. Use static imports instead. Only Vue Router lazy-loaded routes are allowed to use dynamic imports.',
    },
  },
  create(context) {
    return {
      ImportExpression(node) {
        const filename = context.filename;

        // Allow dynamic imports in Vue Router files
        if (
          filename.endsWith('router.ts') ||
          filename.endsWith('router.js') ||
          filename.endsWith('router/index.ts') ||
          filename.endsWith('router/index.js') ||
          filename.includes('/router/')
        ) {
          return;
        }

        // Report the error for all other files
        context.report({
          node,
          messageId: 'noDynamicImport',
        });
      },
    };
  },
};
