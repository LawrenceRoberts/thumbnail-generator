# YouTube Thumbnail Generator

AI-powered YouTube thumbnail generator with CTR optimization, built with FastAPI backend and Next.js frontend.

## 🚀 Features

- **AI-Powered Generation**: Uses Stability AI SDXL for professional-quality thumbnails
- **CTR Optimization**: Built-in design rules (Rule of Thirds, high contrast, complementary colors)
- **16:9 Aspect Ratio**: Perfect 1280x720 resolution for YouTube
- **Negative Prompts**: Excludes unwanted elements (blurry faces, low resolution, messy text)
- **ZAR Cost Tracking**: Real-time currency conversion and cost tracking
- **Modern UI**: Beautiful Next.js frontend with Tailwind CSS

## 📁 Project Structure

```
thumbnail-generator/
├── thumbnail_service.py     # Core AI service with generation logic
├── main.py                  # FastAPI backend server
├── requirements.txt         # Python dependencies
├── .env.example            # Environment variables template
└── thumbnail-frontend/     # Next.js frontend
    ├── app/
    │   ├── page.tsx        # Main UI component
    │   ├── layout.tsx      # App layout
    │   └── globals.css     # Global styles
    └── package.json        # Node.js dependencies
```

## 🛠️ Backend Setup (Python/FastAPI)

### Prerequisites

- Python 3.9+
- Stability AI API key ([Get one here](https://platform.stability.ai/))
- Gemini API key (for thumbnail audits)

### Installation

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Create `.env` file:
```bash
cp .env.example .env
```

3. Add your Stability AI API key to `.env`:
```
STABILITY_API_KEY=sk-your-actual-key-here
```

4. (Optional) Enable Gemini thumbnail audits:
```
GEMINI_API_KEY=your-key-here
# Optional model override:
GEMINI_MODEL_NAME=models/gemini-flash-latest
```

If Gemini requests fail with HTTP 429 and the error indicates quota limits of `0`, you'll need to enable billing / increase quota for the Gemini API in Google AI Studio.

### Run the Backend

```bash
python main.py
```

The API will be available at `http://localhost:8000`

### API Endpoints

- `GET /` - Health check
- `POST /api/generate` - Generate thumbnail
- `GET /api/pricing` - Get current pricing in USD/ZAR
- `GET /docs` - Interactive API documentation

## 🎨 Frontend Setup (Next.js)

### Prerequisites

- Node.js 18+

### Installation

```bash
cd thumbnail-frontend
npm install
```

### Run the Frontend

```bash
npm run dev
```

The app will be available at `http://localhost:3000`

## 💰 Pricing

Based on Stability AI SDXL pricing:

| Steps | USD  | ZAR (approx) |
|-------|------|--------------|
| 40    | $0.04| R0.74        |
| 50    | $0.05| R0.93        |
| 60    | $0.06| R1.11        |

*Exchange rates updated in real-time*

## 🎯 Usage

1. Start the backend server (`python main.py`)
2. Start the frontend (`npm run dev` in thumbnail-frontend/)
3. Open `http://localhost:3000` in your browser
4. Enter a prompt (e.g., "shocked gamer reacting to epic win")
5. Click "Generate Thumbnail"
6. Download your AI-generated thumbnail!

## 🔧 Configuration

### Backend Configuration

Edit `thumbnail_service.py` to customize:
- System design rules
- Negative prompts
- Default generation parameters
- Color schemes and composition rules

### Frontend Configuration

Edit `app/page.tsx` to customize:
- API URL
- UI colors and styling
- Pricing table tiers

## 📝 Environment Variables

### Backend (.env)
```
STABILITY_API_KEY=your_api_key
STABILITY_HOST=grpc.stability.ai:443
```

### Frontend (.env.local)
```
# Recommended: use the Next.js API proxy route (/api/generate) and configure
# the backend URL server-side so it works on any device (desktop/mobile).
BACKEND_URL=http://localhost:8000

# (Optional, dev-only) If you really want the browser to call the backend directly:
# NEXT_PUBLIC_API_URL=http://localhost:8000
```

## 🚦 Development

### Backend Development
```bash
# Run with auto-reload
python main.py

# Or use uvicorn directly
uvicorn main:app --reload --port 8000
```

### Frontend Development
```bash
cd thumbnail-frontend
npm run dev
```

## 📦 Production Build

### Backend
```bash
# Install dependencies
pip install -r requirements.txt

# Run with production settings
uvicorn main:app --host 0.0.0.0 --port 8000
```

### Frontend
```bash
cd thumbnail-frontend
npm run build
npm start
```

## 🎨 Design Principles

The AI service follows professional YouTube thumbnail best practices:
- ✅ 16:9 aspect ratio (1280x720)
- ✅ Rule of Thirds composition
- ✅ High contrast rim lighting
- ✅ Complementary color schemes
- ✅ Gaussian blur on background
- ✅ Exaggerated facial expressions
- ❌ No multiple heads or blurry faces
- ❌ No low resolution or messy text
- ❌ No dark/muddy colors

## 🔒 Security

- CORS configured for localhost development
- API key stored in environment variables
- No sensitive data in frontend

## 📄 License

MIT

## 🤝 Contributing

Contributions welcome! Please feel free to submit a Pull Request.
