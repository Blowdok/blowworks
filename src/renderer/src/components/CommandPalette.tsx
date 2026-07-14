import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppChromeStore } from '../stores/app-chrome-store.js'
import { useEditorStore } from '../stores/editor-store.js'
import { useProjectStore } from '../stores/project-store.js'
import { useUIStore } from '../stores/ui-store.js'
import { useWikiStore } from '../stores/wiki-store.js'
import { slideToProject } from '../lib/project-layout.js'
import {
  spawnBrowserShape,
  spawnChatShape,
  spawnExplorerShape,
  spawnNotepadShape,
  spawnTerminalShape,
  spawnVSCodeShape
} from './canvas/InfiniteCanvas.js'

// Palette de commandes globale (Ctrl+Shift+P). Centralise création de
// shapes, navigation projet, toggles UI et accès aux réglages.

interface CommandItem {
  id: string
  label: string
  group: string
  shortcut?: string
  keywords?: string
  disabled?: boolean
  run: () => void | Promise<void>
}

function matchesQuery(cmd: CommandItem, q: string): boolean {
  if (!q) return true
  const hay = `${cmd.label} ${cmd.group} ${cmd.keywords ?? ''}`.toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => hay.includes(token))
}

function recenterCanvasCamera(): void {
  const editor = useEditorStore.getState().editor
  if (!editor) return
  const vb = editor.getViewportScreenBounds()
  editor.setCamera(
    { x: vb.w / 2, y: vb.h / 2, z: 1 },
    { animation: { duration: 320 } }
  )
}

export default function CommandPalette(): React.ReactElement | null {
  const open = useAppChromeStore((s) => s.commandPaletteOpen)
  const close = useAppChromeStore((s) => s.closeCommandPalette)
  const openSettings = useAppChromeStore((s) => s.openSettings)
  const editor = useEditorStore((s) => s.editor)
  const projects = useProjectStore((s) => s.projects)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const toggleStylePanel = useUIStore((s) => s.toggleStylePanel)
  const toggleToolbar = useUIStore((s) => s.toggleToolbar)
  const wikiStatus = useWikiStore((s) => s.status)
  const runWikiBuilder = useWikiStore((s) => s.runWikiBuilder)
  const setGraphOpen = useWikiStore((s) => s.setGraphOpen)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo((): CommandItem[] => {
    const wikiReady =
      wikiStatus.folderPath != null && wikiStatus.initialized
    const list: CommandItem[] = [
      {
        id: 'new-terminal',
        label: 'Nouveau terminal',
        group: 'Créer',
        shortcut: 'Ctrl+T',
        keywords: 'shell console pwsh powershell',
        disabled: !editor,
        run: () => {
          if (editor) spawnTerminalShape(editor)
        }
      },
      {
        id: 'new-chat',
        label: 'Nouvelle conversation IA',
        group: 'Créer',
        shortcut: 'Ctrl+K',
        keywords: 'chat openrouter ia llm',
        disabled: !editor,
        run: async () => {
          if (editor) await spawnChatShape(editor)
        }
      },
      {
        id: 'new-browser',
        label: 'Nouveau navigateur',
        group: 'Créer',
        shortcut: 'Ctrl+B',
        keywords: 'web internet url',
        disabled: !editor,
        run: () => {
          if (editor) spawnBrowserShape(editor)
        }
      },
      {
        id: 'new-vscode',
        label: 'Nouveau VSCode (choisir un dossier)',
        group: 'Créer',
        keywords: 'ide code éditeur',
        disabled: !editor,
        run: async () => {
          if (!editor) return
          const folder = await window.blow.dialog.pickFolder({
            title: 'Sélectionner un dossier à ouvrir dans VSCode'
          })
          if (folder) spawnVSCodeShape(editor, folder)
        }
      },
      {
        id: 'new-notepad',
        label: 'Nouveau bloc-notes',
        group: 'Créer',
        keywords: 'note texte mémo',
        disabled: !editor,
        run: () => {
          if (editor) spawnNotepadShape(editor)
        }
      },
      {
        id: 'new-explorer',
        label: 'Nouvel explorateur de fichiers',
        group: 'Créer',
        keywords: 'fichiers dossier explorer',
        disabled: !editor,
        run: () => {
          if (editor) spawnExplorerShape(editor)
        }
      },
      {
        id: 'toggle-sidebar',
        label: 'Afficher / masquer la barre latérale',
        group: 'Interface',
        keywords: 'sidebar panneau gauche',
        run: () => toggleSidebar()
      },
      {
        id: 'toggle-style-panel',
        label: 'Afficher / masquer le panneau de styles',
        group: 'Interface',
        keywords: 'styles tldraw dessin',
        run: () => toggleStylePanel()
      },
      {
        id: 'toggle-toolbar',
        label: 'Afficher / masquer la barre d\'outils du canvas',
        group: 'Interface',
        shortcut: 'Alt+T',
        keywords: 'toolbar outils main select',
        run: () => toggleToolbar()
      },
      {
        id: 'recenter-camera',
        label: 'Recentrer la caméra sur l\'origine',
        group: 'Navigation',
        keywords: 'zoom centre origine home',
        disabled: !editor,
        run: () => recenterCanvasCamera()
      },
      {
        id: 'open-settings',
        label: 'Ouvrir les paramètres',
        group: 'Application',
        keywords: 'réglages configuration api',
        run: () => openSettings()
      },
      {
        id: 'open-settings-terminal',
        label: 'Paramètres · Dossier terminal par défaut',
        group: 'Application',
        keywords: 'cwd répertoire bureau',
        run: () => openSettings('terminal')
      }
    ]

    for (const p of projects) {
      list.push({
        id: `project-${p.id}`,
        label: `Aller au projet « ${p.name} »`,
        group: 'Projets',
        keywords: p.name,
        disabled: !editor,
        run: () => {
          if (editor) slideToProject(editor, projects, p.id)
        }
      })
    }

    if (wikiReady) {
      list.push(
        {
          id: 'wiki-build',
          label: 'Mémoire · Reconstruire le wiki',
          group: 'Mémoire',
          keywords: 'wiki builder compiler',
          disabled: wikiStatus.rawCount === 0,
          run: async () => {
            await runWikiBuilder()
          }
        },
        {
          id: 'wiki-graph',
          label: 'Mémoire · Ouvrir le graphe du wiki',
          group: 'Mémoire',
          keywords: 'graph liens wikilinks',
          run: () => setGraphOpen(true)
        },
        {
          id: 'open-settings-wiki',
          label: 'Paramètres · Mémoire wiki',
          group: 'Mémoire',
          keywords: 'dossier wiki configuration',
          run: () => openSettings('wiki')
        }
      )
    }

    return list
  }, [
    editor,
    projects,
    toggleSidebar,
    toggleStylePanel,
    toggleToolbar,
    openSettings,
    wikiStatus,
    runWikiBuilder,
    setGraphOpen
  ])

  const filtered = useMemo(
    () => commands.filter((c) => matchesQuery(c, query.trim())),
    [commands, query]
  )

  const runCommand = useCallback(
    async (cmd: CommandItem): Promise<void> => {
      if (cmd.disabled) return
      close()
      await cmd.run()
    },
    [close]
  )

  // Raccourci global Ctrl+Shift+P
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        useAppChromeStore.getState().toggleCommandPalette()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Reset + focus à l'ouverture
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.clearTimeout(t)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // Navigation clavier dans la liste
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' && filtered.length > 0) {
        e.preventDefault()
        const cmd = filtered[activeIndex]
        if (cmd) void runCommand(cmd)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, close, filtered, activeIndex, runCommand])

  // Scroll l'item actif dans la vue
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector(`[data-cmd-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  if (!open) return null

  // Regroupe visuellement par `group`
  let lastGroup = ''

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center bg-black/50 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Palette de commandes"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-[var(--radius-md)] border shadow-2xl"
        style={{
          borderColor: 'var(--border)',
          background: 'var(--bg-secondary)'
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Tapez une commande…"
          className="border-b bg-transparent px-4 py-3 text-[14px] text-[var(--fg-primary)] placeholder:text-[var(--fg-muted)] outline-none"
          style={{ borderColor: 'var(--border)' }}
          autoComplete="off"
          spellCheck={false}
        />
        <div
          ref={listRef}
          className="max-h-[min(360px,50vh)] overflow-y-auto py-1"
          role="listbox"
        >
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px] text-[var(--fg-muted)]">
              Aucune commande trouvée
            </p>
          ) : (
            filtered.map((cmd, index) => {
              const showGroup = cmd.group !== lastGroup
              lastGroup = cmd.group
              return (
                <div key={cmd.id}>
                  {showGroup && (
                    <div className="px-4 pb-1 pt-2 text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
                      {cmd.group}
                    </div>
                  )}
                  <button
                    type="button"
                    data-cmd-index={index}
                    role="option"
                    aria-selected={index === activeIndex}
                    disabled={cmd.disabled}
                    onClick={() => void runCommand(cmd)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                    style={{
                      background:
                        index === activeIndex ? 'var(--bg-tertiary)' : 'transparent',
                      color: 'var(--fg-primary)'
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <span>{cmd.label}</span>
                    {cmd.shortcut && (
                      <kbd className="shrink-0 font-mono text-[10px] text-[var(--fg-muted)]">
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </button>
                </div>
              )
            })
          )}
        </div>
        <div
          className="flex items-center justify-between border-t px-4 py-2 text-[10px] text-[var(--fg-muted)]"
          style={{ borderColor: 'var(--border)' }}
        >
          <span>↑↓ naviguer · Entrée exécuter · Échap fermer</span>
          <span>Ctrl+Shift+P</span>
        </div>
      </div>
    </div>,
    document.body
  )
}
