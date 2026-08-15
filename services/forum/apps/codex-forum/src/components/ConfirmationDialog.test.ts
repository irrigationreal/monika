import { nextTick } from 'vue';

import { fireEvent, render, screen } from '@testing-library/vue';
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

  it('can skip trigger focus restoration when the caller moves focus after removal', async () => {
    const origin = document.createElement('button');
    document.body.append(origin);
    origin.focus();
    const view = render(ConfirmationDialog, { props: { ...props, restoreFocus: false } });
    await screen.findByRole('button', { name: 'Keep running' });

    await view.rerender({ ...props, open: false, restoreFocus: false });
    await nextTick();
    expect(document.activeElement).not.toBe(origin);
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

  it('disables every action and keeps focus in the dialog when Tab is pressed while pending', () => {
    render(ConfirmationDialog, { props: { ...props, pending: true } });

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Stopping…' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Keep running' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Close Stop robot?' }).disabled).toBe(true);

    const dialog = screen.getByRole('dialog', { name: 'Stop robot?' });
    dialog.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    dialog.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });
});
