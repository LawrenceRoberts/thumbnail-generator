export const runtime = 'nodejs'
// Vercel can terminate long-running Serverless Functions; thumbnail generation can take a while.
// Increase the allowed duration to reduce proxy timeouts.
export const maxDuration = 60

const rawBackendUrl = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const BACKEND_URL = rawBackendUrl.replace(/^"|"$/g, '').replace(/\/$/, '')

function isProbablyLocalhost(url: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(url)
}

export async function POST(request: Request) {
  try {
    if (process.env.NODE_ENV === 'production' && isProbablyLocalhost(BACKEND_URL)) {
      return new Response(
        JSON.stringify({
          detail:
            'Server misconfiguration: BACKEND_URL points to localhost. Set Vercel env BACKEND_URL to your public backend URL (e.g. https://<your-fly-app>.fly.dev) and redeploy.',
        }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      )
    }

    const incoming = await request.formData()

    // Recreate form data for backend
    const formData = new FormData()
    for (const [key, value] of incoming.entries()) {
      formData.append(key, value)
    }

    const res = await fetch(`${BACKEND_URL}/api/generate`, {
      method: 'POST',
      body: formData,
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
