import { app, dialog, BrowserWindow } from 'electron'
import type { MessageBoxOptions } from 'electron'
// electron-updater est un module CommonJS : dans le build de production (ESM),
// l'import nommé `{ autoUpdater }` échoue au runtime (« Named export not found »).
// On importe donc le module par défaut, puis on en extrait `autoUpdater`.
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

// Mises à jour automatiques via electron-updater + Releases GitHub.
//
// Au démarrage (production uniquement), on vérifie s'il existe une version plus
// récente publiée sur GitHub, on la télécharge en arrière-plan, puis on propose
// à l'utilisateur de redémarrer pour l'appliquer. En développement, aucune
// vérification : il n'y a pas de version installée à comparer, et electron-
// updater lèverait une erreur faute de fichier `app-update.yml`.
export function initAutoUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  // Mise à jour téléchargée → on laisse l'utilisateur choisir le moment.
  autoUpdater.on('update-downloaded', async (info) => {
    const win = BrowserWindow.getAllWindows()[0]
    const options: MessageBoxOptions = {
      type: 'info',
      buttons: ['Redémarrer maintenant', 'Plus tard'],
      defaultId: 0,
      cancelId: 1,
      title: 'Mise à jour disponible',
      message: `BlowWorks ${info.version} est prêt à être installé.`,
      detail:
        "Redémarrez pour appliquer la mise à jour. Sinon, elle s'installera automatiquement à la prochaine fermeture de l'application."
    }
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    if (response === 0) autoUpdater.quitAndInstall()
  })

  // Erreurs réseau / API : on log sans déranger l'utilisateur.
  autoUpdater.on('error', (err) => {
    console.error('[auto-update] erreur :', err instanceof Error ? err.message : err)
  })

  autoUpdater.checkForUpdates().catch((err) => {
    console.error(
      '[auto-update] échec de la vérification :',
      err instanceof Error ? err.message : err
    )
  })
}
