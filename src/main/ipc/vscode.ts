import { ipcMain } from 'electron'
import { IPC_CHANNELS, VSCodeOpenInput } from '@shared/ipc-contract.js'
import { vscodeServer } from '../services/vscode-server.js'

export function registerVSCodeHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.vscode.status, async () => {
    const status = await vscodeServer.ensureStarted()
    return { running: status.running, port: status.port, token: status.token }
  })

  ipcMain.handle(IPC_CHANNELS.vscode.openFolder, async (_evt, raw) => {
    const input = VSCodeOpenInput.parse(raw)
    const status = await vscodeServer.ensureStarted()
    if (!status.running || status.port === null) {
      return {
        ok: false as const,
        reason: 'sidecar-indisponible',
        detail: vscodeServer.getLastError()
      }
    }
    // Format attendu par `code-tunnel.exe serve-web` : chemin absolu du
    // filesystem serveur, sans scheme. Le workbench web préfixe lui-même
    // l'authority `vscode-remote://` en interne avant de résoudre.
    //   - `file:///C:/...` échoue ("Workspace does not exist") car interprété
    //      comme fichier local navigateur → inaccessible en mode remote.
    //   - `C:/Users/...` échoue : `URI.parse` prend `C` comme scheme.
    //   - `/C:/Users/...` fonctionne : path absolu sans scheme, le workbench
    //      ajoute son authority automatiquement.
    const normalized = input.folder.replace(/\\/g, '/')
    const folderPath = normalized.startsWith('/') ? normalized : '/' + normalized
    // Pas de `tkn` : le serveur est démarré avec `--without-connection-token`.
    return {
      ok: true as const,
      url: `http://127.0.0.1:${status.port}/?folder=${encodeURIComponent(folderPath)}`
    }
  })
}
