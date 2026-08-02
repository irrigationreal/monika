import { fireEvent, render, screen } from '@testing-library/vue';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';

import ConfirmationDialog from './ConfirmationDialog.vue';

const props = {
  open: true,
  title: 'Stop robot?',
  message: 'This will stop current work.',
  confirmLabel: 'Stop robot',
  cancelLabel: 'Keep running',
  pendingLabel: 'Stopping…',
};

afterEach(() => {
  document.body.style.overflow = '';
});

describe('ConfirmationDialog', () => {
  it('focuses the safe action and restores focus and scrolling when cancelled', async () => {
    const origin = document.createElement('button');
    document.body.append(origin);
    origin.focus();
    const view = render(ConfirmationDialog, { props });

    const cancel = await screen.findByRole('button', { name: 'Keep running' });
    expect(document.activeElement).toBe(cancel);
    expect(document.body.style.overflow).toBe('hidden');

    await fireEvent.click(cancel);
    expect(view.emitted()['cancel']).toHaveLength(1);
    await view.rerender({ ...props, open: false });
    await nextTick();
    expect(document.activeElement).toBe(origin);
    expect(document.body.style.overflow).toBe('');
    origin.remove();
  });

  it('requires explicit confirmation and treats Escape as cancellation', async () => {
    const view = render(ConfirmationDialog, { props });
    const dialog = screen.getByRole('dialog', { name: 'Stop robot?' });

    expect(view.emitted()['confirm']).toBeUndefined();
    await fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(view.emitted()['cancel']).toHaveLength(1);
    expect(view.emitted()['confirm']).toBeUndefined();

    await fireEvent.click(screen.getByRole('button', { name: 'Stop robot' }));
    expect(view.emitted()['confirm']).toHaveLength(1);
  });

  it('disables every dismissal and confirmation control while pending', () => {
    render(ConfirmationDialog, { props: { ...props, pending: true } });

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Stopping…' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Keep running' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Close Stop robot?' }).disabled).toBe(true);
  });
});
