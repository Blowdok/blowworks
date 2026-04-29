import { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '../../stores/editor-store.js'
import {
  spawnBrowserShape,
  spawnChatShape,
  spawnExplorerShape,
  spawnTerminalShape,
  spawnVSCodeShape
} from './InfiniteCanvas.js'
import { AI_SERVICES, type AIService } from '@shared/ai-services.js'

// Menu contextuel custom déclenché au clic droit sur l'espace VIDE du
// canvas (pas sur une shape — dans ce cas tldraw garde son menu natif).
// Chaque item crée la shape correspondante centrée EXACTEMENT sur le
// point cliqué (page coords), pour éviter les chevauchements.
//
// Montage : enfant du wrapper canvas dans `InfiniteCanvas`. Listen sur
// `contextmenu` au niveau document — on filtre par `e.target` pour ne
// s'activer que quand le clic vient du canvas tldraw.
//
// Le menu est positionné en `position: fixed` au clientX/clientY du clic
// (coords écran) et clamped aux bords du viewport pour ne pas sortir.

interface MenuState {
  open: boolean
  screenX: number
  screenY: number
  // Position cible du spawn en coords page tldraw (immuable au zoom/pan
  // — contrairement à screenX/Y qui sont juste pour placer le menu).
  pageX: number
  pageY: number
}

const INITIAL_STATE: MenuState = {
  open: false,
  screenX: 0,
  screenY: 0,
  pageX: 0,
  pageY: 0
}

export default function CanvasContextMenu(): React.ReactElement | null {
  const editor = useEditorStore((s) => s.editor)
  const [state, setState] = useState<MenuState>(INITIAL_STATE)
  // Drill-down dans le menu : 'main' = items shape principaux,
  // 'ai' = liste des assistants IA (Claude, ChatGPT, …). Reset à 'main'
  // à chaque ouverture pour repartir d'un état propre.
  const [view, setView] = useState<'main' | 'ai'>('main')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!editor) return

    function onContextMenu(e: MouseEvent): void {
      if (!editor) return
      // Ignore le clic droit sur nos propres panneaux overlay (viewer,
      // graph, sidebar, modales). Seul le canvas tldraw déclenche notre
      // menu custom. Test robuste : si la cible est DANS `.tl-container`
      // (racine de tldraw) ET PAS dans un overlay qu'on a mis au-dessus.
      const target = e.target as Element | null
      if (!target || !target.closest) return
      const inCanvas = target.closest('.tl-container')
      if (!inCanvas) return
      // Si le clic porte sur une shape existante, on laisse tldraw gérer
      // son propre menu contextuel (copier/supprimer/etc.).
      const pagePoint = editor.inputs.currentPagePoint
      const shapeAtPoint = editor.getShapeAtPoint(pagePoint, {
        hitInside: true,
        margin: 0
      })
      if (shapeAtPoint) return

      // Vide : on prend la main.
      e.preventDefault()
      e.stopPropagation()
      setView('main')
      setState({
        open: true,
        screenX: e.clientX,
        screenY: e.clientY,
        pageX: pagePoint.x,
        pageY: pagePoint.y
      })
    }

    // `capture: true` pour passer AVANT les handlers tldraw et pouvoir
    // preventDefault sur le menu tldraw natif (sinon il se déclenche
    // aussi derrière le nôtre).
    document.addEventListener('contextmenu', onContextMenu, { capture: true })
    return () => {
      document.removeEventListener('contextmenu', onContextMenu, { capture: true })
    }
  }, [editor])

  // Ferme au clic ailleurs / à l'Échap / au scroll.
  useEffect(() => {
    if (!state.open) return
    function close(): void {
      setState(INITIAL_STATE)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') close()
    }
    function onClickOutside(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onClickOutside, true)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onClickOutside, true)
      window.removeEventListener('scroll', close, true)
    }
  }, [state.open])

  if (!editor || !state.open) return null

  // Clamp le menu aux bords viewport. Hauteur estimée plus généreuse pour
  // la vue 'ai' (liste de 10 services). MENU_H sert juste au clamping —
  // si le menu réel est plus petit, c'est OK (left/top sont déjà bornés
  // au minimum, on n'a juste pas un gap parfait en bas).
  const MENU_W = 240
  const MENU_H = view === 'ai' ? 460 : 220
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.min(state.screenX, vw - MENU_W - 8)
  const top = Math.min(state.screenY, vh - MENU_H - 8)

  const at = { x: state.pageX, y: state.pageY }

  function handle(fn: () => void | Promise<void>): () => void {
    return () => {
      setState(INITIAL_STATE)
      void fn()
    }
  }

  async function openFolderAndSpawn(): Promise<void> {
    try {
      const folder = (await window.blow.dialog.pickFolder()) as string | null
      if (!folder || !editor) return
      spawnVSCodeShape(editor, folder, at)
    } catch (e) {
      console.error('[canvas-menu] échec ouverture dossier :', e)
    }
  }

  function recenterCamera(): void {
    if (!editor) return
    // Décale la caméra de la moitié du viewport pour que l'origine
    // (0, 0) du document soit pile au milieu de l'écran. Animation
    // 320 ms pour donner un contexte de mouvement au lieu d'un teleport.
    const vb = editor.getViewportScreenBounds()
    editor.setCamera(
      { x: vb.w / 2, y: vb.h / 2, z: 1 },
      { animation: { duration: 320 } }
    )
  }

  function handleSpawnAI(service: AIService): () => void {
    return () => {
      setState(INITIAL_STATE)
      if (editor) spawnBrowserShape(editor, service.homepage, at)
    }
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      className="pointer-events-auto fixed z-[60] flex flex-col gap-0.5 rounded-[var(--radius-sm)] border p-1 shadow-xl"
      style={{
        left,
        top,
        width: MENU_W,
        borderColor: 'var(--border)',
        background: 'var(--bg-secondary)'
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {view === 'main' ? (
        <>
          <div
            className="px-2 pb-1 pt-0.5 text-[9px] uppercase tracking-widest text-[var(--fg-muted)]"
          >
            Ajouter ici
          </div>
          <MenuItem icon="💬" label="Conversation IA" shortcut="Ctrl+K" onClick={handle(() => spawnChatShape(editor!, at))} />
          <MenuItem icon="⌨" label="Terminal" shortcut="Ctrl+T" onClick={handle(() => spawnTerminalShape(editor!, at))} />
          <MenuItem icon="🌐" label="Navigateur" shortcut="Ctrl+B" onClick={handle(() => spawnBrowserShape(editor!, undefined, at))} />
          <MenuItem icon="📝" label="VSCode (dossier…)" onClick={handle(openFolderAndSpawn)} />
          <MenuItem
            icon="📁"
            label="Explorateur de fichiers"
            onClick={handle(() => spawnExplorerShape(editor!, at))}
          />
          <MenuItem icon="✨" label="IA" trailing="▸" onClick={() => setView('ai')} />
          <div className="my-0.5 h-px" style={{ background: 'var(--border)' }} />
          <MenuItem icon="⊕" label="Centrer le canvas" onClick={handle(recenterCamera)} />
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setView('main')}
            className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-left text-[10px] uppercase tracking-widest text-[var(--fg-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
          >
            <span aria-hidden>←</span>
            <span>Assistants IA</span>
          </button>
          <div className="my-0.5 h-px" style={{ background: 'var(--border)' }} />
          {AI_SERVICES.map((svc) => (
            <button
              key={svc.id}
              type="button"
              role="menuitem"
              onClick={handleSpawnAI(svc)}
              className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[12px] text-[var(--fg-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
            >
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                style={{ background: svc.color }}
                aria-hidden
              >
                {svc.label[0]}
              </span>
              <span className="flex-1 truncate">{svc.label}</span>
            </button>
          ))}
        </>
      )}
    </div>
  )
}

function MenuItem({
  icon,
  label,
  shortcut,
  trailing,
  onClick
}: {
  icon: string
  label: string
  shortcut?: string
  // Glyphe en bout de ligne, ex: '▸' pour signaler un sous-menu. Mutuellement
  // exclusif avec `shortcut` côté usage (un item est soit un raccourci soit
  // un drill-down), mais on ne le force pas en typage pour rester souple.
  trailing?: string
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[12px] text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
    >
      <span className="w-4 text-center">{icon}</span>
      <span className="flex-1">{label}</span>
      {shortcut && (
        <span className="text-[10px] text-[var(--fg-muted)]">{shortcut}</span>
      )}
      {trailing && (
        <span className="text-[10px] text-[var(--fg-muted)]">{trailing}</span>
      )}
    </button>
  )
}
