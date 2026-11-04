import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { fileURLToPath, URL } from 'node:url'

// Build output: the helpinator LAYER's own public/js/ folder. Nuxt serves every
// extended layer's public/ at the site root, so this committed bundle is served
// at /js/helpinator-widget.iife.js by any host that loads the layer — no
// host-side build step. Rebuild with `bun run build:widgets` from the layer
// root whenever the widget source changes, and commit the result.
const PUBLIC_JS_DIR = fileURLToPath(new URL('../../public/js', import.meta.url))

export default defineConfig({
  plugins: [
    // customElement: SFC <style> blocks are inlined into each element's Shadow
    // DOM, isolated from the host page's CSS.
    vue({ customElement: true })
  ],

  define: {
    'process.env': {},
    'process.env.NODE_ENV': JSON.stringify('production')
  },

  build: {
    outDir: PUBLIC_JS_DIR,
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/entry.js'),
      name: 'HelpinatorWidget',
      fileName: () => 'helpinator-widget.iife.js',
      formats: ['iife']
    },
    rollupOptions: {
      output: { inlineDynamicImports: true }
    },
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      compress: { drop_console: false, drop_debugger: true }
    }
  }
})
