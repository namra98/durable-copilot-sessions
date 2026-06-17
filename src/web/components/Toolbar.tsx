import type { RefObject } from "react";
import { Archive, LayoutGrid, Rows3, Search } from "lucide-react";
import type { QuickFilter, SortKey } from "../lib/sessions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type Grouping = "flat" | "by-repo";

interface ToolbarProps {
  search: string;
  onSearch: (value: string) => void;
  sort: SortKey;
  onSort: (key: SortKey) => void;
  grouping: Grouping;
  onGrouping: (grouping: Grouping) => void;
  quickFilters: QuickFilter[];
  onToggleQuick: (chip: QuickFilter) => void;
  searchRef: RefObject<HTMLInputElement>;
  /** Distinct tags available across the current session list. */
  tags: string[];
  /** The active tag filter, or null for "all tags". */
  tagFilter: string | null;
  onTagFilter: (tag: string | null) => void;
  /** Whether archived sessions are currently revealed. */
  showArchived: boolean;
  onShowArchived: (value: boolean) => void;
  /** Number of archived sessions in the current list (for the toggle label). */
  archivedCount: number;
}

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Recent activity" },
  { key: "name", label: "Name" },
  { key: "repo", label: "Repo" },
  { key: "liveness", label: "Liveness" },
];

const QUICK_CHIPS: { key: QuickFilter; label: string }[] = [
  { key: "missing-cwd", label: "Missing cwd" },
  { key: "has-children", label: "Has children" },
];

const ALL_TAGS = "__all__";

/** Client-side controls: debounced search, sort, repo grouping, and quick chips. */
export function Toolbar({
  search,
  onSearch,
  sort,
  onSort,
  grouping,
  onGrouping,
  quickFilters,
  onToggleQuick,
  searchRef,
  tags,
  tagFilter,
  onTagFilter,
  showArchived,
  onShowArchived,
  archivedCount,
}: ToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-56 flex-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={searchRef}
          type="search"
          value={search}
          className="pl-9"
          placeholder="Search title, repo, branch, cwd…  ( / )"
          aria-label="Search sessions"
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Sort</span>
        <Select value={sort} onValueChange={(value) => onSort(value as SortKey)}>
          <SelectTrigger size="sm" className="w-40" aria-label="Sort sessions">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((o) => (
              <SelectItem key={o.key} value={o.key}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-1" role="group" aria-label="Grouping">
        <Button
          type="button"
          size="sm"
          variant={grouping === "flat" ? "default" : "outline"}
          aria-pressed={grouping === "flat"}
          onClick={() => onGrouping("flat")}
        >
          <Rows3 />
          Flat
        </Button>
        <Button
          type="button"
          size="sm"
          variant={grouping === "by-repo" ? "default" : "outline"}
          aria-pressed={grouping === "by-repo"}
          onClick={() => onGrouping("by-repo")}
        >
          <LayoutGrid />
          By repo
        </Button>
      </div>

      <div className="flex items-center gap-1" role="group" aria-label="Quick filters">
        {QUICK_CHIPS.map((chip) => {
          const on = quickFilters.includes(chip.key);
          return (
            <Button
              key={chip.key}
              type="button"
              size="sm"
              variant={on ? "default" : "outline"}
              aria-pressed={on}
              onClick={() => onToggleQuick(chip.key)}
            >
              {chip.label}
            </Button>
          );
        })}
      </div>

      {tags.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Tag</span>
          <Select
            value={tagFilter ?? ALL_TAGS}
            onValueChange={(value) => onTagFilter(value === ALL_TAGS ? null : value)}
          >
            <SelectTrigger size="sm" className="w-36" aria-label="Filter by tag">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TAGS}>All tags</SelectItem>
              {tags.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <Button
        type="button"
        size="sm"
        variant={showArchived ? "default" : "outline"}
        aria-pressed={showArchived}
        title="Toggle archived sessions"
        onClick={() => onShowArchived(!showArchived)}
        className={cn("ml-auto")}
      >
        <Archive />
        {showArchived ? "Hide archived" : `Show archived${archivedCount ? ` (${archivedCount})` : ""}`}
      </Button>
    </div>
  );
}
