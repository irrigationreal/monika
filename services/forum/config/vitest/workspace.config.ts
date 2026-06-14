/**
 * Vitest workspace configuration for monorepo
 *
 * This file should be placed at the root of the monorepo as vitest.workspace.ts
 * It automatically discovers vitest configs in packages and apps.
 */
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  './packages/*/vitest.config.{js,ts}',
  './apps/*/vitest.config.{js,ts}',
]);
