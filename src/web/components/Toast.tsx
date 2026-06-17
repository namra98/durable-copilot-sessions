import { useCallback, useEffect, useRef, useState } from "react";

export type ToastKind = "success" | "error" | "info" | "progress";

/** An optional action button rendered inside a toast (e.g. "Undo"). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  text: string;
  /** Optional inline action button. Clicking it runs `onClick` and dismisses. */
  action?: ToastAction;
  /** When true, render an indeterminate progress affordance (spinner). */
  progress?: boolean;
}

/** Options accepted by {@link ToastApi.push}. */
export interface PushOptions {
  /** An action button (e.g. Undo) shown alongside the message. */
  action?: ToastAction;
  /** Override the auto-dismiss timeout (ms). Use 0 to keep it until dismissed. */
  timeoutMs?: number;
  /** Render a progress spinner (implies a sticky toast unless `timeoutMs` set). */
  progress?: boolean;
}

export interface ToastApi {
  toasts: ToastMessage[];
  /** Show a toast and return its id (for later `update`/`dismiss`). */
  push: (kind: ToastKind, text: string, options?: PushOptions) => number;
  /** Patch an existing toast in place (e.g. flip a progress toast to success). */
  update: (id: number, patch: Partial<Omit<ToastMessage, "id">> & { timeoutMs?: number }) => void;
  dismiss: (id: number) => void;
}

/** Lightweight toast manager: a list plus push/update/dismiss with auto-expiry. */
export function useToasts(timeoutMs = 7000): ToastApi {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Map<number, number>>(new Map());

  const clearTimer = useCallback((id: number) => {
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id);
      setToasts((curr) => curr.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  const arm = useCallback(
    (id: number, ms: number) => {
      clearTimer(id);
      if (ms > 0) {
        const handle = window.setTimeout(() => dismiss(id), ms);
        timers.current.set(id, handle);
      }
    },
    [clearTimer, dismiss],
  );

  const push = useCallback(
    (kind: ToastKind, text: string, options?: PushOptions): number => {
      const id = nextId.current;
      nextId.current += 1;
      const message: ToastMessage = {
        id,
        kind,
        text,
        action: options?.action,
        progress: options?.progress,
      };
      setToasts((curr) => [...curr, message]);
      // Progress toasts stay until explicitly updated/dismissed unless a
      // timeout is given. Toasts with an action get a longer default window.
      const fallback = options?.progress ? 0 : options?.action ? Math.max(timeoutMs, 9000) : timeoutMs;
      arm(id, options?.timeoutMs ?? fallback);
      return id;
    },
    [arm, timeoutMs],
  );

  const update = useCallback(
    (id: number, patch: Partial<Omit<ToastMessage, "id">> & { timeoutMs?: number }) => {
      const { timeoutMs: nextTimeout, ...rest } = patch;
      setToasts((curr) => curr.map((t) => (t.id === id ? { ...t, ...rest } : t)));
      if (nextTimeout !== undefined) arm(id, nextTimeout);
    },
    [arm],
  );

  useEffect(() => {
    const handles = timers.current;
    return () => {
      handles.forEach((handle) => window.clearTimeout(handle));
      handles.clear();
    };
  }, []);

  return { toasts, push, update, dismiss };
}

interface ToastStackProps {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}

const ICONS: Record<ToastKind, string> = {
  success: "✓",
  error: "✕",
  info: "i",
  progress: "↻",
};

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span
            className={`toast__icon${t.progress ? " toast__icon--spin" : ""}`}
            aria-hidden="true"
          >
            {ICONS[t.kind]}
          </span>
          <span className="toast__text">{t.text}</span>
          {t.action && (
            <button
              className="toast__action"
              type="button"
              onClick={() => {
                t.action?.onClick();
                onDismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
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
