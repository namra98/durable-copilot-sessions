import { useState } from "react";
import { Archive, EyeOff, Palette, Pin, Play, Save, Tag, X } from "lucide-react";
import { ColorPopover } from "./ColorPopover";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

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
    <div
      role="region"
      aria-label="Bulk actions"
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-popover/95 px-3 py-2 shadow-lg backdrop-blur"
    >
      <span className="px-1 text-sm font-medium">{count} selected</span>

      <Separator orientation="vertical" className="h-6" />

      <div className="flex items-center gap-1">
        <Button type="button" size="xs" disabled={busy} onClick={onResumeAll}>
          <Play />
          Resume all
        </Button>
        <span className="relative">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={busy}
            aria-expanded={colorOpen}
            onClick={() => setColorOpen((v) => !v)}
          >
            <Palette />
            Set color
          </Button>
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
        <Button type="button" size="xs" variant="secondary" disabled={busy} onClick={onPin}>
          <Pin />
          Pin
        </Button>
        <Button type="button" size="xs" variant="secondary" disabled={busy} onClick={onHide}>
          <EyeOff />
          Hide
        </Button>
        <Button type="button" size="xs" variant="secondary" disabled={busy} onClick={onAddTag}>
          <Tag />
          Add tag
        </Button>
        <Button type="button" size="xs" variant="secondary" disabled={busy} onClick={onArchive}>
          <Archive />
          Archive
        </Button>
        <Button type="button" size="xs" variant="secondary" disabled={busy} onClick={onSaveWorkspace}>
          <Save />
          Save as workspace
        </Button>
      </div>

      <Separator orientation="vertical" className="h-6" />

      <Button type="button" size="xs" variant="ghost" onClick={onClear}>
        <X />
        Clear
      </Button>
    </div>
  );
}
