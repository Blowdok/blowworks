import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from 'react'
import { useUIStore } from '../../stores/ui-store.js'
import { useHeaderButtonsStore } from '../../stores/header-buttons-store.js'
import { SEARCH_ENGINES, type SearchEngineId } from '@shared/search-engines.js'
import {
  listFolders,
  type HeaderButton,
  type HeaderButtonEntry,
  type HeaderButtonItem,
  type HeaderButtonFolder
} from '@shared/header-buttons.js'
import ConfirmDialog from '../ConfirmDialog.js'

// Onglet Settings > Navigateur : choix du moteur de recherche par défaut
// utilisé par BrowserShape (homepage des nouvelles shapes + résolution
// des requêtes barre d'URL) + gestion des extensions Chrome chargées dans
// la session `persist:browser`.

interface ExtensionInfo {
  id: string
  name: string
  version: string
  path: string
  manifestUrl: string | null
}

export default function BrowserSettingsTab(): React.ReactElement {
  const searchEngine = useUIStore((s) => s.searchEngine)
  const setSearchEngine = useUIStore((s) => s.setSearchEngine)

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h3 className="text-[14px] font-semibold text-[var(--fg-primary)]">Navigateur</h3>
        <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
          Moteur de recherche par défaut utilisé par les shapes Navigateur.
          S&apos;applique aux nouvelles shapes spawnées et à toute recherche
          tapée dans la barre d&apos;URL. Les shapes déjà ouvertes gardent
          leur page actuelle.
        </p>
        <p className="mt-1 text-[11px] text-[var(--fg-muted)]">
          Note : le webview BlowWorks utilise une session Chromium isolée
          (cookies persistés sur disque, partition <code>persist:browser</code>).
          Pour synchroniser tes préférences Brave Search, connecte-toi à
          ton compte directement dans la shape Navigateur.
        </p>
      </header>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[12px] text-[var(--fg-secondary)]">Moteur</legend>
        {SEARCH_ENGINES.map((engine) => (
          <SearchEngineRadio
            key={engine.id}
            id={engine.id}
            label={engine.label}
            homepage={engine.homepage}
            checked={engine.id === searchEngine}
            onSelect={() => setSearchEngine(engine.id)}
          />
        ))}
      </fieldset>

      <HeaderButtonsSection />

      <ExtensionsSection />
    </div>
  )
}

// ──────────────────────────────────────────────── Boutons du Header

// Demande de suppression en attente. Capturée dans un seul state au
// niveau de `HeaderButtonsSection` puis rendue via le `ConfirmDialog`
// global. `confirm` est le callback qui exécute réellement la mutation
// store (tirée des helpers `useHeaderButtonsStore`) une fois que
// l'utilisateur a validé la modale.
interface DeleteRequest {
  title: string
  message: ReactNode
  // Label personnalisable du bouton de confirmation. Par défaut "Supprimer"
  // car la majorité des cas sont des suppressions ; on peut surcharger
  // pour une action destructive non-suppression (ex. "Restaurer" qui
  // écrase la config courante par le preset).
  confirmLabel?: string
  confirm: () => void
}

const DeleteRequestContext = createContext<((req: DeleteRequest) => void) | null>(
  null
)

function useRequestDelete(): (req: DeleteRequest) => void {
  const ctx = useContext(DeleteRequestContext)
  if (!ctx) {
    throw new Error('useRequestDelete doit être utilisé dans HeaderButtonsSection')
  }
  return ctx
}

// Section de configuration des boutons custom du Header. Chaque bouton
// contient un arbre d'entrées récursif :
//   • Item   → URL terminale ouverte au clic (BrowserShape).
//   • Folder → conteneur récursif, organisationnel uniquement (pas d'URL).
// Profondeur illimitée. Tout est persisté dans SQLite settings, clé
// `header.buttons` — voir le store `useHeaderButtonsStore` et le module
// shared `header-buttons.ts`.
//
// Toute suppression (bouton / dossier / item) passe par une `ConfirmDialog`
// au lieu du `window.confirm` natif : meilleur fond visuel, focus
// automatique sur Annuler, échappement à l'héritage `pointer-events: none`
// du clip container portails (le composant est rendu via createPortal
// vers `document.body`).
function HeaderButtonsSection(): React.ReactElement {
  const buttons = useHeaderButtonsStore((s) => s.buttons)
  const addButton = useHeaderButtonsStore((s) => s.addButton)
  const moveButton = useHeaderButtonsStore((s) => s.moveButton)
  const removeButton = useHeaderButtonsStore((s) => s.removeButton)
  const resetToDefaults = useHeaderButtonsStore((s) => s.resetToDefaults)

  const [pendingDelete, setPendingDelete] = useState<DeleteRequest | null>(null)
  const requestDelete = useCallback((req: DeleteRequest) => {
    setPendingDelete(req)
  }, [])

  const handleAdd = (): void => {
    // Couleur cyan par défaut (cohérente avec la palette BlowWorks). L'utilisateur
    // ajuste ensuite via le color picker de la carte.
    addButton('Nouveau bouton', '#00b8c4')
  }

  return (
    <DeleteRequestContext.Provider value={requestDelete}>
      <section className="flex flex-col gap-2">
        <header className="flex items-baseline justify-between">
          <div>
            <h4 className="text-[12px] font-semibold text-[var(--fg-primary)]">
              Boutons du Header
            </h4>
            <p className="mt-0.5 text-[11px] text-[var(--fg-muted)]">
              Boutons custom dans la barre du haut qui ouvrent une shape Navigateur
              sur l&apos;URL choisie. Tu peux organiser tes liens en{' '}
              <strong>dossiers et sous-dossiers</strong> récursifs : un bouton
              avec 1 seul item = clic direct, sinon menu cascading. Concerne
              uniquement le navigateur web (pas Terminal / VSCode / Chat).
            </p>
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() =>
                requestDelete({
                  title: 'Restaurer les boutons par défaut ?',
                  message: (
                    <>
                      Tous les boutons et leur arborescence actuels seront{' '}
                      <strong>écrasés</strong> par le preset IA d&apos;origine
                      (10 services : ChatGPT, Claude, Gemini, Perplexity, Le Chat,
                      Grok, Copilot, DeepSeek, NotebookLM, HuggingChat). Cette
                      action n&apos;est pas réversible.
                    </>
                  ),
                  confirmLabel: 'Restaurer',
                  confirm: () => resetToDefaults()
                })
              }
              className="rounded border px-2 py-1 text-[11px] hover:bg-[var(--bg-tertiary)]"
              style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
              title="Réinitialise au preset IA (10 services par défaut). Écrase les boutons existants."
            >
              Restaurer défauts
            </button>
            <button
              type="button"
              onClick={handleAdd}
              className="rounded border px-2 py-1 text-[11px] hover:bg-[var(--bg-tertiary)]"
              style={{ borderColor: 'var(--border)', color: 'var(--fg-primary)' }}
            >
              + Ajouter un bouton
            </button>
          </div>
        </header>

        {buttons.length === 0 ? (
          <div
            className="rounded border px-3 py-3 text-[11px] text-[var(--fg-muted)]"
            style={{ borderColor: 'var(--border)' }}
          >
            Aucun bouton configuré. Clique sur <em>+ Ajouter un bouton</em> ou{' '}
            <em>Restaurer défauts</em> pour repartir du preset IA (ChatGPT, Claude,
            Gemini, etc.).
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {buttons.map((b, idx) => (
              <HeaderButtonCard
                key={b.id}
                button={b}
                isFirst={idx === 0}
                isLast={idx === buttons.length - 1}
                onMoveUp={() => moveButton(b.id, -1)}
                onMoveDown={() => moveButton(b.id, 1)}
                onRemove={() => {
                  const totalEntries = countEntries(b.entries)
                  requestDelete({
                    title: `Supprimer le bouton « ${b.label} » ?`,
                    message:
                      totalEntries === 0 ? (
                        <>
                          Le bouton sera retiré du Header. Aucune entrée ne sera
                          perdue (le bouton est vide).
                        </>
                      ) : (
                        <>
                          Le bouton et son arborescence (
                          <strong>
                            {totalEntries} entrée{totalEntries > 1 ? 's' : ''}
                          </strong>{' '}
                          : items + dossiers) seront supprimés. Les sites web ne
                          sont pas touchés (les sessions et favoris du navigateur
                          intégré restent intacts).
                        </>
                      ),
                    confirm: () => removeButton(b.id)
                  })
                }}
              />
            ))}
          </ul>
        )}
      </section>
      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.title ?? ''}
        message={pendingDelete?.message ?? ''}
        confirmLabel={pendingDelete?.confirmLabel ?? 'Supprimer'}
        onConfirm={() => {
          pendingDelete?.confirm()
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </DeleteRequestContext.Provider>
  )
}

function countEntries(entries: readonly HeaderButtonEntry[]): number {
  let n = 0
  for (const e of entries) {
    n += 1
    if (e.kind === 'folder') n += countEntries(e.children)
  }
  return n
}

function HeaderButtonCard({
  button,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onRemove
}: {
  button: HeaderButton
  isFirst: boolean
  isLast: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
}): React.ReactElement {
  const updateButton = useHeaderButtonsStore((s) => s.updateButton)
  const addItem = useHeaderButtonsStore((s) => s.addItem)
  const addFolder = useHeaderButtonsStore((s) => s.addFolder)
  // État replié persistant (Set partagé avec les dossiers — boutons et
  // dossiers ont des préfixes d'ids distincts, pas de collision).
  const collapsed = useHeaderButtonsStore((s) => s.collapsedIds.has(button.id))
  const toggleCollapsed = useHeaderButtonsStore((s) => s.toggleCollapsed)

  return (
    <li
      className="flex flex-col gap-2 rounded border p-2"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-primary)' }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => toggleCollapsed(button.id)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
          title={collapsed ? 'Déplier' : 'Replier'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
          style={{ background: button.color }}
        >
          {button.label.trim()[0]?.toUpperCase() ?? '?'}
        </span>
        <input
          type="text"
          value={button.label}
          onChange={(e) => updateButton(button.id, { label: e.target.value })}
          placeholder="Libellé"
          className="flex-1 rounded border bg-transparent px-2 py-1 text-[12px]"
          style={{ borderColor: 'var(--border)', color: 'var(--fg-primary)' }}
        />
        <input
          type="color"
          value={normalizeHex(button.color)}
          onChange={(e) => updateButton(button.id, { color: e.target.value })}
          title="Couleur de la pastille"
          className="h-7 w-10 cursor-pointer rounded border bg-transparent"
          style={{ borderColor: 'var(--border)' }}
        />
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)] disabled:opacity-30"
          title="Monter"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)] disabled:opacity-30"
          title="Descendre"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[#fca5a5]"
          title="Supprimer ce bouton"
        >
          ✕
        </button>
      </div>

      {/* Arbre récursif des entrées (items + dossiers) + boutons d'ajout.
          Cachés quand le bouton est replié — l'utilisateur retrouve une
          vue compacte qui ne montre que la ligne de configuration du
          bouton lui-même (label, couleur, ↑↓, ✕). La racine du bouton
          se traite comme un "dossier virtuel" — folderId = null = entries
          directs du bouton. */}
      {!collapsed && (
        <>
          <EntryList
            button={button}
            entries={button.entries}
            parentFolderId={null}
            depth={0}
          />

          <div className="flex gap-1.5 pl-4">
            <button
              type="button"
              onClick={() =>
                addItem(button.id, null, {
                  label: 'Nouvel item',
                  url: 'https://example.com/'
                })
              }
              className="rounded border px-2 py-1 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
              style={{ borderColor: 'var(--border)' }}
            >
              + Ajouter un item
            </button>
            <button
              type="button"
              onClick={() => addFolder(button.id, null, 'Nouveau dossier')}
              className="rounded border px-2 py-1 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
              style={{ borderColor: 'var(--border)' }}
            >
              + Ajouter un dossier
            </button>
          </div>
        </>
      )}
    </li>
  )
}

// Liste récursive des entrées au sein d'un bouton, pour un parent donné.
// Affiche items et dossiers ; chaque dossier expose ses propres enfants
// via une `EntryList` enfant. Indentation visuelle via `depth × padding`.
function EntryList({
  button,
  entries,
  parentFolderId,
  depth
}: {
  button: HeaderButton
  entries: readonly HeaderButtonEntry[]
  parentFolderId: string | null
  depth: number
}): React.ReactElement {
  if (entries.length === 0 && parentFolderId !== null) {
    return (
      <div
        className="ml-2 rounded border-l-2 px-2 py-1 text-[11px] italic text-[var(--fg-muted)]"
        style={{ borderColor: 'var(--border)' }}
      >
        Dossier vide — ajoute un item ou un sous-dossier ci-dessous.
      </div>
    )
  }
  return (
    <ul
      className="flex flex-col gap-1.5"
      style={{ paddingLeft: parentFolderId === null ? 16 : 0 }}
    >
      {entries.map((entry, idx) =>
        entry.kind === 'item' ? (
          <HeaderButtonItemRow
            key={entry.id}
            button={button}
            item={entry}
            parentFolderId={parentFolderId}
            isFirst={idx === 0}
            isLast={idx === entries.length - 1}
            depth={depth}
          />
        ) : (
          <HeaderButtonFolderRow
            key={entry.id}
            button={button}
            folder={entry}
            parentFolderId={parentFolderId}
            isFirst={idx === 0}
            isLast={idx === entries.length - 1}
            depth={depth}
          />
        )
      )}
    </ul>
  )
}

function HeaderButtonItemRow({
  button,
  item,
  parentFolderId,
  isFirst,
  isLast,
  depth
}: {
  button: HeaderButton
  item: HeaderButtonItem
  parentFolderId: string | null
  isFirst: boolean
  isLast: boolean
  depth: number
}): React.ReactElement {
  const updateEntry = useHeaderButtonsStore((s) => s.updateEntry)
  const removeEntryAction = useHeaderButtonsStore((s) => s.removeEntry)
  const moveEntry = useHeaderButtonsStore((s) => s.moveEntry)
  const requestDelete = useRequestDelete()

  return (
    <li
      className="flex items-center gap-1.5"
      style={{ paddingLeft: depth * 16 }}
    >
      <input
        type="text"
        value={item.label}
        onChange={(e) => updateEntry(button.id, item.id, { label: e.target.value })}
        placeholder="Libellé"
        className="w-32 rounded border bg-transparent px-2 py-1 text-[11px]"
        style={{ borderColor: 'var(--border)', color: 'var(--fg-primary)' }}
      />
      <input
        type="url"
        value={item.url}
        onChange={(e) => updateEntry(button.id, item.id, { url: e.target.value })}
        placeholder="https://..."
        className="flex-1 rounded border bg-transparent px-2 py-1 font-mono text-[11px]"
        style={{ borderColor: 'var(--border)', color: 'var(--fg-primary)' }}
      />
      <input
        type="text"
        value={item.tagline ?? ''}
        onChange={(e) =>
          updateEntry(button.id, item.id, {
            tagline: e.target.value.length > 0 ? e.target.value : undefined
          })
        }
        placeholder="Sous-titre (optionnel)"
        className="w-32 rounded border bg-transparent px-2 py-1 text-[11px]"
        style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
      />
      <MoveToFolderPicker button={button} entryId={item.id} />
      <button
        type="button"
        onClick={() => moveEntry(button.id, parentFolderId, item.id, -1)}
        disabled={isFirst}
        className="rounded px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)] disabled:opacity-30"
        title="Monter"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => moveEntry(button.id, parentFolderId, item.id, 1)}
        disabled={isLast}
        className="rounded px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)] disabled:opacity-30"
        title="Descendre"
      >
        ↓
      </button>
      <button
        type="button"
        onClick={() =>
          requestDelete({
            title: `Supprimer l'item « ${item.label || '(sans nom)'} » ?`,
            message: (
              <>
                L&apos;item ouvre <code>{item.url || '(URL vide)'}</code>. Cette
                action retire uniquement le raccourci du Header — la session du
                navigateur intégré, les favoris et l&apos;historique ne sont pas
                touchés.
              </>
            ),
            confirm: () => removeEntryAction(button.id, item.id)
          })
        }
        className="rounded px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[#fca5a5]"
        title="Supprimer cet item"
      >
        ✕
      </button>
    </li>
  )
}

function HeaderButtonFolderRow({
  button,
  folder,
  parentFolderId,
  isFirst,
  isLast,
  depth
}: {
  button: HeaderButton
  folder: HeaderButtonFolder
  parentFolderId: string | null
  isFirst: boolean
  isLast: boolean
  depth: number
}): React.ReactElement {
  // État replié persistant : on s'abonne au Set du store (égalité
  // référentielle stable d'une mutation à l'autre car le toggle remplace
  // le Set) puis on dérive `collapsed` localement. Persisté en SQLite
  // sous la clé `header.collapsedFolders` séparée des boutons eux-mêmes.
  // Set partagé avec les boutons (les ids `hbe_*` ne se chevauchent pas
  // avec les ids `hb_*` des boutons).
  const collapsed = useHeaderButtonsStore((s) => s.collapsedIds.has(folder.id))
  const toggleCollapsed = useHeaderButtonsStore((s) => s.toggleCollapsed)
  const updateEntry = useHeaderButtonsStore((s) => s.updateEntry)
  const removeEntryAction = useHeaderButtonsStore((s) => s.removeEntry)
  const moveEntry = useHeaderButtonsStore((s) => s.moveEntry)
  const addItem = useHeaderButtonsStore((s) => s.addItem)
  const addFolder = useHeaderButtonsStore((s) => s.addFolder)
  const requestDelete = useRequestDelete()

  const childCount = folder.children.length
  // Compteur récursif (items + sous-dossiers) — sert au message de la
  // modale pour distinguer "dossier vide" / "dossier avec sous-arbre".
  const totalDescendants = countEntries(folder.children)

  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5" style={{ paddingLeft: depth * 16 }}>
        <button
          type="button"
          onClick={() => toggleCollapsed(folder.id)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
          title={collapsed ? 'Déplier' : 'Replier'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px]"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--fg-muted)' }}
        >
          📁
        </span>
        <input
          type="text"
          value={folder.label}
          onChange={(e) =>
            updateEntry(button.id, folder.id, { label: e.target.value })
          }
          placeholder="Nom du dossier"
          className="flex-1 rounded border bg-transparent px-2 py-1 text-[11px] font-medium"
          style={{ borderColor: 'var(--border)', color: 'var(--fg-primary)' }}
        />
        <span className="text-[10px] text-[var(--fg-muted)]">
          {childCount} entrée{childCount > 1 ? 's' : ''}
        </span>
        <MoveToFolderPicker button={button} entryId={folder.id} />
        <button
          type="button"
          onClick={() => moveEntry(button.id, parentFolderId, folder.id, -1)}
          disabled={isFirst}
          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)] disabled:opacity-30"
          title="Monter"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => moveEntry(button.id, parentFolderId, folder.id, 1)}
          disabled={isLast}
          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)] disabled:opacity-30"
          title="Descendre"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={() =>
            requestDelete({
              title: `Supprimer le dossier « ${folder.label || '(sans nom)'} » ?`,
              message:
                childCount === 0 ? (
                  <>Le dossier est vide. Il sera retiré du bouton.</>
                ) : (
                  <>
                    Le dossier et son contenu (
                    <strong>
                      {totalDescendants} entrée{totalDescendants > 1 ? 's' : ''}
                    </strong>{' '}
                    : items + sous-dossiers) seront supprimés{' '}
                    <strong>récursivement</strong>. Les sites web ne sont pas
                    touchés (les sessions et favoris du navigateur intégré
                    restent intacts).
                  </>
                ),
              confirm: () => removeEntryAction(button.id, folder.id)
            })
          }
          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[#fca5a5]"
          title="Supprimer ce dossier"
        >
          ✕
        </button>
      </div>

      {!collapsed && (
        <>
          <EntryList
            button={button}
            entries={folder.children}
            parentFolderId={folder.id}
            depth={depth + 1}
          />
          <div className="flex gap-1.5" style={{ paddingLeft: (depth + 1) * 16 + 8 }}>
            <button
              type="button"
              onClick={() =>
                addItem(button.id, folder.id, {
                  label: 'Nouvel item',
                  url: 'https://example.com/'
                })
              }
              className="rounded border px-2 py-0.5 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
              style={{ borderColor: 'var(--border)' }}
            >
              + Item
            </button>
            <button
              type="button"
              onClick={() => addFolder(button.id, folder.id, 'Sous-dossier')}
              className="rounded border px-2 py-0.5 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
              style={{ borderColor: 'var(--border)' }}
            >
              + Dossier
            </button>
          </div>
        </>
      )}
    </li>
  )
}

// Sélecteur "Déplacer vers..." : liste tous les dossiers du bouton +
// la racine. Bloque silencieusement les déplacements vers un descendant
// (cycle) — gardé côté store, mais on filtre aussi côté UI pour éviter
// d'afficher l'option en grisé inutilement.
function MoveToFolderPicker({
  button,
  entryId
}: {
  button: HeaderButton
  entryId: string
}): React.ReactElement {
  const moveEntryToFolder = useHeaderButtonsStore((s) => s.moveEntryToFolder)
  const folders = listFolders(button.entries)

  return (
    <select
      value=""
      onChange={(e) => {
        const v = e.target.value
        if (v === '') return
        const target = v === '__root__' ? null : v
        moveEntryToFolder(button.id, entryId, target)
        // Reset à la valeur vide pour que le select reste sur "Déplacer..."
        e.target.value = ''
      }}
      className="rounded border bg-transparent px-1 py-0.5 text-[10px]"
      style={{
        borderColor: 'var(--border)',
        color: 'var(--fg-muted)',
        maxWidth: 110
      }}
      title="Déplacer cette entrée vers un autre dossier"
    >
      <option value="">↳ Déplacer…</option>
      {folders.map((f) => (
        <option key={f.id ?? '__root__'} value={f.id ?? '__root__'}>
          {'  '.repeat(f.depth)}
          {f.path}
        </option>
      ))}
    </select>
  )
}

// L'input `type="color"` n'accepte QUE des hex 6-digits stricts (`#rrggbb`).
// On ramène toute couleur stockée (qui peut venir d'une saisie libre dans
// une version ultérieure ou d'un preset) vers ce format avant de la passer
// au picker, sinon le navigateur tombe silencieusement à #000.
function normalizeHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    const [, r, g, b] = color
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return '#00b8c4'
}

// ──────────────────────────────────────────────────────────── Extensions

function ExtensionsSection(): React.ReactElement {
  const [exts, setExts] = useState<ExtensionInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await window.blow.browser.extensions.list()
      setExts(list)
    } catch (err) {
      console.warn('[browser-settings] list extensions échoué', err)
    }
  }, [])

  // Pattern annulable : un fetch lent ne peut pas écraser un montage
  // démonté ou un fetch ultérieur (StrictMode-safe).
  useEffect(() => {
    let cancelled = false
    window.blow.browser.extensions
      .list()
      .then((list) => {
        if (!cancelled) setExts(list)
      })
      .catch((err) => {
        console.warn('[browser-settings] list extensions échoué', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onInstall = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const folder = await window.blow.dialog.pickFolder({
        title: "Choisir un dossier d'extension Chrome (manifest.json à la racine)"
      })
      if (!folder) {
        setBusy(false)
        return
      }
      const result = await window.blow.browser.extensions.load(folder)
      if (!result.ok) {
        setError(result.error)
      } else {
        await refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const onRemove = async (id: string): Promise<void> => {
    setError(null)
    const result = await window.blow.browser.extensions.remove(id)
    if (!result.ok) {
      setError(result.error ?? "Suppression échouée.")
    }
    await refresh()
  }

  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-baseline justify-between">
        <div>
          <h4 className="text-[12px] font-semibold text-[var(--fg-primary)]">
            Extensions Chrome
          </h4>
          <p className="mt-0.5 text-[11px] text-[var(--fg-muted)]">
            Chargées dans la session des shapes Navigateur. Support complet
            MV2, partiel MV3 (service workers OK, certains <code>chrome.*</code>{' '}
            APIs limités).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onInstall()}
          disabled={busy}
          className="rounded border px-2 py-1 text-[11px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          style={{
            borderColor: 'var(--border)',
            color: 'var(--fg-primary)'
          }}
        >
          {busy ? 'Installation…' : 'Installer un dossier…'}
        </button>
      </header>

      {error && (
        <div
          className="rounded border px-2 py-1.5 text-[11px]"
          style={{
            borderColor: '#7f1d1d',
            background: '#1f0a0a',
            color: '#fca5a5'
          }}
        >
          {error}
        </div>
      )}

      {exts.length === 0 ? (
        <div
          className="rounded border px-3 py-3 text-[11px] text-[var(--fg-muted)]"
          style={{ borderColor: 'var(--border)' }}
        >
          Aucune extension installée. Place un dossier d&apos;extension décompressé
          (avec <code>manifest.json</code> à la racine) puis clique sur{' '}
          <em>Installer un dossier</em>. Le redémarrage de BlowWorks rechargera
          automatiquement les extensions placées dans{' '}
          <code>userData/extensions/</code>.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {exts.map((ext) => (
            <li
              key={ext.id}
              className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-[11px]"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-[var(--fg-primary)]">
                  {ext.name}
                </div>
                <div className="truncate text-[10px] text-[var(--fg-muted)]">
                  v{ext.version} · <span className="font-mono">{ext.id}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void onRemove(ext.id)}
                className="rounded px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
                title="Désinstaller"
              >
                Désinstaller
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[10px] text-[var(--fg-muted)]">
        Astuce : un changement d&apos;extension prend effet au prochain
        rechargement de la page dans la shape Navigateur.
      </p>
    </section>
  )
}

function SearchEngineRadio({
  id,
  label,
  homepage,
  checked,
  onSelect
}: {
  id: SearchEngineId
  label: string
  homepage: string
  checked: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <label
      className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] border px-3 py-2 transition-colors"
      style={{
        borderColor: checked ? 'var(--fg-secondary)' : 'var(--border)',
        background: checked ? 'var(--bg-tertiary)' : 'transparent'
      }}
    >
      <input
        type="radio"
        name="search-engine"
        value={id}
        checked={checked}
        onChange={onSelect}
        className="h-3.5 w-3.5 shrink-0 accent-[var(--fg-secondary)]"
      />
      <div className="flex min-w-0 flex-col">
        <span
          className="text-[12px]"
          style={{
            color: checked ? 'var(--fg-secondary)' : 'var(--fg-primary)',
            fontWeight: checked ? 600 : 400
          }}
        >
          {label}
        </span>
        <span className="truncate text-[10px] text-[var(--fg-muted)]">
          {stripScheme(homepage)}
        </span>
      </div>
    </label>
  )
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}
