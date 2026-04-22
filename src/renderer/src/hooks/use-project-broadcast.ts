import { useCallback } from 'react'
import type { TLShape } from 'tldraw'
import { useEditorStore } from '../stores/editor-store.js'

// Broadcast d'une commande à tous les terminaux d'un projet.
export function useProjectBroadcast(): (projectId: string, command: string) => Promise<void> {
  const editor = useEditorStore((s) => s.editor)

  return useCallback(
    async (projectId: string, command: string) => {
      if (!editor) return
      // Cast : les shapes custom (terminal) ne font pas partie de l'union TLShape par défaut.
      const shapes = (editor.getCurrentPageShapes() as TLShape[]).filter((s) => {
        if ((s as { type: string }).type !== 'terminal') return false
        const props = s.props as { projectId?: string | null }
        return props.projectId === projectId
      })
      const cmd = command.endsWith('\n') ? command : `${command}\n`
      await Promise.all(shapes.map((s) => window.blow.terminal.write(s.id, cmd)))
    },
    [editor]
  )
}
