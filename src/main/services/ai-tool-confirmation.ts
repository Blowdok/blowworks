// Gestionnaire de confirmations de tools (pattern nexusvault_v4).
//
// Quand streamChat détecte un tool_call destructif (write/rename/delete),
// il appelle `awaitConfirmation(toolCallId)` qui retourne une Promise.
// En parallèle, il broadcast au renderer un event `toolConfirmNeeded`.
// Le renderer affiche un dialog. L'utilisateur approuve ou refuse →
// ipcRenderer.invoke('ai.confirmToolCall', {id, approved}) côté renderer
// → handler main appelle `resolveConfirmation(id, approved)` qui débloque
// le await.
//
// Timeout : 5 minutes. Si l'utilisateur ne répond pas, on refuse par
// défaut (sécurité) et le modèle reçoit un tool_result d'erreur.

interface PendingEntry {
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingEntry>()
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

// Attend la décision utilisateur pour le tool call `id`. Retourne true
// si approuvé, false si refusé ou timeout.
export function awaitToolConfirmation(
  id: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  // Cleanup d'une entrée orpheline portant le même id (cas où un stream
  // précédent a laissé un pending pas résolu — ne devrait pas arriver
  // mais défensif).
  const existing = pending.get(id)
  if (existing) {
    clearTimeout(existing.timer)
    existing.resolve(false)
    pending.delete(id)
  }

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const entry = pending.get(id)
      if (entry) {
        pending.delete(id)
        entry.resolve(false)
      }
    }, timeoutMs)
    pending.set(id, { resolve, timer })
  })
}

// Résout la Promise en attente. Appelé par le handler IPC quand le
// renderer envoie la décision utilisateur. Retourne true si l'id était
// connu, false s'il a expiré (timeout déjà passé) ou n'existe pas.
export function resolveToolConfirmation(id: string, approved: boolean): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  clearTimeout(entry.timer)
  pending.delete(id)
  entry.resolve(approved)
  return true
}

// Annule toutes les confirmations en attente. Utilisé au cancelStream
// pour ne pas laisser de Promises orphelines quand l'utilisateur annule.
export function cancelAllToolConfirmations(): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.resolve(false)
  }
  pending.clear()
}
