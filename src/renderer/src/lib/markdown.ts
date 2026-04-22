import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

// Configuration partagée pour react-markdown :
// - remark-gfm : tables, strikethrough, task lists, autolinks (GitHub Flavor)
// - rehype-highlight : coloration syntaxique via highlight.js (zéro JS async,
//   léger, supporte 190+ langages)
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
