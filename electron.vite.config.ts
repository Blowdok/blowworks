import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Configuration Electron-Vite : 3 cibles de build (main, preload, renderer).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'src/main'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        // Les modules natifs ne doivent pas être bundlés.
        external: [
          'better-sqlite3',
          '@lydell/node-pty',
          '@lydell/node-pty-win32-x64',
          '@lydell/node-pty-win32-arm64',
          '@lydell/node-pty-darwin-x64',
          '@lydell/node-pty-darwin-arm64',
          '@lydell/node-pty-linux-x64',
          '@lydell/node-pty-linux-arm64'
        ]
      }
    }
  },
  preload: {
    // PAS de externalizeDepsPlugin ici : avec `sandbox: true`, Chromium
    // n'autorise que les modules natifs d'Electron (`electron`, `events`, ...)
    // dans les `require()` du preload. Toute dépendance npm (zod, etc.) doit
    // être INLINÉE dans le bundle pour éviter "module not found".
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        // `electron` reste la seule externe : le runtime l'injecte.
        external: ['electron'],
        output: {
          // CJS obligatoire : ESM refusé par les preloads sandboxés
          // ("Cannot use import statement outside a module").
          format: 'cjs',
          entryFileNames: '[name].js',
          chunkFileNames: '[name].js',
          inlineDynamicImports: true
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    // `@tldraw/assets/imports.vite` utilise ~300 imports `?url` qui cassent le
    // pre-bundling esbuild. On l'exclut pour que Vite passe par sa pipeline
    // d'assets standard (dev + build).
    optimizeDeps: {
      exclude: ['@tldraw/assets', '@tldraw/assets/imports.vite']
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    server: {
      port: 5173
    }
  }
})
