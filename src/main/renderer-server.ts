import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, normalize, sep, extname } from 'node:path'

// Sert le renderer compilé via un petit serveur http local (loopback) en
// production. Raison : sous `file://` ou un scheme custom `app://`, la
// résolution d'URL et le fetch des assets tldraw échouent (URLs doublées,
// décodage d'images bloqué). En `http` — exactement comme le serveur Vite en
// dev — tout se charge normalement. Écoute uniquement sur 127.0.0.1, aucune
// exposition réseau externe.

const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), '../renderer')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json'
}

let server: Server | null = null

// Démarre le serveur et résout avec l'URL de base à charger (ex.
// http://127.0.0.1:27339/).
export function startRendererServer(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      try {
        const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1')
        const relative = pathname === '/' ? '/index.html' : decodeURIComponent(pathname)
        const filePath = normalize(join(rendererRoot, relative))
        // Garde anti-traversée : le fichier résolu doit rester sous la racine.
        if (filePath !== rendererRoot && !filePath.startsWith(rendererRoot + sep)) {
          res.writeHead(403).end('Forbidden')
          return
        }
        const body = await readFile(filePath)
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
        })
        res.end(body)
      } catch {
        res.writeHead(404).end('Not found')
      }
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${port}/`))
  })
}

export function stopRendererServer(): void {
  server?.close()
  server = null
}
