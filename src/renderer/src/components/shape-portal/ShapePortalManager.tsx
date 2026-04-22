import { useValue, useEditor, type Editor, type TLShape } from 'tldraw'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { VSCodePortalContent, type VSCodeShape } from '../canvas/shapes/VSCodeShape.js'
import { TerminalPortalContent, type TerminalShape } from '../canvas/shapes/TerminalShape.js'
import { ChatPortalContent, type ChatShape } from '../canvas/shapes/ChatShape.js'
import { usePortalHoverStore } from '../../stores/portal-hover-store.js'

// Manager global qui maintient en DOM un portail par shape "lourde" (VSCode,
// Terminal). Les portails survivent aux switch de pages tldraw car ce
// composant vit au niveau `<Tldraw>` et itère sur le store entier (toutes
// pages confondues) via `editor.store.allRecords()`.
//
// POSITIONNEMENT : chaque slot suit en rAF la BCR du placeholder DOM
// rendu par tldraw (identifié par `[data-blowworks-shape-id="<id>"]`).
// C'est la seule source de vérité fiable pour s'aligner avec la bordure
// de sélection tldraw qui utilise les coords DOM réelles.
//
// CLIPPING : tous les slots sont enfants d'un conteneur positionné
// EXACTEMENT sur la zone canvas (via `useCanvasRect`) avec
// `overflow: hidden`. Quand une shape est déplacée au-delà du canvas
// (vers sidebar/header), l'iframe est clippée automatiquement et ne
// déborde plus sur les zones UI hors canvas.
export default function ShapePortalManager(): React.ReactElement {
  const editor = useEditor()

  // Liste des shapes portail à rendre + rang z-order de chaque shape.
  //
  // CRITIQUE : l'ordre de sortie est STABLE (trié par `shape.id`) car tout
  // réordonnancement du DOM parent fait que Chromium RECHARGE les iframes
  // contenues (détache/réattache). Pour n'importe quel bring-to-front, les
  // slots DOM ne changent JAMAIS de position — seul leur `zIndex` CSS
  // varie. Le stacking visuel et le hit-testing (`elementFromPoint`)
  // respectent le z-index, donc la sémantique tldraw est préservée sans
  // jamais remount une iframe VSCode ou une instance xterm.
  const { portalShapes, zIndexById, topIdByPage } = useValue(
    'portal-shapes',
    () => {
      const shapes: TLShape[] = []
      for (const record of editor.store.allRecords()) {
        if (record.typeName !== 'shape') continue
        const shape = record as TLShape
        if (shape.type === 'vscode' || shape.type === 'terminal' || shape.type === 'chat') {
          shapes.push(shape)
        }
      }
      // Ordre z : par `shape.index` tldraw (IndexKey lexicographique).
      const zSorted = [...shapes].sort((a, b) =>
        a.index > b.index ? 1 : a.index < b.index ? -1 : 0
      )
      const rank = new Map<string, number>()
      zSorted.forEach((s, i) => rank.set(s.id, i))
      // Top par page : la dernière shape itérée (ordre croissant) avec ce
      // parentId est celle au plus haut `shape.index` de la page, donc au
      // premier plan. Utilisé pour activer le "click-shield" sur toutes
      // les autres shapes portail de la même page.
      const topIdByPage = new Map<string, string>()
      for (const s of zSorted) {
        const pageId = (s as TLShape & { parentId: string }).parentId
        topIdByPage.set(pageId, s.id)
      }
      // Ordre DOM : STABLE par `shape.id`. Nouvelles shapes ajoutées à la
      // fin, supprimées sans bouger les autres. Garantit qu'aucune iframe
      // ne change de position DOM lors d'un bringToFront.
      shapes.sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0))
      return { portalShapes: shapes, zIndexById: rank, topIdByPage }
    },
    [editor]
  )

  const currentPageId = useValue('current-page-id', () => editor.getCurrentPageId(), [editor])
  const canvasRect = useCanvasRect()

  // Helper : vérifie si une shape portail est DÉJÀ au top de la pile
  // des shapes portail de la page courante (vscode/terminal uniquement).
  // Évite les writes redondants au store tldraw (un bringToFront sur une
  // shape déjà top déclenche quand même un changement d'index + save).
  const isShapeAlreadyTop = (shapeId: string): boolean => {
    const pageId = editor.getCurrentPageId()
    let top: { id: string; index: string } | null = null
    for (const record of editor.store.allRecords()) {
      if (record.typeName !== 'shape') continue
      const s = record as TLShape & { parentId: string }
      if (s.parentId !== pageId) continue
      if (s.type !== 'vscode' && s.type !== 'terminal' && s.type !== 'chat') continue
      if (!top || s.index > top.index) {
        top = { id: s.id, index: s.index as string }
      }
    }
    return top?.id === shapeId
  }

  // Bring-to-front + select automatique quand l'utilisateur clique DANS
  // une iframe. Les iframes cross-origin n'émettent pas de mousedown vers
  // le parent (sécurité navigateur), mais on détecte le transfert de
  // focus via `window.blur` : si `document.activeElement` devient une
  // iframe enfant d'un slot portail, on remonte la shape au top-order
  // tldraw et on la sélectionne pour afficher la bordure bleue.
  //
  // Robustesse : double rAF pour laisser le navigateur stabiliser
  // `document.activeElement` (en cas de switch rapide iframe A → B,
  // le premier rAF peut encore voir A, le second voit B). Dedup via
  // `isShapeAlreadyTop` pour éviter les writes redondants.
  useEffect(() => {
    const onBlur = (): void => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const active = document.activeElement
          if (!(active instanceof HTMLIFrameElement)) return
          const slot = active.closest<HTMLElement>('[data-shape-portal]')
          const shapeId = slot?.getAttribute('data-shape-portal')
          if (!shapeId) return
          const alreadyTop = isShapeAlreadyTop(shapeId)
          // Immersion : l'utilisateur clique DANS une iframe (VSCode) →
          // il veut travailler dedans SANS chrome tldraw (ni bordure
          // bleue, ni handles de resize). On bring-to-front (pour l'ordre
          // z) et on DÉSÉLECTIONNE (au lieu de sélectionner comme avant)
          // → tldraw ne dessine plus d'overlay pour cette shape. L'état
          // « active work » est également set dans le store pour que
          // `useShapeBorderState` masque aussi la bordure de hover.
          //
          // Le retour à l'état « selected » (bordure bleue + handles
          // visibles) se fait au clic sur le HEADER de la shape — traité
          // par le listener global pointerdown ci-dessous.
          editor.run(() => {
            if (!alreadyTop) editor.bringToFront([shapeId as never])
            if (editor.getSelectedShapeIds().length > 0) {
              editor.setSelectedShapes([])
            }
          })
          usePortalHoverStore.getState().setActiveWorkShapeId(shapeId as never)
        })
      })
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Bring-to-front AUTOMATIQUE sur sélection tldraw : couvre les cas où
  // l'utilisateur sélectionne une shape portail sans passer par son
  // iframe (clic sur header avec `pointer-events: none`, clic sur la
  // bordure invisible, drag-select rectangulaire, Tab clavier…).
  // Sans ce hook, la shape est sélectionnée (bordure bleue) mais reste
  // derrière une autre shape qui la chevauche — contre-intuitif.
  //
  // Ne déclenche le bring-to-front que pour une sélection SIMPLE d'une
  // shape portail, et SEULEMENT si la shape n'est pas déjà au top (évite
  // les boucles : bringToFront → change d'index → re-sélection…).
  const selectedIds = useValue(
    'selected-portal-shape',
    () => editor.getSelectedShapeIds(),
    [editor]
  )

  useEffect(() => {
    if (selectedIds.length !== 1) return
    const shapeId = selectedIds[0]
    const shape = editor.getShape(shapeId)
    if (!shape) return
    if (shape.type !== 'vscode' && shape.type !== 'terminal' && shape.type !== 'chat') return
    if (isShapeAlreadyTop(shapeId)) return
    editor.bringToFront([shapeId])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, editor])

  // Listener global `pointerdown` (capture phase) — détermine l'état
  // « active work » selon où l'utilisateur clique dans un slot portail :
  //
  //   - Clic dans la bande HEADER (top 28 px) → clear active work. tldraw
  //     va ensuite sélectionner la shape via son hit-testing natif (le
  //     header a `pointer-events: none` pour laisser tldraw capturer le
  //     pointerdown) → bordure bleue + handles de resize apparaissent.
  //
  //   - Clic dans le BODY (xterm, Chat, boutons header pointer-events auto
  //     en dessous des 28 px) → set active work + DÉSÉLECTIONNE tldraw
  //     (pour cacher la bordure bleue native et les handles). Immersion
  //     totale : l'utilisateur travaille dans la shape sans chrome.
  //
  //   - Clic HORS de tout slot (canvas vide) → tldraw désélectionne
  //     nativement. L'active work reste set jusqu'au prochain mouseleave
  //     du slot (voir handler onMouseLeave), ce qui laisse l'immersion
  //     active tant que la souris reste sur la shape.
  //
  // Les clics À L'INTÉRIEUR d'une iframe (VSCode) ne bubble PAS au window
  // parent → le listener `window.blur` ci-dessus couvre ce cas.
  useEffect(() => {
    const HEADER_HEIGHT = 28
    const handler = (e: PointerEvent): void => {
      const slots = document.querySelectorAll<HTMLElement>('[data-shape-portal]')
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        const rect = slot.getBoundingClientRect()
        if (
          e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom
        ) {
          continue
        }
        const shapeId = slot.getAttribute('data-shape-portal')
        if (shapeId === null) return
        const store = usePortalHoverStore.getState()
        if (e.clientY < rect.top + HEADER_HEIGHT) {
          store.setActiveWorkShapeId(null)
        } else {
          store.setActiveWorkShapeId(shapeId as never)
          // Immersion : désélectionner tldraw pour masquer la bordure
          // bleue native + les handles de resize. Bring-to-front pour
          // respecter le pattern UX fenêtré (la shape sur laquelle on
          // interagit monte au top). Les deux opérations sont regroupées
          // dans `editor.run()` pour n'émettre qu'un seul history entry.
          editor.run(() => {
            if (!isShapeAlreadyTop(shapeId)) {
              editor.bringToFront([shapeId as never])
            }
            if (editor.getSelectedShapeIds().length > 0) {
              editor.setSelectedShapes([])
            }
          })
        }
        return
      }
      // Clic hors de tout slot portail (canvas vide ou sidebar) → clear
      // l'active work. tldraw fait sa propre désélection via son handler
      // natif, on se contente d'aligner notre store.
      usePortalHoverStore.getState().setActiveWorkShapeId(null)
    }
    window.addEventListener('pointerdown', handler, true)
    return () => window.removeEventListener('pointerdown', handler, true)
  }, [editor])

  const clipStyle: CSSProperties = {
    position: 'fixed',
    left: canvasRect.left,
    top: canvasRect.top,
    width: canvasRect.width,
    height: canvasRect.height,
    // Clip : toute iframe qui sortirait du canvas (drag vers sidebar
    // ou header) est visuellement coupée ici — pas de débordement UI.
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: 40
  }

  const selectedSet = new Set(selectedIds)

  return (
    <div style={clipStyle} data-shape-portal-clip="">
      {portalShapes.map((shape) => {
        const pageId = (shape as TLShape & { parentId: string }).parentId
        // `isTop` : cette shape portail est-elle la shape portail la plus
        // haute (`shape.index` max) de sa page ? Seule la shape top reçoit
        // les événements pointeur directement vers son iframe. Les autres
        // sont protégées par un "click-shield" (voir commentaire dans
        // ShapePortalSlot).
        const isTop = topIdByPage.get(pageId) === shape.id
        return (
          <ShapePortalSlot
            key={shape.id}
            shape={shape}
            currentPageId={currentPageId}
            canvasRect={canvasRect}
            zIndex={zIndexById.get(shape.id) ?? 0}
            isSelected={selectedSet.has(shape.id)}
            isTop={isTop}
            editor={editor}
          />
        )
      })}
    </div>
  )
}

// BCR live du canvas tldraw dans la fenêtre. Sert à positionner le clip
// et à convertir les bounds window-absolute des slots en bounds relatives
// au clip.
function useCanvasRect(): { left: number; top: number; width: number; height: number } {
  const [rect, setRect] = useState({ left: 0, top: 0, width: 0, height: 0 })

  useEffect(() => {
    let canvas: Element | null = null
    let resizeObserver: ResizeObserver | null = null

    const update = (): void => {
      if (!canvas) return
      const r = canvas.getBoundingClientRect()
      setRect((prev) =>
        prev.left === r.left &&
        prev.top === r.top &&
        prev.width === r.width &&
        prev.height === r.height
          ? prev
          : { left: r.left, top: r.top, width: r.width, height: r.height }
      )
    }

    const attach = (): boolean => {
      canvas = document.querySelector('.tl-container')
      if (!canvas) return false
      update()
      resizeObserver = new ResizeObserver(update)
      resizeObserver.observe(canvas)
      if (canvas.parentElement) resizeObserver.observe(canvas.parentElement)
      return true
    }

    if (!attach()) {
      const interval = window.setInterval(() => {
        if (attach()) window.clearInterval(interval)
      }, 50)
      return () => {
        window.clearInterval(interval)
        resizeObserver?.disconnect()
      }
    }

    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [])

  return rect
}

interface Bounds {
  left: number
  top: number
  width: number
  height: number
}

// Rectangle en coords locales au slot (origine = coin haut-gauche du slot).
interface LocalRect {
  left: number
  top: number
  right: number
  bottom: number
}

// Soustraction géométrique : découpe chaque rect de `baseRects` en jusqu'à
// 4 bandes (haut / bas / gauche / droite) autour de l'intersection avec `cut`.
// Utilisé pour construire le click-shield uniquement sur la ZONE VISIBLE
// d'une shape arrière (celle non recouverte par une shape portail au-dessus)
// — sinon le shield intercepte les clics du header de la fenêtre du dessus
// et bloque drag/resize tldraw.
function subtractRect(baseRects: LocalRect[], cut: LocalRect): LocalRect[] {
  const result: LocalRect[] = []
  for (const base of baseRects) {
    const ix1 = Math.max(base.left, cut.left)
    const iy1 = Math.max(base.top, cut.top)
    const ix2 = Math.min(base.right, cut.right)
    const iy2 = Math.min(base.bottom, cut.bottom)
    if (ix1 >= ix2 || iy1 >= iy2) {
      result.push(base)
      continue
    }
    if (base.top < iy1)
      result.push({ left: base.left, top: base.top, right: base.right, bottom: iy1 })
    if (iy2 < base.bottom)
      result.push({ left: base.left, top: iy2, right: base.right, bottom: base.bottom })
    if (base.left < ix1)
      result.push({ left: base.left, top: iy1, right: ix1, bottom: iy2 })
    if (ix2 < base.right)
      result.push({ left: ix2, top: iy1, right: base.right, bottom: iy2 })
  }
  return result
}

function sameRectList(a: LocalRect[], b: LocalRect[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].left !== b[i].left ||
      a[i].top !== b[i].top ||
      a[i].right !== b[i].right ||
      a[i].bottom !== b[i].bottom
    )
      return false
  }
  return true
}

function ShapePortalSlot({
  shape,
  currentPageId,
  canvasRect,
  zIndex,
  isSelected,
  isTop,
  editor
}: {
  shape: TLShape
  currentPageId: string
  canvasRect: { left: number; top: number }
  zIndex: number
  isSelected: boolean
  isTop: boolean
  editor: Editor
}): React.ReactElement | null {
  const [bounds, setBounds] = useState<Bounds | null>(null)
  const lastRef = useRef<Bounds | null>(null)
  // Rectangles DÉCOUPÉS du click-shield : uniquement la zone de la shape
  // arrière NON recouverte par une shape portail au z-index supérieur.
  // Vide quand `isTop` (pas de shield) ou quand la shape est entièrement
  // recouverte (aucune zone libre → aucun mini-shield rendu, drag/resize
  // via le header passe directement à tldraw).
  const [shieldRects, setShieldRects] = useState<LocalRect[]>([])
  const lastShieldRef = useRef<LocalRect[]>([])

  const visible = (shape as TLShape & { parentId: string }).parentId === currentPageId

  useEffect(() => {
    if (!visible) return
    let rafId: number
    const tick = (): void => {
      const el = document.querySelector<HTMLDivElement>(
        `[data-blowworks-shape-id="${shape.id}"]`
      )
      if (el) {
        const r = el.getBoundingClientRect()
        const next: Bounds = {
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height
        }
        const prev = lastRef.current
        if (
          !prev ||
          prev.left !== next.left ||
          prev.top !== next.top ||
          prev.width !== next.width ||
          prev.height !== next.height
        ) {
          lastRef.current = next
          setBounds(next)
        }

        // Calcul des shieldRects : part du slot entier et soustrait
        // la BCR de chaque autre slot portail au z-index supérieur.
        // Lecture directe des BCR (indépendante de `pointer-events`)
        // pour refléter la géométrie exacte, y compris les headers
        // en `pointer-events: none` que `elementsFromPoint` ignorerait.
        //
        // CRITIQUE : filtrer par `visibility === 'visible'` pour exclure
        // les slots des AUTRES pages. Sans ce filtre, les shapes de la
        // page inactive (rendues en visibility:hidden mais BCR toujours
        // présente) sont comptées comme "recouvrant" celles de la page
        // active, ce qui clippe à inset(100%) tous les slots non-top de
        // la page 2+ — bug visible quand plusieurs ChatShapes / VSCode
        // cohabitent sur une 2ème page.
        if (!isTop) {
          let rects: LocalRect[] = [
            { left: 0, top: 0, right: next.width, bottom: next.height }
          ]
          const allSlots = document.querySelectorAll<HTMLElement>('[data-shape-portal]')
          for (const otherSlot of allSlots) {
            const otherId = otherSlot.getAttribute('data-shape-portal')
            if (!otherId || otherId === shape.id) continue
            if (otherSlot.style.visibility === 'hidden') continue
            const otherZ = Number(otherSlot.style.zIndex || '0')
            if (otherZ <= zIndex) continue
            const or = otherSlot.getBoundingClientRect()
            const cut: LocalRect = {
              left: or.left - next.left,
              top: or.top - next.top,
              right: or.right - next.left,
              bottom: or.bottom - next.top
            }
            rects = subtractRect(rects, cut)
            if (rects.length === 0) break
          }
          if (!sameRectList(lastShieldRef.current, rects)) {
            lastShieldRef.current = rects
            setShieldRects(rects)
          }
        } else if (lastShieldRef.current.length !== 0) {
          lastShieldRef.current = []
          setShieldRects([])
        }
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [shape.id, visible, isTop, zIndex])

  if (!bounds) return null

  // Clip-path dynamique : pour les shapes NON-TOP, restreindre le slot
  // aux zones visibles (non couvertes par une shape portail au-dessus).
  // La spec CSS masking indique que `clip-path` affecte le rendu ET le
  // hit-testing — les zones clippées deviennent donc TRANSPARENTES au
  // pointer-events, y compris pour les wrappers iframe / xterm internes
  // (pointer-events: auto) qui, sans cela, interceptaient le clic sur
  // la zone de chevauchement et déclenchaient un bringToFront parasite
  // (ping-pong). Avec le clip, un clic sur la zone de chevauchement
  // passe à travers le slot arrière et atteint la shape tldraw pour un
  // drag natif.
  //
  // Cas shieldRects vide (shape entièrement couverte) : clip-path
  // `inset(100%)` masque intégralement le slot (et désactive le
  // hit-test) ; l'iframe reste vivante dans le DOM pour être restaurée
  // dès qu'un bring-to-front la remet au top. Cas shape top : pas de
  // clip, la shape reste pleinement interactive.
  let clipPath: string | undefined
  if (!isTop) {
    if (shieldRects.length === 0) {
      clipPath = 'inset(100%)'
    } else {
      clipPath = `path('${shieldRects
        .map(
          (r) =>
            `M${r.left},${r.top}L${r.right},${r.top}L${r.right},${r.bottom}L${r.left},${r.bottom}Z`
        )
        .join('')}')`
    }
  }

  // Coords relatives au clip container (qui est positionné sur le canvas).
  // Soustraction du canvasRect pour convertir window-absolute → local.
  const style: CSSProperties = {
    position: 'absolute',
    left: bounds.left - canvasRect.left,
    top: bounds.top - canvasRect.top,
    width: bounds.width,
    height: bounds.height,
    visibility: visible ? 'visible' : 'hidden',
    // `pointer-events: none` sur le slot lui-même : l'intérieur (header +
    // iframe) gère ses propres zones interactives via `pointer-events:
    // auto` explicite. Permet au drag-tldraw de passer à travers le
    // header (clic-glisser pour déplacer la shape), même quand 2 shapes
    // se chevauchent — chacune laisse passer le clic à la shape sous-jacente
    // jusqu'à atteindre la vraie shape tldraw ciblée.
    pointerEvents: 'none',
    transformOrigin: '0 0',
    // Stacking visuel via z-index CSS : indispensable car l'ordre DOM
    // des slots est STABLE (trié par `shape.id`) pour ne jamais remount
    // les iframes VSCode / xterm. Le `zIndex` ici est calculé depuis
    // `shape.index` tldraw côté manager, donc respecte la sémantique
    // bring-to-front SANS déclencher de réordonnancement DOM (et donc
    // SANS rechargement d'iframe côté Chromium).
    zIndex,
    clipPath
  }

  return (
    <div
      style={style}
      data-shape-portal={shape.id}
      // Bloque le bubbling de `contextmenu` pour que le menu natif de
      // l'iframe (ou le menu VSCode) s'affiche sans être masqué par le
      // menu tldraw qui écoute au niveau document.
      onContextMenu={(e) => e.stopPropagation()}
      // Détection DOM du survol — `editor.getHoveredShapeId()` tldraw ne se
      // met PAS à jour quand la souris est au-dessus d'une iframe (l'iframe
      // capture les events), donc on publie ici dans le store partagé.
      // `onMouseEnter/Leave` fonctionnent même avec `pointer-events: none`
      // sur le slot car les events bubble depuis les descendants
      // `pointer-events: auto` (iframe, xterm, boutons header).
      onMouseEnter={() => {
        usePortalHoverStore.getState().setHoveredShapeId(shape.id)
      }}
      onMouseLeave={() => {
        const store = usePortalHoverStore.getState()
        if (store.hoveredShapeId === shape.id) {
          store.setHoveredShapeId(null)
        }
        // L'utilisateur sort de la shape → fin d'immersion. Clear l'active
        // work pour que les hovers fonctionnent à nouveau normalement lors
        // du prochain retour de la souris (sinon active work persisterait
        // et masquerait la bordure de hover).
        if (store.activeWorkShapeId === shape.id) {
          store.setActiveWorkShapeId(null)
        }
      }}
    >
      {shape.type === 'vscode' && <VSCodePortalContent shape={shape as VSCodeShape} />}
      {shape.type === 'terminal' && <TerminalPortalContent shape={shape as TerminalShape} />}
      {shape.type === 'chat' && <ChatPortalContent shape={shape as ChatShape} />}
      {!isTop && visible && shieldRects.length > 0 && (
        <div
          aria-hidden
          data-shape-portal-shield=""
          // CLICK-SHIELD : overlay transparent sur TOUTE la surface du
          // slot. Le clip-path du slot parent (calculé depuis shieldRects)
          // le limite automatiquement aux zones visibles de la shape
          // arrière — sur la zone de chevauchement, le slot est exclu
          // du hit-test, donc le shield l'est aussi : le pointerdown
          // descend jusqu'à tldraw et le drag natif démarre.
          //
          // Rôle du shield sur les zones visibles : fournir l'UX
          // "Windows click-to-raise" (1 clic pour activer une shape
          // arrière, 2ᵉ clic pour interagir avec son iframe). Aussi :
          // contourner le bug de hit-testing Chromium OOPIF — quand
          // deux iframes cross-origin se chevauchent, le compositeur
          // peut router le clic vers l'iframe sous-jacente au lieu de
          // celle au-dessus. Le shield capte le pointerdown AVANT qu'il
          // n'atteigne l'iframe, déclenche `bringToFront`, puis disparaît
          // (car `isTop` devient true) ; le clic suivant passe à l'iframe.
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'auto',
            cursor: 'default',
            // Transparent mais DOIT être peint (background rgba 0) sinon
            // certains navigateurs le sautent pour le hit-testing.
            background: 'rgba(0,0,0,0)'
          }}
          onPointerDown={(e) => {
            // Stop propagation pour ne pas laisser tldraw démarrer un
            // drag-select dans le canvas derrière le slot.
            e.stopPropagation()
            editor.run(() => {
              editor.bringToFront([shape.id])
              editor.setSelectedShapes([shape.id])
            })
          }}
        />
      )}
      {isSelected && visible && (
        <div
          aria-hidden
          // Bordure de sélection bleue RE-rendue dans le slot portail.
          // La bordure SVG native de tldraw (indicator `<rect>`) vit dans
          // le layer overlay de tldraw (z-index interne < 40), donc est
          // MASQUÉE par n'importe quelle iframe portail qui la croise —
          // même celles d'une shape de z-index portail INFÉRIEUR, car
          // toutes les iframes sont toujours au-dessus du SVG overlay.
          //
          // En plaçant la bordure ici, elle partage le `zIndex` CSS du
          // slot courant : pour la shape sélectionnée (portée en haut
          // de la pile par `bringToFront`), son zIndex est le plus élevé,
          // donc la bordure passe correctement PAR-DESSUS les iframes des
          // slots inférieurs. `pointer-events: none` pour ne pas bloquer
          // clics / drag sur l'iframe en dessous.
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            boxSizing: 'border-box',
            border: '1.5px solid var(--color-selected, #4465e9)',
            borderRadius: 8
          }}
        />
      )}
    </div>
  )
}
