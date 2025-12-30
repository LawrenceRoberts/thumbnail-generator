'use client'

import { Suspense, useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { getThumbnail, putThumbnail, type ImageLayer, type TextLayer } from '../../lib/thumbDb'

type Thumbnail = {
  id: string
  prompt: string
  overlayText: string
  createdAt: string
  cost: any
}

type TextElement = TextLayer

type ImageElement = ImageLayer

function ThumbnailEditorInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const thumbnailId = searchParams.get('id')
  
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [thumbnail, setThumbnail] = useState<Thumbnail | null>(null)
  const [backgroundImage, setBackgroundImage] = useState<HTMLImageElement | null>(null)
  const [dbRecord, setDbRecord] = useState<any>(null)
  
  const [textElements, setTextElements] = useState<TextElement[]>([])
  const [imageElements, setImageElements] = useState<ImageElement[]>([])
  const [selectedElement, setSelectedElement] = useState<string | null>(null)
  const [selectedType, setSelectedType] = useState<'text' | 'image' | null>(null)
  
  const [activeTool, setActiveTool] = useState<'select' | 'text' | 'image'>('select')
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef<null | {
    type: 'text' | 'image'
    id: string
    startX: number
    startY: number
    pointerStartX: number
    pointerStartY: number
  }>(null)

  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const [imageCacheVersion, setImageCacheVersion] = useState(0)

  // Canvas dimensions (default YouTube thumbnail size, but supports 9:16 too)
  const [canvasSize, setCanvasSize] = useState({ width: 1280, height: 720 })
  const CANVAS_WIDTH = canvasSize.width
  const CANVAS_HEIGHT = canvasSize.height

  const buildFont = (element: TextElement) => {
    let font = ''
    if (element.italic) font += 'italic '
    if (element.bold) font += 'bold '
    font += `${element.fontSize}px ${element.fontFamily}`
    return font
  }

  const getCanvasPoint = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const scaleX = CANVAS_WIDTH / rect.width
    const scaleY = CANVAS_HEIGHT / rect.height
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    }
  }

  const getTextLocalBounds = (ctx: CanvasRenderingContext2D, element: TextElement) => {
    ctx.font = buildFont(element)
    ctx.textBaseline = 'top'

    const lines = (element.text ?? '').split('\n')
    const safeLines = lines.length > 0 ? lines : ['']

    let maxLineWidth = 0
    let maxAscent = element.fontSize * 0.8
    let maxDescent = element.fontSize * 0.2

    for (const line of safeLines) {
      const metrics = ctx.measureText(line)
      maxLineWidth = Math.max(maxLineWidth, metrics.width)
      // Prefer precise bounds when available
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ascent = (metrics as any).actualBoundingBoxAscent
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const descent = (metrics as any).actualBoundingBoxDescent
      if (typeof ascent === 'number') maxAscent = Math.max(maxAscent, ascent)
      if (typeof descent === 'number') maxDescent = Math.max(maxDescent, descent)
    }

    const lineHeight = Math.round(element.fontSize * 1.15)
    const textWidth = maxLineWidth
    const textHeight = (safeLines.length - 1) * lineHeight + (maxAscent + maxDescent)

    // When drawing we render at (0,0) with ctx.textAlign = element.align.
    // That means the local origin shifts based on alignment.
    let left = 0
    if (element.align === 'center') left = -textWidth / 2
    if (element.align === 'right') left = -textWidth

    const pad = Math.max(10, Math.round((element.strokeWidth ?? 0) * 1.5))

    return {
      x: left - pad,
      y: 0 - pad,
      w: textWidth + pad * 2,
      h: textHeight + pad * 2,
    }
  }

  const pickElementAtPoint = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number
  ): { type: 'text' | 'image'; id: string } | null => {
    // Text: top-most first. Accounts for bold/italic, alignment, and rotation.
    for (let i = textElements.length - 1; i >= 0; i--) {
      const element = textElements[i]

      // Convert world point -> element-local point (undo translate + rotation)
      const dx = x - element.x
      const dy = y - element.y
      const rad = (-element.rotation * Math.PI) / 180
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad)

      const b = getTextLocalBounds(ctx, element)
      if (lx >= b.x && lx <= b.x + b.w && ly >= b.y && ly <= b.y + b.h) {
        return { type: 'text', id: element.id }
      }
    }

    // Images: top-most first (axis-aligned bounds, consistent with selection rendering)
    for (let i = imageElements.length - 1; i >= 0; i--) {
      const element = imageElements[i]
      if (x >= element.x && x <= element.x + element.width && y >= element.y && y <= element.y + element.height) {
        return { type: 'image', id: element.id }
      }
    }

    return null
  }

  useEffect(() => {
    if (!thumbnailId) {
      router.push('/gallery')
      return
    }

    void (async () => {
      const record = await getThumbnail(thumbnailId)
      if (!record) {
        router.push('/gallery')
        return
      }

      setDbRecord(record)
      setThumbnail({
        id: record.id,
        prompt: record.prompt,
        overlayText: record.overlayText,
        createdAt: record.createdAt,
        cost: record.cost,
      })

      if (typeof record.width === 'number' && typeof record.height === 'number' && record.width > 0 && record.height > 0) {
        setCanvasSize({ width: record.width, height: record.height })
      }

      // Load the base image that has NO baked text.
      const baseUrl = URL.createObjectURL(record.basePng)
      loadBackgroundImage(baseUrl)

      // Load saved layer state (this avoids ever duplicating baked text).
      if (record.layers?.text) setTextElements(record.layers.text)
      if (record.layers?.images) setImageElements(record.layers.images)
    })()
  }, [thumbnailId, router])

  const loadBackgroundImage = (dataUrl: string) => {
    const img = new Image()
    img.onload = () => {
      setBackgroundImage(img)
      // Prefer the actual bitmap size; this keeps the editor aligned with the generated image.
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setCanvasSize({ width: img.naturalWidth, height: img.naturalHeight })
      }
    }
    img.src = dataUrl
  }

  useEffect(() => {
    if (backgroundImage) {
      renderCanvas()
    }
  }, [backgroundImage, textElements, imageElements, selectedElement, imageCacheVersion])

  const renderCanvas = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Clear canvas
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)

    // Draw background
    if (backgroundImage) {
      ctx.drawImage(backgroundImage, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
    }

    // Draw image elements
    imageElements.forEach(element => {
      ctx.save()
      ctx.globalAlpha = element.opacity
      ctx.translate(element.x + element.width / 2, element.y + element.height / 2)
      ctx.rotate((element.rotation * Math.PI) / 180)

      const cached = imageCacheRef.current.get(element.id)
      if (cached && cached.complete && cached.naturalWidth > 0) {
        ctx.drawImage(cached, -element.width / 2, -element.height / 2, element.width, element.height)
      } else {
        // Lazy-load and re-render when ready.
        const img = cached ?? new Image()
        if (!cached) {
          img.decoding = 'async'
          img.onload = () => {
            setImageCacheVersion(v => v + 1)
          }
          img.onerror = () => {
            // Drop broken images so we don't keep retrying.
            imageCacheRef.current.delete(element.id)
            setImageCacheVersion(v => v + 1)
          }
          img.src = element.src
          imageCacheRef.current.set(element.id, img)
        }
      }
      
      ctx.restore()

      // Selection box
      if (selectedElement === element.id) {
        ctx.strokeStyle = '#3b82f6'
        ctx.lineWidth = 3
        ctx.strokeRect(element.x, element.y, element.width, element.height)
      }
    })

    // Draw text elements
    textElements.forEach(element => {
      ctx.save()
      ctx.translate(element.x, element.y)
      ctx.rotate((element.rotation * Math.PI) / 180)

      // Font setup
      ctx.font = buildFont(element)
      ctx.textAlign = element.align
      ctx.textBaseline = 'top'

      const lines = (element.text ?? '').split('\n')
      const safeLines = lines.length > 0 ? lines : ['']
      const lineHeight = Math.round(element.fontSize * 1.15)

      // Draw stroke
      if (element.strokeWidth > 0) {
        ctx.strokeStyle = element.strokeColor
        ctx.lineWidth = element.strokeWidth
        ctx.lineJoin = 'round'
        safeLines.forEach((line, idx) => {
          ctx.strokeText(line, 0, idx * lineHeight)
        })
      }

      // Draw fill
      ctx.fillStyle = element.color
      safeLines.forEach((line, idx) => {
        ctx.fillText(line, 0, idx * lineHeight)
      })

      // Selection indicator (draw in the same transformed space so it matches rotation/alignment)
      if (selectedElement === element.id) {
        const b = getTextLocalBounds(ctx, element)
        ctx.save()
        ctx.strokeStyle = '#3b82f6'
        ctx.lineWidth = 3
        ctx.setLineDash([8, 6])
        ctx.strokeRect(b.x, b.y, b.w, b.h)
        ctx.setLineDash([])
        ctx.restore()
      }

      ctx.restore()
    })
  }

  const addText = () => {
    const newText: TextElement = {
      id: `text-${Date.now()}`,
      text: 'Click to Edit',
      x: 640,
      y: 360,
      fontSize: 60,
      fontFamily: 'Impact',
      color: '#FFFFFF',
      bold: true,
      italic: false,
      align: 'center',
      rotation: 0,
      strokeColor: '#000000',
      strokeWidth: 3
    }
    setTextElements([...textElements, newText])
    setSelectedElement(newText.id)
    setSelectedType('text')
    setActiveTool('select')
  }

  const addImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const newImage: ImageElement = {
        id: `image-${Date.now()}`,
        src: event.target?.result as string,
        x: 400,
        y: 200,
        width: 300,
        height: 300,
        rotation: 0,
        opacity: 1
      }
      setImageElements([...imageElements, newImage])
      setSelectedElement(newImage.id)
      setSelectedType('image')
      setActiveTool('select')
    }
    reader.readAsDataURL(file)
  }

  const updateTextElement = (id: string, updates: Partial<TextElement>) => {
    setTextElements(textElements.map(el => 
      el.id === id ? { ...el, ...updates } : el
    ))
  }

  const updateImageElement = (id: string, updates: Partial<ImageElement>) => {
    setImageElements(imageElements.map(el => 
      el.id === id ? { ...el, ...updates } : el
    ))
  }

  const deleteSelected = () => {
    if (!selectedElement) return
    
    setTextElements(textElements.filter(el => el.id !== selectedElement))
    setImageElements(imageElements.filter(el => el.id !== selectedElement))
    setSelectedElement(null)
    setSelectedType(null)
  }

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const pt = getCanvasPoint(e)
    if (!pt) return
    const { x, y } = pt

    const hit = pickElementAtPoint(ctx, x, y)
    if (!hit) {
      setSelectedElement(null)
      setSelectedType(null)
      setIsDragging(false)
      dragRef.current = null
      return
    }

    setSelectedElement(hit.id)
    setSelectedType(hit.type)

    if (activeTool !== 'select') return

    if (hit.type === 'text') {
      const element = textElements.find(el => el.id === hit.id)
      if (!element) return

      setIsDragging(true)
      dragRef.current = {
        type: 'text',
        id: hit.id,
        startX: element.x,
        startY: element.y,
        pointerStartX: x,
        pointerStartY: y,
      }
    }

    if (hit.type === 'image') {
      const element = imageElements.find(el => el.id === hit.id)
      if (!element) return

      setIsDragging(true)
      dragRef.current = {
        type: 'image',
        id: hit.id,
        startX: element.x,
        startY: element.y,
        pointerStartX: x,
        pointerStartY: y,
      }
    }

    if (dragRef.current) {
      // Capture pointer so dragging continues even if the finger/mouse leaves the canvas.
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // Ignore if not supported
      }
      e.preventDefault()
    }
  }

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDragging || !dragRef.current) return
    const pt = getCanvasPoint(e)
    if (!pt) return

    const dx = pt.x - dragRef.current.pointerStartX
    const dy = pt.y - dragRef.current.pointerStartY
    const nextX = dragRef.current.startX + dx
    const nextY = dragRef.current.startY + dy

    if (dragRef.current.type === 'text') {
      setTextElements(prev =>
        prev.map(el => (el.id === dragRef.current?.id ? { ...el, x: nextX, y: nextY } : el))
      )
    } else {
      setImageElements(prev =>
        prev.map(el => (el.id === dragRef.current?.id ? { ...el, x: nextX, y: nextY } : el))
      )
    }
    e.preventDefault()
  }

  const stopDragging = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (canvas && e) {
      try {
        canvas.releasePointerCapture(e.pointerId)
      } catch {
        // Ignore if not supported
      }
    }
    setIsDragging(false)
    dragRef.current = null
  }

  const exportThumbnail = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    void (async () => {
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/png'))

      if (dbRecord && thumbnail) {
        await putThumbnail({
          ...dbRecord,
          finalPng: blob,
          overlayText: thumbnail.overlayText,
          layers: {
            text: textElements,
            images: imageElements,
          },
        })
      }

      alert('Thumbnail saved successfully! 🎉')
      router.push('/gallery')
    })()
  }

  const downloadThumbnail = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const link = document.createElement('a')
    link.download = `thumbnail-edited-${Date.now()}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  const selectedTextElement = selectedType === 'text' && selectedElement
    ? textElements.find(el => el.id === selectedElement)
    : null

  const selectedImageElement = selectedType === 'image' && selectedElement
    ? imageElements.find(el => el.id === selectedElement)
    : null

  if (!thumbnail) return <div className="min-h-screen bg-gray-900 flex items-center justify-center text-white">Loading...</div>

  return (
    <div className="h-screen bg-gray-900 text-white flex flex-col overflow-hidden">
      {/* Top Toolbar */}
      <div className="bg-gray-800 border-b border-gray-700 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/gallery" className="text-gray-400 hover:text-white transition-colors">
            ← Back to Gallery
          </Link>
          <div className="h-6 w-px bg-gray-700"></div>
          <h1 className="text-lg font-semibold">Edit Thumbnail</h1>
        </div>
        <div className="flex gap-3">
          <button
            onClick={downloadThumbnail}
            className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg font-medium transition-colors"
          >
            ⬇️ Download
          </button>
          <button
            onClick={exportThumbnail}
            className="bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 px-6 py-2 rounded-lg font-semibold transition-all"
          >
            💾 Save Changes
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar - Tools */}
        <div className="w-20 bg-gray-800 border-r border-gray-700 flex flex-col items-center py-4 gap-2">
          <button
            onClick={() => setActiveTool('select')}
            className={`w-14 h-14 rounded-lg flex flex-col items-center justify-center transition-colors ${
              activeTool === 'select' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'
            }`}
            title="Select"
          >
            <span className="text-2xl">↖️</span>
            <span className="text-xs mt-1">Select</span>
          </button>
          
          <button
            onClick={addText}
            className={`w-14 h-14 rounded-lg flex flex-col items-center justify-center transition-colors ${
              activeTool === 'text' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'
            }`}
            title="Add Text"
          >
            <span className="text-2xl">T</span>
            <span className="text-xs mt-1">Text</span>
          </button>

          <label className="w-14 h-14 rounded-lg flex flex-col items-center justify-center bg-gray-700 hover:bg-gray-600 transition-colors cursor-pointer">
            <span className="text-2xl">🖼️</span>
            <span className="text-xs mt-1">Image</span>
            <input
              type="file"
              accept="image/*"
              onChange={addImage}
              className="hidden"
            />
          </label>

          {selectedElement && (
            <>
              <div className="h-px w-12 bg-gray-700 my-2"></div>
              <button
                onClick={deleteSelected}
                className="w-14 h-14 rounded-lg flex flex-col items-center justify-center bg-red-600 hover:bg-red-700 transition-colors"
                title="Delete"
              >
                <span className="text-2xl">🗑️</span>
                <span className="text-xs mt-1">Delete</span>
              </button>
            </>
          )}
        </div>

        {/* Main Canvas Area */}
        <div className="flex-1 bg-gray-850 flex items-center justify-center p-8 overflow-auto">
          <div className="relative" style={{ maxWidth: '90%', maxHeight: '90%' }}>
            <canvas
              ref={canvasRef}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={stopDragging}
              onPointerCancel={stopDragging}
              onPointerLeave={stopDragging}
              className={`border-2 border-gray-600 rounded-lg shadow-2xl ${
                activeTool === 'select' ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-crosshair'
              }`}
              style={{
                width: '100%',
                height: 'auto',
                maxWidth: '1280px',
                backgroundColor: '#1f2937',
                touchAction: 'none'
              }}
            />
          </div>
        </div>

        {/* Right Sidebar - Properties */}
        <div className="w-80 bg-gray-800 border-l border-gray-700 overflow-y-auto">
          <div className="p-6">
            {!selectedElement && (
              <div className="text-center text-gray-400 py-12">
                <p className="text-4xl mb-4">👈</p>
                <p>Select an element to edit its properties</p>
              </div>
            )}

            {/* Text Element Properties */}
            {selectedTextElement && (
              <div className="space-y-6">
                <h3 className="text-lg font-bold mb-4">Text Properties</h3>

                <div>
                  <label className="block text-sm font-medium mb-2">Text Content</label>
                  <textarea
                    value={selectedTextElement.text}
                    onChange={(e) => updateTextElement(selectedTextElement.id, { text: e.target.value })}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    rows={3}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Font Size: {selectedTextElement.fontSize}px</label>
                  <input
                    type="range"
                    min="20"
                    max="200"
                    value={selectedTextElement.fontSize}
                    onChange={(e) => updateTextElement(selectedTextElement.id, { fontSize: parseInt(e.target.value) })}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Font Family</label>
                  <select
                    value={selectedTextElement.fontFamily}
                    onChange={(e) => updateTextElement(selectedTextElement.id, { fontFamily: e.target.value })}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="Impact">Impact</option>
                    <option value="Arial">Arial</option>
                    <option value="Arial Black">Arial Black</option>
                    <option value="Helvetica">Helvetica</option>
                    <option value="Times New Roman">Times New Roman</option>
                    <option value="Georgia">Georgia</option>
                    <option value="Courier New">Courier New</option>
                    <option value="Comic Sans MS">Comic Sans MS</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium mb-2">Text Color</label>
                    <input
                      type="color"
                      value={selectedTextElement.color}
                      onChange={(e) => updateTextElement(selectedTextElement.id, { color: e.target.value })}
                      className="w-full h-10 rounded-lg cursor-pointer"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">Stroke Color</label>
                    <input
                      type="color"
                      value={selectedTextElement.strokeColor}
                      onChange={(e) => updateTextElement(selectedTextElement.id, { strokeColor: e.target.value })}
                      className="w-full h-10 rounded-lg cursor-pointer"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Stroke Width: {selectedTextElement.strokeWidth}px</label>
                  <input
                    type="range"
                    min="0"
                    max="20"
                    value={selectedTextElement.strokeWidth}
                    onChange={(e) => updateTextElement(selectedTextElement.id, { strokeWidth: parseInt(e.target.value) })}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Text Align</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['left', 'center', 'right'] as const).map(align => (
                      <button
                        key={align}
                        onClick={() => updateTextElement(selectedTextElement.id, { align })}
                        className={`py-2 rounded-lg font-medium transition-colors ${
                          selectedTextElement.align === align
                            ? 'bg-blue-600'
                            : 'bg-gray-700 hover:bg-gray-600'
                        }`}
                      >
                        {align.charAt(0).toUpperCase() + align.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedTextElement.bold}
                      onChange={(e) => updateTextElement(selectedTextElement.id, { bold: e.target.checked })}
                      className="w-5 h-5"
                    />
                    <span className="font-bold">Bold</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedTextElement.italic}
                      onChange={(e) => updateTextElement(selectedTextElement.id, { italic: e.target.checked })}
                      className="w-5 h-5"
                    />
                    <span className="italic">Italic</span>
                  </label>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Rotation: {selectedTextElement.rotation}°</label>
                  <input
                    type="range"
                    min="0"
                    max="360"
                    value={selectedTextElement.rotation}
                    onChange={(e) => updateTextElement(selectedTextElement.id, { rotation: parseInt(e.target.value) })}
                    className="w-full"
                  />
                </div>
              </div>
            )}

            {/* Image Element Properties */}
            {selectedImageElement && (
              <div className="space-y-6">
                <h3 className="text-lg font-bold mb-4">Image Properties</h3>

                <div>
                  <label className="block text-sm font-medium mb-2">Width: {Math.round(selectedImageElement.width)}px</label>
                  <input
                    type="range"
                    min="50"
                    max={CANVAS_WIDTH}
                    value={selectedImageElement.width}
                    onChange={(e) => updateImageElement(selectedImageElement.id, { width: parseInt(e.target.value) })}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Height: {Math.round(selectedImageElement.height)}px</label>
                  <input
                    type="range"
                    min="50"
                    max={CANVAS_HEIGHT}
                    value={selectedImageElement.height}
                    onChange={(e) => updateImageElement(selectedImageElement.id, { height: parseInt(e.target.value) })}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Position X: {Math.round(selectedImageElement.x)}</label>
                  <input
                    type="range"
                    min="0"
                    max={CANVAS_WIDTH}
                    value={selectedImageElement.x}
                    onChange={(e) => updateImageElement(selectedImageElement.id, { x: parseInt(e.target.value) })}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Position Y: {Math.round(selectedImageElement.y)}</label>
                  <input
                    type="range"
                    min="0"
                    max={CANVAS_HEIGHT}
                    value={selectedImageElement.y}
                    onChange={(e) => updateImageElement(selectedImageElement.id, { y: parseInt(e.target.value) })}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Rotation: {selectedImageElement.rotation}°</label>
                  <input
                    type="range"
                    min="0"
                    max="360"
                    value={selectedImageElement.rotation}
                    onChange={(e) => updateImageElement(selectedImageElement.id, { rotation: parseInt(e.target.value) })}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Opacity: {Math.round(selectedImageElement.opacity * 100)}%</label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={selectedImageElement.opacity * 100}
                    onChange={(e) => updateImageElement(selectedImageElement.id, { opacity: parseInt(e.target.value) / 100 })}
                    className="w-full"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ThumbnailEditor() {
  return (
    <Suspense fallback={<div className="p-6">Loading…</div>}>
      <ThumbnailEditorInner />
    </Suspense>
  )
}
