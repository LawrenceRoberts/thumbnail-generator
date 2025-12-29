# YouTube Thumbnail Generator - Frontend

A Next.js frontend for the AI-powered YouTube thumbnail generator with real-time ZAR pricing.

## Features

- 🎨 Simple, intuitive interface for generating thumbnails
- 💰 Real-time ZAR pricing table
- 📊 Detailed cost tracking for each generation
- 🖼️ Instant preview of generated thumbnails
- ⚡ Built with Next.js 14, React, and Tailwind CSS

## Getting Started

### Prerequisites

- Node.js 18+ installed
- Backend service running on `http://localhost:8000`

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build for Production

```bash
npm run build
npm start
```

## Configuration

The frontend uses a same-origin API route (`/api/generate`) which proxies to your backend.

- Local dev: set `BACKEND_URL=http://localhost:8000`
- Deploy (Vercel): set `BACKEND_URL=https://<your-backend-host>` (e.g. your Fly app URL)

Avoid pointing the browser at `localhost`/LAN IPs in production, because that will only work on the specific machine running the backend (phones will fail with “Failed to fetch”).

## Tech Stack

- **Next.js 14** - React framework
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **React Hooks** - State management

## Features

### Generate Button
- Input your thumbnail description
- Click "Generate Thumbnail" to create AI-powered thumbnails
- Real-time loading states and error handling

### ZAR Pricing Table
- Displays pricing in both USD and ZAR
- Shows different pricing tiers based on generation steps
- Real-time exchange rate updates

### Cost Tracking
- Shows exact cost per generation
- Displays USD and ZAR amounts
- Includes current exchange rate and timestamp
