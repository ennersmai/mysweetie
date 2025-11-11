import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import svgr from 'vite-plugin-svgr'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
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
      
      // Copy and patch the library's JS file to public/
      // Patch: Add 'var WebRtcAec3Wasm;' declaration to make it module-safe
      const jsSource = join(distPath, 'webrtcaec3-0.3.0.js')
      const jsDest = join(publicPath, 'webrtcaec3-0.3.0.js')
      
      if (existsSync(jsSource)) {
        try {
          // Read the original file
          let jsContent = readFileSync(jsSource, 'utf-8')
          
          // Patch: Add WebRtcAec3Wasm declaration at the top if not already present
          // This prevents "assignment to undeclared variable" errors in module context
          if (!jsContent.includes('var WebRtcAec3Wasm') && !jsContent.includes('let WebRtcAec3Wasm') && !jsContent.includes('const WebRtcAec3Wasm')) {
            jsContent = 'var WebRtcAec3Wasm;\n' + jsContent
            console.log('✅ Patched webrtcaec3 JS file (added WebRtcAec3Wasm declaration)')
          }
          
          // Write the patched file
          writeFileSync(jsDest, jsContent, 'utf-8')
          console.log('✅ Copied and patched webrtcaec3 JS file to public/')
        } catch (error) {
          console.warn('⚠️ Failed to copy/patch JS file:', error)
        }
      } else {
        console.warn('⚠️ JS file not found at:', jsSource)
      }
    },
    generateBundle() {
      // Also copy WASM and JS to dist during build so it's available in production
      const distPath = join(process.cwd(), 'node_modules/@ennuicastr/webrtcaec3.js/dist')
      const buildPath = join(process.cwd(), 'dist')
      
      if (!existsSync(buildPath)) {
        mkdirSync(buildPath, { recursive: true })
      }
      
      // Copy WASM file
      const wasmSource = join(distPath, 'webrtcaec3-0.3.0.wasm')
      const wasmDest = join(buildPath, 'webrtcaec3-0.3.0.wasm')
      
      if (existsSync(wasmSource)) {
        try {
          copyFileSync(wasmSource, wasmDest)
          console.log('✅ Copied webrtcaec3 WASM file to dist/')
        } catch (error) {
          console.warn('⚠️ Failed to copy WASM file to dist:', error)
        }
      }
      
      // Copy and patch JS file
      const jsSource = join(distPath, 'webrtcaec3-0.3.0.js')
      const jsDest = join(buildPath, 'webrtcaec3-0.3.0.js')
      
      if (existsSync(jsSource)) {
        try {
          // Read the original file
          let jsContent = readFileSync(jsSource, 'utf-8')
          
          // Patch: Add WebRtcAec3Wasm declaration at the top if not already present
          if (!jsContent.includes('var WebRtcAec3Wasm') && !jsContent.includes('let WebRtcAec3Wasm') && !jsContent.includes('const WebRtcAec3Wasm')) {
            jsContent = 'var WebRtcAec3Wasm;\n' + jsContent
            console.log('✅ Patched webrtcaec3 JS file (added WebRtcAec3Wasm declaration)')
          }
          
          // Write the patched file
          writeFileSync(jsDest, jsContent, 'utf-8')
          console.log('✅ Copied and patched webrtcaec3 JS file to dist/')
        } catch (error) {
          console.warn('⚠️ Failed to copy/patch JS file to dist:', error)
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
          // Ensure worklet files are NOT treated as assets - they should be chunks
          if (assetInfo.name?.includes('aec-processor') || assetInfo.name?.includes('processor')) {
            // This shouldn't happen, but if it does, we want to know
            console.warn('⚠️ Worklet file being treated as asset:', assetInfo.name)
          }
          return 'assets/[name]-[hash][extname]'
        },
        // Ensure worklet files are treated as chunks (modules), not assets
        manualChunks: undefined,
        // Ensure worklet chunks are output with .js extension
        chunkFileNames: 'assets/[name]-[hash].js'
      }
    }
  }
})
