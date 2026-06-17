import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Info, Loader2, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

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

const ICON: Record<ToastKind, typeof Check> = {
  success: Check,
  error: XCircle,
  info: Info,
  progress: Loader2,
};

const ACCENT: Record<ToastKind, string> = {
  success: "text-live",
  error: "text-destructive",
  info: "text-primary",
  progress: "text-muted-foreground",
};

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-3 rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur animate-in slide-in-from-bottom-2 fade-in duration-200"
          >
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                ACCENT[t.kind],
                t.progress && "animate-spin",
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 text-sm leading-snug">{t.text}</span>
            {t.action && (
              <button
                className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-accent"
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
              className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss notification"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
