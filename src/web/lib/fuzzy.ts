/**
 * A tiny, dependency-free fuzzy / subsequence matcher used by the command
 * palette. Kept pure and DOM-free so it can be unit-tested under the node-only
 * vitest environment.
 *
 * Matching is case-insensitive and order-preserving: every character of the
 * query must appear in the target in order (a subsequence match). The score
 * rewards contiguous runs, matches at word boundaries, and matches near the
 * start of the target, so the most "obvious" hits rank first.
 */

/** Outcome of matching a query against one target string. */
export interface FuzzyMatch {
  /** Whether the query is a subsequence of the target (case-insensitive). */
  matched: boolean;
  /** Relevance score; higher is better. 0 when not matched. */
  score: number;
  /** Indices in the target that were matched, for optional highlighting. */
  positions: number[];
}

/** Characters that introduce a "word boundary" for scoring purposes. */
function isBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return ch === " " || ch === "-" || ch === "_" || ch === "/" || ch === "\\" || ch === "." || ch === ":";
}

/**
 * Match `query` against `target`. An empty query matches everything with a
 * neutral score of 1 so callers can show the full, unfiltered list.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch {
  const q = query.trim().toLowerCase();
  if (q === "") return { matched: true, score: 1, positions: [] };

  const hay = target.toLowerCase();
  const positions: number[] = [];

  let qi = 0;
  let score = 0;
  let run = 0;
  let lastMatch = -2;

  for (let hi = 0; hi < hay.length && qi < q.length; hi++) {
    if (hay[hi] !== q[qi]) continue;

    positions.push(hi);

    // Base point for any match.
    let point = 1;
    // Contiguous with the previous match: reward longer runs.
    if (hi === lastMatch + 1) {
      run += 1;
      point += run * 2;
    } else {
      run = 0;
    }
    // Word-boundary start (e.g. matching the first letter of a word).
    if (isBoundary(hay[hi - 1])) point += 3;
    // Matches near the very start of the target are slightly preferred.
    if (hi < 4) point += 1;

    score += point;
    lastMatch = hi;
    qi += 1;
  }

  if (qi < q.length) return { matched: false, score: 0, positions: [] };

  // Prefer shorter targets when scores are otherwise close.
  score += Math.max(0, 12 - target.length / 4);

  return { matched: true, score, positions };
}

/** A candidate to rank, paired with the searchable text used for matching. */
export interface FuzzyCandidate<T> {
  item: T;
  text: string;
}

/** A ranked result: the original item plus its match details. */
export interface FuzzyResult<T> {
  item: T;
  score: number;
  positions: number[];
}

/**
 * Rank `candidates` against `query`, keeping only matches and ordering them by
 * descending score. An empty query returns every candidate in its original
 * order (score 0), so the palette can show the full list when nothing is typed.
 */
export function fuzzyRank<T>(query: string, candidates: FuzzyCandidate<T>[]): FuzzyResult<T>[] {
  const q = query.trim();
  if (q === "") {
    return candidates.map((c) => ({ item: c.item, score: 0, positions: [] }));
  }
  const out: FuzzyResult<T>[] = [];
  for (const c of candidates) {
    const m = fuzzyMatch(q, c.text);
    if (m.matched) out.push({ item: c.item, score: m.score, positions: m.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
