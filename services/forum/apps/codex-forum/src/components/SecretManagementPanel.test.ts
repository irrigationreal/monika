import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../composables/useTheme';
import SecretManagementPanel from './SecretManagementPanel.vue';

vi.mock('../lib/apiClient', () => ({ api: {
  listSecrets: vi.fn().mockResolvedValue({ items: [] }),
  listAdminSecrets: vi.fn().mockResolvedValue({ items: [] }),
} }));

describe('shared secret controls', () => {
  afterEach(() => { useTheme().resolvedTone.value = 'dark'; });
  for (const admin of [false, true]) {
    it(`themes native controls for ${admin ? 'admin' : 'personal'} secrets`, async () => {
      const { resolvedTone } = useTheme();
      resolvedTone.value = 'dark';
      const wrapper = mount(SecretManagementPanel, { props: { admin } });
      await flushPromises();
      expect(wrapper.attributes('style')).toContain('color-scheme: dark');
      expect(wrapper.get('input[type="datetime-local"]').exists()).toBe(true);
      expect(wrapper.findAll('.secret-management__fields input')).toHaveLength(4);
      resolvedTone.value = 'light';
      await wrapper.vm.$nextTick();
      expect(wrapper.attributes('style')).toContain('color-scheme: light');
      wrapper.unmount();
    });
  }
});
