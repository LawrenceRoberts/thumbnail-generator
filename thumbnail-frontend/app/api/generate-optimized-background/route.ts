export const runtime = 'nodejs'
// Flux + Supabase upload can take a while
export const maxDuration = 180

const rawBackendUrl = process.env.BACKEND_URL || 'http://localhost:8000'
const BACKEND_URL = rawBackendUrl.replace(/^"|"$/g, '').replace(/\/$/, '')

type GenerateOptimizedBackgroundRequest = {
  prompt?: string
  flux_prompt?: string
  style_reference_url?: string
  styleReferenceUrl?: string
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as GenerateOptimizedBackgroundRequest

    const prompt = String(payload.prompt ?? payload.flux_prompt ?? '').trim()
    const styleReferenceUrl = String(payload.style_reference_url ?? payload.styleReferenceUrl ?? '').trim()

    if (!prompt) {
      return new Response(JSON.stringify({ detail: 'prompt is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }

    if (!styleReferenceUrl) {
      return new Response(JSON.stringify({ detail: 'style_reference_url is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }

    const res = await fetch(`${BACKEND_URL}/generate-optimized-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        style_reference_url: styleReferenceUrl,
      }),
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
