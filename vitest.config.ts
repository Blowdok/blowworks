import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Configuration Vitest pour les tests unitaires (sans Electron).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    globals: false
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  }
})
