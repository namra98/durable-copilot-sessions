import { useCallback, useRef, useState } from "react";

export type ToastKind = "success" | "error" | "info";

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  text: string;
}

export interface ToastApi {
  toasts: ToastMessage[];
  push: (kind: ToastKind, text: string) => void;
  dismiss: (id: number) => void;
}

/** Lightweight toast manager: a list plus push/dismiss with auto-expiry. */
export function useToasts(timeoutMs = 7000): ToastApi {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((curr) => curr.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((curr) => [...curr, { id, kind, text }]);
      if (timeoutMs > 0) {
        window.setTimeout(() => dismiss(id), timeoutMs);
      }
    },
    [dismiss, timeoutMs],
  );

  return { toasts, push, dismiss };
}

interface ToastStackProps {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}

const ICONS: Record<ToastKind, string> = {
  success: "✓",
  error: "✕",
  info: "i",
};

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span className="toast__icon" aria-hidden="true">{ICONS[t.kind]}</span>
          <span className="toast__text">{t.text}</span>
          <button
            className="toast__close"
            type="button"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
