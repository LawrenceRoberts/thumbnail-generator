export const runtime = 'nodejs'
// Gemini + Flux can take a while
export const maxDuration = 180

const rawBackendUrl = process.env.BACKEND_URL || 'http://localhost:8000'
const BACKEND_URL = rawBackendUrl.replace(/^"|"$/g, '').replace(/\/$/, '')

type PerformanceTuningRequest = {
  videoId?: string
  video_id?: string
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as PerformanceTuningRequest
    const videoId = String(payload.videoId ?? payload.video_id ?? '').trim()

    if (!videoId) {
      return new Response(JSON.stringify({ detail: 'videoId is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }

    const res = await fetch(`${BACKEND_URL}/performance-tuning`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ video_id: videoId }),
    })

    const contentType = res.headers.get('content-type') || ''
    const body = contentType.includes('application/json') ? await res.json() : await res.text()

    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: res.status,
      headers: {
        'content-type': contentType.includes('application/json') ? 'application/json' : contentType || 'text/plain',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to proxy request'
    return new Response(JSON.stringify({ detail: message }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }
}
