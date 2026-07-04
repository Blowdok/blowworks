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
      // 0 = ne jamais inliner les assets en `data:` base64. En prod Electron
      // (file://), les icônes tldraw inlinées en `data:image/svg+xml` échouent
      // au décodage (`EncodingError`) et via la CSP `connect-src`. En les
      // gardant comme fichiers .svg servis localement, elles se chargent comme
      // en dev.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    server: {
      // `host: '127.0.0.1'` (et pas `localhost`) : sur Windows, `localhost`
      // peut résoudre vers `::1` (IPv6 loopback) tandis que le bind par
      // défaut de Vite v7 reste IPv4 → ERR_CONNECTION_REFUSED côté Electron
      // qui tente de se connecter via le nom. En forçant l'écoute sur
      // 127.0.0.1, on garantit l'alignement IPv4 partout (electron-vite
      // génère alors `ELECTRON_RENDERER_URL=http://localhost:5173/` mais
      // la résolution DNS tombera sur 127.0.0.1, qui est servi).
      host: '127.0.0.1',
      port: 5173,
      // `strictPort: true` : si 5173 est déjà occupé, on échoue brutalement
      // au lieu de glisser silencieusement sur 5174 (auquel cas
      // ELECTRON_RENDERER_URL pointerait sur le mauvais port).
      strictPort: true
    }
  }
})
