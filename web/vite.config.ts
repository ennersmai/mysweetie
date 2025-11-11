import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import svgr from 'vite-plugin-svgr'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

// Plugin to copy WASM file to public directory so it's accessible at runtime
const copyWasmPlugin = () => {
  return {
    name: 'copy-wasm',
    buildStart() {
      const distPath = join(process.cwd(), 'node_modules/@ennuicastr/webrtcaec3.js/dist')
      const publicPath = join(process.cwd(), 'public')
      
      // Copy WASM file to public/ so it's accessible at /webrtcaec3-0.3.0.wasm
      const wasmSource = join(distPath, 'webrtcaec3-0.3.0.wasm')
      const wasmDest = join(publicPath, 'webrtcaec3-0.3.0.wasm')
      
      if (existsSync(wasmSource)) {
        try {
          copyFileSync(wasmSource, wasmDest)
          console.log('✅ Copied webrtcaec3 WASM file to public/')
        } catch (error) {
          console.warn('⚠️ Failed to copy WASM file:', error)
        }
      } else {
        console.warn('⚠️ WASM file not found at:', wasmSource)
      }
    },
    generateBundle() {
      // Also copy WASM to dist during build so it's available in production
      const distPath = join(process.cwd(), 'node_modules/@ennuicastr/webrtcaec3.js/dist')
      const buildPath = join(process.cwd(), 'dist')
      
      const wasmSource = join(distPath, 'webrtcaec3-0.3.0.wasm')
      const wasmDest = join(buildPath, 'webrtcaec3-0.3.0.wasm')
      
      if (existsSync(wasmSource)) {
        try {
          // Ensure dist directory exists
          if (!existsSync(buildPath)) {
            mkdirSync(buildPath, { recursive: true })
          }
          copyFileSync(wasmSource, wasmDest)
          console.log('✅ Copied webrtcaec3 WASM file to dist/')
        } catch (error) {
          console.warn('⚠️ Failed to copy WASM file to dist:', error)
        }
      }
    }
  }
}


// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), svgr(), copyWasmPlugin()],
  publicDir: 'public',
  optimizeDeps: {
    exclude: ['@ennuicastr/webrtcaec3.js'] // Don't pre-bundle, let it load WASM at runtime
  },
  worker: {
    format: 'es' // Use ES modules for workers/worklets
  },
  assetsInclude: ['**/*.wasm'], // Ensure WASM files are treated as assets
  build: {
    rollupOptions: {
      output: {
        // Let Vite handle all file naming - it will compile .ts to .js automatically
        assetFileNames: (assetInfo) => {
          // Only special handling for WASM files - keep them accessible
          if (assetInfo.name?.endsWith('.wasm')) {
            return 'assets/[name][extname]'
          }
          return 'assets/[name]-[hash][extname]'
        },
        // Ensure worklet files are treated as chunks (modules), not assets
        manualChunks: undefined
      }
    }
  }
})
