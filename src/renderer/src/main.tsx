import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import './styles/globals.css'
// Thème github-dark pour les code blocks rendus par rehype-highlight
// dans les messages IA (cf. `lib/markdown.ts`). Import global pour que
// les classes hljs-* soient stylées partout.
import 'highlight.js/styles/github-dark.css'

// Point d'entrée du renderer React 19.
const root = document.getElementById('root')
if (!root) throw new Error('Élément #root introuvable dans index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
