import { useEffect, useMemo, useState } from 'react'
import type { WikiEntryT } from '@shared/ipc-contract.js'
import { useWikiStore } from '../stores/wiki-store.js'

// Explorateur wiki plein cadre dans la sidebar. Remplace le contenu
// standard (Projets + Mémoire + Graph) quand `sidebarMode === 'wiki-explorer'`.
// Propres scrollbars internes → ne pousse pas le footer hors écran.
//
// Affiche TOUT le dossier wiki (pas seulement wiki/) : SCHEMA.md, log.md,
// raw/, audit/, wiki/, etc. Arborescence récursive.
//   - Dossiers racine : orange
//   - Sous-dossiers   : bleu
//   - Fichiers        : blanc
//   - Fichier actif   : cyan (sélection)
//
// Dispatch au clic :
//   - `wiki/xxx.md` → viewer markdown intégré (strip prefix `wiki/`)
//   - autres        → ouverture dans l'app par défaut de l'OS

interface WikiExplorerSidebarProps {
  collapsed: boolean
}

interface TreeFolder {
  kind: 'folder'
  name: string
  path: string
  children: TreeNode[]
}
interface TreeFile {
  kind: 'file'
  name: string
  path: string
  entry: WikiEntryT
}
type TreeNode = TreeFolder | TreeFile

function buildTree(entries: WikiEntryT[]): TreeNode[] {
  const root: TreeFolder = { kind: 'folder', name: '', path: '', children: [] }
  for (const e of entries) {
    const parts = e.name.split('/')
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i]
      const segPath = parts.slice(0, i + 1).join('/')
      let next = cur.children.find(
        (c): c is TreeFolder => c.kind === 'folder' && c.name === segment
      )
      if (!next) {
        next = { kind: 'folder', name: segment, path: segPath, children: [] }
        cur.children.push(next)
      }
      cur = next
    }
    const filename = parts[parts.length - 1]
    cur.children.push({ kind: 'file', name: filename, path: e.name, entry: e })
  }
  const sort = (n: TreeNode): void => {
    if (n.kind === 'folder') {
      n.children.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      for (const c of n.children) sort(c)
    }
  }
  sort(root)
  return root.children
}

function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  if (!q) return nodes
  const out: TreeNode[] = []
  for (const n of nodes) {
    if (n.kind === 'file') {
      if (n.path.toLowerCase().includes(q)) out.push(n)
    } else {
      const sub = filterTree(n.children, q)
      if (sub.length > 0 || n.name.toLowerCase().includes(q)) {
        out.push({ ...n, children: sub.length > 0 ? sub : n.children })
      }
    }
  }
  return out
}

interface TreeViewProps {
  nodes: TreeNode[]
  depth: number
  selectedPath: string | null
  onSelect: (entry: WikiEntryT) => void
}

function TreeView({ nodes, depth, selectedPath, onSelect }: TreeViewProps): React.ReactElement {
  return (
    <div className="flex flex-col">
      {nodes.map((n) =>
        n.kind === 'folder' ? (
          <FolderNode
            key={n.path}
            node={n}
            depth={depth}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ) : (
          <FileNode
            key={n.path}
            node={n}
            depth={depth}
            selected={selectedPath === n.path}
            onSelect={onSelect}
          />
        )
      )}
    </div>
  )
}

interface FolderNodeProps {
  node: TreeFolder
  depth: number
  selectedPath: string | null
  onSelect: (entry: WikiEntryT) => void
}

function FolderNode({ node, depth, selectedPath, onSelect }: FolderNodeProps): React.ReactElement {
  const [open, setOpen] = useState(depth === 0)
  // Orange pour racine, bleu pour sous-dossiers.
  const colorClass = depth === 0 ? 'text-orange-400' : 'text-blue-400'
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-1 truncate rounded-[var(--radius-sm)] px-1 py-0.5 text-left text-[11px] font-medium hover:bg-[var(--bg-tertiary)] ${colorClass}`}
        style={{ paddingLeft: 4 + depth * 10 }}
        title={node.path}
      >
        <span className="inline-block w-3 text-[9px] opacity-70">{open ? '▾' : '▸'}</span>
        <span className="truncate">{node.name}/</span>
        <span className="ml-auto text-[9px] opacity-60">{node.children.length}</span>
      </button>
      {open && (
        <TreeView
          nodes={node.children}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      )}
    </div>
  )
}

interface FileNodeProps {
  node: TreeFile
  depth: number
  selected: boolean
  onSelect: (entry: WikiEntryT) => void
}

function FileNode({ node, depth, selected, onSelect }: FileNodeProps): React.ReactElement {
  const displayName = node.name.replace(/\.(md|markdown)$/i, '')
  // Fichiers : blanc par défaut, cyan si sélectionné.
  const colorClass = selected
    ? 'text-cyan-400 bg-[var(--bg-tertiary)]'
    : 'text-white hover:text-cyan-300'
  return (
    <button
      type="button"
      onClick={() => onSelect(node.entry)}
      className={`flex w-full items-center gap-1 truncate rounded-[var(--radius-sm)] px-1 py-0.5 text-left text-[11px] hover:bg-[var(--bg-tertiary)] ${colorClass}`}
      style={{ paddingLeft: 4 + depth * 10 + 12 }}
      title={node.path}
    >
      <span className="truncate">{displayName}</span>
    </button>
  )
}

export default function WikiExplorerSidebar({
  collapsed
}: WikiExplorerSidebarProps): React.ReactElement {
  const status = useWikiStore((s) => s.status)
  const setSidebarMode = useWikiStore((s) => s.setSidebarMode)
  const openWikiPage = useWikiStore((s) => s.openWikiPage)
  const openWikiFile = useWikiStore((s) => s.openWikiFile)
  const openPageName = useWikiStore((s) => s.openPageName)
  const openFilePath = useWikiStore((s) => s.openFilePath)

  const [entries, setEntries] = useState<WikiEntryT[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  // Synchronise la sélection avec le viewer wiki global : si l'utilisateur
  // clique un wikilink depuis le chat ou ouvre un fichier ailleurs, on met
  // à jour la surbrillance ici. Pattern render-reset (la lint rule bloque
  // setState dans un effect).
  const activeTarget = openFilePath ?? (openPageName ? `wiki/${openPageName}` : null)
  const [lastActiveTarget, setLastActiveTarget] = useState(activeTarget)
  if (lastActiveTarget !== activeTarget) {
    setLastActiveTarget(activeTarget)
    if (activeTarget) setSelectedPath(activeTarget)
  }

  // Re-fetch quand le statut change (wikiCount, rawCount, initialized).
  // Pattern render-reset pour `loading: true`.
  const [lastSignature, setLastSignature] = useState(
    `${status.wikiCount}:${status.rawCount}:${status.initialized}`
  )
  const currentSignature = `${status.wikiCount}:${status.rawCount}:${status.initialized}`
  if (lastSignature !== currentSignature) {
    setLastSignature(currentSignature)
    if (status.initialized) setLoading(true)
  }

  useEffect(() => {
    if (!status.initialized) return
    let cancelled = false
    window.blow.wiki
      .listAllFiles()
      .then((list) => {
        if (!cancelled) {
          setEntries(list as WikiEntryT[])
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEntries([])
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [status.initialized, status.wikiCount, status.rawCount])

  const tree = useMemo(() => {
    const full = buildTree(entries)
    return filterTree(full, filter.trim().toLowerCase())
  }, [entries, filter])

  const handleSelect = (entry: WikiEntryT): void => {
    setSelectedPath(entry.name)
    if (entry.name.startsWith('wiki/')) {
      // Pages wiki : viewer markdown intégré en mode legacy (readWiki).
      // Strip le préfixe `wiki/` pour que readWiki localise le fichier.
      openWikiPage(entry.name.slice('wiki/'.length))
    } else {
      // Hors wiki/ (SCHEMA.md, log.md, raw/, audit/, …) → même viewer
      // interne mais via readFile/writeFile (chemin complet relatif).
      // Évite que l'OS lance VSCode/Notepad pour chaque clic.
      openWikiFile(entry.name)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header
        className="flex shrink-0 items-center gap-2 border-b px-3 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <button
          type="button"
          onClick={() => setSidebarMode('standard')}
          className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)]"
          title="Retour à la sidebar standard"
          aria-label="Retour"
        >
          ←
        </button>
        {!collapsed && (
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-[var(--fg-muted)]">
            Explorateur wiki
          </h2>
        )}
      </header>

      {!collapsed && (
        <div
          className="shrink-0 border-b px-3 py-2"
          style={{ borderColor: 'var(--border)' }}
        >
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filtrer…"
            className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-[12px] text-[var(--fg-primary)] outline-none focus:border-[var(--fg-secondary)]"
          />
          <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--fg-muted)]">
            <span>
              {entries.length} fichier{entries.length > 1 ? 's' : ''} · {status.wikiCount} wiki ·{' '}
              {status.rawCount} raw
            </span>
            {loading && <span>⏳</span>}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {entries.length === 0 && !loading && (
          <span className="text-[10px] text-[var(--fg-muted)]">
            {collapsed
              ? ''
              : 'Dossier vide. Utilise le chat + ✦ dans la section Mémoire pour construire le wiki.'}
          </span>
        )}
        {!collapsed && tree.length > 0 && (
          <TreeView
            nodes={tree}
            depth={0}
            selectedPath={selectedPath}
            onSelect={handleSelect}
          />
        )}
      </div>
    </div>
  )
}
