import Image from "next/image";

export type YouTubeStats = {
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
};

export type ThumbnailComparisonProps = {
  currentThumbnailUrl: string;
  currentStats?: YouTubeStats;
  currentBadgeText?: string;

  optimizedThumbnailUrl?: string | null;
  geminiScore?: number | null;
  improvements?: string[];
  optimizedLoading?: boolean;
};

function formatCompactNumber(value: number): string {
  try {
    return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
  } catch {
    return String(value);
  }
}

function StatPill({ label, value }: { label: string; value: number | null | undefined }) {
  const display = typeof value === "number" && Number.isFinite(value) ? formatCompactNumber(value) : "—";
  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-gray-700 bg-gray-900/40 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-xs text-gray-300">{label}</span>
      <span className="shrink-0 text-xs font-semibold text-white tabular-nums">{display}</span>
    </div>
  );
}

function ThumbnailFrame({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-gray-700 bg-black aspect-video">
      <Image src={src} alt={alt} fill className="object-cover" sizes="(max-width: 768px) 100vw, 50vw" />
    </div>
  );
}

export function ThumbnailComparison({
  currentThumbnailUrl,
  currentStats,
  currentBadgeText = "Low Performance",
  optimizedThumbnailUrl,
  geminiScore,
  improvements,
  optimizedLoading,
}: ThumbnailComparisonProps) {
  const safeImprovements = (improvements ?? []).map((x) => String(x)).filter(Boolean);
  const scoreDisplay = typeof geminiScore === "number" && Number.isFinite(geminiScore) ? Math.round(geminiScore) : null;
  const showAfter = Boolean(optimizedLoading) || Boolean(optimizedThumbnailUrl);

  return (
    <div className={`grid grid-cols-1 gap-4 ${showAfter ? "md:grid-cols-2" : ""}`}>
      {/* BEFORE */}
      <div className="rounded-2xl border-2 border-red-500 bg-gray-900/40 p-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-gray-300">Before</p>
            <h3 className="text-lg font-bold truncate">Current Thumbnail</h3>
          </div>
          <span className="shrink-0 rounded-full border border-red-400 bg-red-500/20 px-3 py-1 text-xs font-bold text-red-200">
            {currentBadgeText}
          </span>
        </div>

        <ThumbnailFrame src={currentThumbnailUrl} alt="Current thumbnail" />

        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <StatPill label="Views" value={currentStats?.views ?? null} />
          <StatPill label="Likes" value={currentStats?.likes ?? null} />
          <StatPill label="Comments" value={currentStats?.comments ?? null} />
        </div>
      </div>

      {/* AFTER */}
      {showAfter ? (
        <div className="rounded-2xl border-2 border-green-500 bg-gray-900/40 p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-gray-300">After</p>
              <h3 className="text-lg font-bold truncate">Data-Optimized Thumbnail</h3>
            </div>

            <span className="shrink-0 rounded-full border border-green-400 bg-green-500/20 px-3 py-1 text-xs font-bold text-green-200">
              AI Score{scoreDisplay !== null ? `: ${scoreDisplay}/100` : " (out of 100)"}
            </span>
          </div>

          {optimizedThumbnailUrl ? (
            <ThumbnailFrame src={optimizedThumbnailUrl} alt="Data-optimized thumbnail" />
          ) : (
            <div className="relative w-full overflow-hidden rounded-lg border border-gray-700 bg-black aspect-video">
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-sm text-gray-400">Generating optimized thumbnail…</p>
              </div>
            </div>
          )}

          <div className="mt-3">
            <p className="text-sm font-semibold mb-2">Improvements implemented</p>
            {safeImprovements.length > 0 ? (
              <ul className="space-y-1">
                {safeImprovements.map((item, idx) => (
                  <li key={idx} className="text-sm text-gray-200">
                    • {item}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-400">No improvement list available yet.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
