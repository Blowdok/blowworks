import { create } from 'zustand'
import type { Editor } from 'tldraw'

// Référence globale à l'instance tldraw Editor, exposée pour permettre au
// Sidebar et aux composants hors canvas de zoomer/cibler des shapes.
interface EditorState {
  editor: Editor | null
  setEditor: (editor: Editor | null) => void
}

export const useEditorStore = create<EditorState>((set) => ({
  editor: null,
  setEditor: (editor) => set({ editor })
}))
