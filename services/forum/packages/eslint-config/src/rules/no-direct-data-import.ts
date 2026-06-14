/**
 * ESLint rule to prevent direct imports from @irrigationreal/data package
 * Only stores and test files are allowed to import directly from @irrigationreal/data
 */

import type { Rule } from 'eslint';

export const noDirectDataImport: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct imports from @irrigationreal/data except in stores',
      category: 'Best Practices',
      recommended: true,
    },
    schema: [],
    messages: {
      noDirectImport: 'Direct imports from @irrigationreal/data are not allowed. Import from stores instead.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const importPath = node.source.value;

        // Check if this is an import from @irrigationreal/data
        if (typeof importPath === 'string' && importPath.startsWith('@irrigationreal/data')) {
          const filename = context.filename;

          // Allow imports in store files
          if (filename.includes('/stores/')) {
            return;
          }

          if (importPath.includes('/helpers/')) {
            return;
          }

          // Allow imports in test files
          if (
            filename.endsWith('.test.ts') ||
            filename.endsWith('.spec.ts') ||
            filename.endsWith('.test.tsx') ||
            filename.endsWith('.spec.tsx')
          ) {
            return;
          }

          // Report the error for all other files
          context.report({
            node,
            messageId: 'noDirectImport',
          });
        }
      },
    };
  },
};
