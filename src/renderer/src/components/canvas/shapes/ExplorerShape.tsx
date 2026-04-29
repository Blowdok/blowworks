import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  createShapeId,
  createShapePropsMigrationSequence,
  type TLBaseShape,
  type RecordProps
} from 'tldraw'
import type { VSCodeShape } from './VSCodeShape.js'
import type { NotepadShape } from './NotepadShape.js'

// Extensions reconnues comme « texte » → double-clic ouvre dans une
// NotepadShape BlowWorks au lieu de l'application système. La liste est
// volontairement conservative : on tape les formats classiques que
// l'utilisateur veut éditer rapidement, pas les binaires/archives.
const TEXT_FILE_EXTS = new Set([
  'txt',
  'md',
  'log',
  'json',
  'csv',
  'yml',
  'yaml',
  'ini',
  'toml',
  'xml',
  'env',
  'conf',
  'cfg',
  'gitignore',
  'gitattributes',
  'editorconfig'
])

// Shape Explorer (option 2) : explorateur de fichiers Windows recréé en
// React/HTML, vraie shape tldraw qui suit zoom/pan. Pas de fenêtre native
// embarquée, pas de limites HWND/DirectComposition — tout est du DOM.
//
// Navigation persistée dans `props.currentPath` + `props.historyJson` :
// l'historique survit aux switch de pages tldraw et au redémarrage de
// l'app (via le système de persistance du canvas).

// Constante magique pour la racine virtuelle "Ce PC" — le service main
// retourne la liste des disques quand il reçoit cette valeur. On évite
// la chaîne vide qui serait ambiguë avec un état "non initialisé".
const ROOT_PATH = 'ThisPC'

// Hauteur du header tldraw-friendly : zone où `pointer-events: none`
// laisse passer le drag tldraw. Tous les contrôles interactifs (boutons,
// path bar) sont en `pointer-events: auto` explicite — le fond du header
// reste transparent au pointeur pour autoriser le drag de la shape.
const HEADER_HEIGHT = 64

// ── Types ─────────────────────────────────────────────────────────────

type ExplorerShapeProps = {
  w: number
  h: number
  // Chemin absolu courant, ou ROOT_PATH ('ThisPC') pour la vue racine.
  currentPath: string
  // Historique sérialisé `{ paths: string[]; index: number }`. JSON
  // car les arrays/objets ne sont pas natifs dans le système de props
  // tldraw (RecordProps ne supporte que primitifs + structures simples
  // déclarées via T.*).
  historyJson: string
}

export type ExplorerShape = TLBaseShape<'explorer', ExplorerShapeProps>

declare module 'tldraw' {
  interface TLGlobalShapePropsMap {
    explorer: ExplorerShapeProps
  }
}

// État de l'historique de navigation (back/forward).
interface NavHistory {
  paths: string[]
  index: number
}

interface FsEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number
  ext: string
  hidden: boolean
}

interface QuickAccessItem {
  id: string
  label: string
  path: string | null
  icon: string
}

// ── ShapeUtil ─────────────────────────────────────────────────────────

export class ExplorerShapeUtil extends BaseBoxShapeUtil<ExplorerShape> {
  static override type = 'explorer' as const
  static override props: RecordProps<ExplorerShape> = {
    w: T.number,
    h: T.number,
    currentPath: T.string,
    historyJson: T.string
  }

  // Migration : les anciennes ExplorerShape (option 1 du PoC, abandonnée)
  // n'avaient que `w` et `h` — sans `currentPath` ni `historyJson`. Au
  // chargement du canvas persisté, tldraw exécute cette migration AVANT
  // de valider les records → on remplit les props manquants avec les
  // défauts. Sans ça, ValidationError crash le canvas au reload.
  static override migrations = createShapePropsMigrationSequence({
    sequence: [
      {
        id: 'com.tldraw.shape.explorer/1',
        up(props) {
          const p = props as Record<string, unknown>
          if (typeof p.currentPath !== 'string') p.currentPath = ROOT_PATH
          if (typeof p.historyJson !== 'string') {
            p.historyJson = JSON.stringify({ paths: [ROOT_PATH], index: 0 })
          }
        }
      }
    ]
  })

  override getDefaultProps(): ExplorerShape['props'] {
    return {
      w: 920,
      h: 580,
      currentPath: ROOT_PATH,
      historyJson: JSON.stringify({ paths: [ROOT_PATH], index: 0 } satisfies NavHistory)
    }
  }

  override canEdit = (): boolean => true
  override canResize = (): boolean => true

  override onResize(
    shape: ExplorerShape,
    info: { scaleX: number; scaleY: number }
  ): { props: { w: number; h: number } } {
    return {
      props: {
        w: Math.max(420, shape.props.w * info.scaleX),
        h: Math.max(280, shape.props.h * info.scaleY)
      }
    }
  }

  override component(shape: ExplorerShape) {
    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          // Root pointer-events: none → drag tldraw passe à travers le
          // chrome de la shape. Les zones interactives (boutons, liste,
          // sidebar) surchargent en `auto` ci-dessous.
          pointerEvents: 'none'
        }}
      >
        <ExplorerView shape={shape} />
      </HTMLContainer>
    )
  }

  override indicator(shape: ExplorerShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />
  }
}

// ── Vue principale ────────────────────────────────────────────────────

const ExplorerView = memo(
  function ExplorerViewImpl({ shape }: { shape: ExplorerShape }) {
    const editor = useEditor()
    const [entries, setEntries] = useState<FsEntry[]>([])
    const [quickAccess, setQuickAccess] = useState<QuickAccessItem[]>([])
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    // path en cours de renommage (mode inline). null = aucun.
    const [renaming, setRenaming] = useState<string | null>(null)
    // Menu contextuel : coords écran + entrée ciblée (null = clic dans
    // zone vide → menu "fond" : Coller (v2), Actualiser, Ouvrir natif).
    const [contextMenu, setContextMenu] = useState<{
      x: number
      y: number
      target: FsEntry | null
    } | null>(null)
    // Path bar : null = mode breadcrumb. string = mode saisie (Ctrl+L
    // ou clic dans l'input).
    const [pathInputValue, setPathInputValue] = useState<string | null>(null)
    // Anchor pour Maj+clic (range select). Pas dans la sélection elle-
    // même — c'est l'index de l'entrée pivot.
    const [anchorIndex, setAnchorIndex] = useState<number | null>(null)
    const listScrollRef = useRef<HTMLDivElement>(null)

    // Quick Access chargé une fois au mount — la liste est statique
    // (Bureau, Documents, Ce PC, …) donc pas besoin de re-fetch.
    useEffect(() => {
      void window.blow.fs.quickAccess().then(setQuickAccess)
    }, [])

    // Recharge les entrées quand le path change. Reset sélection +
    // renaming + contextMenu pour partir d'un état propre.
    useEffect(() => {
      let cancelled = false
      setLoading(true)
      setError(null)
      setSelected(new Set())
      setRenaming(null)
      setContextMenu(null)
      setAnchorIndex(null)
      setPathInputValue(null)
      if (listScrollRef.current) listScrollRef.current.scrollTop = 0
      void window.blow.fs.list(shape.props.currentPath).then((res) => {
        if (cancelled) return
        if (res.ok) {
          setEntries(res.entries)
        } else {
          setEntries([])
          setError(res.reason)
        }
        setLoading(false)
      })
      return () => {
        cancelled = true
      }
    }, [shape.props.currentPath])

    const history = useMemo<NavHistory>(() => {
      try {
        return JSON.parse(shape.props.historyJson) as NavHistory
      } catch {
        return { paths: [shape.props.currentPath], index: 0 }
      }
    }, [shape.props.historyJson, shape.props.currentPath])

    const canBack = history.index > 0
    const canForward = history.index < history.paths.length - 1

    // ── Navigation ──────────────────────────────────────────────────

    const navigateTo = useCallback(
      (path: string) => {
        if (path === shape.props.currentPath) return
        // Branche de l'historique : on tronque tout ce qui était "après"
        // l'index courant (si l'utilisateur avait fait back puis navigue
        // ailleurs, on perd l'arborescence forward — comme un browser).
        const newPaths = history.paths.slice(0, history.index + 1)
        newPaths.push(path)
        // Cap historique : 100 entrées max pour éviter de gonfler le
        // store tldraw avec un blob historyJson énorme sur des sessions
        // longues. Drop les plus anciennes en gardant la position
        // relative.
        let trimmed = newPaths
        let newIndex = newPaths.length - 1
        if (newPaths.length > 100) {
          const overflow = newPaths.length - 100
          trimmed = newPaths.slice(overflow)
          newIndex = trimmed.length - 1
        }
        editor.updateShape<ExplorerShape>({
          id: shape.id,
          type: 'explorer',
          props: {
            currentPath: path,
            historyJson: JSON.stringify({ paths: trimmed, index: newIndex })
          }
        })
      },
      [editor, history, shape.id, shape.props.currentPath]
    )

    const navigateHistoryDelta = useCallback(
      (delta: -1 | 1) => {
        const newIndex = history.index + delta
        if (newIndex < 0 || newIndex >= history.paths.length) return
        editor.updateShape<ExplorerShape>({
          id: shape.id,
          type: 'explorer',
          props: {
            currentPath: history.paths[newIndex],
            historyJson: JSON.stringify({ paths: history.paths, index: newIndex })
          }
        })
      },
      [editor, history, shape.id]
    )

    const navigateUp = useCallback(() => {
      const current = shape.props.currentPath
      if (current === ROOT_PATH) return
      // Windows : C:\Users\Bob → C:\Users → C:\ → ThisPC
      // C:\ → ThisPC
      const isDriveRoot = /^[A-Z]:\\?$/i.test(current)
      if (isDriveRoot) {
        navigateTo(ROOT_PATH)
        return
      }
      const parent = parentDir(current)
      if (parent) navigateTo(parent)
    }, [shape.props.currentPath, navigateTo])

    // ── Sélection ───────────────────────────────────────────────────

    const onEntryClick = useCallback(
      (entry: FsEntry, idx: number, e: React.MouseEvent) => {
        if (e.shiftKey && anchorIndex !== null) {
          // Range select de anchor à idx (inclus).
          const lo = Math.min(anchorIndex, idx)
          const hi = Math.max(anchorIndex, idx)
          const newSet = new Set<string>()
          for (let i = lo; i <= hi; i++) newSet.add(entries[i].path)
          setSelected(newSet)
        } else if (e.ctrlKey || e.metaKey) {
          // Toggle individuel.
          const newSet = new Set(selected)
          if (newSet.has(entry.path)) newSet.delete(entry.path)
          else newSet.add(entry.path)
          setSelected(newSet)
          setAnchorIndex(idx)
        } else {
          setSelected(new Set([entry.path]))
          setAnchorIndex(idx)
        }
      },
      [entries, selected, anchorIndex]
    )

    // Forward ref pour permettre à `onEntryDoubleClick` d'appeler
    // `openInBlowNotepad` qui est défini plus bas (dépendance circulaire
    // de useCallback). Pattern : on stocke la fonction dans une ref,
    // mise à jour à chaque render, et on lit `current` au moment de
    // l'appel.
    const openInBlowNotepadRef = useRef<((target: FsEntry) => void) | null>(null)

    const onEntryDoubleClick = useCallback(
      (entry: FsEntry) => {
        if (entry.isDirectory) {
          navigateTo(entry.path)
          return
        }
        // Fichier texte connu → ouvrir dans une NotepadShape BlowWorks
        // sous l'Explorer plutôt que de déléguer à l'application système.
        // Plus rapide et reste dans le canvas.
        if (TEXT_FILE_EXTS.has(entry.ext) && openInBlowNotepadRef.current) {
          openInBlowNotepadRef.current(entry)
          return
        }
        // Fallback : application Windows par défaut.
        void window.blow.fs.open(entry.path).then((res) => {
          if (!res.ok) {
            console.warn('[explorer-shape] échec open :', res.reason)
          }
        })
      },
      [navigateTo]
    )

    // ── Actions sur sélection ───────────────────────────────────────

    const trashSelection = useCallback(async () => {
      if (selected.size === 0) return
      const count = selected.size
      const confirm = window.confirm(
        count === 1
          ? `Envoyer cet élément à la corbeille ?`
          : `Envoyer ${count} éléments à la corbeille ?`
      )
      if (!confirm) return
      const paths = Array.from(selected)
      const results = await Promise.all(
        paths.map((p) => window.blow.fs.trash(p))
      )
      const failures = results.filter((r) => !r.ok)
      if (failures.length > 0) {
        console.warn('[explorer-shape] échec trash :', failures)
      }
      // Recharge le dossier pour refléter les suppressions.
      const res = await window.blow.fs.list(shape.props.currentPath)
      if (res.ok) setEntries(res.entries)
      setSelected(new Set())
    }, [selected, shape.props.currentPath])

    const startRename = useCallback(() => {
      if (selected.size !== 1) return
      const path = Array.from(selected)[0]
      setRenaming(path)
    }, [selected])

    const commitRename = useCallback(
      async (oldPath: string, newName: string) => {
        setRenaming(null)
        if (!newName || newName === basenameWin(oldPath)) return
        const res = await window.blow.fs.rename(oldPath, newName)
        if (!res.ok) {
          console.warn('[explorer-shape] échec rename :', res.reason)
          window.alert(`Impossible de renommer : ${res.reason}`)
          return
        }
        // Recharge + sélectionne le nouveau chemin.
        const list = await window.blow.fs.list(shape.props.currentPath)
        if (list.ok) {
          setEntries(list.entries)
          setSelected(new Set([res.newPath]))
        }
      },
      [shape.props.currentPath]
    )

    // ── Raccourcis clavier (capture sur le wrapper) ─────────────────

    const onKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        // Quand le path input est focused, on laisse le browser gérer
        // (Entrée valide, Échap annule via onKeyDown du <input>).
        if (pathInputValue !== null) return
        // Quand on est en mode renommage, idem (le <input> gère).
        if (renaming !== null) return

        if (e.key === 'F2') {
          e.preventDefault()
          startRename()
        } else if (e.key === 'Delete') {
          e.preventDefault()
          void trashSelection()
        } else if (e.key === 'Enter') {
          if (selected.size === 1) {
            e.preventDefault()
            const path = Array.from(selected)[0]
            const entry = entries.find((x) => x.path === path)
            if (entry) onEntryDoubleClick(entry)
          }
        } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
          e.preventDefault()
          setPathInputValue(shape.props.currentPath)
        } else if (e.key === 'Escape') {
          setContextMenu(null)
          setSelected(new Set())
        } else if (e.key === 'Backspace') {
          e.preventDefault()
          navigateUp()
        }
      },
      [
        pathInputValue,
        renaming,
        selected,
        entries,
        startRename,
        trashSelection,
        onEntryDoubleClick,
        navigateUp,
        shape.props.currentPath
      ]
    )

    // ── Spawn shapes BlowWorks depuis le menu ──────────────────────

    // Calcule la position du spawn : EN DESSOUS de la shape courante,
    // alignée à gauche, avec un petit padding vertical pour aérer
    // visuellement les deux fenêtres. Utilise les coords actuelles de
    // la shape via `editor.getShape` plutôt que celles du closure pour
    // rester juste après un déplacement utilisateur.
    const computeSpawnPosition = useCallback(() => {
      const me = editor.getShape(shape.id) as
        | { x: number; y: number; props: { w: number; h: number } }
        | undefined
      if (!me) return { x: 0, y: 0 }
      const PADDING = 16
      return { x: me.x, y: me.y + me.props.h + PADDING }
    }, [editor, shape.id])

    const openInBlowVSCode = useCallback(
      (target: FsEntry | null) => {
        // VSCode a besoin d'un DOSSIER. Si la cible est un fichier, on
        // ouvre son dossier parent. Si pas de cible (menu fond), on
        // ouvre le dossier courant.
        let folder: string
        if (target === null) {
          folder = shape.props.currentPath
        } else if (target.isDirectory) {
          folder = target.path
        } else {
          const parent = parentDir(target.path)
          folder = parent ?? shape.props.currentPath
        }
        if (folder === ROOT_PATH) {
          window.alert(
            'Impossible d\'ouvrir "Ce PC" dans VSCode — choisissez un dossier réel.'
          )
          return
        }
        const pos = computeSpawnPosition()
        editor.createShape<VSCodeShape>({
          id: createShapeId(),
          type: 'vscode',
          x: pos.x,
          y: pos.y,
          props: {
            w: 960,
            h: 600,
            folder: folder.replace(/\\/g, '/'),
            projectId: null
          }
        })
      },
      [editor, shape.props.currentPath, computeSpawnPosition]
    )

    const openInBlowExplorer = useCallback(
      (target: FsEntry | null) => {
        // Nouvelle ExplorerShape sur le dossier cible. Pour un fichier,
        // on ouvre son dossier parent (cohérent avec le comportement
        // "Ouvrir dans l'Explorateur" qui fait `showItemInFolder`).
        let path: string
        if (target === null) {
          path = shape.props.currentPath
        } else if (target.isDirectory) {
          path = target.path
        } else {
          path = parentDir(target.path) ?? shape.props.currentPath
        }
        const pos = computeSpawnPosition()
        editor.createShape<ExplorerShape>({
          id: createShapeId(),
          type: 'explorer',
          x: pos.x,
          y: pos.y,
          props: {
            w: 920,
            h: 580,
            currentPath: path,
            historyJson: JSON.stringify({ paths: [path], index: 0 })
          }
        })
      },
      [editor, shape.props.currentPath, computeSpawnPosition]
    )

    // Spawn une NotepadShape liée au fichier cible, sous l'Explorer.
    // Pas applicable aux dossiers (le bloc-notes édite des fichiers
    // texte). Le caller filtre déjà sur isDirectory côté double-clic
    // et menu contextuel — défense en profondeur ici.
    const openInBlowNotepad = useCallback(
      (target: FsEntry) => {
        if (target.isDirectory) return
        const pos = computeSpawnPosition()
        const id = createShapeId()
        editor.createShape<NotepadShape>({
          id,
          type: 'notepad',
          x: pos.x,
          y: pos.y,
          props: {
            w: 480,
            h: 360,
            filePath: target.path,
            content: ''
          }
        })
        editor.setSelectedShapes([id])
      },
      [editor, computeSpawnPosition]
    )

    // Maintien de la ref pour que `onEntryDoubleClick` (défini plus haut)
    // puisse invoquer la fonction sans dépendance circulaire de useCallback.
    useEffect(() => {
      openInBlowNotepadRef.current = openInBlowNotepad
    }, [openInBlowNotepad])

    // ── Menu contextuel ─────────────────────────────────────────────

    const onContextMenuEntry = useCallback(
      (entry: FsEntry, e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        // Si l'entrée n'est pas déjà sélectionnée, on la sélectionne en
        // clic simple (mimique Windows).
        if (!selected.has(entry.path)) {
          setSelected(new Set([entry.path]))
        }
        setContextMenu({ x: e.clientX, y: e.clientY, target: entry })
      },
      [selected]
    )

    const onContextMenuBackground = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setSelected(new Set())
        setContextMenu({ x: e.clientX, y: e.clientY, target: null })
      },
      []
    )

    const closeContextMenu = useCallback(() => setContextMenu(null), [])

    // Ferme le menu sur scroll ou clic ailleurs.
    useEffect(() => {
      if (!contextMenu) return
      const onScroll = (): void => closeContextMenu()
      window.addEventListener('scroll', onScroll, true)
      return () => {
        window.removeEventListener('scroll', onScroll, true)
      }
    }, [contextMenu, closeContextMenu])

    // Listener natif `wheel` sur la zone interactive : nécessaire car le
    // `onWheel` React utilise la délégation au niveau root et arrive trop
    // tard — tldraw a déjà capturé l'event et l'a transformé en zoom du
    // canvas. Avec un listener natif sur l'élément lui-même, le bubbling
    // est stoppé AVANT d'atteindre les listeners ancêtres de tldraw, et
    // le scroll reste local à la zone.
    const interactiveRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
      const el = interactiveRef.current
      if (!el) return
      const onWheel = (e: WheelEvent): void => {
        e.stopPropagation()
      }
      el.addEventListener('wheel', onWheel, { passive: true })
      return () => el.removeEventListener('wheel', onWheel)
    }, [])

    // Désélectionne la shape tldraw quand l'utilisateur clique dans la
    // zone interactive (immersion : on travaille DANS la fenêtre, pas
    // SUR la shape). Le clic sur le HEADER passe à travers grâce à
    // pointer-events: none → tldraw sélectionne nativement la shape pour
    // permettre le drag. Pattern miroir au ShapePortalManager pour les
    // shapes portail (VSCode, Chat, Browser).
    const onInteractivePointerDown = useCallback(
      (e: React.PointerEvent) => {
        e.stopPropagation()
        if (editor.getSelectedShapeIds().length > 0) {
          editor.setSelectedShapes([])
        }
      },
      [editor]
    )

    // ── Render ──────────────────────────────────────────────────────

    return (
      <div
        // Wrapper racine en pointer-events: NONE pour que le drag tldraw
        // puisse atteindre la shape via le HEADER (qui est lui aussi
        // transparent au pointeur). Pattern identique à VSCodeShape /
        // ChatShape / BrowserShape : zone d'interaction réelle restreinte
        // à un conteneur intérieur dédié.
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-primary, #0a0a0a)',
          color: 'var(--fg-primary, #e5e5e5)',
          border: '1px solid var(--border, #2a2a2a)',
          borderRadius: 'var(--radius-md, 8px)',
          overflow: 'hidden',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontSize: 13,
          pointerEvents: 'none'
        }}
      >
        <Header
          shape={shape}
          canBack={canBack}
          canForward={canForward}
          onBack={() => navigateHistoryDelta(-1)}
          onForward={() => navigateHistoryDelta(1)}
          onUp={navigateUp}
          onRefresh={() => {
            void window.blow.fs.list(shape.props.currentPath).then((res) => {
              if (res.ok) setEntries(res.entries)
            })
          }}
          pathInputValue={pathInputValue}
          setPathInputValue={setPathInputValue}
          onPathSubmit={(p) => {
            setPathInputValue(null)
            const cleaned = p.trim()
            if (!cleaned) return
            navigateTo(cleaned)
          }}
          onBreadcrumbClick={navigateTo}
        />

        {/* Zone interactive : pointer-events auto, capture clavier (F2,
            Suppr, Ctrl+L, …) via tabIndex+onKeyDown. Scroll molette via
            listener natif (cf. useEffect plus haut). pointerDown stoppe
            tldraw + désélectionne la shape pour l'immersion (le user
            clique DANS la fenêtre, pas SUR la shape). */}
        <div
          ref={interactiveRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onInteractivePointerDown}
          style={{
            display: 'flex',
            flex: 1,
            minHeight: 0,
            pointerEvents: 'auto',
            outline: 'none'
          }}
        >
          <Sidebar
            quickAccess={quickAccess}
            currentPath={shape.props.currentPath}
            onItemClick={(path) => navigateTo(path ?? ROOT_PATH)}
          />
          <FileList
            forwardedRef={listScrollRef}
            entries={entries}
            loading={loading}
            error={error}
            selected={selected}
            renaming={renaming}
            onEntryClick={onEntryClick}
            onEntryDoubleClick={onEntryDoubleClick}
            onContextMenuEntry={onContextMenuEntry}
            onContextMenuBackground={onContextMenuBackground}
            onCommitRename={commitRename}
            onCancelRename={() => setRenaming(null)}
          />
        </div>

        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            target={contextMenu.target}
            currentPath={shape.props.currentPath}
            selectedCount={selected.size}
            onClose={closeContextMenu}
            onOpen={() => {
              if (contextMenu.target) onEntryDoubleClick(contextMenu.target)
              closeContextMenu()
            }}
            onCopyPath={() => {
              const path = contextMenu.target?.path ?? shape.props.currentPath
              void navigator.clipboard.writeText(path)
              closeContextMenu()
            }}
            onRename={() => {
              if (contextMenu.target) {
                setSelected(new Set([contextMenu.target.path]))
                setRenaming(contextMenu.target.path)
              }
              closeContextMenu()
            }}
            onTrash={() => {
              closeContextMenu()
              void trashSelection()
            }}
            onOpenInExplorer={() => {
              const path = contextMenu.target?.path ?? shape.props.currentPath
              void window.blow.fs.openInExplorer(path)
              closeContextMenu()
            }}
            onRefresh={() => {
              closeContextMenu()
              void window.blow.fs.list(shape.props.currentPath).then((res) => {
                if (res.ok) setEntries(res.entries)
              })
            }}
            onOpenInBlowVSCode={() => {
              const target = contextMenu.target
              closeContextMenu()
              openInBlowVSCode(target)
            }}
            onOpenInBlowExplorer={() => {
              const target = contextMenu.target
              closeContextMenu()
              openInBlowExplorer(target)
            }}
            onOpenInBlowNotepad={() => {
              const target = contextMenu.target
              closeContextMenu()
              if (target && !target.isDirectory) openInBlowNotepad(target)
            }}
            onShellMenu={() => {
              console.log('[explorer-shape] onShellMenu déclenché')
              // Capture les coords AVANT de fermer le menu : on veut que
              // le shell menu Windows s'ouvre au même point que notre
              // menu maison. Après refresh la liste pour refléter les
              // éventuelles modifications (suppression, renommage, …)
              // faites par la commande shell.
              const sx = contextMenu.x
              const sy = contextMenu.y
              const path = contextMenu.target?.path ?? shape.props.currentPath
              console.log(
                `[explorer-shape] appel IPC shellContextMenu path=${path} screen=${sx},${sy}`
              )
              closeContextMenu()
              void window.blow.fs
                .shellContextMenu(path, sx, sy)
                .then((res) => {
                  console.log('[explorer-shape] shellContextMenu retour :', res)
                  if (!res.ok) {
                    console.warn('[explorer-shape] shellContextMenu :', res.reason)
                  }
                  if (res.invoked) {
                    void window.blow.fs.list(shape.props.currentPath).then((r) => {
                      if (r.ok) setEntries(r.entries)
                    })
                  }
                })
                .catch((err) => {
                  console.error('[explorer-shape] shellContextMenu rejette :', err)
                })
            }}
          />
        )}
      </div>
    )
  },
  (prev, next) =>
    prev.shape.id === next.shape.id &&
    prev.shape.props.w === next.shape.props.w &&
    prev.shape.props.h === next.shape.props.h &&
    prev.shape.props.currentPath === next.shape.props.currentPath &&
    prev.shape.props.historyJson === next.shape.props.historyJson
)

// ── Header (toolbar + path bar) ───────────────────────────────────────

function Header({
  shape,
  canBack,
  canForward,
  onBack,
  onForward,
  onUp,
  onRefresh,
  pathInputValue,
  setPathInputValue,
  onPathSubmit,
  onBreadcrumbClick
}: {
  shape: ExplorerShape
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
  onUp: () => void
  onRefresh: () => void
  pathInputValue: string | null
  setPathInputValue: (v: string | null) => void
  onPathSubmit: (path: string) => void
  onBreadcrumbClick: (path: string) => void
}): React.ReactElement {
  const breadcrumb = useMemo(
    () => buildBreadcrumb(shape.props.currentPath),
    [shape.props.currentPath]
  )
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus auto quand on entre en mode saisie (Ctrl+L ou clic dans la
  // path bar).
  useEffect(() => {
    if (pathInputValue !== null && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [pathInputValue])

  return (
    <div
      data-shape-header
      style={{
        height: HEADER_HEIGHT,
        flexShrink: 0,
        background: 'var(--bg-secondary, #101010)',
        borderBottom: '1px solid var(--border, #2a2a2a)',
        display: 'flex',
        flexDirection: 'column',
        // Header transparent au pointeur → drag tldraw passe à travers.
        // Les boutons et l'input surchargent en auto explicite.
        pointerEvents: 'none'
      }}
    >
      {/* Toolbar : retour / avant / parent / refresh */}
      <div
        style={{
          height: 32,
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px',
          gap: 4
        }}
      >
        <ToolbarButton
          label="Retour"
          disabled={!canBack}
          onClick={onBack}
          glyph="←"
        />
        <ToolbarButton
          label="Avant"
          disabled={!canForward}
          onClick={onForward}
          glyph="→"
        />
        <ToolbarButton
          label="Dossier parent"
          disabled={shape.props.currentPath === ROOT_PATH}
          onClick={onUp}
          glyph="↑"
        />
        <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 6px' }} />
        <ToolbarButton label="Actualiser" onClick={onRefresh} glyph="⟳" />
      </div>

      {/* Path bar : breadcrumb OU saisie texte */}
      <div
        style={{
          height: 32,
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px 6px 8px',
          minWidth: 0
        }}
      >
        {pathInputValue !== null ? (
          <input
            ref={inputRef}
            type="text"
            value={pathInputValue}
            onChange={(e) => setPathInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onPathSubmit(pathInputValue)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setPathInputValue(null)
              }
              e.stopPropagation()
            }}
            onBlur={() => setPathInputValue(null)}
            // stopPropagation sur pointerdown pour empêcher tldraw de
            // démarrer un drag (le header parent est pointer-events: none).
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              minWidth: 0,
              height: 24,
              padding: '0 8px',
              background: 'var(--bg-primary)',
              color: 'var(--fg-primary)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontFamily: 'inherit',
              fontSize: 12,
              outline: 'none',
              pointerEvents: 'auto'
            }}
          />
        ) : (
          <div
            onClick={() => setPathInputValue(shape.props.currentPath)}
            onPointerDown={(e) => e.stopPropagation()}
            title="Cliquer pour saisir un chemin (Ctrl+L)"
            style={{
              flex: 1,
              minWidth: 0,
              height: 24,
              padding: '0 8px',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              overflow: 'hidden',
              cursor: 'text',
              pointerEvents: 'auto'
            }}
          >
            {breadcrumb.map((seg, i) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onBreadcrumbClick(seg.path)
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--fg-primary)',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    fontFamily: 'inherit',
                    fontSize: 12,
                    borderRadius: 3,
                    pointerEvents: 'auto'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--bg-tertiary)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  {seg.label}
                </button>
                {i < breadcrumb.length - 1 && (
                  <span style={{ color: 'var(--fg-muted)' }}>›</span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ToolbarButton({
  label,
  glyph,
  disabled,
  onClick
}: {
  label: string
  glyph: string
  disabled?: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      // Stop propagation pointerdown : sans ça, tldraw reçoit le clic
      // (le header parent étant en pointer-events: none) et démarre un
      // drag de la shape avant que le click bouton ne tire.
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        width: 28,
        height: 24,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        color: disabled ? 'var(--fg-muted)' : 'var(--fg-primary)',
        border: '1px solid transparent',
        borderRadius: 4,
        cursor: disabled ? 'default' : 'pointer',
        fontSize: 14,
        fontFamily: 'inherit',
        opacity: disabled ? 0.4 : 1,
        pointerEvents: 'auto'
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = 'var(--bg-tertiary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {glyph}
    </button>
  )
}

// ── Sidebar ───────────────────────────────────────────────────────────

function Sidebar({
  quickAccess,
  currentPath,
  onItemClick
}: {
  quickAccess: QuickAccessItem[]
  currentPath: string
  onItemClick: (path: string | null) => void
}): React.ReactElement {
  return (
    <div
      style={{
        width: 180,
        flexShrink: 0,
        background: 'var(--bg-secondary, #101010)',
        borderRight: '1px solid var(--border, #2a2a2a)',
        overflowY: 'auto',
        padding: '8px 0'
      }}
    >
      <div
        style={{
          padding: '4px 12px',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--fg-muted)'
        }}
      >
        Accès rapide
      </div>
      {quickAccess.map((item) => {
        const itemKey = item.path ?? 'thispc'
        const isActive =
          (item.path === null && currentPath === ROOT_PATH) ||
          (item.path !== null && item.path === currentPath)
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onItemClick(item.path)}
            title={item.path ?? 'Ce PC (disques)'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '6px 12px',
              background: isActive ? 'var(--bg-tertiary, #1a1a1a)' : 'transparent',
              color: 'var(--fg-primary)',
              border: 'none',
              borderLeft: isActive
                ? '2px solid var(--color-accent, #4465e9)'
                : '2px solid transparent',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
              textAlign: 'left',
              pointerEvents: 'auto'
            }}
            onMouseEnter={(e) => {
              if (!isActive) e.currentTarget.style.background = 'var(--bg-tertiary)'
            }}
            onMouseLeave={(e) => {
              if (!isActive) e.currentTarget.style.background = 'transparent'
            }}
            data-key={itemKey}
          >
            <span style={{ width: 16, textAlign: 'center' }}>{item.icon}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {item.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ── File list ─────────────────────────────────────────────────────────

const FileList = memo(
  function FileListImpl(
    {
      entries,
      loading,
      error,
      selected,
      renaming,
      onEntryClick,
      onEntryDoubleClick,
      onContextMenuEntry,
      onContextMenuBackground,
      onCommitRename,
      onCancelRename,
      forwardedRef
    }: {
      entries: FsEntry[]
      loading: boolean
      error: string | null
      selected: Set<string>
      renaming: string | null
      onEntryClick: (entry: FsEntry, idx: number, e: React.MouseEvent) => void
      onEntryDoubleClick: (entry: FsEntry) => void
      onContextMenuEntry: (entry: FsEntry, e: React.MouseEvent) => void
      onContextMenuBackground: (e: React.MouseEvent) => void
      onCommitRename: (oldPath: string, newName: string) => void
      onCancelRename: () => void
      forwardedRef: React.RefObject<HTMLDivElement | null>
    }
  ): React.ReactElement {
    return (
      <div
        ref={forwardedRef}
        onContextMenu={onContextMenuBackground}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: 'auto',
          background: 'var(--bg-primary, #0a0a0a)'
        }}
      >
        {/* Header colonnes */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 110px 140px 90px',
            padding: '6px 12px',
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--fg-muted)',
            borderBottom: '1px solid var(--border, #2a2a2a)',
            position: 'sticky',
            top: 0,
            background: 'var(--bg-primary)',
            zIndex: 1
          }}
        >
          <span>Nom</span>
          <span style={{ textAlign: 'right' }}>Taille</span>
          <span>Modifié le</span>
          <span>Type</span>
        </div>

        {loading ? (
          <div style={{ padding: 16, color: 'var(--fg-muted)', fontSize: 12 }}>
            Chargement…
          </div>
        ) : error ? (
          <div style={{ padding: 16, color: '#e57373', fontSize: 12 }}>
            Erreur : {humanizeError(error)}
          </div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--fg-muted)', fontSize: 12 }}>
            Dossier vide.
          </div>
        ) : (
          entries.map((entry, idx) => {
            const isSelected = selected.has(entry.path)
            const isRenaming = renaming === entry.path
            return (
              <div
                key={entry.path}
                onClick={(e) => {
                  if (isRenaming) return
                  onEntryClick(entry, idx, e)
                }}
                onDoubleClick={() => {
                  if (isRenaming) return
                  onEntryDoubleClick(entry)
                }}
                onContextMenu={(e) => onContextMenuEntry(entry, e)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 110px 140px 90px',
                  padding: '4px 12px',
                  fontSize: 12,
                  background: isSelected ? 'var(--bg-tertiary, #1a1a1a)' : 'transparent',
                  cursor: 'default',
                  color: entry.hidden ? 'var(--fg-muted)' : 'var(--fg-primary)',
                  borderLeft: isSelected
                    ? '2px solid var(--color-accent, #4465e9)'
                    : '2px solid transparent',
                  alignItems: 'center'
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = 'var(--bg-secondary)'
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.background = 'transparent'
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minWidth: 0
                  }}
                >
                  <span style={{ width: 18, textAlign: 'center' }}>
                    {entry.isDirectory ? '📁' : guessFileIcon(entry.ext)}
                  </span>
                  {isRenaming ? (
                    <RenameInput
                      initial={entry.name}
                      onCommit={(newName) => onCommitRename(entry.path, newName)}
                      onCancel={onCancelRename}
                    />
                  ) : (
                    <span
                      style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {entry.name}
                    </span>
                  )}
                </div>
                <span style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>
                  {entry.isDirectory ? '' : formatSize(entry.size)}
                </span>
                <span style={{ color: 'var(--fg-muted)' }}>
                  {entry.modifiedAt > 0 ? formatDate(entry.modifiedAt) : ''}
                </span>
                <span style={{ color: 'var(--fg-muted)' }}>
                  {entry.isDirectory ? 'Dossier' : entry.ext.toUpperCase() || 'Fichier'}
                </span>
              </div>
            )
          })
        )}
      </div>
    )
  }
)


function RenameInput({
  initial,
  onCommit,
  onCancel
}: {
  initial: string
  onCommit: (newName: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
      // Sélectionne le NOM sans l'extension (comme Windows F2).
      const dot = initial.lastIndexOf('.')
      if (dot > 0) {
        inputRef.current.setSelectionRange(0, dot)
      } else {
        inputRef.current.select()
      }
    }
  }, [initial])

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit(value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      onBlur={() => onCommit(value)}
      style={{
        flex: 1,
        minWidth: 0,
        height: 22,
        padding: '0 4px',
        background: 'var(--bg-primary)',
        color: 'var(--fg-primary)',
        border: '1px solid var(--color-accent, #4465e9)',
        borderRadius: 3,
        fontFamily: 'inherit',
        fontSize: 12,
        outline: 'none'
      }}
    />
  )
}

// ── Context menu ──────────────────────────────────────────────────────

function ContextMenu({
  x,
  y,
  target,
  currentPath,
  selectedCount,
  onClose,
  onOpen,
  onCopyPath,
  onRename,
  onTrash,
  onOpenInExplorer,
  onRefresh,
  onShellMenu,
  onOpenInBlowVSCode,
  onOpenInBlowExplorer,
  onOpenInBlowNotepad
}: {
  x: number
  y: number
  target: FsEntry | null
  currentPath: string
  selectedCount: number
  onClose: () => void
  onOpen: () => void
  onCopyPath: () => void
  onRename: () => void
  onTrash: () => void
  onOpenInExplorer: () => void
  onRefresh: () => void
  // Ouvre le menu shell Windows complet via IContextMenu COM. La cible
  // est définie par le composant parent (target ?? currentPath).
  onShellMenu: () => void
  // Spawn une VSCodeShape BlowWorks sur le dossier cible (ou parent
  // pour un fichier). Distinct du menu shell qui invoque le VSCode
  // SYSTÈME via "Open with Code" — celui-ci reste dans BlowWorks.
  onOpenInBlowVSCode: () => void
  // Spawn une nouvelle ExplorerShape BlowWorks sur le dossier cible.
  onOpenInBlowExplorer: () => void
  // Spawn une NotepadShape BlowWorks liée au fichier cible. No-op si la
  // cible est un dossier ou null (le menu fond ne propose pas l'item).
  onOpenInBlowNotepad: () => void
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [onClose])

  // Clamp aux bords viewport. Hauteur estimée en fonction du contenu :
  // plus d'items quand on a une cible (target) qu'en menu fond.
  const MENU_W = 240
  const MENU_H = target ? 260 : 140
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.min(x, vw - MENU_W - 8)
  const top = Math.min(y, vh - MENU_H - 8)

  // Désactive renommer/supprimer si la cible est la racine virtuelle (pas
  // de target) ou si l'entrée est un disque (path comme C:\).
  const isDriveRoot =
    target && /^[A-Z]:\\?$/i.test(target.path)
  const canRename = target && !isDriveRoot && selectedCount === 1
  const canTrash = target && !isDriveRoot && selectedCount > 0

  // Portal vers document.body : la shape est rendue DANS le canvas tldraw
  // qui applique un `transform: scale()` pour le zoom, ce qui crée un
  // containing block et casse `position: fixed` (les coords deviennent
  // relatives au layer transformé au lieu de l'écran). En portallant le
  // menu hors du sous-arbre de la shape, on s'échappe de ce transform et
  // les coords clientX/clientY (= coords écran de l'event original)
  // pointent à nouveau au bon endroit.
  return createPortal(
    <div
      ref={ref}
      role="menu"
      // Le menu hérite du transform du body — pas de transform → coords
      // brutes écran, ce qui est ce qu'on veut.
      style={{
        position: 'fixed',
        left,
        top,
        width: MENU_W,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        zIndex: 1000,
        padding: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        fontSize: 12,
        pointerEvents: 'auto',
        // Le portal sort du contexte CSS de la shape → on doit re-spécifier
        // les variables (ou utiliser des fallbacks). Les `var(--…)` sont
        // résolus via la cascade du body, qui a accès aux mêmes variables
        // racine de l'app (cf. globals.css).
        color: 'var(--fg-primary)',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif'
      }}
    >
      {target ? (
        <>
          <MenuRow icon="📂" label="Ouvrir" onClick={onOpen} />
          <MenuRow icon="📋" label="Copier le chemin" onClick={onCopyPath} />
          <MenuRow
            icon="✏️"
            label="Renommer"
            shortcut="F2"
            disabled={!canRename}
            onClick={canRename ? onRename : undefined}
          />
          <MenuRow
            icon="🗑️"
            label={
              selectedCount > 1
                ? `Supprimer (${selectedCount})`
                : 'Supprimer'
            }
            shortcut="Suppr"
            disabled={!canTrash}
            onClick={canTrash ? onTrash : undefined}
          />
          <MenuSeparator />
          <MenuRow
            icon="📝"
            label="Ouvrir avec Bloc-notes (BlowWorks)"
            onClick={onOpenInBlowNotepad}
            disabled={target.isDirectory}
          />
          <MenuRow
            icon="🧰"
            label="Ouvrir dans VSCode (BlowWorks)"
            onClick={onOpenInBlowVSCode}
            disabled={isDriveRoot ?? false}
          />
          <MenuRow
            icon="📁"
            label="Ouvrir dans nouvel Explorateur (BlowWorks)"
            onClick={onOpenInBlowExplorer}
          />
          <MenuSeparator />
          <MenuRow
            icon="🪟"
            label="Ouvrir dans l'Explorateur"
            onClick={onOpenInExplorer}
          />
          <MenuRow
            icon="⋯"
            label="Plus d'options Windows…"
            onClick={onShellMenu}
          />
        </>
      ) : (
        <>
          <MenuRow icon="⟳" label="Actualiser" onClick={onRefresh} />
          <MenuRow icon="📋" label="Copier le chemin" onClick={onCopyPath} />
          <MenuSeparator />
          <MenuRow
            icon="📝"
            label="Ouvrir dans VSCode (BlowWorks)"
            onClick={onOpenInBlowVSCode}
            disabled={currentPath === ROOT_PATH}
          />
          <MenuRow
            icon="📁"
            label="Ouvrir dans nouvel Explorateur (BlowWorks)"
            onClick={onOpenInBlowExplorer}
            disabled={currentPath === ROOT_PATH}
          />
          <MenuSeparator />
          <MenuRow
            icon="🪟"
            label="Ouvrir dans l'Explorateur"
            onClick={onOpenInExplorer}
            // Pour le menu fond, "Ouvrir natif" pointe sur currentPath.
            disabled={currentPath === ROOT_PATH}
          />
          <MenuRow
            icon="⋯"
            label="Plus d'options Windows…"
            onClick={onShellMenu}
            disabled={currentPath === ROOT_PATH}
          />
        </>
      )}
    </div>,
    document.body
  )
}

function MenuRow({
  icon,
  label,
  shortcut,
  disabled,
  onClick
}: {
  icon: string
  label: string
  shortcut?: string
  disabled?: boolean
  onClick?: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        console.log(`[explorer-shape] MenuRow click "${label}" disabled=${disabled}`)
        e.stopPropagation()
        if (!disabled && onClick) onClick()
      }}
      // stopPropagation pointerdown pour empêcher tout listener global
      // (tldraw, ShapePortalManager) d'intercepter et de déclencher un
      // effet secondaire (drag, désélection) qui pourrait fermer le menu
      // AVANT que le click n'ait fire.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        background: 'transparent',
        color: disabled ? 'var(--fg-muted)' : 'var(--fg-primary)',
        border: 'none',
        borderRadius: 3,
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit',
        fontSize: 12,
        textAlign: 'left',
        opacity: disabled ? 0.5 : 1
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = 'var(--bg-tertiary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <span style={{ width: 16, textAlign: 'center' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {shortcut && (
        <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>{shortcut}</span>
      )}
    </button>
  )
}

function MenuSeparator(): React.ReactElement {
  return (
    <div
      style={{
        height: 1,
        background: 'var(--border)',
        margin: '4px 0'
      }}
    />
  )
}

// ── Helpers ───────────────────────────────────────────────────────────

// Construit le breadcrumb pour un chemin Windows. ROOT_PATH retourne
// uniquement [{ Ce PC, ROOT_PATH }]. C:\Users\Bob retourne :
//   [{Ce PC, ROOT_PATH}, {C:, C:\\}, {Users, C:\\Users}, {Bob, C:\\Users\\Bob}]
function buildBreadcrumb(path: string): Array<{ label: string; path: string }> {
  const result: Array<{ label: string; path: string }> = [
    { label: 'Ce PC', path: ROOT_PATH }
  ]
  if (path === ROOT_PATH) return result
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0)
  let acc = ''
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (i === 0) {
      // Drive letter : "C:" → acc = "C:\\"
      acc = part + '\\'
      result.push({ label: part, path: acc })
    } else {
      acc = acc.replace(/\\$/, '') + '\\' + part
      result.push({ label: part, path: acc })
    }
  }
  return result
}

// Parent dir Windows-aware : C:\Users\Bob → C:\Users, C:\ → null (la
// navigation up reroute vers ROOT_PATH côté handler dédié).
function parentDir(path: string): string | null {
  if (/^[A-Z]:\\?$/i.test(path)) return null
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0)
  if (parts.length <= 1) return null
  parts.pop()
  return parts[0] + '\\' + parts.slice(1).join('\\')
}

// basename Windows : C:\Users\Bob → Bob, C:\ → C:
function basenameWin(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0)
  return parts[parts.length - 1] ?? path
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} Go`
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`
}

function guessFileIcon(ext: string): string {
  // Mapping minimal d'icônes emoji par extension. Pas exhaustif — c'est
  // un MVP visuel. v2 : remplacer par une vraie librairie d'icônes.
  switch (ext) {
    case 'txt':
    case 'md':
    case 'log':
      return '📄'
    case 'pdf':
      return '📕'
    case 'doc':
    case 'docx':
      return '📘'
    case 'xls':
    case 'xlsx':
    case 'csv':
      return '📊'
    case 'ppt':
    case 'pptx':
      return '📽️'
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
      return '🗜️'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'bmp':
    case 'webp':
    case 'svg':
      return '🖼️'
    case 'mp3':
    case 'wav':
    case 'flac':
    case 'ogg':
    case 'm4a':
      return '🎵'
    case 'mp4':
    case 'mkv':
    case 'avi':
    case 'mov':
    case 'webm':
      return '🎬'
    case 'js':
    case 'ts':
    case 'tsx':
    case 'jsx':
    case 'py':
    case 'rs':
    case 'go':
    case 'java':
    case 'c':
    case 'cpp':
    case 'h':
    case 'cs':
    case 'rb':
    case 'php':
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'xml':
    case 'html':
    case 'css':
    case 'scss':
      return '📜'
    case 'exe':
    case 'msi':
      return '⚙️'
    default:
      return '📄'
  }
}

// Traduit les codes errno en messages utilisateur. Liste non-exhaustive
// — pour les codes inconnus on retourne le code brut.
function humanizeError(reason: string): string {
  switch (reason) {
    case 'ENOENT':
      return 'Dossier introuvable.'
    case 'EACCES':
    case 'EPERM':
      return "Accès refusé (permissions insuffisantes)."
    case 'ENOTDIR':
      return 'Ce chemin n\'est pas un dossier.'
    case 'EBUSY':
      return 'Ressource verrouillée.'
    case 'nom-invalide':
      return 'Nom invalide (séparateur, vide, ou réservé).'
    case 'payload-invalide':
      return 'Requête malformée.'
    default:
      return reason
  }
}

