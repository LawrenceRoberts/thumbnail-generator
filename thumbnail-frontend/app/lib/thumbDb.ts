'use client'

export type ThumbnailCost = {
  usd: number
  zar: number
  exchange_rate?: number
  timestamp?: string
} | null

export type TextLayer = {
  id: string
  text: string
  x: number
  y: number
  fontSize: number
  fontFamily: string
  color: string
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
  rotation: number
  strokeColor: string
  strokeWidth: number
}

export type ImageLayer = {
  id: string
  src: string // data URL for now
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
}

export type ThumbnailRecord = {
  id: string
  createdAt: string
  prompt: string
  overlayText: string
  cost: ThumbnailCost
  width?: number
  height?: number
  finalPng: Blob
  basePng: Blob // composite_before_text (background + person, no text)
  layers?: {
    text: TextLayer[]
    images: ImageLayer[]
  }
}

const DB_NAME = 'thumbnail-pro'
const DB_VERSION = 1
const STORE = 'thumbnails'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }

    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode)
    const store = transaction.objectStore(STORE)
    const req = fn(store)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function putThumbnail(record: ThumbnailRecord): Promise<void> {
  const db = await openDb()
  await tx(db, 'readwrite', (store) => store.put(record))
  db.close()
}

export async function getThumbnail(id: string): Promise<ThumbnailRecord | null> {
  const db = await openDb()
  const result = await tx(db, 'readonly', (store) => store.get(id))
  db.close()
  return (result as any) ?? null
}

export async function listThumbnails(): Promise<ThumbnailRecord[]> {
  const db = await openDb()
  const result = await tx(db, 'readonly', (store) => store.getAll())
  db.close()
  const items = (result as any[]) as ThumbnailRecord[]
  // newest first
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return items
}

export async function deleteThumbnail(id: string): Promise<void> {
  const db = await openDb()
  await tx(db, 'readwrite', (store) => store.delete(id))
  db.close()
}

export async function clearThumbnails(): Promise<void> {
  const db = await openDb()
  await tx(db, 'readwrite', (store) => store.clear())
  db.close()
}

export async function blobToObjectUrl(blob: Blob): Promise<string> {
  return URL.createObjectURL(blob)
}

export async function base64PngToBlob(base64: string): Promise<Blob> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: 'image/png' })
}
