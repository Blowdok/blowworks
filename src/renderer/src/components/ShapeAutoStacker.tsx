import { useEffect, useRef, useState } from 'react'
import type { TLShape, TLShapeId, TLShapePartial } from 'tldraw'
import { useEditorStore } from '../stores/editor-store.js'
import { useWikiStore } from '../stores/wiki-store.js'

// Auto-stacker des shapes du canvas. Quand un panneau gauche est ouvert
// (viewer markdown ou graph wiki, signalé par `leftPanelWidthFraction`
// dans le wiki-store), repositionne toutes les shapes utilisateur
// (ChatShape, TerminalShape, BrowserShape, VSCodeShape) en colonne
// dans la zone libre droite, avec un gap entre elles.
//
// Au close du panneau, restaure les positions d'origine. Les shapes
// CRÉÉES pendant l'ouverture restent à leur position dans la colonne
// (leur backup est leur point d'apparition, pas leur position empilée).
//
// Implémentation :
//   1. `backupRef` Map<id, {x,y}> = position originale par shape vue
//      au moins une fois pendant cette session d'ouverture.
//   2. À l'ouverture / au resize / à l'apparition d'une nouvelle shape :
//      stack TOUTES les shapes en colonne (ordre stable = id).
//   3. À la fermeture : updateShapes pour restaurer les backupées,
//      puis vide la backup map.
//   4. `isReorganizingRef` empêche la boucle infinie : le listener
//      tldraw ignore les updates qui viennent de nous-mêmes.

const STACKABLE_TYPES = new Set(['chat', 'terminal', 'browser', 'vscode'])
const GAP = 24 // pixels de séparation entre shapes (et avec le bord du panel)

interface BackupEntry {
  x: number
  y: number
}

export default function ShapeAutoStacker(): null {
  const editor = useEditorStore((s) => s.editor)
  const frac = useWikiStore((s) => s.leftPanelWidthFraction)
  const backupRef = useRef<Map<TLShapeId, BackupEntry>>(new Map())
  const isReorganizingRef = useRef(false)
  // Tick incrémenté quand une nouvelle shape stackable apparaît pendant
  // qu'un panel est ouvert — force le re-stack.
  const [tick, setTick] = useState(0)

  // Listener tldraw : déclenche un re-stack quand l'user crée une
  // nouvelle shape pendant l'ouverture d'un panneau.
  useEffect(() => {
    if (!editor) return
    if (frac === null) return
    const unsub = editor.store.listen(
      (entry) => {
        if (isReorganizingRef.current) return
        const adds = Object.values(entry.changes.added)
        const hasStackableAdd = adds.some(
          (r) => r.typeName === 'shape' && STACKABLE_TYPES.has((r as TLShape).type)
        )
        if (hasStackableAdd) setTick((t) => t + 1)
      },
      { source: 'user', scope: 'document' }
    )
    return () => unsub()
  }, [editor, frac])

  // Effet principal : stack à l'ouverture / au resize / au tick ;
  // restore à la fermeture.
  useEffect(() => {
    if (!editor) return

    if (frac === null) {
      // Fermeture : restore les positions backupées.
      const backup = backupRef.current
      if (backup.size === 0) return
      isReorganizingRef.current = true
      try {
        const updates: TLShapePartial[] = []
        for (const [id, entry] of backup) {
          const shape = editor.getShape(id)
          if (shape) {
            updates.push({ id, type: shape.type, x: entry.x, y: entry.y })
          }
        }
        if (updates.length > 0) editor.updateShapes(updates)
      } finally {
        isReorganizingRef.current = false
      }
      backup.clear()
      return
    }

    // Ouverture ou changement de frac : (re)stack toutes les shapes.
    const overlay = document.getElementById('canvas-overlay-root')
    if (!overlay) return
    const rect = overlay.getBoundingClientRect()
    if (rect.width === 0) return

    isReorganizingRef.current = true
    try {
      const allShapes: TLShape[] = []
      for (const record of editor.store.allRecords()) {
        if (record.typeName !== 'shape') continue
        const s = record as TLShape
        if (STACKABLE_TYPES.has(s.type)) allShapes.push(s)
      }

      // Backup à la 1ère vue de chaque shape (position courante = point
      // d'origine / d'apparition). Idempotent grâce au has().
      for (const s of allShapes) {
        if (!backupRef.current.has(s.id)) {
          backupRef.current.set(s.id, { x: s.x, y: s.y })
        }
      }

      // Calcul de la zone libre droite en coordonnées page tldraw.
      const screenLeft = rect.left + rect.width * frac + GAP
      const screenTop = rect.top + GAP
      const topLeftPage = editor.screenToPage({ x: screenLeft, y: screenTop })

      // Empile en colonne. Ordre stable basé sur l'ID pour que le rendu
      // soit déterministe — pas de "saut" quand on bouge le panel.
      const sorted = [...allShapes].sort((a, b) => a.id.localeCompare(b.id))
      let currentY = topLeftPage.y
      const updates: TLShapePartial[] = []
      for (const s of sorted) {
        // Hauteur courante de la shape — toutes les shapes custom du
        // projet ont `props.h` (ChatShape/TerminalShape/BrowserShape/VSCodeShape).
        const h = typeof (s.props as { h?: number }).h === 'number'
          ? (s.props as { h: number }).h
          : 200
        updates.push({ id: s.id, type: s.type, x: topLeftPage.x, y: currentY })
        currentY += h + GAP
      }
      if (updates.length > 0) editor.updateShapes(updates)
    } finally {
      isReorganizingRef.current = false
    }
  }, [editor, frac, tick])

  return null
}
