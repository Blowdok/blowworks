import { _electron as electron, test, expect } from '@playwright/test'
import { resolve } from 'node:path'

// Smoke test E2E : l'app démarre, affiche le header et le canvas.
test('BlowWorks démarre et affiche le layout', async () => {
  const app = await electron.launch({
    args: [resolve(process.cwd(), 'out/main/index.js')],
    env: { ...process.env, NODE_ENV: 'production' }
  })

  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  // Vérification du header.
  await expect(window.locator('header')).toBeVisible()
  await expect(window.getByText('BlowWorks').first()).toBeVisible()

  // Vérification de la sidebar (présence du placeholder projets).
  await expect(window.locator('aside')).toBeVisible()

  await app.close()
})
