import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    // Happy DOM 21 keeps external stylesheet/iframe loading disabled. Exercise
    // real resource loading in Playwright instead of opting out of these defaults.
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
    },
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['dist/**/*', '**/*.d.ts'],
  },
});
