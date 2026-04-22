import type { BlowApi } from './index.js'

declare global {
  interface Window {
    blow: BlowApi
  }
}

export {}
