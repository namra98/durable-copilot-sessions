import { useCallback, useEffect, useState } from "react";

/**
 * A `useState`-like hook that persists its value to `localStorage` under `key`.
 *
 * Reads are best-effort: malformed or inaccessible storage falls back to the
 * provided initial value. Writes are wrapped in try/catch so a storage failure
 * (e.g. private mode) never crashes the UI.
 */
export function useLocalStorage<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore persistence failures (storage full / disabled).
    }
  }, [key, value]);

  const set = useCallback((next: T | ((prev: T) => T)) => {
    setValue((prev) => (typeof next === "function" ? (next as (p: T) => T)(prev) : next));
  }, []);

  return [value, set];
}
