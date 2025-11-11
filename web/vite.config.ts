import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import svgr from 'vite-plugin-svgr'
import { copyFileSync, existsSync } from 'fs'
import { join } from 'path'

// Plugin to copy WASM and JS files from @ennuicastr/webrtcaec3.js to public directory
const copyWasmPlugin = () => {
  return {
    name: 'copy-wasm',
    buildStart() {
      const distPath = join(process.cwd(), 'node_modules/@ennuicastr/webrtcaec3.js/dist')
      const publicPath = join(process.cwd(), 'public')
      
      // Copy WASM file
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
      
      // Copy main JS file (contains WebRtcAec3 export)
      const jsSource = join(distPath, 'webrtcaec3-0.3.0.js')
      const jsDest = join(publicPath, 'webrtcaec3-0.3.0.js')
      
      if (existsSync(jsSource)) {
        try {
          copyFileSync(jsSource, jsDest)
          console.log('✅ Copied webrtcaec3 JS file to public/')
        } catch (error) {
          console.warn('⚠️ Failed to copy JS file:', error)
        }
      } else {
        console.warn('⚠️ JS file not found at:', jsSource)
      }
    }
  }
}


// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), svgr(), copyWasmPlugin()],
  publicDir: 'public',
  build: {
    rollupOptions: {
      output: {
        // Let Vite handle all file naming - it will compile .ts to .js automatically
        assetFileNames: (assetInfo) => {
          // Only special handling for WASM files
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
