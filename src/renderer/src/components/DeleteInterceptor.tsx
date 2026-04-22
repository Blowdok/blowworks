import { useCallback, useEffect, useRef, useState } from 'react'
import type { TLShape, TLShapeId } from 'tldraw'
import { useEditorStore } from '../stores/editor-store.js'
import ConfirmDialog from './ConfirmDialog.js'

// Intercepte TOUTE suppression de shape portail (`vscode` / `terminal` /
// `chat` / `browser`) pour afficher une modale de confirmation centralisée.
// Un seul point d'écoute couvre simultanément tous les déclencheurs tldraw :
//
// - Touche Delete / Backspace.
// - Option « Delete » du menu contextuel natif tldraw (clic droit).
// - Bouton poubelle de la barre d'actions tldraw (`.tlui-menu-zone`
//   flottante dans le canvas — undo / poubelle / copier / menu ⋯).
// - Appels programmatiques à `editor.deleteShapes(...)`.
//
// Les shapes natives tldraw (geo, arrow, note, draw, etc.) ne sont PAS
// interceptées : leur suppression reste immédiate, comportement attendu
// pour des annotations légères. Seules les fenêtres portail (qui
// embarquent un PTY vivant ou une iframe VSCode lourde) passent par la
// modale.

export default function DeleteInterceptor(): React.ReactElement | null {
  const editor = useEditorStore((s) => s.editor)
  const [pending, setPending] = useState<{
    ids: TLShapeId[]
    hasVSCode: boolean
    hasTerminal: boolean
    hasChat: boolean
    hasBrowser: boolean
  } | null>(null)
  // Drapeau qui permet à la 2ᵉ passe (après confirmation) de laisser
  // tldraw réellement supprimer. Sans ce bypass, le handler re-bloquerait
  // la suppression et on boucle.
  const bypassRef = useRef(false)

  useEffect(() => {
    if (!editor) return

    // tldraw invoque le handler pour CHAQUE shape supprimée dans un même
    // appel. On accumule sur un microtask puis on ouvre la modale UNE
    // fois avec tout le lot — évite N modales en cascade.
    let batch: TLShape[] = []
    let scheduled = false

    const flush = (): void => {
      scheduled = false
      if (batch.length === 0) return
      const collected = batch
      batch = []
      setPending({
        ids: collected.map((s) => s.id),
        hasVSCode: collected.some((s) => s.type === 'vscode'),
        hasTerminal: collected.some((s) => s.type === 'terminal'),
        hasChat: collected.some((s) => s.type === 'chat'),
        hasBrowser: collected.some((s) => s.type === 'browser')
      })
    }

    const off = editor.sideEffects.registerBeforeDeleteHandler(
      'shape',
      (shape) => {
        if (bypassRef.current) return
        if (
          shape.type !== 'vscode' &&
          shape.type !== 'terminal' &&
          shape.type !== 'chat' &&
          shape.type !== 'browser'
        ) return
        batch.push(shape)
        if (!scheduled) {
          scheduled = true
          queueMicrotask(flush)
        }
        return false
      }
    )

    return () => {
      off()
    }
  }, [editor])

  const handleConfirm = useCallback(() => {
    if (!editor || !pending) return
    // Récupère les IDs de ChatShape AVANT suppression tldraw pour purger
    // la conversation côté DB (CASCADE supprimera les messages).
    const chatIds: string[] = []
    for (const id of pending.ids) {
      const s = editor.getShape(id)
      if (s && s.type === 'chat') chatIds.push(s.id)
    }
    bypassRef.current = true
    try {
      editor.deleteShapes(pending.ids)
    } finally {
      bypassRef.current = false
    }
    // Purge DB en best-effort après la suppression tldraw. On tolère les
    // erreurs silencieuses : la shape a déjà disparu de la UI, la
    // conversation orpheline est inoffensive (réservation SQLite mineure).
    for (const id of chatIds) {
      void window.blow.ai.deleteConversation(id).catch(() => {})
    }
    setPending(null)
  }, [editor, pending])

  const handleCancel = useCallback(() => {
    setPending(null)
  }, [])

  if (!pending) return null

  const count = pending.ids.length

  return (
    <ConfirmDialog
      open={true}
      title={count === 1 ? 'Supprimer la fenêtre' : `Supprimer ${count} fenêtres`}
      message={
        <>
          {count === 1 ? (
            <>La fenêtre sélectionnée va être supprimée.</>
          ) : (
            <>
              Les <strong>{count}</strong> fenêtres sélectionnées vont être
              supprimées.
            </>
          )}{' '}
          {pending.hasTerminal && (
            <>
              Les processus PTY des terminaux seront tués et le scrollback
              affiché sera perdu — les processus attachés via{' '}
              <code>tmux</code> ou <code>screen</code> continuent de tourner
              côté système.{' '}
            </>
          )}
          {pending.hasVSCode && (
            <>
              Les fenêtres VSCode disparaissent du canvas mais{' '}
              <code>openvscode-server</code> reste vivant — aucun fichier
              non sauvegardé n&apos;est perdu côté éditeur.{' '}
            </>
          )}
          {pending.hasChat && (
            <>
              Les conversations IA seront <strong>définitivement supprimées</strong>{' '}
              avec tous leurs messages. Un stream en cours est interrompu.{' '}
            </>
          )}
          {pending.hasBrowser && (
            <>
              Les onglets du navigateur web seront fermés. La session partagée
              (cookies, logins) reste intacte pour les prochains navigateurs
              que vous ouvrirez.{' '}
            </>
          )}
          Cette action est annulable via <code>Ctrl+Z</code>{' '}
          {pending.hasChat && (
            <em>(sauf pour les messages des conversations IA)</em>
          )}.
        </>
      }
      onCancel={handleCancel}
      onConfirm={handleConfirm}
    />
  )
}
