// Noms canoniques des canaux IPC (main ⇄ preload ⇄ renderer).
// Ce fichier est volontairement SANS dépendance externe (pas de zod) pour
// pouvoir être importé par le preload sandboxé d'Electron, qui refuse tout
// `require()` de package npm.
export const IPC_CHANNELS = {
  project: {
    list: 'project.list',
    create: 'project.create',
    update: 'project.update',
    delete: 'project.delete'
  },
  terminal: {
    spawn: 'terminal.spawn',
    write: 'terminal.write',
    resize: 'terminal.resize',
    kill: 'terminal.kill',
    persist: 'terminal.persist',
    restore: 'terminal.restore',
    dataEvent: 'terminal.data',
    exitEvent: 'terminal.exit'
  },
  vscode: {
    status: 'vscode.status',
    openFolder: 'vscode.openFolder'
  },
  // Explorateur de fichiers embarqué dans le canvas (ExplorerShape).
  // Toutes les opérations passent par le main pour accéder au filesystem
  // — le renderer sandboxé n'a pas accès direct à `fs`.
  fs: {
    list: 'fs.list',
    quickAccess: 'fs.quickAccess',
    open: 'fs.open',
    rename: 'fs.rename',
    trash: 'fs.trash',
    openInExplorer: 'fs.openInExplorer',
    // Affiche le menu shell Windows COMPLET (extensions installées : 7-Zip,
    // Git, "Ouvrir avec…", "Propriétés", "Partager…", etc.) au point écran
    // donné. Bloque pendant la sélection puis InvokeCommand sur la verb
    // choisie. Win32 only.
    shellContextMenu: 'fs.shellContextMenu'
  },
  canvas: {
    saveSnapshot: 'canvas.saveSnapshot',
    loadSnapshot: 'canvas.loadSnapshot'
  },
  settings: {
    get: 'settings.get',
    set: 'settings.set'
  },
  dialog: {
    pickFolder: 'dialog.pickFolder',
    pickImage: 'dialog.pickImage'
  },
  github: {
    setToken: 'github.setToken',
    getStatus: 'github.getStatus',
    disconnect: 'github.disconnect',
    reconnect: 'github.reconnect',
    forgetToken: 'github.forgetToken',
    startDeviceFlow: 'github.startDeviceFlow',
    completeDeviceFlow: 'github.completeDeviceFlow'
  },
  ai: {
    sendMessage: 'ai.sendMessage',
    cancelStream: 'ai.cancelStream',
    listModels: 'ai.listModels',
    chunkEvent: 'ai.chunk',
    setApiKey: 'ai.setApiKey',
    getApiKeyStatus: 'ai.getApiKeyStatus',
    getDefaults: 'ai.getDefaults',
    setDefaults: 'ai.setDefaults',
    getConversation: 'ai.getConversation',
    createConversation: 'ai.createConversation',
    updateConversation: 'ai.updateConversation',
    listConversations: 'ai.listConversations',
    deleteConversation: 'ai.deleteConversation',
    // Réveil d'un await côté main après que l'utilisateur a tranché
    // un dialog de confirmation tool (write/rename/delete). Le payload
    // est `{ toolCallId, approved }`.
    confirmToolCall: 'ai.confirmToolCall',
    // Persiste la timeline entrelacée d'un message assistant après fin
    // de stream. Appelé une seule fois par message (juste après que le
    // refetch a révélé son id). Payload `{ messageId, segmentsJson }`.
    saveMessageSegments: 'ai.saveMessageSegments'
  },
  browser: {
    // Push main → renderer : demander l'ouverture d'une URL dans une
    // nouvelle BrowserShape. Émis depuis `setWindowOpenHandler` et
    // `will-navigate` (voir `src/main/window.ts`).
    openUrlEvent: 'browser.openUrl',
    // Historique global (toutes shapes confondues, partagé entre projets).
    // `record` retourne l'id de l'entrée créée pour permettre au renderer
    // de patcher titre/favicon plus tard (les events Chromium arrivent
    // décorrélés de did-navigate).
    historyRecord: 'browser.history.record',
    historyPatch: 'browser.history.patch',
    historyList: 'browser.history.list',
    historyDelete: 'browser.history.delete',
    historyClear: 'browser.history.clear',
    // Favoris globaux (toggle par URL). Push event pour que toutes les
    // shapes mettent à jour leur étoile en temps réel quand un favori
    // est ajouté/retiré depuis n'importe quelle autre shape.
    bookmarkToggle: 'browser.bookmark.toggle',
    bookmarkList: 'browser.bookmark.list',
    bookmarkDelete: 'browser.bookmark.delete',
    bookmarkUpdate: 'browser.bookmark.update',
    bookmarkChangedEvent: 'browser.bookmark.changed',
    // Téléchargements (Palier 2). Capturés côté main via
    // session.on('will-download') sur la partition persist:browser.
    downloadList: 'browser.download.list',
    downloadCancel: 'browser.download.cancel',
    downloadOpen: 'browser.download.open',
    downloadShowInFolder: 'browser.download.showInFolder',
    downloadClear: 'browser.download.clear',
    downloadProgressEvent: 'browser.download.progress',
    // Extensions Chrome (Palier 3) — chargées au boot depuis
    // userData/extensions/ via session.loadExtension().
    extensionList: 'browser.extension.list',
    extensionLoad: 'browser.extension.load',
    extensionRemove: 'browser.extension.remove'
  },
  agents: {
    // CRUD + exécution des agents (lot 3). Les agents system ('synthesizer',
    // 'wiki_builder') ne peuvent pas être supprimés — seul le champ
    // `enabled` et `systemPrompt`/`model` sont éditables.
    list: 'agents.list',
    get: 'agents.get',
    create: 'agents.create',
    update: 'agents.update',
    delete: 'agents.delete',
    runSynthesizer: 'agents.runSynthesizer',
    runWikiBuilder: 'agents.runWikiBuilder',
    // File-back (Sprint 3) : transforme un message assistant en page
    // wiki qa/ réutilisable. Payload: { conversationId, messageId }.
    runFileBackResponse: 'agents.runFileBackResponse',
    // Lint (Sprint 4) : audit de cohérence du wiki.
    runLint: 'agents.runLint',
    // Researcher (Sprint 5) : actualise le wiki via recherches web Tavily.
    runResearcher: 'agents.runResearcher'
  },
  wiki: {
    // Mémoire long-terme partagée entre conversations IA (dossier FS
    // choisi par l'utilisateur). Structure : raw/, wiki/, MEMORY.md.
    // Tous les handlers vérifient `wiki.folderPath` en settings et
    // échouent proprement (no-op silencieux ou erreur explicite) si
    // pas configuré — onboarding paresseux dans l'onglet Wiki Settings.
    getFolder: 'wiki.getFolder',
    chooseFolder: 'wiki.chooseFolder',
    listRaw: 'wiki.listRaw',
    listWiki: 'wiki.listWiki',
    readRaw: 'wiki.readRaw',
    readWiki: 'wiki.readWiki',
    readSchema: 'wiki.readSchema',
    readIndex: 'wiki.readIndex',
    readLog: 'wiki.readLog',
    // Alias déprécié — preload continue de l'exposer le temps que les
    // appelants renderer migrent (readMemoryTemplate → readSchema).
    readMemoryTemplate: 'wiki.readMemoryTemplate',
    writeRaw: 'wiki.writeRaw',
    writeWiki: 'wiki.writeWiki',
    writeIndex: 'wiki.writeIndex',
    appendLog: 'wiki.appendLog',
    openFolderInExplorer: 'wiki.openFolderInExplorer',
    openRawInExplorer: 'wiki.openRawInExplorer',
    openFileInOS: 'wiki.openFileInOS',
    // Lecture/écriture d'un fichier texte arbitraire dans le dossier
    // wiki (hors `wiki/`). Utilisé par le viewer intégré quand l'user
    // clique dans l'explorateur sur SCHEMA.md, log.md, raw/ ou audit/.
    readFile: 'wiki.readFile',
    writeFile: 'wiki.writeFile',
    // Suppression d'un fichier arbitraire dans le dossier wiki (sandbox).
    // Utilisé par le menu contextuel de l'explorateur (clic droit → 🗑).
    deleteFile: 'wiki.deleteFile',
    // Import manuel : ouvre un file picker + copie .md/.txt dans raw/
    // pour ingestion par le Wiki Builder. Atomique côté renderer.
    importToRaw: 'wiki.importToRaw',
    // Arborescence complète du dossier wiki (pas juste wiki/).
    // Utilisé par l'explorateur de la sidebar pour afficher TOUS les
    // fichiers créés (raw, audit, SCHEMA, log, etc.).
    listAllFiles: 'wiki.listAllFiles',
    // Graphe du wiki (Sprint 3 étape 2). Retourne {nodes, edges}
    // construits à partir des wikilinks du dossier wiki/.
    getGraph: 'wiki.getGraph'
  }
} as const
