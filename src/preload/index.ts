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
      ipcRenderer.invoke(IPC_CHANNELS.dialog.pickFolder, options ?? {})
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
      maxTokens?: number
    }) => ipcRenderer.invoke(IPC_CHANNELS.ai.sendMessage, input),
    cancelStream: (requestId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.cancelStream, { requestId }),
    onChunk: (
      cb: (payload: {
        requestId: string
        conversationId: string
        delta?: string
        done?: boolean
        error?: string
        usage?: { promptTokens: number; completionTokens: number }
        citations?: string[]
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
    onOpenUrl: (cb: (payload: { url: string }) => void) => {
      const listener = (_: unknown, payload: { url: string }): void => cb(payload)
      ipcRenderer.on(IPC_CHANNELS.browser.openUrlEvent, listener)
      return () => ipcRenderer.off(IPC_CHANNELS.browser.openUrlEvent, listener)
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
      enabled?: boolean
    }) => ipcRenderer.invoke(IPC_CHANNELS.agents.create, input),
    update: (input: {
      id: string
      name?: string
      description?: string
      model?: string
      systemPrompt?: string
      enabled?: boolean
    }) => ipcRenderer.invoke(IPC_CHANNELS.agents.update, input),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.agents.delete, { id }),
    runSynthesizer: (conversationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.agents.runSynthesizer, { conversationId }),
    runWikiBuilder: () => ipcRenderer.invoke(IPC_CHANNELS.agents.runWikiBuilder)
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
      ipcRenderer.invoke(IPC_CHANNELS.wiki.openFolderInExplorer)
  }
}

contextBridge.exposeInMainWorld('blow', api)

export type BlowApi = typeof api
