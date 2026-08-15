import { computed, ref } from 'vue';

import { enableAutoUnmount, flushPromises, shallowMount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import UserFilesView from './UserFilesView.vue';

const currentUser = ref<{ id: string } | null>({ id: 'owner-a' });
const listUserFiles = vi.fn();
const uploadUserFile = vi.fn();

enableAutoUnmount(afterEach);

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../composables/useForumState', () => ({
  useForumState: () => ({
    currentUser,
    authChecked: ref(true),
    isLoggedIn: computed(() => Boolean(currentUser.value)),
    checkAuth: vi.fn(),
    POSTS_PER_PAGE: 8,
  }),
}));
vi.mock('../lib/apiClient', () => ({
  api: {
    listUserFilesPage: (...args: unknown[]) => listUserFiles(...args) as Promise<unknown>,
    uploadUserFile: (...args: unknown[]) => uploadUserFile(...args) as Promise<unknown>,
    deleteUserFile: vi.fn(),
    updateUserFile: vi.fn(),
    deleteAttachment: vi.fn(),
  },
}));

function file(id: string, filename: string) {
  return {
    id,
    ownerId: id,
    filename,
    mimeType: 'text/plain',
    sizeBytes: 1,
    standalone: true,
    visibility: 'private' as const,
    expiresAt: null,
    revision: 1,
    blobState: 'ready' as const,
    associations: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mountView() {
  return shallowMount(UserFilesView, { global: { stubs: { RouterLink: true } } });
}

describe('UserFilesView async identity boundaries', () => {
  beforeEach(() => {
    currentUser.value = { id: 'owner-a' };
    listUserFiles.mockReset();
    uploadUserFile.mockReset();
  });

  it('clears the previous owner metadata before loading the next identity', async () => {
    listUserFiles
      .mockResolvedValueOnce({ items: [file('a', 'owner-a-secret.txt')], nextCursor: null })
      .mockResolvedValueOnce({ items: [file('b', 'owner-b.txt')], nextCursor: null });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('owner-a-secret.txt');

    currentUser.value = null;
    await flushPromises();
    expect(wrapper.text()).not.toContain('owner-a-secret.txt');

    currentUser.value = { id: 'owner-b' };
    await flushPromises();
    expect(wrapper.text()).not.toContain('owner-a-secret.txt');
    expect(wrapper.text()).toContain('owner-b.txt');
    expect(listUserFiles).toHaveBeenCalledTimes(2);
  });

  it('ignores a delayed list response from the previous identity', async () => {
    const ownerA = deferred<{ items: ReturnType<typeof file>[]; nextCursor: null }>();
    listUserFiles
      .mockReturnValueOnce(ownerA.promise)
      .mockResolvedValueOnce({ items: [file('b', 'owner-b.txt')], nextCursor: null });
    const wrapper = mountView();
    await flushPromises();

    currentUser.value = { id: 'owner-b' };
    await flushPromises();
    expect(wrapper.text()).toContain('owner-b.txt');

    ownerA.resolve({ items: [file('a', 'owner-a-secret.txt')], nextCursor: null });
    await flushPromises();
    expect(wrapper.text()).toContain('owner-b.txt');
    expect(wrapper.text()).not.toContain('owner-a-secret.txt');
  });

  it('ignores a delayed response after the filter changes', async () => {
    const standalone = deferred<{ items: ReturnType<typeof file>[]; nextCursor: null }>();
    listUserFiles
      .mockReturnValueOnce(standalone.promise)
      .mockResolvedValueOnce({ items: [file('all', 'all-files.txt')], nextCursor: null });
    const wrapper = mountView();
    await flushPromises();

    const allButton = wrapper.findAll('button').find((button) => button.text() === 'All');
    expect(allButton).toBeDefined();
    await allButton!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('all-files.txt');

    standalone.resolve({ items: [file('standalone', 'stale-standalone.txt')], nextCursor: null });
    await flushPromises();
    expect(wrapper.text()).toContain('all-files.txt');
    expect(wrapper.text()).not.toContain('stale-standalone.txt');
  });

  it('stops a sequential upload when the identity changes mid-request', async () => {
    const firstUpload = deferred<ReturnType<typeof file> & { deduplicated?: boolean }>();
    listUserFiles
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({ items: [file('b', 'owner-b.txt')], nextCursor: null });
    uploadUserFile.mockReturnValueOnce(firstUpload.promise);
    const wrapper = mountView();
    await flushPromises();

    const selectedFiles = [
      new File(['one'], 'owner-a-one.txt', { type: 'text/plain' }),
      new File(['two'], 'owner-a-two.txt', { type: 'text/plain' }),
    ];
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, 'files', { configurable: true, value: selectedFiles });
    await input.trigger('change');
    const uploadButton = wrapper.findAll('button').find((button) => button.text() === 'Upload');
    expect(uploadButton).toBeDefined();
    await uploadButton!.trigger('click');
    await flushPromises();
    expect(uploadUserFile).toHaveBeenCalledTimes(1);

    currentUser.value = { id: 'owner-b' };
    await flushPromises();
    firstUpload.resolve({ ...file('a', 'owner-a-one.txt'), deduplicated: false });
    await flushPromises();

    expect(uploadUserFile).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('owner-b.txt');
    expect(wrapper.text()).not.toContain('owner-a-one.txt');
    expect(wrapper.text()).not.toContain('Uploaded 1 file');
    expect(wrapper.text()).not.toContain('owner-a-two.txt');
  });
});
