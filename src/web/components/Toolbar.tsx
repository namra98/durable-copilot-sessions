import type { RefObject } from "react";
import type { QuickFilter, SortKey } from "../lib/sessions";

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
    <div className="toolbar">
      <div className="toolbar__search">
        <span className="toolbar__search-icon" aria-hidden="true">⌕</span>
        <input
          ref={searchRef}
          className="input toolbar__search-input"
          type="search"
          value={search}
          placeholder="Search title, repo, branch, cwd…  ( / )"
          aria-label="Search sessions"
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      <label className="field">
        <span className="field__label">Sort</span>
        <select className="select" value={sort} onChange={(e) => onSort(e.target.value as SortKey)}>
          {SORT_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <div className="seg" role="group" aria-label="Grouping">
        <button
          type="button"
          className={`seg__btn${grouping === "flat" ? " seg__btn--on" : ""}`}
          onClick={() => onGrouping("flat")}
        >
          Flat
        </button>
        <button
          type="button"
          className={`seg__btn${grouping === "by-repo" ? " seg__btn--on" : ""}`}
          onClick={() => onGrouping("by-repo")}
        >
          By repo
        </button>
      </div>

      <div className="chips" role="group" aria-label="Quick filters">
        {QUICK_CHIPS.map((chip) => {
          const on = quickFilters.includes(chip.key);
          return (
            <button
              key={chip.key}
              type="button"
              className={`chip${on ? " chip--on" : ""}`}
              aria-pressed={on}
              onClick={() => onToggleQuick(chip.key)}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {tags.length > 0 && (
        <label className="field">
          <span className="field__label">Tag</span>
          <select
            className="select"
            value={tagFilter ?? ""}
            onChange={(e) => onTagFilter(e.target.value || null)}
          >
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      )}

      <button
        type="button"
        className={`chip${showArchived ? " chip--on" : ""}`}
        aria-pressed={showArchived}
        title="Toggle archived sessions"
        onClick={() => onShowArchived(!showArchived)}
      >
        {showArchived ? "Hide archived" : `Show archived${archivedCount ? ` (${archivedCount})` : ""}`}
      </button>
    </div>
  );
}
