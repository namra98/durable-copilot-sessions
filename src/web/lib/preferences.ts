import { useCallback, useEffect, useState } from "react";

/** UI theme: an explicit user choice persisted across reloads. */
export type Theme = "dark" | "light";

/** Card density for the session grid. */
export type Density = "comfortable" | "compact";

const THEME_KEY = "dcs.theme";
const DENSITY_KEY = "dcs.density";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore persistence failures (storage full / disabled).
  }
}

/** First-load theme: a stored choice if present, else the OS preference. */
function initialTheme(): Theme {
  const stored = readStored(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  try {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
      return "light";
    }
  } catch {
    // matchMedia unavailable — fall through to the dark default.
  }
  return "dark";
}

/**
 * Theme state synced to `document.documentElement`'s `data-theme` attribute and
 * persisted to localStorage. Honors `prefers-color-scheme` on the very first
 * load (before the user has made an explicit choice).
 */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggleTheme: () => void } {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    writeStored(THEME_KEY, next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((curr) => {
      const next: Theme = curr === "dark" ? "light" : "dark";
      writeStored(THEME_KEY, next);
      return next;
    });
  }, []);

  return { theme, setTheme, toggleTheme };
}

/** First-load density: a stored choice if present, else comfortable. */
function initialDensity(): Density {
  const stored = readStored(DENSITY_KEY);
  return stored === "compact" ? "compact" : "comfortable";
}

/** Density state persisted to localStorage; applied as a class on the grid. */
export function useDensity(): {
  density: Density;
  setDensity: (d: Density) => void;
  toggleDensity: () => void;
} {
  const [density, setDensityState] = useState<Density>(initialDensity);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    writeStored(DENSITY_KEY, next);
  }, []);

  const toggleDensity = useCallback(() => {
    setDensityState((curr) => {
      const next: Density = curr === "comfortable" ? "compact" : "comfortable";
      writeStored(DENSITY_KEY, next);
      return next;
    });
  }, []);

  return { density, setDensity, toggleDensity };
}
