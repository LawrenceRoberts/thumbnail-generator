'use client'

import { useMemo } from 'react'

export type PerformanceAuditData = {
  videoId: string
  thumbnailUrl: string
  views: number
  /** 0-100 (percentage) */
  estimatedCtr: number
}

export type PerformanceAuditThresholds = {
  /** CTR below this is considered low (amber) */
  lowCtrPct: number
  /** CTR below this is considered very low (red) */
  veryLowCtrPct: number
}

export type PerformanceAuditProps = {
  /** Data to display once fetched */
  data?: PerformanceAuditData
  /** True while the Python API is fetching analysis */
  isLoading: boolean
  /** Optional error message to render */
  error?: string | null
  /** Optional thresholds for low-performing highlighting */
  thresholds?: Partial<PerformanceAuditThresholds>
}

const DEFAULT_THRESHOLDS: PerformanceAuditThresholds = {
  lowCtrPct: 3,
  veryLowCtrPct: 1.5,
}

function formatInteger(value: number) {
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
  } catch {
    return String(value)
  }
}

function formatPct(value: number) {
  if (!Number.isFinite(value)) return '—'
  const v = Math.max(0, value)
  return `${v.toFixed(1)}%`
}

type MetricTone = 'neutral' | 'amber' | 'red'

function ctrTone(ctrPct: number, t: PerformanceAuditThresholds): MetricTone {
  if (!Number.isFinite(ctrPct)) return 'neutral'
  if (ctrPct < t.veryLowCtrPct) return 'red'
  if (ctrPct < t.lowCtrPct) return 'amber'
  return 'neutral'
}

function toneClasses(tone: MetricTone) {
  switch (tone) {
    case 'red':
      return 'bg-red-500/10 border-red-500/30 text-red-200'
    case 'amber':
      return 'bg-amber-500/10 border-amber-500/30 text-amber-200'
    default:
      return 'bg-gray-700/40 border-gray-600 text-gray-100'
  }
}

export function PerformanceAudit({ data, isLoading, error, thresholds }: PerformanceAuditProps) {
  const t = useMemo<PerformanceAuditThresholds>(() => {
    return {
      ...DEFAULT_THRESHOLDS,
      ...(thresholds ?? {}),
    }
  }, [thresholds])

  const tone = useMemo(() => {
    return data ? ctrTone(data.estimatedCtr, t) : 'neutral'
  }, [data, t])

  return (
    <section className="bg-gray-800 rounded-2xl p-6 shadow-2xl">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-bold">Performance Audit</h2>
        {isLoading ? (
          <span className="text-sm text-gray-300">Analyzing…</span>
        ) : error ? (
          <span className="text-sm text-red-300">{error}</span>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Thumbnail */}
        <div className="md:col-span-1">
          <div className="rounded-xl overflow-hidden border border-gray-700 bg-gray-900">
            {isLoading ? (
              <div className="w-full aspect-video bg-gray-700/40 animate-pulse" />
            ) : data?.thumbnailUrl ? (
              <img
                src={data.thumbnailUrl}
                alt="Current video thumbnail"
                className="w-full object-cover"
              />
            ) : (
              <div className="w-full aspect-video grid place-items-center text-gray-400">
                No thumbnail
              </div>
            )}
          </div>
          {data?.videoId && !isLoading && (
            <p className="mt-2 text-xs text-gray-400 break-all">Video ID: {data.videoId}</p>
          )}
        </div>

        {/* Metrics */}
        <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="rounded-xl border border-gray-600 bg-gray-700/40 p-4">
            <p className="text-xs text-gray-400 uppercase tracking-wide">Views</p>
            {isLoading ? (
              <div className="mt-2 h-7 w-32 bg-gray-600/50 rounded animate-pulse" />
            ) : (
              <p className="mt-1 text-2xl font-bold">{data ? formatInteger(data.views) : '—'}</p>
            )}
          </div>

          <div className={`rounded-xl border p-4 ${toneClasses(tone)}`}>
            <p className="text-xs uppercase tracking-wide opacity-80">Estimated CTR</p>
            {isLoading ? (
              <div className="mt-2 h-7 w-24 bg-gray-600/50 rounded animate-pulse" />
            ) : (
              <p className="mt-1 text-2xl font-bold">{data ? formatPct(data.estimatedCtr) : '—'}</p>
            )}

            {!isLoading && data ? (
              <p className="mt-2 text-xs opacity-90">
                {tone === 'red'
                  ? `Very low (below ${t.veryLowCtrPct}%)`
                  : tone === 'amber'
                    ? `Low (below ${t.lowCtrPct}%)`
                    : 'Healthy'}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
