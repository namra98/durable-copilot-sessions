import { useEffect, useRef, useState } from "react";
import { COLOR_SWATCHES, parseColorInput, toCssColor } from "../lib/colors";

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
    <div className="popover" ref={ref} role="dialog" aria-label="Choose tab color">
      <div className="popover__swatches">
        {COLOR_SWATCHES.map((sw) => {
          const active = activeCss.toLowerCase() === sw.toLowerCase();
          return (
            <button
              key={sw}
              type="button"
              className={`swatch${active ? " swatch--active" : ""}`}
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

      <div className="popover__custom">
        <span
          className="popover__preview"
          style={{ backgroundColor: parsed.valid ? parsed.css : "transparent" }}
          aria-hidden="true"
        />
        <input
          className={`input popover__input${draft && !parsed.valid ? " popover__input--bad" : ""}`}
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
        <button
          type="button"
          className="btn btn--primary popover__apply"
          disabled={busy || !parsed.valid}
          onClick={() => parsed.valid && onApply(parsed.stored)}
        >
          Apply
        </button>
      </div>
      {draft && !parsed.valid && (
        <p className="popover__hint">Enter #RRGGBB, bare hex, or a color name.</p>
      )}
    </div>
  );
}
