import * as pty from '@lydell/node-pty'
import { BrowserWindow } from 'electron'
import type { ShellKindT } from '@shared/ipc-contract.js'
import { IPC_CHANNELS } from '@shared/ipc-contract.js'

// Gestionnaire central des PTY. Hiberne / tue les moins récents au-delà de MAX_ALIVE.

interface ManagedPty {
  id: string
  process: pty.IPty
  shell: ShellKindT
  cwd: string
  lastActivity: number
}

const MAX_ALIVE = 50

class PtyManager {
  private readonly ptys = new Map<string, ManagedPty>()

  spawn(input: {
    id: string
    shell: ShellKindT
    cwd: string
    cols: number
    rows: number
    env?: Record<string, string>
  }): void {
    // Idempotent si config identique (survit au double-mount StrictMode).
    // Recrée si le shell ou le cwd ont changé (switch de shell côté UI).
    const existing = this.ptys.get(input.id)
    if (existing) {
      const sameConfig = existing.shell === input.shell && existing.cwd === input.cwd
      if (sameConfig) {
        try {
          existing.process.resize(input.cols, input.rows)
        } catch {
          /* la taille restera celle du spawn initial */
        }
        existing.lastActivity = Date.now()
        return
      }
      // Config changée → on tue l'ancien PTY. L'event `exit` sera filtré ci-
      // dessous (vérif d'identité proc) pour ne pas parasiter le renderer.
      this.kill(input.id)
    }

    const shellBinary = resolveShellBinary(input.shell)
    const args = resolveShellArgs(input.shell)

    const proc = pty.spawn(shellBinary, args, {
      name: 'xterm-color',
      cols: input.cols,
      rows: input.rows,
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}), TERM: 'xterm-256color' } as { [key: string]: string },
      useConpty: process.platform === 'win32'
    })

    const managed: ManagedPty = {
      id: input.id,
      process: proc,
      shell: input.shell,
      cwd: input.cwd,
      lastActivity: Date.now()
    }
    this.ptys.set(input.id, managed)

    // Relais des données vers tous les renderers ouverts.
    proc.onData((data) => {
      managed.lastActivity = Date.now()
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.terminal.dataEvent, { id: input.id, data })
        }
      }
    })

    proc.onExit(({ exitCode, signal }) => {
      // Vérif d'identité : ne propage l'event `exit` au renderer que si CE
      // proc est toujours le PTY courant pour cet id. Sinon c'est un ancien
      // PTY tué lors d'un switch de shell → silence pour éviter le message
      // "[processus terminé]" parasite sur le nouveau terminal.
      const current = this.ptys.get(input.id)
      if (current && current.process === proc) {
        this.ptys.delete(input.id)
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.terminal.exitEvent, {
              id: input.id,
              exitCode,
              signal
            })
          }
        }
      }
    })

    // Politique LRU : si on dépasse MAX_ALIVE, on tue les plus anciens.
    this.enforceLimit()
  }

  write(id: string, data: string): void {
    const managed = this.ptys.get(id)
    if (!managed) return
    managed.lastActivity = Date.now()
    managed.process.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const managed = this.ptys.get(id)
    if (!managed) return
    managed.process.resize(cols, rows)
  }

  kill(id: string): void {
    const managed = this.ptys.get(id)
    if (!managed) return
    try {
      managed.process.kill()
    } catch {
      // Ignorer : le process est peut-être déjà mort.
    }
    this.ptys.delete(id)
  }

  isAlive(id: string): boolean {
    return this.ptys.has(id)
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.ptys.keys()]) {
      this.kill(id)
    }
  }

  private enforceLimit(): void {
    if (this.ptys.size <= MAX_ALIVE) return
    const sorted = [...this.ptys.values()].sort((a, b) => a.lastActivity - b.lastActivity)
    const toKill = sorted.slice(0, this.ptys.size - MAX_ALIVE)
    for (const item of toKill) this.kill(item.id)
  }
}

export const ptyManager = new PtyManager()

// Résolution de la binaire de shell par plateforme.
function resolveShellBinary(shell: ShellKindT): string {
  if (process.platform === 'win32') {
    switch (shell) {
      case 'powershell':
        return 'powershell.exe'
      case 'pwsh':
        return 'pwsh.exe'
      case 'cmd':
        return 'cmd.exe'
      case 'bash':
        // Nécessite Git Bash ou WSL dans le PATH.
        return 'bash.exe'
    }
  }
  // Autres plateformes (v2 macOS/Linux).
  return shell === 'bash' ? '/bin/bash' : '/bin/sh'
}

function resolveShellArgs(shell: ShellKindT): string[] {
  if (shell === 'powershell' || shell === 'pwsh') {
    return ['-NoLogo']
  }
  return []
}
