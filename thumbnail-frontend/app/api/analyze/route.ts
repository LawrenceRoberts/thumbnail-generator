export const runtime = 'nodejs'
// Analysis can involve multiple upstream calls; allow longer execution.
export const maxDuration = 60

const rawBackendUrl = process.env.BACKEND_URL || 'http://localhost:8000'
const BACKEND_URL = rawBackendUrl.replace(/^"|"$/g, '').replace(/\/$/, '')

function corsHeaders(origin: string | null) {
  // For same-origin calls (typical in Next.js apps), CORS headers don't matter.
  // But for flexibility (and per request), we include permissive headers.
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  }
}

function extractYouTubeVideoId(videoUrl: string): string | null {
  try {
    const url = new URL(videoUrl)
    const host = url.hostname.replace(/^www\./, '').toLowerCase()

    // https://youtu.be/<id>
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0]
      return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null
    }

    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      // https://youtube.com/watch?v=<id>
      const v = url.searchParams.get('v')
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v

      // https://youtube.com/shorts/<id>
      const parts = url.pathname.split('/').filter(Boolean)
      const shortsIdx = parts.indexOf('shorts')
      if (shortsIdx >= 0 && parts[shortsIdx + 1] && /^[A-Za-z0-9_-]{11}$/.test(parts[shortsIdx + 1])) {
        return parts[shortsIdx + 1]
      }

      // https://youtube.com/embed/<id>
      const embedIdx = parts.indexOf('embed')
      if (embedIdx >= 0 && parts[embedIdx + 1] && /^[A-Za-z0-9_-]{11}$/.test(parts[embedIdx + 1])) {
        return parts[embedIdx + 1]
      }
    }

    return null
  } catch {
    return null
  }
}

type AnalyzeRequest = {
  videoUrl?: string
}

type AnalyzeResponse = {
  performanceScore: number
  improvementSuggestions: string[]
  videoId: string
  thumbnailUrl?: string
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin')
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin')
  const headers = { 'content-type': 'application/json', ...corsHeaders(origin) }

  let payload: AnalyzeRequest
  try {
    payload = (await request.json()) as AnalyzeRequest
  } catch {
    return new Response(JSON.stringify({ detail: 'Invalid JSON body' }), { status: 400, headers })
  }

  const videoUrl = (payload.videoUrl ?? '').trim()
  if (!videoUrl) {
    return new Response(JSON.stringify({ detail: 'videoUrl is required' }), { status: 400, headers })
  }

  const videoId = extractYouTubeVideoId(videoUrl)
  if (!videoId) {
    return new Response(JSON.stringify({ detail: 'Unable to extract a valid YouTube video ID from videoUrl' }), {
      status: 400,
      headers,
    })
  }

  // Timeout handling (upstream can be slow or quota-limited)
  const controller = new AbortController()
  const timeoutMs = Number(process.env.ANALYZE_PROXY_TIMEOUT_MS ?? 25000)
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${BACKEND_URL}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ video_id: videoId }),
      signal: controller.signal,
    })

    const contentType = res.headers.get('content-type') || ''
    const body = contentType.includes('application/json') ? await res.json() : await res.text()

    if (!res.ok) {
      return new Response(
        typeof body === 'string' ? body : JSON.stringify(body),
        {
          status: res.status,
          headers,
        }
      )
    }

    // Ensure the shape the frontend expects.
    const data = body as Partial<AnalyzeResponse>
    if (typeof data.performanceScore !== 'number' || !Array.isArray(data.improvementSuggestions)) {
      return new Response(JSON.stringify({ detail: 'Backend response shape invalid' }), { status: 502, headers })
    }

    return new Response(JSON.stringify(data), { status: 200, headers })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return new Response(JSON.stringify({ detail: 'Upstream /analyze timed out' }), { status: 504, headers })
    }

    const message = err instanceof Error ? err.message : 'Failed to proxy request'
    return new Response(JSON.stringify({ detail: message }), { status: 502, headers })
  } finally {
    clearTimeout(timer)
  }
}
