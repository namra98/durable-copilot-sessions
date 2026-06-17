import * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Sonner Toaster wired to the app's data-theme convention (dark default,
 * [data-theme="light"] opt-in) instead of next-themes.
 */
function Toaster(props: ToasterProps) {
  const [theme, setTheme] = React.useState<"light" | "dark">(() =>
    document.documentElement.getAttribute("data-theme") === "light"
      ? "light"
      : "dark",
  );

  React.useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => {
      setTheme(el.getAttribute("data-theme") === "light" ? "light" : "dark");
    });
    observer.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      position="bottom-right"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
