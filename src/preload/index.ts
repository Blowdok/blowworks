import { contextBridge, ipcRenderer } from 'electron'
// On importe depuis `ipc-channels.js` (pas `ipc-contract.js`) pour éviter
// d'entraîner zod dans le bundle preload — les preloads sandboxés ne peuvent
// pas faire `require()` de packages npm à l'exécution.
import { IPC_CHANNELS } from '@shared/ipc-channels.js'

// Pont contextuel : expose une API sûre et typée à window.blow.

const api = {
  project: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.project.list),
    create: (input: { name: string; color?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.project.create, input),
    update: (input: { id: string; name?: string; color?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.project.update, input),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.project.delete, { id })
  },
  terminal: {
    spawn: (input: {
      id: string
      shell: 'powershell' | 'cmd' | 'bash' | 'pwsh'
      cwd: string
      cols: number
      rows: number
      env?: Record<string, string>
      restoreScrollback?: boolean
    }) => ipcRenderer.invoke(IPC_CHANNELS.terminal.spawn, input),
    write: (id: string, data: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminal.write, { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminal.resize, { id, cols, rows }),
    kill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.terminal.kill, { id }),
    persist: (id: string, scrollback: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminal.persist, { id, scrollback }),
    restore: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.terminal.restore, { id }),
    onData: (cb: (payload: { id: string; data: string }) => void) => {
      const listener = (_: unknown, payload: { id: string; data: string }) => cb(payload)
      ipcRenderer.on(IPC_CHANNELS.terminal.dataEvent, listener)
      return () => ipcRenderer.off(IPC_CHANNELS.terminal.dataEvent, listener)
    },
    onExit: (cb: (payload: { id: string; exitCode: number; signal?: number }) => void) => {
      const listener = (_: unknown, payload: { id: string; exitCode: number; signal?: number }) =>
        cb(payload)
      ipcRenderer.on(IPC_CHANNELS.terminal.exitEvent, listener)
      return () => ipcRenderer.off(IPC_CHANNELS.terminal.exitEvent, listener)
    }
  },
  vscode: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.vscode.status),
    openFolder: (folder: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.vscode.openFolder, { folder })
  },
  fs: {
    // Liste un dossier. `path` vide ou 'ThisPC' renvoie les disques.
    list: (
      path: string
    ): Promise<
      | {
          ok: true
          entries: Array<{
            name: string
            path: string
            isDirectory: boolean
            size: number
            modifiedAt: number
            ext: string
            hidden: boolean
          }>
        }
      | { ok: false; reason: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.fs.list, { path }),
    // Sidebar Quick Access (Bureau, Documents, etc.). Statique au boot.
    quickAccess: (): Promise<
      Array<{ id: string; label: string; path: string | null; icon: string }>
    > => ipcRenderer.invoke(IPC_CHANNELS.fs.quickAccess),
    // Double-clic fichier : ouvre avec l'app par défaut Windows.
    open: (
      path: string
    ): Promise<{ ok: true } | { ok: false; reason: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.open, { path }),
    // F2 : renomme. Le renderer fournit l'ancien chemin complet et le
    // NOUVEAU NOM (pas le chemin) — le main rebuild le chemin pour éviter
    // les attaques de chemin relatif.
    rename: (
      oldPath: string,
      newName: string
    ): Promise<
      { ok: true; newPath: string } | { ok: false; reason: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.fs.rename, { oldPath, newName }),
    // Suppr : envoie à la corbeille (réversible). Plus sûr que fs.rm.
    trash: (
      path: string
    ): Promise<{ ok: true } | { ok: false; reason: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.trash, { path }),
    // Menu contextuel "Ouvrir dans l'Explorateur natif" : highlight le
    // fichier dans son dossier parent (ou ouvre le dossier directement).
    openInExplorer: (
      path: string
    ): Promise<{ ok: true } | { ok: false; reason: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.openInExplorer, { path }),
    // "Plus d'options Windows…" : ouvre le menu shell Windows complet
    // (extensions, Ouvrir avec, Propriétés, Partager, etc.) au point
    // écran spécifié. La promesse résout APRÈS que l'utilisateur ait
    // choisi une commande (ou annulé). Win32 uniquement.
    shellContextMenu: (
      path: string,
      screenX: number,
      screenY: number
    ): Promise<{ ok: boolean; invoked: boolean; reason?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.shellContextMenu, {
        path,
        screenX,
        screenY
      }),
    // Lit un fichier texte UTF-8 (utilisé par NotepadShape mode "fichier").
    // Refuse les fichiers > 5 Mo et les dossiers.
    readFile: (
      path: string
    ): Promise<{ ok: true; content: string } | { ok: false; reason: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.readFile, { path }),
    // Écrit un fichier texte UTF-8. Crée le fichier s'il n'existe pas.
    writeFile: (
      path: string,
      content: string
    ): Promise<{ ok: true } | { ok: false; reason: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.fs.writeFile, { path, content })
  },
  canvas: {
    saveSnapshot: (snapshotJson: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.canvas.saveSnapshot, { snapshotJson }),
    loadSnapshot: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.canvas.loadSnapshot)
  },
  settings: {
    get: (key: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.settings.get, { key }),
    set: (key: string, value: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.settings.set, { key, value })
  },
  dialog: {
    pickFolder: (options?: { title?: string; defaultPath?: string }): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.dialog.pickFolder, options ?? {}),
    pickImage: (
      options?: { title?: string }
    ): Promise<{ dataUrl: string; name: string } | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.dialog.pickImage, options ?? {})
  },
  github: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.github.getStatus),
    setToken: (pat: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.github.setToken, { pat }),
    reconnect: () => ipcRenderer.invoke(IPC_CHANNELS.github.reconnect),
    disconnect: () => ipcRenderer.invoke(IPC_CHANNELS.github.disconnect),
    forgetToken: () => ipcRenderer.invoke(IPC_CHANNELS.github.forgetToken),
    startDeviceFlow: () => ipcRenderer.invoke(IPC_CHANNELS.github.startDeviceFlow),
    completeDeviceFlow: (input: {
      deviceCode: string
      expiresIn: number
      interval: number
    }) => ipcRenderer.invoke(IPC_CHANNELS.github.completeDeviceFlow, input)
  },
  ai: {
    // ── Clés API (jamais retournées en clair au renderer) ───────────
    setApiKey: (input: { provider: 'openrouter' | 'tavily'; key: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.setApiKey, input),
    getApiKeyStatus: () => ipcRenderer.invoke(IPC_CHANNELS.ai.getApiKeyStatus),
    // ── Défauts globaux ─────────────────────────────────────────────
    getDefaults: () => ipcRenderer.invoke(IPC_CHANNELS.ai.getDefaults),
    setDefaults: (input: { model: string; temperature: number; maxTokens: number }) =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.setDefaults, input),
    // ── Modèles ─────────────────────────────────────────────────────
    listModels: (opts?: { forceRefresh?: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.listModels, opts ?? {}),
    // ── Conversations / Messages ────────────────────────────────────
    createConversation: (input: {
      id: string
      model: string
      system?: string | null
      temperature?: number
      projectId?: string | null
    }) => ipcRenderer.invoke(IPC_CHANNELS.ai.createConversation, input),
    updateConversation: (input: {
      id: string
      title?: string
      model?: string
      system?: string | null
      temperature?: number
      projectId?: string | null
    }) => ipcRenderer.invoke(IPC_CHANNELS.ai.updateConversation, input),
    getConversation: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.getConversation, { id }),
    listConversations: () => ipcRenderer.invoke(IPC_CHANNELS.ai.listConversations),
    deleteConversation: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.deleteConversation, { id }),
    // ── Envoi + streaming ───────────────────────────────────────────
    sendMessage: (input: {
      conversationId: string
      content: string
      model: string
      temperature?: number
      systemPrompt?: string | null
      wikiContext?: string | null
      webSearchEnabled?: boolean
      wikiToolsEnabled?: boolean
      thinkingEnabled?: boolean
      maxTokens?: number
    }) => ipcRenderer.invoke(IPC_CHANNELS.ai.sendMessage, input),
    cancelStream: (requestId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.cancelStream, { requestId }),
    // Réveil d'un await de confirmation tool côté main.
    confirmToolCall: (toolCallId: string, approved: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.confirmToolCall, { toolCallId, approved }),
    saveMessageSegments: (messageId: string, segmentsJson: string | null) =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.saveMessageSegments, { messageId, segmentsJson }),
    onChunk: (
      cb: (payload: {
        requestId: string
        conversationId: string
        delta?: string
        reasoningDelta?: string
        done?: boolean
        error?: string
        usage?: { promptTokens: number; completionTokens: number }
        citations?: string[]
        toolCall?: { id: string; name: string; arguments: Record<string, unknown> }
        toolResult?: { id: string; name: string; result: string; error?: string }
        toolConfirmNeeded?: {
          id: string
          name: string
          arguments: Record<string, unknown>
        }
      }) => void
    ) => {
      const listener = (_: unknown, payload: unknown): void =>
        cb(payload as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC_CHANNELS.ai.chunkEvent, listener)
      return () => ipcRenderer.off(IPC_CHANNELS.ai.chunkEvent, listener)
    }
  },
  browser: {
    // Listener main → renderer : déclenché par `setWindowOpenHandler`
    // et `will-navigate` du process main. Le renderer crée une nouvelle
    // BrowserShape sur l'URL reçue.
    onOpenUrl: (
      cb: (payload: { url: string; sourceWebContentsId?: number }) => void
    ) => {
      const listener = (
        _: unknown,
        payload: { url: string; sourceWebContentsId?: number }
      ): void => cb(payload)
      ipcRenderer.on(IPC_CHANNELS.browser.openUrlEvent, listener)
      return () => ipcRenderer.off(IPC_CHANNELS.browser.openUrlEvent, listener)
    },
    // Historique global (toutes shapes/projets confondus). `record`
    // retourne l'id pour que l'appelant puisse patcher titre/favicon
    // une fois reçus de Chromium.
    history: {
      record: (input: {
        url: string
        title?: string | null
        favicon?: string | null
      }): Promise<number> =>
        ipcRenderer.invoke(IPC_CHANNELS.browser.historyRecord, input),
      patch: (input: {
        id: number
        title?: string
        favicon?: string | null
      }): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.browser.historyPatch, input),
      list: (
        opts?: { limit?: number; offset?: number; search?: string }
      ): Promise<
        Array<{
          id: number
          url: string
          title: string
          favicon: string | null
          visitedAt: number
        }>
      > => ipcRenderer.invoke(IPC_CHANNELS.browser.historyList, opts ?? {}),
      delete: (id: number): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.browser.historyDelete, { id }),
      clear: (): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.browser.historyClear)
    },
    // Favoris globaux. Toggle = ajoute si absent, retire si présent.
    // `onChanged` est broadcasté à toutes les BrowserShapes pour qu'elles
    // rafraîchissent l'icône étoile en temps réel.
    bookmarks: {
      toggle: (input: {
        url: string
        title?: string | null
        favicon?: string | null
      }): Promise<{ bookmarked: boolean }> =>
        ipcRenderer.invoke(IPC_CHANNELS.browser.bookmarkToggle, input),
      list: (): Promise<
        Array<{
          id: number
          url: string
          title: string
          favicon: string | null
          sortOrder: number
          createdAt: number
        }>
      > => ipcRenderer.invoke(IPC_CHANNELS.browser.bookmarkList),
      delete: (id: number): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.browser.bookmarkDelete, { id }),
      update: (input: { id: number; title?: string; url?: string }): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.browser.bookmarkUpdate, input),
      onChanged: (cb: () => void) => {
        const listener = (): void => cb()
        ipcRenderer.on(IPC_CHANNELS.browser.bookmarkChangedEvent, listener)
        return () =>
          ipcRenderer.off(IPC_CHANNELS.browser.bookmarkChangedEvent, listener)
      }
    },
    // Téléchargements gérés côté main sur la partition `persist:browser`.
    // Le renderer reçoit les progress events via `onProgress` pour mettre
    // à jour la UI dropdown en temps réel (barre de progression).
    downloads: {
      list: (): Promise<
        Array<{
          id: string
          url: string
          filename: string
          savePath: string
          mimeType: string | null
          totalBytes: number
          receivedBytes: number
          state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
          startedAt: number
          endedAt: number | null
        }>
      > => ipcRenderer.invoke(IPC_CHANNELS.browser.downloadList),
      cancel: (id: string): Promise<{ cancelled: boolean }> =>
        ipcRenderer.invoke(IPC_CHANNELS.browser.downloadCancel, { id }),
      open: (id: string): Promise<{ ok: boolean; reason?: string }> =>
        ipcRenderer.invoke(IPC_CHANNELS.browser.downloadOpen, { id }),
      showInFolder: (id: string): Promise<{ ok: boolean; reason?: string }> =>
        ipcRenderer.invoke(IPC_CHANNELS.browser.downloadShowInFolder, { id }),
      clear: (): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.browser.downloadClear),
      onProgress: (
        cb: (payload: {
          id: string
          url: string
          filename: string
          savePath: string
          mimeType: string | null
          totalBytes: number
          receivedBytes: number
          state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
          startedAt: number
          endedAt: number | null
        }) => void
      ) => {
        const listener = (_: unknown, payload: unknown): void =>
          cb(payload as Parameters<typeof cb>[0])
        ipcRenderer.on(IPC_CHANNELS.browser.downloadProgressEvent, listener)
        return () =>
          ipcRenderer.off(IPC_CHANNELS.browser.downloadProgressEvent, listener)
      }
    },
    // Extensions Chrome (Palier 3). API exposée mais l'UI est en
    // Settings > Navigateur, pas dans la BrowserShape.
    extensions: {
      list: (): Promise<
        Array<{ id: string; name: string; version: string; path: string; manifestUrl: string | null }>
      > => ipcRenderer.invoke(IPC_CHANNELS.browser.extensionList),
      load: (folderPath: string): Promise<
        { ok: true; id: string; name: string; version: string }
        | { ok: false; error: string }
      > => ipcRenderer.invoke(IPC_CHANNELS.browser.extensionLoad, { folderPath }),
      remove: (id: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke(IPC_CHANNELS.browser.extensionRemove, { id })
    }
  },
  agents: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.agents.list),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.agents.get, { id }),
    create: (input: {
      name: string
      description?: string
      model: string
      systemPrompt: string
      temperature?: number
      maxTokens?: number
      enabled?: boolean
    }) => ipcRenderer.invoke(IPC_CHANNELS.agents.create, input),
    update: (input: {
      id: string
      name?: string
      description?: string
      model?: string
      systemPrompt?: string
      temperature?: number
      maxTokens?: number
      enabled?: boolean
    }) => ipcRenderer.invoke(IPC_CHANNELS.agents.update, input),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.agents.delete, { id }),
    runSynthesizer: (conversationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.agents.runSynthesizer, { conversationId }),
    runWikiBuilder: () => ipcRenderer.invoke(IPC_CHANNELS.agents.runWikiBuilder),
    runFileBackResponse: (conversationId: string, messageId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.agents.runFileBackResponse, { conversationId, messageId }),
    runLint: () => ipcRenderer.invoke(IPC_CHANNELS.agents.runLint),
    runResearcher: () => ipcRenderer.invoke(IPC_CHANNELS.agents.runResearcher)
  },
  wiki: {
    getFolder: () => ipcRenderer.invoke(IPC_CHANNELS.wiki.getFolder),
    chooseFolder: () => ipcRenderer.invoke(IPC_CHANNELS.wiki.chooseFolder),
    listRaw: () => ipcRenderer.invoke(IPC_CHANNELS.wiki.listRaw),
    listWiki: () => ipcRenderer.invoke(IPC_CHANNELS.wiki.listWiki),
    readRaw: (name: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.wiki.readRaw, { name }),
    readWiki: (name: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.wiki.readWiki, { name }),
    readSchema: () => ipcRenderer.invoke(IPC_CHANNELS.wiki.readSchema),
    readIndex: () => ipcRenderer.invoke(IPC_CHANNELS.wiki.readIndex),
    readLog: () => ipcRenderer.invoke(IPC_CHANNELS.wiki.readLog),
    // Alias deprecated — garde la signature le temps que le renderer migre.
    readMemoryTemplate: () => ipcRenderer.invoke(IPC_CHANNELS.wiki.readMemoryTemplate),
    writeRaw: (name: string, content: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.wiki.writeRaw, { name, content }),
    writeWiki: (name: string, content: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.wiki.writeWiki, { name, content }),
    writeIndex: (content: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.wiki.writeIndex, { content }),
    appendLog: (entry: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.wiki.appendLog, { entry }),
    openFolderInExplorer: () =>
      ipcRenderer.invoke(IPC_CHANNELS.wiki.openFolderInExplorer),
    openRawInExplorer: () =>
      ipcRenderer.invoke(IPC_CHANNELS.wiki.openRawInExplorer),
    openFileInOS: (relPath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.wiki.openFileInOS, { relPath }),
    readFile: (relPath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.wiki.readFile, { relPath }),
    writeFile: (relPath: string, content: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.wiki.writeFile, { relPath, content }),
    deleteFile: (relPath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.wiki.deleteFile, { relPath }),
    importToRaw: () => ipcRenderer.invoke(IPC_CHANNELS.wiki.importToRaw),
    listAllFiles: () => ipcRenderer.invoke(IPC_CHANNELS.wiki.listAllFiles),
    getGraph: () => ipcRenderer.invoke(IPC_CHANNELS.wiki.getGraph)
  }
}

contextBridge.exposeInMainWorld('blow', api)

export type BlowApi = typeof api
