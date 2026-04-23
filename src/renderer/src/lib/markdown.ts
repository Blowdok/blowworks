import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { defaultUrlTransform } from 'react-markdown'

// Configuration partagée pour react-markdown :
// - remark-gfm : tables, strikethrough, task lists, autolinks (GitHub Flavor)
// - rehype-highlight : coloration syntaxique via highlight.js (zéro JS async,
//   léger, supporte 190+ langages)
// - markdownUrlTransform : étend la liste blanche des schemes pour
//   autoriser notre scheme custom `wiki-page://` (utilisé par
//   `linkifyWikiRefs` → ouvre les pages wiki dans le viewer interne).
//   Sans cette surcharge, react-markdown v10 strippe les URLs avec
//   scheme inconnu (comportement par défaut anti-XSS), et les clics
//   sur les wikilinks tombaient dans la branche "http(s)" qui spawne
//   une BrowserShape au lieu du viewer.
//
// Pour la coloration, on charge `highlight.js/styles/github-dark.css` dans
// `main.tsx` globalement. Côté dark natif de BlowWorks, github-dark fond
// parfaitement dans la palette var(--bg-*).
//
// Note : rehype-highlight ajoute les classes `hljs-*` au DOM. Si un jour on
// veut passer à shiki pour un rendu plus fidèle, ce fichier est le seul
// point de bascule — tous les messages passent par `markdownPlugins`.

export const markdownRemarkPlugins = [remarkGfm]
export const markdownRehypePlugins = [rehypeHighlight]

// Transform d'URL qui préserve `wiki-page://xxx.md` (scheme custom) et
// délègue au transform par défaut de react-markdown pour tout le reste.
// `defaultUrlTransform` garde http/https/mailto/tel et strippe les autres
// schemes dangereux (javascript:, data: avec HTML, etc.).
export function markdownUrlTransform(url: string): string {
  if (url.startsWith('wiki-page://')) return url
  return defaultUrlTransform(url)
}
