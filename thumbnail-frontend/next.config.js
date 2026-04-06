/** @type {import('next').NextConfig} */
function hostnameFromUrl(value) {
	if (!value || typeof value !== 'string') return null
	try {
		return new URL(value).hostname
	} catch {
		return null
	}
}

const supabaseHostname = hostnameFromUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)
const backendHostname = hostnameFromUrl(process.env.NEXT_PUBLIC_BACKEND_URL || process.env.BACKEND_URL)

/** @type {import('next').NextConfig} */
const nextConfig = {
	images: {
		remotePatterns: [
			// YouTube thumbnails
			{ protocol: 'https', hostname: 'i.ytimg.com' },
			{ protocol: 'https', hostname: 'img.youtube.com' },

			// Local dev backend (when backend returns absolute URLs)
			{ protocol: 'http', hostname: '127.0.0.1', port: '8000' },
			{ protocol: 'http', hostname: 'localhost', port: '8000' },

			// Optional: Supabase storage (only when env is present)
			...(supabaseHostname ? [{ protocol: 'https', hostname: supabaseHostname }] : []),

			// Optional: explicit backend host (Fly/production) if provided
			...(backendHostname ? [{ protocol: 'https', hostname: backendHostname }] : []),
		],
	},
}

module.exports = nextConfig
