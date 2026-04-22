import { create } from 'zustand'
import type { Project } from '@shared/ipc-contract.js'

// Store Zustand : cache de la liste des projets (source de vérité = SQLite côté main).
interface ProjectState {
  projects: Project[]
  load: () => Promise<void>
  create: (input: { name: string; color?: string }) => Promise<Project>
  update: (input: { id: string; name?: string; color?: string }) => Promise<void>
  delete: (id: string) => Promise<void>
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],

  load: async () => {
    try {
      const projects = (await window.blow.project.list()) as Project[]
      set({ projects })
    } catch (err) {
      console.error('[project-store] load échoué', err)
      throw err
    }
  },

  create: async (input) => {
    try {
      const created = (await window.blow.project.create(input)) as Project
      set({ projects: [created, ...get().projects] })
      return created
    } catch (err) {
      console.error('[project-store] create échoué', err, 'input=', input)
      throw err
    }
  },

  update: async (input) => {
    const updated = (await window.blow.project.update(input)) as Project | null
    if (!updated) return
    set({ projects: get().projects.map((p) => (p.id === updated.id ? updated : p)) })
  },

  delete: async (id) => {
    const ok = (await window.blow.project.delete(id)) as boolean
    if (!ok) return
    set({ projects: get().projects.filter((p) => p.id !== id) })
  }
}))
