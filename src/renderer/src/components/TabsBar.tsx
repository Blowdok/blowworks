import { useEffect, useState } from 'react'
import type { TLPageId } from 'tldraw'
import { useEditorStore } from '../stores/editor-store.js'
import ConfirmDialog from './ConfirmDialog.js'

// Barre d'onglets rendant la liste des pages tldraw — remplace visuellement
// le menu Pages natif (caché via CSS dans `globals.css`). Cliquer sur un
// onglet bascule `editor.setCurrentPage(id)`. L'identifiant de la page
// active est persisté via `ui.activePageId` dans les settings SQLite pour
// restaurer l'onglet au redémarrage de BlowWorks.
//
// Rendue HORS du contexte <Tldraw> (entre Header et InfiniteCanvas pour
// le layout) — elle consomme l'éditeur via `useEditorStore` et s'abonne
// aux changements via `editor.store.listen` plutôt que `useValue`.
//
// CRUD disponible :
//   - `+` crée une nouvelle page
//   - double-clic sur un onglet → renomme
//   - `×` au hover sur un onglet → supprime (si >1 page restante)

const KEY_ACTIVE_PAGE = 'ui.activePageId'

interface PageSummary {
  id: TLPageId
  name: string
}

export default function TabsBar(): React.ReactElement | null {
  const editor = useEditorStore((s) => s.editor)
  const [pages, setPages] = useState<PageSummary[]>([])
  const [currentPageId, setCurrentPageId] = useState<TLPageId | null>(null)
  const [editingId, setEditingId] = useState<TLPageId | null>(null)
  const [draftName, setDraftName] = useState('')
  const [hydrated, setHydrated] = useState(false)
  // Page candidate à la suppression — `null` signifie « aucune modale ouverte ».
  // On stocke id + nom pour afficher le nom dans la modale même si la page
  // disparaît du store entre l'ouverture et la confirmation.
  const [pageToDelete, setPageToDelete] = useState<PageSummary | null>(null)

  // Synchronise l'état local avec le store tldraw : pages + currentPageId.
  // PAS de filtre `scope` : les pages vivent dans le scope `document` mais
  // le `currentPageId` est dans le scope `session` (changements de caméra,
  // sélection, page courante). Écouter sans filtre capture les deux.
  useEffect(() => {
    if (!editor) return
    const refresh = (): void => {
      setPages(editor.getPages().map((p) => ({ id: p.id, name: p.name })))
      setCurrentPageId(editor.getCurrentPageId())
    }
    refresh()
    const dispose = editor.store.listen(refresh)
    return dispose
  }, [editor])

  // Hydrate l'onglet actif depuis les settings SQLite au premier mount.
  useEffect(() => {
    if (!editor || hydrated) return
    void (async () => {
      try {
        const stored = (await window.blow.settings.get(KEY_ACTIVE_PAGE)) as string | null
        if (stored) {
          const exists = editor.getPages().some((p) => p.id === stored)
          if (exists) editor.setCurrentPage(stored as TLPageId)
        }
      } catch {
        /* silencieux : fallback sur la page par défaut de tldraw */
      }
      setHydrated(true)
    })()
  }, [editor, hydrated])

  // Persiste l'onglet actif à chaque changement après hydrate.
  useEffect(() => {
    if (!hydrated || !currentPageId) return
    void window.blow.settings.set(KEY_ACTIVE_PAGE, currentPageId).catch(() => {
      /* best-effort */
    })
  }, [hydrated, currentPageId])

  if (!editor) return null

  function activate(id: TLPageId): void {
    editor!.setCurrentPage(id)
  }

  function createPage(): void {
    const num = pages.length + 1
    editor!.createPage({ name: `Page ${num}` })
    // Bascule automatiquement sur la page nouvellement créée — tldraw
    // ne le fait PAS automatiquement via `createPage`. La nouvelle page
    // est toujours la dernière dans `getPages()` (ordre d'insertion).
    const all = editor!.getPages()
    const created = all[all.length - 1]
    if (created) editor!.setCurrentPage(created.id)
  }

  function requestDeletePage(page: PageSummary, e: React.MouseEvent): void {
    e.stopPropagation()
    if (pages.length <= 1) return
    setPageToDelete(page)
  }

  function confirmDeletePage(): void {
    if (!pageToDelete) return
    // Double-vérification : ne pas supprimer la dernière page restante même
    // si l'état a changé pendant que la modale était ouverte.
    if (editor!.getPages().length > 1) editor!.deletePage(pageToDelete.id)
    setPageToDelete(null)
  }

  function startRename(page: PageSummary, e: React.MouseEvent): void {
    e.stopPropagation()
    setEditingId(page.id)
    setDraftName(page.name)
  }

  function commitRename(): void {
    if (!editingId) return
    const name = draftName.trim()
    if (name.length > 0) editor!.renamePage(editingId, name)
    setEditingId(null)
    setDraftName('')
  }

  return (
    <div
      className="no-drag flex h-9 items-center gap-1 overflow-x-auto border-b-[0.5px] border-[var(--border)] bg-[var(--bg-secondary)] px-2"
      role="tablist"
    >
      {/* Bouton "+" placé AVANT le premier onglet — création rapide
         d'une nouvelle page qui devient immédiatement active. */}
      <button
        type="button"
        onClick={createPage}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border-[0.5px] border-[var(--border)] text-[var(--fg-muted)] transition-colors hover:border-[var(--fg-secondary)] hover:text-[var(--fg-secondary)]"
        title="Nouvelle page"
        aria-label="Créer une nouvelle page"
      >
        +
      </button>
      {pages.map((page) => {
        const isActive = page.id === currentPageId
        const isEditing = editingId === page.id
        return (
          <div
            key={page.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => activate(page.id)}
            onDoubleClick={(e) => startRename(page, e)}
            className={`group flex h-7 min-w-[80px] cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border-[0.5px] px-2 text-xs transition-colors ${
              isActive
                ? 'border-[var(--fg-secondary)] bg-[var(--bg-tertiary)] text-[var(--fg-primary)]'
                : 'border-[var(--border)] text-[var(--fg-muted)] hover:border-[var(--fg-secondary)]/50 hover:text-[var(--fg-primary)]'
            }`}
            title={isActive ? page.name : `Aller à « ${page.name} » (double-clic pour renommer)`}
          >
            {isEditing ? (
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') {
                    setEditingId(null)
                    setDraftName('')
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-24 bg-transparent outline-none"
              />
            ) : (
              <span className="truncate">{page.name}</span>
            )}

            {!isEditing && pages.length > 1 && (
              <button
                type="button"
                onClick={(e) => requestDeletePage(page, e)}
                className="invisible text-[var(--fg-muted)] hover:text-red-400 group-hover:visible"
                aria-label={`Supprimer ${page.name}`}
                title="Supprimer cette page"
              >
                ×
              </button>
            )}
          </div>
        )
      })}

      <ConfirmDialog
        open={pageToDelete !== null}
        title="Supprimer la page"
        message={
          <>
            La page <strong>« {pageToDelete?.name} »</strong> sera supprimée
            avec toutes les shapes qu&apos;elle contient (VSCode, terminaux, notes,
            dessins…). Cette action est irréversible.
          </>
        }
        onCancel={() => setPageToDelete(null)}
        onConfirm={confirmDeletePage}
      />
    </div>
  )
}
