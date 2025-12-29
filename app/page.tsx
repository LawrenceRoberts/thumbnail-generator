'use client'

import { useState } from 'react'
import Image from 'next/image'
import { base64PngToBlob, putThumbnail, type ImageLayer } from './lib/thumbDb'

interface CostTracking {
  usd: number
  zar: number
  exchange_rate: number
  timestamp: string
}

interface GenerationResult {
  success: boolean
  images: Array<{
    image_data: string
    seed: number
    finish_reason: number
  }>
  metadata: {
    original_prompt: string
    enhanced_prompt: string
    width: number
    height: number
    cfg_scale: number
    steps: number
    samples: number
    generated_at: string
  }
  cost_tracking: CostTracking | null
  editable_data?: {
    background_image?: string
    person_cutout?: string
    person_cutouts?: string[]
    composite_before_text?: string
    text_content?: string
  }
}

export default function Home() {
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<GenerationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [peopleImages, setPeopleImages] = useState<File[]>([])
  const [peoplePreviews, setPeoplePreviews] = useState<string[]>([])
  const [backgroundImage, setBackgroundImage] = useState<File | null>(null)
  const [backgroundPreview, setBackgroundPreview] = useState<string | null>(null)
  const [overlayText, setOverlayText] = useState('')

  const revokeIfObjectUrl = (url: string | null) => {
    if (url && url.startsWith('blob:')) {
      URL.revokeObjectURL(url)
    }
  }

  const handlePeopleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) {
      // Append new files (don't replace). Dedupe by basic file signature.
      const existingKeys = new Set(peopleImages.map((f) => `${f.name}:${f.size}:${f.lastModified}`))
      const toAdd = files.filter((f) => !existingKeys.has(`${f.name}:${f.size}:${f.lastModified}`))

      if (toAdd.length > 0) {
        const newUrls = toAdd.map((f) => URL.createObjectURL(f))
        setPeopleImages([...peopleImages, ...toAdd])
        setPeoplePreviews([...peoplePreviews, ...newUrls])
      }
    }
    // allow selecting the same file(s) again
    e.target.value = ''
  }

  const handleBackgroundUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setBackgroundImage(file)
      revokeIfObjectUrl(backgroundPreview)
      setBackgroundPreview(URL.createObjectURL(file))
    }
    // allow selecting the same file again
    e.target.value = ''
  }

  const handleGenerate = async () => {
    // Only require prompt if no background image is uploaded
    if (!prompt.trim() && !backgroundImage) {
      setError('Please enter a prompt or upload a background image')
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      // Always use same-origin API in production so the app works on any device.
      // (Using NEXT_PUBLIC_API_URL can accidentally point to localhost/LAN and only work on one machine.)
      const isDev = process.env.NODE_ENV === 'development'
      const apiBase = isDev ? process.env.NEXT_PUBLIC_API_URL : undefined
      const endpoint = apiBase ? `${apiBase}/api/generate` : '/api/generate'

      const formData = new FormData()
      formData.append('simple_prompt', prompt || 'User uploaded background')
      formData.append('track_cost', 'true')
      
      if (peopleImages.length > 0) {
        for (const f of peopleImages) {
          formData.append('people_images', f)
        }
        // Backend auto-tunes speed/quality per request; send explicitly for stability.
        formData.append('cutout_quality', 'auto')
      }
      
      if (backgroundImage) {
        formData.append('background_image', backgroundImage)
      }
      
      if (overlayText.trim()) {
        formData.append('overlay_text', overlayText)
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        let message = 'Failed to generate thumbnail'
        try {
          const errorData = await response.json()
          const detail = (errorData as any)?.detail ?? errorData
          if (typeof detail === 'string') {
            message = detail
          } else {
            message = JSON.stringify(detail)
          }
        } catch {
          try {
            const text = await response.text()
            if (text) message = text
          } catch {
            // ignore
          }
        }
        throw new Error(message)
      }

      const data = await response.json()
      setResult(data)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An error occurred'
      if (message === 'Failed to fetch') {
        setError(
          'Failed to fetch. This usually means the app is calling a backend URL that your device cannot reach. In production, set Vercel env BACKEND_URL to your public backend (e.g. https://<your-fly-app>.fly.dev) and redeploy.'
        )
      } else {
        setError(message)
      }
    } finally {
      setLoading(false)
    }
  }

  const getPersonCutouts = () => {
    const list = result?.editable_data?.person_cutouts
    if (Array.isArray(list) && list.length > 0) return list
    const single = result?.editable_data?.person_cutout
    return single ? [single] : []
  }

  const loadImageDimensions = (src: string): Promise<{ width: number; height: number }> => {
    return new Promise((resolve, reject) => {
      const img = new window.Image()
      img.decoding = 'async'
      img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height })
      img.onerror = () => reject(new Error('Failed to load image'))
      img.src = src
    })
  }

  const buildPersonImageLayers = async (cutouts: string[]): Promise<ImageLayer[]> => {
    // Canvas is 1280x720 in the editor.
    const CANVAS_WIDTH = 1280
    const CANVAS_HEIGHT = 720

    const sources = cutouts.map((b64) => `data:image/png;base64,${b64}`)
    const dims = await Promise.all(sources.map((src) => loadImageDimensions(src)))

    const n = sources.length
    const baseTargetHeight = n <= 1 ? Math.round(CANVAS_HEIGHT * 0.75) : Math.round(CANVAS_HEIGHT * 0.65)
    const paddingX = 32
    const spacing = n <= 1 ? 0 : 24
    const maxTotalWidth = CANVAS_WIDTH - paddingX * 2

    // Initial scale per image (by height), then downscale group if it doesn't fit.
    let scales = dims.map((d) => (d.height > 0 ? baseTargetHeight / d.height : 1))

    const computeTotalWidth = (sc: number[]) => {
      const widths = dims.map((d, i) => d.width * sc[i])
      const total = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, n - 1)
      return { widths, total }
    }

    let { widths, total } = computeTotalWidth(scales)
    if (total > maxTotalWidth && total > 0) {
      const shrink = maxTotalWidth / total
      scales = scales.map((s) => s * shrink)
      ;({ widths, total } = computeTotalWidth(scales))
    }

    let cursorX = (CANVAS_WIDTH - total) / 2

    const layers: ImageLayer[] = sources.map((src, i) => {
      const w = Math.max(1, Math.round(widths[i]))
      const h = Math.max(1, Math.round(dims[i].height * scales[i]))
      const x = Math.round(cursorX)
      const y = Math.round(CANVAS_HEIGHT - h - 10)
      cursorX += w + spacing

      return {
        id: `person-${Date.now()}-${i}`,
        src,
        x,
        y,
        width: w,
        height: h,
        rotation: 0,
        opacity: 1,
      }
    })

    return layers
  }

  const saveThumbnail = () => {
    void (async () => {
      if (!result || !result.images || result.images.length === 0) return

      // Final image (always present)
      const finalPng = await base64PngToBlob(result.images[0].image_data)

      const personCutouts = getPersonCutouts()
      const canSeparatePeople = personCutouts.length > 0 && !!result.editable_data?.background_image

      // Editable base should be background-only when we have person cutouts as separate layers.
      // If missing, fall back to composite-before-text, then to final.
      const basePngBase64 =
        (canSeparatePeople ? result.editable_data?.background_image : undefined) ||
        result.editable_data?.composite_before_text ||
        result.images[0].image_data
      const basePng = await base64PngToBlob(basePngBase64)

      const id = Date.now().toString()
      const createdAt = new Date().toISOString()
      const textContent = result.editable_data?.text_content || overlayText || ''

      const personLayers = canSeparatePeople ? await buildPersonImageLayers(personCutouts) : []

      await putThumbnail({
        id,
        createdAt,
        prompt: result.metadata.original_prompt,
        overlayText: overlayText,
        cost: result.cost_tracking,
        finalPng,
        basePng,
        layers: {
          text: textContent
            ? [
                {
                  id: 'text-1',
                  text: textContent,
                  x: 640,
                  y: 40,
                  fontSize: 80,
                  fontFamily: 'Impact',
                  color: '#FFFFFF',
                  bold: true,
                  italic: false,
                  align: 'center',
                  rotation: 0,
                  strokeColor: '#000000',
                  strokeWidth: 4,
                },
              ]
            : [],
          images: personLayers,
        },
      })

      alert('Thumbnail saved to gallery! 🎉')
    })()
  }

  const downloadThumbnail = () => {
    if (!result || !result.images || result.images.length === 0) return

    const link = document.createElement('a')
    link.href = `data:image/png;base64,${result.images[0].image_data}`
    link.download = `thumbnail-${Date.now()}.png`
    link.click()
  }

  return (
    <main className="min-h-screen p-8 bg-gradient-to-b from-gray-900 to-gray-800 text-white">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-5xl font-bold text-center mb-2 bg-gradient-to-r from-red-500 to-pink-500 bg-clip-text text-transparent">
          YouTube Thumbnail Generator
        </h1>
        <p className="text-center text-gray-400 mb-12">
          AI-powered thumbnails optimized for maximum CTR
        </p>

        {/* Input Section */}
        <div className="bg-gray-800 rounded-2xl p-8 shadow-2xl mb-8">
          {/* Background Image Upload Section */}
          <div className="mb-6">
            <label className="block text-lg font-semibold mb-4">
              🖼️ Upload Background Image (Optional)
            </label>
            <p className="text-sm text-gray-400 mb-3">
              Upload your own background image instead of AI-generating one
            </p>
            <div className="flex items-center gap-4">
              <label className="cursor-pointer bg-purple-700 hover:bg-purple-600 text-white font-semibold py-3 px-6 rounded-lg transition-all inline-block">
                Choose Background
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleBackgroundUpload}
                  className="hidden"
                />
              </label>
              {backgroundPreview && (
                <div className="relative">
                  <img
                    src={backgroundPreview}
                    alt="Background Preview"
                    className="h-20 w-20 object-cover rounded-lg border-2 border-purple-600"
                  />
                  <button
                    onClick={() => {
                      setBackgroundImage(null)
                      revokeIfObjectUrl(backgroundPreview)
                      setBackgroundPreview(null)
                    }}
                    className="absolute -top-2 -right-2 bg-red-500 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs"
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Person Image Upload Section */}
          <div className="mb-6">
            <label className="block text-lg font-semibold mb-4">
              📸 Upload People Images (Optional)
            </label>
            <p className="text-sm text-gray-400 mb-3">
              Upload one or more people to composite onto the background
            </p>
            <div className="flex items-center gap-4">
              <label className="cursor-pointer bg-gray-700 hover:bg-gray-600 text-white font-semibold py-3 px-6 rounded-lg transition-all inline-block">
                Add Images
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handlePeopleUpload}
                  className="hidden"
                />
              </label>
              {peoplePreviews.length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {peoplePreviews.map((url, idx) => (
                    <div key={idx} className="relative">
                      <img
                        src={url}
                        alt={`Person ${idx + 1}`}
                        className="h-20 w-20 object-cover rounded-lg border-2 border-gray-600"
                      />
                    </div>
                  ))}
                  <button
                    onClick={() => {
                      for (const url of peoplePreviews) revokeIfObjectUrl(url)
                      setPeopleImages([])
                      setPeoplePreviews([])
                    }}
                    className="h-10 px-4 bg-red-500 hover:bg-red-600 text-white rounded-lg font-semibold"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
          </div>

          <label className="block text-lg font-semibold mb-4">
            {backgroundImage ? 'Additional Instructions (Optional)' : 'Describe Your Thumbnail Background'}
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={backgroundImage ? "E.g., make it more vibrant, add dramatic lighting" : "E.g., football stadium at sunset, dramatic lighting, epic atmosphere"}
            className="w-full p-4 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 transition-all"
            rows={3}
          />
          
          {/* Text Overlay Input */}
          <div className="mt-6">
            <label className="block text-lg font-semibold mb-4">
              💬 Text Overlay (Optional)
            </label>
            <input
              type="text"
              value={overlayText}
              onChange={(e) => setOverlayText(e.target.value)}
              placeholder="E.g., EPIC WIN! or NEW RECORD"
              className="w-full p-4 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 transition-all"
            />
          </div>
          
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="mt-6 w-full bg-gradient-to-r from-red-500 to-pink-500 hover:from-red-600 hover:to-pink-600 disabled:from-gray-600 disabled:to-gray-700 text-white font-bold py-4 px-8 rounded-lg text-lg transition-all transform hover:scale-105 disabled:scale-100 disabled:cursor-not-allowed shadow-lg"
          >
            {loading ? (
              <span className="flex items-center justify-center">
                <svg className="animate-spin h-5 w-5 mr-3" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Generating...
              </span>
            ) : (
              '🎨 Generate Thumbnail'
            )}
          </button>
        </div>

        {/* Pricing Table */}
        <div className="bg-gray-800 rounded-2xl p-8 shadow-2xl mb-8">
          <h2 className="text-2xl font-bold mb-6 text-center">💰 ZAR Pricing</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="pb-4 font-semibold text-gray-300">Resolution</th>
                  <th className="pb-4 font-semibold text-gray-300">Steps</th>
                  <th className="pb-4 font-semibold text-gray-300">USD</th>
                  <th className="pb-4 font-semibold text-gray-300">ZAR (approx)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                <tr className="hover:bg-gray-750 transition-colors">
                  <td className="py-4 text-gray-200">1280x720 (16:9)</td>
                  <td className="py-4 text-gray-200">40</td>
                  <td className="py-4 text-green-400 font-semibold">$0.04</td>
                  <td className="py-4 text-green-400 font-semibold">R0.74</td>
                </tr>
                <tr className="hover:bg-gray-750 transition-colors">
                  <td className="py-4 text-gray-200">1280x720 (16:9)</td>
                  <td className="py-4 text-gray-200">50</td>
                  <td className="py-4 text-yellow-400 font-semibold">$0.05</td>
                  <td className="py-4 text-yellow-400 font-semibold">R0.93</td>
                </tr>
                <tr className="hover:bg-gray-750 transition-colors">
                  <td className="py-4 text-gray-200">1280x720 (16:9)</td>
                  <td className="py-4 text-gray-200">60</td>
                  <td className="py-4 text-orange-400 font-semibold">$0.06</td>
                  <td className="py-4 text-orange-400 font-semibold">R1.11</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-sm text-gray-400 text-center">
            * Prices based on Stability AI SDXL pricing. Exchange rate updated in real-time.
          </p>
        </div>

        {/* Error Display */}
        {error && (
          <div className="bg-red-900/50 border border-red-500 rounded-lg p-4 mb-8">
            <p className="text-red-200">❌ {error}</p>
          </div>
        )}

        {/* Results Display */}
        {result && (
          <div className="space-y-8">
            {/* Generated Image */}
            <div className="bg-gray-800 rounded-2xl p-8 shadow-2xl">
              <h2 className="text-2xl font-bold mb-6">Generated Thumbnail</h2>
              {result.images.map((img, idx) => (
                <div key={idx} className="mb-6">
                  <img
                    src={`data:image/png;base64,${img.image_data}`}
                    alt="Generated thumbnail"
                    className="w-full rounded-lg shadow-xl"
                  />
                  <p className="mt-3 text-sm text-gray-400">
                    Seed: {img.seed}
                  </p>
                </div>
              ))}
              
              {/* Action Buttons */}
              <div className="flex gap-4 mt-6">
                <button
                  onClick={saveThumbnail}
                  className="flex-1 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white font-bold py-3 px-6 rounded-lg transition-all transform hover:scale-105 shadow-lg"
                >
                  💾 Save to Gallery
                </button>
                <button
                  onClick={downloadThumbnail}
                  className="flex-1 bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white font-bold py-3 px-6 rounded-lg transition-all transform hover:scale-105 shadow-lg"
                >
                  ⬇️ Download
                </button>
              </div>
            </div>

            {/* Cost Tracking */}
            {result.cost_tracking && (
              <div className="bg-gradient-to-r from-green-900/30 to-blue-900/30 border border-green-500/50 rounded-2xl p-8 shadow-2xl">
                <h2 className="text-2xl font-bold mb-6">💵 Generation Cost</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="bg-gray-800/50 rounded-lg p-6">
                    <p className="text-gray-400 text-sm mb-2">USD Cost</p>
                    <p className="text-3xl font-bold text-green-400">
                      ${result.cost_tracking.usd.toFixed(4)}
                    </p>
                  </div>
                  <div className="bg-gray-800/50 rounded-lg p-6">
                    <p className="text-gray-400 text-sm mb-2">ZAR Cost</p>
                    <p className="text-3xl font-bold text-green-400">
                      R{result.cost_tracking.zar.toFixed(2)}
                    </p>
                  </div>
                  <div className="bg-gray-800/50 rounded-lg p-6">
                    <p className="text-gray-400 text-sm mb-2">Exchange Rate</p>
                    <p className="text-3xl font-bold text-blue-400">
                      {result.cost_tracking.exchange_rate.toFixed(2)}
                    </p>
                  </div>
                </div>
                <p className="mt-4 text-xs text-gray-400">
                  Updated: {new Date(result.cost_tracking.timestamp).toLocaleString()}
                </p>
              </div>
            )}

            {/* Metadata */}
            <div className="bg-gray-800 rounded-2xl p-8 shadow-2xl">
              <h2 className="text-2xl font-bold mb-6">📊 Generation Details</h2>
              <div className="space-y-3 text-sm">
                <div>
                  <span className="text-gray-400">Original Prompt:</span>
                  <p className="text-white mt-1">{result.metadata.original_prompt}</p>
                </div>
                <div>
                  <span className="text-gray-400">Resolution:</span>
                  <p className="text-white mt-1">
                    {result.metadata.width}x{result.metadata.height} (16:9)
                  </p>
                </div>
                <div>
                  <span className="text-gray-400">Steps:</span>
                  <p className="text-white mt-1">{result.metadata.steps}</p>
                </div>
                <div>
                  <span className="text-gray-400">CFG Scale:</span>
                  <p className="text-white mt-1">{result.metadata.cfg_scale}</p>
                </div>
                <div>
                  <span className="text-gray-400">Generated:</span>
                  <p className="text-white mt-1">
                    {new Date(result.metadata.generated_at).toLocaleString()}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
