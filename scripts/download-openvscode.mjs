// Télécharge VSCode portable (Windows) et l'extrait dans resources/openvscode-server/
// pour alimenter le sidecar `Code.exe serve-web`. openvscode-server et code-server
// ne publient plus de binaires Windows ; VSCode Desktop embarque nativement
// `serve-web` depuis fin 2024.
//
// Usage : node scripts/download-openvscode.mjs

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'

const DEST = resolve('resources/openvscode-server')
const URL = 'https://code.visualstudio.com/sha/download?build=stable&os=win32-x64-archive'

async function main() {
  if (process.platform !== 'win32') {
    console.error('[vscode] ce script télécharge la build Windows. Plateforme détectée :', process.platform)
    process.exit(1)
  }

  if (!existsSync(DEST)) mkdirSync(DEST, { recursive: true })

  const archivePath = join(DEST, 'vscode-win32-x64.zip')

  // curl.exe est natif à Windows 10+ et gère parfaitement les redirects de
  // code.visualstudio.com (contrairement à fetch qui peut tronquer le stream).
  console.log('[vscode] téléchargement de VSCode portable Windows (~215 Mo)…')
  await runCommand('curl.exe', ['-L', '--fail', '-o', archivePath, URL])

  console.log('[vscode] extraction (20-40 s)…')
  await runCommand('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath "${archivePath}" -DestinationPath "${DEST}" -Force`
  ])

  rmSync(archivePath, { force: true })

  const codeExe = join(DEST, 'Code.exe')
  if (!existsSync(codeExe)) {
    console.warn('[vscode] Code.exe introuvable après extraction — vérifier manuellement :', DEST)
    return
  }

  // Lanceur bin/openvscode-server.cmd attendu par src/main/services/vscode-server.ts.
  const binDir = join(DEST, 'bin')
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true })
  const launcher = join(binDir, 'openvscode-server.cmd')
  const launcherContent =
    '@echo off\r\n' +
    'rem Lanceur généré par BlowWorks : délègue à Code.exe serve-web.\r\n' +
    'setlocal\r\n' +
    'set "VSCODE_ROOT=%~dp0.."\r\n' +
    '"%VSCODE_ROOT%\\Code.exe" serve-web %*\r\n' +
    'endlocal\r\n'
  writeFileSync(launcher, launcherContent, 'utf8')

  console.log('[vscode] ✅ terminé. Binaire prêt :')
  console.log('  →', launcher)
  console.log("[vscode] BlowWorks lancera automatiquement Code.exe serve-web à la première demande d'une shape VSCode.")
}

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Commande ${cmd} code ${code}`))))
  })
}

main().catch((err) => {
  console.error('[vscode] erreur :', err.message)
  process.exit(1)
})
