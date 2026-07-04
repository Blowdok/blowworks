import * as pty from '@lydell/node-pty'
import { BrowserWindow, app } from 'electron'
import { accessSync, constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
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

// Résout un cwd valide et portable : le dossier demandé s'il existe, sinon le
// bureau de l'utilisateur, sinon son dossier home. Évite l'échec obscur de
// ConPTY quand une shape persistée référence un dossier absent (projet déplacé
// sur une autre machine) ou quand aucun cwd n'est fourni.
function resolveCwd(requested: string): string {
  const exists = (p: string): boolean => {
    try {
      accessSync(p, fsConstants.F_OK)
      return true
    } catch {
      return false
    }
  }
  if (requested && exists(requested)) return requested
  const desktop = app.getPath('desktop')
  return exists(desktop) ? desktop : app.getPath('home')
}

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

    // Vérif d'existence AVANT spawn : node-pty / ConPTY échoue avec un
    // message obscur `File not found: ` (chemin vidé) quand le binaire
    // cible n'est pas résoluble via PATH — typiquement `pwsh.exe` qui
    // n'est pas installé par défaut sur Windows (PowerShell 7 = install
    // séparée depuis le Microsoft Store ou https://aka.ms/powershell).
    // On remonte ici une erreur humaine avec pointeur d'installation.
    if (!isBinaryResolvable(shellBinary)) {
      throw new Error(buildShellNotFoundMessage(input.shell, shellBinary))
    }

    const proc = pty.spawn(shellBinary, args, {
      name: 'xterm-color',
      cols: input.cols,
      rows: input.rows,
      cwd: resolveCwd(input.cwd),
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
//
// Sur Windows, on essaye d'abord PATH (comportement standard), puis on
// retombe sur les emplacements canoniques d'installation. C'est crucial
// pour les cas suivants :
//   - pwsh.exe installé pendant que BlowWorks tourne → le PATH de notre
//     process Electron est figé au démarrage et ne voit pas la nouvelle
//     entrée système. Un redémarrage de l'app ne suffit pas toujours
//     (héritage du PATH du process parent qui peut lui aussi être stale).
//   - Machines où PATH a été customisé et omet les emplacements standards.
// En retournant un chemin absolu quand le fallback trouve le binaire, on
// passe directement à `CreateProcess` sans aucune résolution PATH.
function resolveShellBinary(shell: ShellKindT): string {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    switch (shell) {
      case 'powershell':
        return pickFirstResolvable('powershell.exe', [
          join(systemRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')
        ])
      case 'pwsh':
        return pickFirstResolvable('pwsh.exe', [
          join(programFiles, 'PowerShell\\7\\pwsh.exe'),
          join(programFilesX86, 'PowerShell\\7\\pwsh.exe'),
          join(programFiles, 'PowerShell\\7-preview\\pwsh.exe')
        ])
      case 'cmd':
        return pickFirstResolvable('cmd.exe', [join(systemRoot, 'System32\\cmd.exe')])
      case 'bash':
        // Git for Windows (bash.exe) ou WSL (System32\bash.exe).
        return pickFirstResolvable('bash.exe', [
          join(programFiles, 'Git\\bin\\bash.exe'),
          join(programFilesX86, 'Git\\bin\\bash.exe'),
          join(systemRoot, 'System32\\bash.exe')
        ])
    }
  }
  // Autres plateformes (v2 macOS/Linux).
  return shell === 'bash' ? '/bin/bash' : '/bin/sh'
}

// Essaie PATH en premier (nom court), puis les chemins absolus candidats.
// Retourne le premier qui résout. Si RIEN ne résout, retourne le nom court
// — `isBinaryResolvable` déclenchera l'erreur humanisée en aval.
function pickFirstResolvable(pathName: string, absoluteFallbacks: string[]): string {
  if (isBinaryResolvable(pathName)) return pathName
  for (const abs of absoluteFallbacks) {
    if (isBinaryResolvable(abs)) return abs
  }
  return pathName
}

function resolveShellArgs(shell: ShellKindT): string[] {
  if (shell === 'powershell' || shell === 'pwsh') {
    return ['-NoLogo']
  }
  return []
}

// Teste si un binaire est résoluble via PATH + PATHEXT (Windows) ou
// directement accessible (POSIX). Sur Windows on split `process.env.PATH`
// et on itère les extensions de `PATHEXT` car `pty.spawn` appelle
// `CreateProcess` qui ne fait PAS toujours de résolution propre en
// environnement Electron — mieux vaut sortir une erreur claire ici.
function isBinaryResolvable(binary: string): boolean {
  // Chemin absolu → test direct.
  if (binary.includes('/') || binary.includes('\\')) {
    try {
      accessSync(binary, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }
  const paths = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  if (process.platform === 'win32') {
    const pathExt = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())
    const hasExt = pathExt.some((ext) => binary.toLowerCase().endsWith(ext))
    const candidates = hasExt ? [binary] : pathExt.map((ext) => binary + ext)
    for (const dir of paths) {
      if (!dir) continue
      for (const candidate of candidates) {
        try {
          accessSync(join(dir, candidate), fsConstants.F_OK)
          return true
        } catch {
          /* essayer suivant */
        }
      }
    }
    return false
  }
  for (const dir of paths) {
    if (!dir) continue
    try {
      accessSync(join(dir, binary), fsConstants.X_OK)
      return true
    } catch {
      /* essayer suivant */
    }
  }
  return false
}

// Message d'erreur contextuel par shell manquant. Priorité à l'action
// utilisateur (« comment installer ») plutôt qu'au diagnostic technique.
function buildShellNotFoundMessage(shell: ShellKindT, binary: string): string {
  switch (shell) {
    case 'pwsh':
      return (
        `PowerShell 7 (pwsh) n'est pas installé sur ce système. ` +
        `Installer depuis https://aka.ms/powershell ou via « winget install Microsoft.PowerShell ». ` +
        `En attendant, vous pouvez utiliser « powershell » (Windows PowerShell 5.1, pré-installé).`
      )
    case 'bash':
      return (
        `bash n'est pas trouvé dans le PATH. Installer Git for Windows ` +
        `(https://git-scm.com/download/win) ou activer WSL.`
      )
    case 'powershell':
      return `Windows PowerShell (${binary}) introuvable dans le PATH — très inhabituel sur Windows 10/11.`
    case 'cmd':
      return `cmd.exe introuvable dans le PATH — très inhabituel sur Windows.`
    default:
      return `Shell « ${shell} » introuvable (${binary}).`
  }
}
