import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A small accessible modal: role=dialog + aria-modal, labelled by its title, focus moves into it when it opens (first [data-autofocus], else the
// dialog itself), Tab is kept inside, and focus returns to the element that opened it. `onEscape` is opt-in: the one-time password dialog must NOT
// vanish on a stray Escape.
export function Modal({ title, children, onEscape }: { title: string; children: ReactNode; onEscape?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = `modal-title-${title.replace(/\W+/g, '-')}`;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    (node?.querySelector<HTMLElement>('[data-autofocus]') ?? node)?.focus();
    return () => opener?.focus?.();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && onEscape) {
      event.stopPropagation();
      onEscape();
      return;
    }
    if (event.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return (
    <div className="modal-backdrop">
      <div ref={ref} className="modal-card" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
