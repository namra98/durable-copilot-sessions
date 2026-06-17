import { cn } from "@/lib/utils";

function Shimmer({ className }: { className?: string }) {
  return <span className={cn("block animate-pulse rounded-md bg-muted", className)} />;
}

/** A shimmer placeholder card shown while the session list is loading. */
export function SkeletonCard() {
  return (
    <article
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
      aria-hidden="true"
    >
      <div className="flex items-center gap-2">
        <Shimmer className="size-3 rounded-full" />
        <Shimmer className="h-4 w-40" />
      </div>
      <div className="flex gap-2">
        <Shimmer className="h-5 w-14 rounded-full" />
        <Shimmer className="h-5 w-16 rounded-full" />
      </div>
      <Shimmer className="h-3.5 w-full" />
      <Shimmer className="h-3.5 w-2/3" />
      <div className="mt-1 flex gap-2">
        <Shimmer className="h-8 w-24" />
        <Shimmer className="h-8 w-16" />
      </div>
    </article>
  );
}

/** A grid of skeleton cards. */
export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-4">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
