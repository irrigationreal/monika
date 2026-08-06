import { config } from '@vue/test-utils';

// Global test configuration
config.global.stubs = {
  // Add global stubs here if needed
};
config.global.directives = {
  'enhance-mermaid': {},
};

// Mock window.matchMedia for tests
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});
