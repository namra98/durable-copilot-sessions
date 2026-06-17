import { useEffect, useRef, useState } from "react";
import { COLOR_SWATCHES, parseColorInput, toCssColor } from "../lib/colors";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface ColorPopoverProps {
  /** The currently applied color (hex or WT name), for highlighting + preview. */
  current: string;
  /** Disable inputs while a patch is in flight. */
  busy: boolean;
  /** Apply a new color (canonical stored value) and close. */
  onApply: (stored: string) => void;
  /** Close without applying. */
  onClose: () => void;
}

/**
 * A small popover with the 12-swatch palette plus a custom hex / WT-name input
 * with live validation and preview. Closes on outside click or Escape.
 */
export function ColorPopover({ current, busy, onApply, onClose }: ColorPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(current);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const parsed = parseColorInput(draft);
  const activeCss = toCssColor(current);

  return (
    <div
      className="absolute left-0 top-7 z-30 w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg animate-in fade-in zoom-in-95 duration-100"
      ref={ref}
      role="dialog"
      aria-label="Choose tab color"
    >
      <div className="grid grid-cols-6 gap-1.5">
        {COLOR_SWATCHES.map((sw) => {
          const active = activeCss.toLowerCase() === sw.toLowerCase();
          return (
            <button
              key={sw}
              type="button"
              className={cn(
                "size-7 rounded-md ring-offset-2 ring-offset-popover transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active && "ring-2 ring-ring",
              )}
              style={{ backgroundColor: sw }}
              title={`Set color ${sw}`}
              aria-label={`Set tab color ${sw}`}
              aria-pressed={active}
              disabled={busy}
              onClick={() => onApply(sw)}
            />
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span
          className="size-7 shrink-0 rounded-md border border-border"
          style={{ backgroundColor: parsed.valid ? parsed.css : "transparent" }}
          aria-hidden="true"
        />
        <Input
          className={cn(
            "h-8 flex-1",
            draft && !parsed.valid && "border-destructive focus-visible:ring-destructive/40",
          )}
          value={draft}
          placeholder="#3b82f6 or blue"
          aria-label="Custom hex or color name"
          autoFocus
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && parsed.valid) onApply(parsed.stored);
          }}
        />
        <Button
          type="button"
          size="sm"
          disabled={busy || !parsed.valid}
          onClick={() => parsed.valid && onApply(parsed.stored)}
        >
          Apply
        </Button>
      </div>
      {draft && !parsed.valid && (
        <p className="mt-2 text-xs text-muted-foreground">
          Enter #RRGGBB, bare hex, or a color name.
        </p>
      )}
    </div>
  );
}
