// Postinstall : rebuild les modules natifs contre Electron, en isolant les erreurs.
// Si un module échoue (p.ex. absence de VS Build Tools), on l'affiche sans bloquer
// le reste pour laisser le dev lancer `npm run dev` quand même.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// @lydell/node-pty installe un binary prebuilt per-platform (no rebuild nécessaire).
const modules = ['better-sqlite3']

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts })
    p.on('exit', (code) => resolve(code ?? 0))
  })
}

async function main() {
  if (process.env.BLOWWORKS_SKIP_REBUILD === '1') {
    console.log('[postinstall] BLOWWORKS_SKIP_REBUILD=1 → rebuild natif ignoré.')
    return
  }

  const electronRebuildBin = resolve('./node_modules/.bin/electron-rebuild' + (process.platform === 'win32' ? '.cmd' : ''))
  if (!existsSync(electronRebuildBin)) {
    console.warn('[postinstall] electron-rebuild introuvable — ignoré.')
    return
  }

  for (const mod of modules) {
    console.log(`[postinstall] rebuild de ${mod}…`)
    const code = await run(electronRebuildBin, ['-f', '-w', mod])
    if (code !== 0) {
      console.warn(
        `\n[postinstall] ⚠️ rebuild de "${mod}" a échoué (code ${code}). ` +
        `Si les prebuilds sont disponibles, l'app peut tout de même fonctionner. ` +
        `Sinon, installez Visual Studio Build Tools 2022 (composant "Développement desktop en C++") ` +
        `puis relancez : npm run rebuild:native\n`
      )
    }
  }
}

main().catch((err) => {
  console.error('[postinstall] erreur inattendue :', err)
  process.exit(0) // Jamais bloquer l'installation.
})
