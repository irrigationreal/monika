import { computed, ref } from 'vue';

import { enableAutoUnmount, flushPromises, shallowMount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConfirmationDialog from '../components/ConfirmationDialog.vue';
import UserFilesView from './UserFilesView.vue';

const currentUser = ref<{ id: string } | null>({ id: 'owner-a' });
const listUserFiles = vi.fn();
const uploadUserFile = vi.fn();
const deleteUserFile = vi.fn();
const deleteAttachment = vi.fn();
const updateUserFile = vi.fn();

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
    deleteUserFile: (...args: unknown[]) => deleteUserFile(...args) as Promise<unknown>,
    updateUserFile: (...args: unknown[]) => updateUserFile(...args) as Promise<unknown>,
    deleteAttachment: (...args: unknown[]) => deleteAttachment(...args) as Promise<unknown>,
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

function mountView(attachTo?: HTMLElement) {
  return shallowMount(UserFilesView, {
    ...(attachTo ? { attachTo } : {}),
    global: { stubs: { RouterLink: true } },
  });
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected test element to exist');
  return value;
}

describe('UserFilesView async identity boundaries', () => {
  beforeEach(() => {
    currentUser.value = { id: 'owner-a' };
    listUserFiles.mockReset();
    uploadUserFile.mockReset();
    deleteUserFile.mockReset();
    deleteAttachment.mockReset();
    updateUserFile.mockReset();
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
    await required(allButton).trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('all-files.txt');

    standalone.resolve({ items: [file('standalone', 'stale-standalone.txt')], nextCursor: null });
    await flushPromises();
    expect(wrapper.text()).toContain('all-files.txt');
    expect(wrapper.text()).not.toContain('stale-standalone.txt');
  });

  it('renders styled selects, an accessible hidden picker, and a browse trigger', async () => {
    listUserFiles.mockResolvedValue({ items: [], nextCursor: null });
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.findAll('select.vb-option-select')).toHaveLength(2);
    const input = wrapper.find('input[type="file"]');
    expect(input.classes()).toContain('vb-user-files-hidden-input');
    expect(input.attributes('multiple')).toBeDefined();
    expect(input.attributes('aria-label')).toBe('Choose files to upload');
    expect(input.attributes('tabindex')).toBe('-1');
    const click = vi.spyOn(input.element as HTMLInputElement, 'click');
    const browse = wrapper.findAll('button').find((button) => button.text() === 'Browse files');
    expect(browse).toBeDefined();
    await required(browse).trigger('click');
    expect(click).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('No files selected');
  });

  it('exposes an exclusive filter with persistent selected and aria-pressed state', async () => {
    listUserFiles.mockResolvedValue({ items: [], nextCursor: null });
    const wrapper = mountView();
    await flushPromises();

    const filterButtons = wrapper.findAll('.vb-user-files-filter-button');
    expect(filterButtons).toHaveLength(3);
    expect(filterButtons.map((button) => button.attributes('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(required(filterButtons[0]).classes()).toContain('vb-user-files-filter-button-selected');

    await required(filterButtons[1]).trigger('click');
    await flushPromises();
    expect(filterButtons.map((button) => button.attributes('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(required(filterButtons[1]).classes()).toContain('vb-user-files-filter-button-selected');
  });

  it('opens the reusable confirmation dialog and prevents duplicate standalone removal', async () => {
    const pendingDelete = deferred<undefined>();
    listUserFiles.mockResolvedValue({ items: [file('file-a', 'canonical.txt')], nextCursor: null });
    deleteUserFile.mockReturnValue(pendingDelete.promise);
    const wrapper = mountView(document.body);
    await flushPromises();

    const remove = wrapper.findAll('button').find((button) => button.text() === 'Remove standalone copy');
    expect(remove).toBeDefined();
    await required(remove).trigger('click');
    const dialog = wrapper.findComponent(ConfirmationDialog);
    expect(dialog.props()).toMatchObject({
      open: true,
      title: 'Remove standalone copy?',
      confirmLabel: 'Remove standalone copy',
    });
    expect(dialog.props('message')).toContain('Its post associations will remain.');

    dialog.vm.$emit('confirm');
    dialog.vm.$emit('confirm');
    await flushPromises();
    expect(deleteUserFile).toHaveBeenCalledTimes(1);
    pendingDelete.resolve(undefined);
    await flushPromises();
    expect(listUserFiles).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(wrapper.find('.vb-user-files-header h3').element);
  });

  it('opens a tombstone-specific confirmation before removing a post attachment', async () => {
    const associated = {
      ...file('file-a', 'canonical.txt'),
      associations: [
        {
          id: 'association-a',
          postId: 'post-a',
          topicId: 'topic-a',
          topicTitle: 'Topic',
          postNumber: 1,
          filename: 'context-name.txt',
          mimeType: 'text/plain',
          deletedAt: null,
        },
      ],
    };
    listUserFiles.mockResolvedValue({ items: [associated], nextCursor: null });
    const wrapper = mountView();
    await flushPromises();

    const remove = wrapper.findAll('button').find((button) => button.text() === 'Remove from post');
    expect(remove).toBeDefined();
    await required(remove).trigger('click');
    const dialog = wrapper.findComponent(ConfirmationDialog);
    expect(dialog.props()).toMatchObject({
      open: true,
      title: 'Remove attachment from post?',
      confirmLabel: 'Remove from post',
    });
    expect(dialog.props('message')).toContain('A tombstone will remain in the post.');
    expect(deleteAttachment).not.toHaveBeenCalled();

    dialog.vm.$emit('confirm');
    dialog.vm.$emit('confirm');
    await flushPromises();
    expect(deleteAttachment).toHaveBeenCalledTimes(1);
    expect(deleteAttachment).toHaveBeenCalledWith('association-a');
    expect(listUserFiles).toHaveBeenCalledTimes(2);
  });

  it('disables filters while an upload is pending', async () => {
    const pendingUpload = deferred<ReturnType<typeof file> & { deduplicated?: boolean }>();
    listUserFiles.mockResolvedValue({ items: [], nextCursor: null });
    uploadUserFile.mockReturnValue(pendingUpload.promise);
    const wrapper = mountView();
    await flushPromises();

    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['one'], 'one.txt', { type: 'text/plain' })],
    });
    await input.trigger('change');
    const uploadButton = wrapper.findAll('button').find((button) => button.text() === 'Upload');
    await required(uploadButton).trigger('click');
    await flushPromises();

    expect(
      wrapper.findAll('.vb-user-files-filter-button').every((button) => button.attributes('disabled') !== undefined)
    ).toBe(true);

    pendingUpload.resolve({ ...file('one', 'one.txt'), deduplicated: false });
    await flushPromises();
    expect(
      wrapper.findAll('.vb-user-files-filter-button').every((button) => button.attributes('disabled') === undefined)
    ).toBe(true);
  });

  it('keeps the list visible and only marks Load more pending while appending', async () => {
    const append = deferred<{ items: ReturnType<typeof file>[]; nextCursor: null }>();
    listUserFiles
      .mockResolvedValueOnce({ items: [file('one', 'one.txt')], nextCursor: 'next' })
      .mockReturnValueOnce(append.promise);
    const wrapper = mountView();
    await flushPromises();

    const loadMore = wrapper.findAll('button').find((button) => button.text() === 'Load more');
    await required(loadMore).trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('one.txt');
    expect(wrapper.find('.vb-user-files-loading').exists()).toBe(false);
    expect(required(loadMore).attributes('disabled')).toBeDefined();
    expect(required(loadMore).text()).toBe('Loading…');

    append.resolve({ items: [file('two', 'two.txt')], nextCursor: null });
    await flushPromises();
    expect(wrapper.text()).toContain('one.txt');
    expect(wrapper.text()).toContain('two.txt');
  });

  it('does not leak a stale append response after the filter changes', async () => {
    const append = deferred<{ items: ReturnType<typeof file>[]; nextCursor: null }>();
    listUserFiles
      .mockResolvedValueOnce({ items: [file('one', 'one.txt')], nextCursor: 'next' })
      .mockReturnValueOnce(append.promise)
      .mockResolvedValueOnce({ items: [file('all', 'all-files.txt')], nextCursor: null });
    const wrapper = mountView();
    await flushPromises();

    const loadMore = wrapper.findAll('button').find((button) => button.text() === 'Load more');
    await required(loadMore).trigger('click');
    await flushPromises();
    const allButton = wrapper.findAll('button').find((button) => button.text() === 'All');
    await required(allButton).trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('all-files.txt');

    append.resolve({ items: [file('stale', 'stale-append.txt')], nextCursor: null });
    await flushPromises();
    expect(wrapper.text()).not.toContain('stale-append.txt');
    expect(wrapper.text()).toContain('all-files.txt');
  });

  it('prevents duplicate settings updates for one file and disables filters until it settles', async () => {
    const pendingUpdate = deferred<undefined>();
    listUserFiles.mockResolvedValue({ items: [file('one', 'one.txt')], nextCursor: null });
    updateUserFile.mockReturnValue(pendingUpdate.promise);
    const wrapper = mountView();
    await flushPromises();

    const visibilitySelect = required(wrapper.findAll('.vb-user-file-controls select')[0]);
    await visibilitySelect.setValue('public');
    await visibilitySelect.trigger('change');
    await flushPromises();

    expect(updateUserFile).toHaveBeenCalledTimes(1);
    expect(
      wrapper.findAll('.vb-user-files-filter-button').every((button) => button.attributes('disabled') !== undefined)
    ).toBe(true);

    pendingUpdate.reject(new Error('revision conflict'));
    await flushPromises();
    expect(wrapper.text()).toContain('revision conflict');
    expect(
      wrapper.findAll('.vb-user-files-filter-button').every((button) => button.attributes('disabled') === undefined)
    ).toBe(true);
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
    await required(uploadButton).trigger('click');
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
