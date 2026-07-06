import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages（https://<user>.github.io/ofc-solver/）配下で動かすためのベースパス。
  base: '/ofc-solver/',
})
