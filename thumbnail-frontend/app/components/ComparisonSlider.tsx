'use client'

import { motion } from 'framer-motion'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

export type ComparisonSliderProps = {
  originalUrl: string
  optimizedUrl?: string | null
  afterLoading?: boolean
}

export function ComparisonSlider({ originalUrl, optimizedUrl, afterLoading }: ComparisonSliderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  // 0..1 where 0 means fully original, 1 means fully optimized.
  const [reveal, setReveal] = useState(0.5)

  const clipId = useId()

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const ro = new ResizeObserver(() => {
      setContainerWidth(el.getBoundingClientRect().width)
    })

    ro.observe(el)
    setContainerWidth(el.getBoundingClientRect().width)

    return () => ro.disconnect()
  }, [])

  const revealPct = useMemo(() => {
    const v = Number.isFinite(reveal) ? reveal : 0.5
    return Math.max(0, Math.min(1, v))
  }, [reveal])

  // Optimized is revealed from the RIGHT ("After" side).
  const handleX = containerWidth * (1 - revealPct)

  return (
    <div className="w-full">
      <div
        ref={containerRef}
        className="relative w-full aspect-video overflow-hidden rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl select-none"
        aria-label="Before/After thumbnail comparison"
      >
        {/* Original */}
        <img
          src={originalUrl}
          alt="Original thumbnail"
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />

        {/* Optimized overlay (revealed from left to right) */}
        <div
          className="absolute inset-0 overflow-hidden"
          style={{ width: `${revealPct * 100}%`, right: 0 }}
        >
          {optimizedUrl ? (
            <img
              src={optimizedUrl}
              alt="Data-Optimized thumbnail"
              className="absolute inset-0 h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0">
              <img
                src={originalUrl}
                alt="Ready to optimize"
                className="absolute inset-0 h-full w-full object-cover blur-md scale-110 opacity-60"
                draggable={false}
              />
              <div className="absolute inset-0 bg-gray-900/40" />

              <div className="pointer-events-none absolute right-3 top-3 rounded-lg bg-black/60 px-3 py-1.5 text-xs font-semibold tracking-wide text-white">
                Ready to Optimize
              </div>

              <div className="absolute inset-0 animate-pulse">
                <div className="absolute inset-0 bg-gradient-to-b from-transparent via-gray-800/20 to-transparent" />
              </div>
            </div>
          )}
        </div>

        {/* Labels */}
        <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-black/60 px-3 py-1.5 text-xs font-semibold tracking-wide text-white">
          Original
        </div>
        <div className="pointer-events-none absolute right-3 top-3 rounded-lg bg-black/60 px-3 py-1.5 text-xs font-semibold tracking-wide text-white">
          Data-Optimized
        </div>

        {afterLoading ? (
          <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-black/60 backdrop-blur-sm">
            <div className="absolute inset-0 grid place-items-center px-6">
              <p className="text-center text-sm font-semibold text-white">
                Flux.1 is rendering your performance-backed background...
              </p>
            </div>
          </div>
        ) : null}

        {/* Draggable handle */}
        <motion.div
          className="absolute top-0 h-full"
          style={{ left: handleX }}
          drag="x"
          dragElastic={0}
          dragMomentum={false}
          dragConstraints={containerRef}
          onDrag={(_, info) => {
            const el = containerRef.current
            if (!el) return
            const rect = el.getBoundingClientRect()
            const x = info.point.x - rect.left
            const next = rect.width > 0 ? 1 - x / rect.width : 0.5
            setReveal(Math.max(0, Math.min(1, next)))
          }}
          onPointerDown={(e) => {
            // Allow clicking anywhere on the bar to move it immediately.
            const el = containerRef.current
            if (!el) return
            const rect = el.getBoundingClientRect()
            const x = e.clientX - rect.left
            const next = rect.width > 0 ? 1 - x / rect.width : 0.5
            setReveal(Math.max(0, Math.min(1, next)))
          }}
        >
          {/* Vertical bar */}
          <div className="absolute -left-px top-0 h-full w-[3px] bg-red-500" />

          {/* Knob */}
          <div className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-red-500 shadow-lg ring-4 ring-black/30">
              <div className="flex items-center gap-1">
                <span className="block h-4 w-[2px] rounded bg-white/90" />
                <span className="block h-4 w-[2px] rounded bg-white/90" />
              </div>
            </div>
          </div>
        </motion.div>

        {/* A11y: hidden clip path id (kept for future enhancements) */}
        <svg className="sr-only" aria-hidden="true">
          <defs>
            <clipPath id={clipId} />
          </defs>
        </svg>
      </div>
    </div>
  )
}
