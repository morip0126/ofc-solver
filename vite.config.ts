import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // オフライン起動用の Service Worker。manifest は public/manifest.webmanifest を使う。
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false,
      includeAssets: ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      },
    }),
  ],
  // GitHub Pages（https://<user>.github.io/ofc-solver/）配下で動かすためのベースパス。
  base: '/ofc-solver/',
})
