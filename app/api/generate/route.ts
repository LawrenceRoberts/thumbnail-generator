export const runtime = 'nodejs'

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000'

export async function POST(request: Request) {
  try {
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
