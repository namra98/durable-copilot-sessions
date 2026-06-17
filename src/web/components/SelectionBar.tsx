import { useState } from "react";
import { ColorPopover } from "./ColorPopover";

interface SelectionBarProps {
  count: number;
  busy: boolean;
  onResumeAll: () => void;
  onSetColor: (stored: string) => void;
  onPin: () => void;
  onHide: () => void;
  onAddTag: () => void;
  onArchive: () => void;
  onSaveWorkspace: () => void;
  onClear: () => void;
}

/** Sticky bottom bar shown when one or more session cards are selected. */
export function SelectionBar({
  count,
  busy,
  onResumeAll,
  onSetColor,
  onPin,
  onHide,
  onAddTag,
  onArchive,
  onSaveWorkspace,
  onClear,
}: SelectionBarProps) {
  const [colorOpen, setColorOpen] = useState(false);

  return (
    <div className="selbar" role="region" aria-label="Bulk actions">
      <span className="selbar__count">
        {count} selected
      </span>
      <div className="selbar__actions">
        <button type="button" className="btn btn--primary btn--xs" disabled={busy} onClick={onResumeAll}>
          Resume all
        </button>
        <span className="selbar__color">
          <button
            type="button"
            className="btn btn--xs"
            disabled={busy}
            aria-expanded={colorOpen}
            onClick={() => setColorOpen((v) => !v)}
          >
            Set color
          </button>
          {colorOpen && (
            <ColorPopover
              current="#3b82f6"
              busy={busy}
              onApply={(stored) => {
                setColorOpen(false);
                onSetColor(stored);
              }}
              onClose={() => setColorOpen(false)}
            />
          )}
        </span>
        <button type="button" className="btn btn--xs" disabled={busy} onClick={onPin}>
          Pin
        </button>
        <button type="button" className="btn btn--xs" disabled={busy} onClick={onHide}>
          Hide
        </button>
        <button type="button" className="btn btn--xs" disabled={busy} onClick={onAddTag}>
          Add tag
        </button>
        <button type="button" className="btn btn--xs" disabled={busy} onClick={onArchive}>
          Archive
        </button>
        <button type="button" className="btn btn--xs" disabled={busy} onClick={onSaveWorkspace}>
          Save as workspace
        </button>
      </div>
      <button type="button" className="btn btn--ghost btn--xs selbar__clear" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
