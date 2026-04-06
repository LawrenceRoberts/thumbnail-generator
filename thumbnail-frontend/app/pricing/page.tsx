export default function Pricing() {
  return (
    <main className="min-h-screen p-8 bg-gradient-to-b from-gray-900 to-gray-800 text-white">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-4xl font-bold text-center mb-2 bg-gradient-to-r from-red-500 to-pink-500 bg-clip-text text-transparent">
          Pricing & Features
        </h1>
        <p className="text-center text-gray-400 mb-12">
          Transparent pricing with no hidden fees
        </p>

        {/* Feature Comparison */}
        <div className="grid md:grid-cols-2 gap-8 mb-12">
          {/* Free Features */}
          <div className="bg-gray-800 rounded-2xl p-8 shadow-2xl border-2 border-gray-700">
            <div className="text-4xl mb-4">🎁</div>
            <h2 className="text-2xl font-bold mb-4">Free Features</h2>
            <ul className="space-y-3 text-gray-300">
              <li className="flex items-start">
                <span className="text-green-400 mr-3">✓</span>
                <span>Upload your own background images</span>
              </li>
              <li className="flex items-start">
                <span className="text-green-400 mr-3">✓</span>
                <span>Auto background removal from photos</span>
              </li>
              <li className="flex items-start">
                <span className="text-green-400 mr-3">✓</span>
                <span>Professional text overlays</span>
              </li>
              <li className="flex items-start">
                <span className="text-green-400 mr-3">✓</span>
                <span>High-quality image enhancements</span>
              </li>
              <li className="flex items-start">
                <span className="text-green-400 mr-3">✓</span>
                <span>Smart text sizing and positioning</span>
              </li>
              <li className="flex items-start">
                <span className="text-green-400 mr-3">✓</span>
                <span>1280x720 HD resolution</span>
              </li>
            </ul>
            <div className="mt-6 pt-6 border-t border-gray-700">
              <p className="text-3xl font-bold text-green-400">R0.00</p>
              <p className="text-gray-400 text-sm">When using your own backgrounds</p>
            </div>
          </div>

          {/* AI Generation */}
          <div className="bg-gradient-to-br from-red-900/30 to-pink-900/30 rounded-2xl p-8 shadow-2xl border-2 border-red-500/50">
            <div className="text-4xl mb-4">🤖</div>
            <h2 className="text-2xl font-bold mb-4">AI Background Generation</h2>
            <ul className="space-y-3 text-gray-300">
              <li className="flex items-start">
                <span className="text-red-400 mr-3">✓</span>
                <span>Everything from Free Features</span>
              </li>
              <li className="flex items-start">
                <span className="text-red-400 mr-3">+</span>
                <span>AI-generated backgrounds from text prompts</span>
              </li>
              <li className="flex items-start">
                <span className="text-red-400 mr-3">+</span>
                <span>Powered by Stability AI SDXL</span>
              </li>
              <li className="flex items-start">
                <span className="text-red-400 mr-3">+</span>
                <span>Professional scene composition</span>
              </li>
              <li className="flex items-start">
                <span className="text-red-400 mr-3">+</span>
                <span>Dramatic lighting & effects</span>
              </li>
              <li className="flex items-start">
                <span className="text-red-400 mr-3">+</span>
                <span>Unlimited creative possibilities</span>
              </li>
            </ul>
            <div className="mt-6 pt-6 border-t border-red-500/30">
              <p className="text-3xl font-bold text-red-400">~R0.74</p>
              <p className="text-gray-400 text-sm">Per AI-generated background</p>
            </div>
          </div>
        </div>

        {/* Detailed Pricing Table */}
        <div className="bg-gray-800 rounded-2xl p-8 shadow-2xl">
          <h2 className="text-2xl font-bold mb-6 text-center">💰 AI Generation Pricing</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="pb-4 font-semibold text-gray-300">Quality Level</th>
                  <th className="pb-4 font-semibold text-gray-300">Steps</th>
                  <th className="pb-4 font-semibold text-gray-300">USD</th>
                  <th className="pb-4 font-semibold text-gray-300">ZAR (approx)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                <tr className="hover:bg-gray-750 transition-colors">
                  <td className="py-4 text-gray-200">Standard Quality</td>
                  <td className="py-4 text-gray-200">40 steps</td>
                  <td className="py-4 text-green-400 font-semibold">$0.04</td>
                  <td className="py-4 text-green-400 font-semibold">R0.74</td>
                </tr>
                <tr className="hover:bg-gray-750 transition-colors">
                  <td className="py-4 text-gray-200">High Quality</td>
                  <td className="py-4 text-gray-200">50 steps</td>
                  <td className="py-4 text-yellow-400 font-semibold">$0.05</td>
                  <td className="py-4 text-yellow-400 font-semibold">R0.93</td>
                </tr>
                <tr className="hover:bg-gray-750 transition-colors">
                  <td className="py-4 text-gray-200">Premium Quality</td>
                  <td className="py-4 text-gray-200">60 steps</td>
                  <td className="py-4 text-orange-400 font-semibold">$0.06</td>
                  <td className="py-4 text-orange-400 font-semibold">R1.11</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-sm text-gray-400 text-center">
            * Prices based on Stability AI SDXL. Exchange rate updated in real-time.
            <br />
            All resolutions: 1280x720 (16:9 YouTube standard)
          </p>
        </div>

        {/* Tips Section */}
        <div className="mt-8 bg-blue-900/20 border border-blue-500/30 rounded-2xl p-6">
          <h3 className="text-xl font-bold mb-3 text-blue-300">💡 Pro Tips</h3>
          <ul className="space-y-2 text-gray-300">
            <li>• Use your own backgrounds to avoid AI generation costs</li>
            <li>• Upload high-quality photos for best results</li>
            <li>• Text overlays and image composition are always free</li>
            <li>• Each AI generation creates a unique, professional background</li>
          </ul>
        </div>

        {/* CTA */}
        <div className="mt-12 text-center">
          <a
            href="/"
            className="inline-block bg-gradient-to-r from-red-500 to-pink-500 hover:from-red-600 hover:to-pink-600 text-white font-bold py-4 px-8 rounded-lg text-lg transition-all transform hover:scale-105 shadow-lg"
          >
            Start Creating Thumbnails
          </a>
        </div>
      </div>
    </main>
  )
}
