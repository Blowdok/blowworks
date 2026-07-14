import { useRef, useEffect } from 'react'
import { ArrowUp, Globe, Paperclip, Square, Zap } from 'lucide-react'

import type { AIImageAttachmentT } from '@shared/ipc-contract.js'

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  isStreaming: boolean
  disabled: boolean
  disabledReason?: string
  webSearchEnabled: boolean
  onToggleWebSearch: () => void
  attachments?: AIImageAttachmentT[]
  onRemoveAttachment?: (index: number) => void
  onAttach?: () => void
  onOptimize?: () => void
}

// Zone de saisie d'une ChatShape — capsule flottante immersive :
// - Surface extérieure fondue dans le canvas (#101011), sans bordure visible.
// - Capsule intérieure légèrement détachée (fond #1a1a1b, shadow douce,
//   coin 16 px), textarea en haut et barre d'actions en bas (icônes
//   lucide à gauche, bouton envoyer circulaire à droite).
// - Entrée : envoie. Shift+Entrée : saut de ligne.
// - Pendant un stream, « Envoyer » devient « Stop » (carré rouge).
export default function ChatInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  isStreaming,
  disabled,
  disabledReason,
  webSearchEnabled,
  onToggleWebSearch,
  attachments = [],
  onRemoveAttachment,
  onAttach,
  onOptimize
}: ChatInputProps): React.ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Auto-grow « respectueux » — cohabite avec le resize manuel vertical
  // (poignée native en bas-droite du textarea) :
  //   - Champ vide (après submit) → reset à la hauteur naturelle (min-h
  //     définie en classe), laissant le prochain auto-grow repartir de zéro.
  //   - Contenu qui déborde (scrollHeight > hauteur courante) → le textarea
  //     grandit jusqu'à ~80 % du conteneur parent. Ce cas couvre l'usage
  //     normal (tape plusieurs lignes) mais aussi la borne basse si
  //     l'utilisateur a resize trop petit.
  //   - Contenu qui tient dans la hauteur actuelle → on NE touche PAS au
  //     style.height : la hauteur définie manuellement par drag est
  //     préservée tant que l'utilisateur tape dedans.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    if (value.length === 0) {
      el.style.height = ''
      return
    }
    if (el.scrollHeight > el.offsetHeight) {
      const max = Math.round(el.parentElement!.clientHeight * 0.8)
      el.style.height = Math.min(el.scrollHeight, max) + 'px'
    }
  }, [value])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      if (isStreaming) {
        onCancel()
      } else if (!disabled && (value.trim().length > 0 || attachments.length > 0)) {
        onSubmit()
      }
    }
  }

  // Empêche tldraw de recevoir le pointerdown sur textarea / boutons.
  const stopInteractive = {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onTouchStart: (e: React.TouchEvent) => e.stopPropagation()
  }

  const canSubmit = !disabled && (value.trim().length > 0 || attachments.length > 0)

  return (
    <div
      // Surface externe fondue au canvas : même teinte #101011, pas de
      // bordure visible. Le padding crée la marge qui fait « flotter » la
      // capsule intérieure.
      className="shrink-0 px-3 pb-3 pt-2"
      style={{
        background: 'var(--shape-surface, #101011)',
        pointerEvents: 'auto'
      }}
      {...stopInteractive}
    >
      <div
        // Capsule « zero chrome » : fond ET bordure fondus au canvas
        // (#101011). Seule la shadow projetée vers le bas révèle la
        // présence de la capsule au repos, et la bordure cyan apparaît au
        // focus pour signaler que le champ est actif. Pattern minimaliste
        // extrême — la zone de saisie n'existe plus comme objet encadré,
        // elle est suggérée par la lumière.
        // `mx-auto max-w-[720px]` : centrage adaptatif aligné sur la colonne
        // de lecture du ChatMessageList → la capsule garde la même largeur
        // visuelle que les messages quelle que soit la taille de la shape.
        className="mx-auto flex w-full max-w-[720px] flex-col gap-1.5 rounded-[16px] px-3 pb-2 pt-2.5 transition-colors focus-within:border-[#00ffff5a]"
        style={{
          background: 'var(--shape-surface, #101011)',
          border: '1px solid var(--shape-surface, #101011)',
          boxShadow:
            '0 8px 24px -6px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.02) inset'
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            disabled && disabledReason
              ? disabledReason
              : 'Écrivez votre message… (Entrée pour envoyer, Shift+Entrée pour saut de ligne)'
          }
          className="chat-textarea min-h-[44px] max-h-[360px] w-full resize-y border-none bg-transparent px-0 py-0.5 text-[13px] leading-relaxed text-[var(--fg-primary)] placeholder:text-[var(--fg-muted)] outline-none focus:outline-none focus:ring-0"
          disabled={disabled && !isStreaming}
          {...stopInteractive}
        />

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((att, index) => (
              <div
                key={`${att.name}-${index}`}
                className="group relative overflow-hidden rounded-[10px] border"
                style={{ borderColor: 'var(--border)' }}
              >
                <img
                  src={att.dataUrl}
                  alt={att.name}
                  className="h-16 w-16 object-cover"
                  draggable={false}
                />
                {onRemoveAttachment && (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(index)}
                    className="absolute right-0.5 top-0.5 rounded bg-black/70 px-1 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100"
                    title="Retirer"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-0.5">
            <IconToggle
              active={webSearchEnabled}
              onClick={onToggleWebSearch}
              title={
                webSearchEnabled
                  ? 'Recherche web activée (Tavily)'
                  : 'Activer la recherche web (Tavily)'
              }
              Icon={Globe}
            />
            <IconButton
              disabled={disabled || isStreaming || !onAttach}
              onClick={onAttach}
              title="Joindre une image (max 4)"
              Icon={Paperclip}
            />
            <IconButton
              disabled
              onClick={onOptimize}
              title="Optimiser le prompt (bientôt)"
              Icon={Zap}
            />
          </div>

          <SendButton
            isStreaming={isStreaming}
            canSubmit={canSubmit}
            onSubmit={onSubmit}
            onCancel={onCancel}
            stopInteractive={stopInteractive}
          />
        </div>
      </div>
    </div>
  )
}

// Bouton envoyer circulaire — ArrowUp plein quand une requête peut partir,
// Square rouge pendant un stream (clic = annule). Dimension 30 px pour un
// ratio visuel équilibré face aux icônes d'actions (18 px).
function SendButton({
  isStreaming,
  canSubmit,
  onSubmit,
  onCancel,
  stopInteractive
}: {
  isStreaming: boolean
  canSubmit: boolean
  onSubmit: () => void
  onCancel: () => void
  stopInteractive: {
    onPointerDown: (e: React.PointerEvent) => void
    onTouchStart: (e: React.TouchEvent) => void
  }
}): React.ReactElement {
  const isActive = isStreaming || canSubmit

  return (
    <button
      type="button"
      onClick={isStreaming ? onCancel : onSubmit}
      disabled={!isStreaming && !canSubmit}
      aria-label={isStreaming ? 'Arrêter la génération' : 'Envoyer le message'}
      title={isStreaming ? 'Arrêter' : 'Envoyer'}
      className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full transition-all duration-150 disabled:cursor-not-allowed"
      style={{
        background: isStreaming
          ? '#f87171'
          : canSubmit
            ? 'var(--fg-primary)'
            : 'rgba(255, 255, 255, 0.08)',
        color: isStreaming ? '#ffffff' : canSubmit ? '#0a0a0a' : 'var(--fg-muted)',
        transform: isActive ? 'scale(1)' : 'scale(0.96)'
      }}
      {...stopInteractive}
    >
      {isStreaming ? (
        <Square size={13} strokeWidth={0} fill="currentColor" />
      ) : (
        <ArrowUp size={17} strokeWidth={2.5} />
      )}
    </button>
  )
}

// Interrupteur d'état pour une option (recherche web, raisonnement…). Actif :
// fond cyan subtil + icône cyan ; inactif : neutre muted.
function IconToggle({
  active,
  onClick,
  title,
  Icon
}: {
  active: boolean
  onClick: () => void
  title: string
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className="flex h-7 w-7 items-center justify-center rounded-[10px] transition-colors"
      style={{
        background: active ? 'rgba(0, 255, 255, 0.12)' : 'transparent',
        color: active ? 'var(--fg-secondary)' : 'var(--fg-muted)'
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Icon size={17} strokeWidth={2} />
    </button>
  )
}

// Action ponctuelle (attach, optimize). Hover = survole vers blanc ; disabled
// = opacité réduite, pas d'interaction.
function IconButton({
  disabled,
  onClick,
  title,
  Icon
}: {
  disabled?: boolean
  onClick?: () => void
  title: string
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded-[10px] text-[var(--fg-muted)] transition-colors hover:bg-white/5 hover:text-[var(--fg-primary)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--fg-muted)]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Icon size={17} strokeWidth={2} />
    </button>
  )
}
