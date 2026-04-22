import { useCallback, useRef } from 'react'
import type { Editor } from 'tldraw'

// Persistance du snapshot tldraw vers SQLite côté main, débouncée à 500 ms.
const DEBOUNCE_MS = 500

export function useCanvasPersistence(): {
  loadInitial: (editor: Editor) => Promise<void>
  scheduleSave: (editor: Editor) => void
} {
  const timer = useRef<number | null>(null)

  const loadInitial = useCallback(async (editor: Editor): Promise<void> => {
    try {
      const json = await window.blow.canvas.loadSnapshot()
      if (!json) return
      const snapshot = JSON.parse(json) as Parameters<Editor['loadSnapshot']>[0]
      editor.loadSnapshot(snapshot)
    } catch (err) {
      console.error('[canvas] chargement snapshot échoué', err)
    }
  }, [])

  const scheduleSave = useCallback((editor: Editor): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      try {
        const snapshot = editor.getSnapshot()
        void window.blow.canvas.saveSnapshot(JSON.stringify(snapshot))
      } catch (err) {
        console.error('[canvas] sauvegarde snapshot échouée', err)
      }
    }, DEBOUNCE_MS)
  }, [])

  return { loadInitial, scheduleSave }
}
