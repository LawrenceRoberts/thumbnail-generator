'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { blobToObjectUrl, clearThumbnails, deleteThumbnail as deleteThumbnailFromDb, listThumbnails } from '../lib/thumbDb'

type Thumbnail = {
  id: string
  imageUrl: string
  prompt: string
  overlayText: string
  createdAt: string
  cost: { usd: number; zar: number } | null
}

export default function Gallery() {
  const [thumbnails, setThumbnails] = useState<Thumbnail[]>([])
  const [selectedThumbnail, setSelectedThumbnail] = useState<Thumbnail | null>(null)

  useEffect(() => {
    void loadThumbnails()
    return () => {
      // Cleanup object URLs
      thumbnails.forEach((t) => URL.revokeObjectURL(t.imageUrl))
    }
  }, [])

  const loadThumbnails = async () => {
    const records = await listThumbnails()
    const mapped: Thumbnail[] = []
    for (const record of records) {
      mapped.push({
        id: record.id,
        imageUrl: await blobToObjectUrl(record.finalPng),
        prompt: record.prompt,
        overlayText: record.overlayText,
        createdAt: record.createdAt,
        cost: record.cost ? { usd: record.cost.usd, zar: record.cost.zar } : null,
      })
    }
    setThumbnails(mapped)
    setSelectedThumbnail((prev) => (prev ? mapped.find((t) => t.id === prev.id) || null : null))
  }

  const handleDeleteThumbnail = (id: string) => {
    if (confirm('Are you sure you want to delete this thumbnail?')) {
      void (async () => {
        const toRevoke = thumbnails.find((t) => t.id === id)?.imageUrl
        if (toRevoke) URL.revokeObjectURL(toRevoke)

        await deleteThumbnailFromDb(id)
        await loadThumbnails()
        if (selectedThumbnail?.id === id) setSelectedThumbnail(null)
      })()
    }
  }

  const downloadThumbnail = (thumbnail: Thumbnail) => {
    const link = document.createElement('a')
    link.href = thumbnail.imageUrl
    link.download = `thumbnail-${thumbnail.id}.png`
    link.click()
  }

  const clearAll = () => {
    if (confirm('Are you sure you want to delete ALL thumbnails? This cannot be undone.')) {
      void (async () => {
        await clearThumbnails()
        thumbnails.forEach((t) => URL.revokeObjectURL(t.imageUrl))
        setThumbnails([])
        setSelectedThumbnail(null)
      })()
    }
  }

  return (
    <main className="min-h-screen p-8 bg-gradient-to-b from-gray-900 to-gray-800 text-white">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-red-500 to-pink-500 bg-clip-text text-transparent">
              My Thumbnails
            </h1>
            <p className="text-gray-400">
              {thumbnails.length} {thumbnails.length === 1 ? 'thumbnail' : 'thumbnails'} saved
            </p>
          </div>
          <div className="flex gap-3">
            {thumbnails.length > 0 && (
              <button
                onClick={clearAll}
                className="bg-red-600 hover:bg-red-700 text-white font-semibold py-2 px-4 rounded-lg transition-all"
              >
                🗑️ Clear All
              </button>
            )}
            <Link
              href="/"
              className="bg-gradient-to-r from-red-500 to-pink-500 hover:from-red-600 hover:to-pink-600 text-white font-bold py-2 px-6 rounded-lg transition-all"
            >
              ➕ Create New
            </Link>
          </div>
        </div>

        {/* Empty State */}
        {thumbnails.length === 0 ? (
          <div className="bg-gray-800 rounded-2xl p-12 text-center shadow-2xl">
            <div className="text-6xl mb-6">🖼️</div>
            <h2 className="text-2xl font-bold mb-4">No Thumbnails Yet</h2>
            <p className="text-gray-400 mb-8">
              Create your first thumbnail to see it here!
            </p>
            <Link
              href="/"
              className="inline-block bg-gradient-to-r from-red-500 to-pink-500 hover:from-red-600 hover:to-pink-600 text-white font-bold py-3 px-6 rounded-lg transition-all"
            >
              Create Thumbnail
            </Link>
          </div>
        ) : (
          <div className="grid lg:grid-cols-3 gap-8">
            {/* Thumbnail Grid */}
            <div className="lg:col-span-2">
              <div className="grid sm:grid-cols-2 gap-4">
                {thumbnails.map((thumbnail) => (
                  <div
                    key={thumbnail.id}
                    className={`bg-gray-800 rounded-xl overflow-hidden shadow-xl cursor-pointer transition-all hover:scale-105 ${
                      selectedThumbnail?.id === thumbnail.id ? 'ring-4 ring-pink-500' : ''
                    }`}
                    onClick={() => setSelectedThumbnail(thumbnail)}
                  >
                    <img
                      src={thumbnail.imageUrl}
                      alt={thumbnail.prompt}
                      className="w-full aspect-video object-cover"
                    />
                    <div className="p-4">
                      <p className="text-sm text-gray-400 truncate">
                        {thumbnail.overlayText || thumbnail.prompt || 'No description'}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        {new Date(thumbnail.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Details Panel */}
            <div className="lg:col-span-1">
              {selectedThumbnail ? (
                <div className="bg-gray-800 rounded-2xl p-6 shadow-2xl sticky top-24">
                  <h3 className="text-xl font-bold mb-4">Thumbnail Details</h3>
                  
                  {/* Preview */}
                  <img
                    src={selectedThumbnail.imageUrl}
                    alt={selectedThumbnail.prompt}
                    className="w-full rounded-lg mb-4 shadow-lg"
                  />

                  {/* Info */}
                  <div className="space-y-3 mb-6">
                    {selectedThumbnail.overlayText && (
                      <div>
                        <p className="text-xs text-gray-500 uppercase">Text Overlay</p>
                        <p className="text-sm font-medium">{selectedThumbnail.overlayText}</p>
                      </div>
                    )}
                    {selectedThumbnail.prompt && (
                      <div>
                        <p className="text-xs text-gray-500 uppercase">Prompt</p>
                        <p className="text-sm font-medium">{selectedThumbnail.prompt}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-xs text-gray-500 uppercase">Created</p>
                      <p className="text-sm font-medium">
                        {new Date(selectedThumbnail.createdAt).toLocaleString()}
                      </p>
                    </div>
                    {selectedThumbnail.cost && (
                      <div>
                        <p className="text-xs text-gray-500 uppercase">Generation Cost</p>
                        <p className="text-sm font-medium text-green-400">
                          ${selectedThumbnail.cost.usd.toFixed(2)} (R{selectedThumbnail.cost.zar.toFixed(2)})
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="space-y-3">
                    <Link
                      href={`/gallery/edit?id=${selectedThumbnail.id}`}
                      className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-bold py-3 px-4 rounded-lg transition-all block text-center"
                    >
                      ✏️ Edit
                    </Link>
                    <button
                      onClick={() => downloadThumbnail(selectedThumbnail)}
                      className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white font-bold py-3 px-4 rounded-lg transition-all"
                    >
                      ⬇️ Download
                    </button>
                    <button
                      onClick={() => handleDeleteThumbnail(selectedThumbnail.id)}
                      className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 px-4 rounded-lg transition-all"
                    >
                      🗑️ Delete
                    </button>
                  </div>
                </div>
              ) : (
                <div className="bg-gray-800 rounded-2xl p-8 text-center shadow-2xl sticky top-24">
                  <div className="text-4xl mb-4">👈</div>
                  <p className="text-gray-400">
                    Select a thumbnail to view details
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
