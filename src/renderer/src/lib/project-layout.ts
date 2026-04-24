import type { Editor, TLShape } from 'tldraw'

// Utilitaires de disposition des shapes portail d'un projet en grille.
//
// - `filterProjectShapes` : filtre unique réutilisé (page courante, shapes
//   portail type `vscode`/`terminal` avec `props.projectId === projectId`).
// - `computeGridLayout` / `computeGridLayoutAt` : fonctions PURES de calcul
//   des cellules (centré sur un point, ou ancré sur un top-left). Testables
//   sans mocker tldraw.
// - `getProjectOrigin` / `getProjectZone` : zone déterministe par projet
//   basée sur son rang dans `projects[]`. Garantit qu'aucun projet ne se
//   superpose à un autre quand on les range → chacun a son "couloir" sur
//   le canvas infini, aligné horizontalement.
// - `arrangeProjectInGrid` / `slideToProject` : orchestrateurs tldraw.
//   Le range applique les positions via `editor.updateShape` + zoom dans
//   un `editor.run()` → 1 seul step d'undo. Le slide anime la caméra vers
//   la zone déterministe du projet (effet "glissement" latéral).

export interface GridCell {
  x: number
  y: number
  w: number
  h: number
}

export interface GridConfig {
  cellW?: number
  cellH?: number
  columns?: number
  gap?: number
}

// Défauts : ratio 1.6 aligné sur VSCode (960×600), reste acceptable pour
// un xterm. Gap 32 px laisse voir la séparation sans être trop lâche.
export const DEFAULT_GRID_CONFIG: Required<GridConfig> = {
  cellW: 800,
  cellH: 500,
  columns: 3,
  gap: 32
}

// Espace horizontal entre la zone d'un projet et celle du projet suivant
// sur le "corridor" des projets. Dimensionné à **une cellule iframe + un
// gap interne** (= cellW + gap = 832 px par défaut) : visuellement, on
// lit « [1 2 3] [case vide] [1 2 3] [case vide] [1 2 3] » — chaque projet
// est une ligne de 3 clairement séparée de la suivante par l'équivalent
// d'une iframe vide. Un gap plus petit (ex. 80 px) agglomérait les 9
// shapes en une seule masse horizontale indistincte.
export const PROJECT_CORRIDOR_GAP =
  DEFAULT_GRID_CONFIG.cellW + DEFAULT_GRID_CONFIG.gap

export function filterProjectShapes(editor: Editor, projectId: string): TLShape[] {
  return editor.getCurrentPageShapes().filter((s) => {
    // Types de shapes "portail" affectables à un projet. BrowserShape a été
    // ajoutée après ChatShape (feat navigateur intégré) mais doit aussi
    // être rangée — sans ça, `arrange` oublie les iframes web et l'user
    // voit une shape "paumée" après avoir cliqué sur ▦.
    if (s.type !== 'vscode' && s.type !== 'terminal' && s.type !== 'chat' && s.type !== 'browser') {
      return false
    }
    const pid = (s.props as { projectId?: string | null }).projectId
    return pid === projectId
  })
}

// Rang (0-based) du projet dans la liste, ou -1 si introuvable.
// L'ordre de `projects[]` est stable pour une session donnée (insertion
// en tête par le store Zustand) → chaque projet obtient un rang constant.
export function getProjectRank(
  projects: readonly { id: string }[],
  projectId: string
): number {
  return projects.findIndex((p) => p.id === projectId)
}

// Origine (coin top-left) de la zone du projet sur le canvas infini.
// Chaque projet occupe son propre "couloir" sur l'axe X, séparé du
// suivant par `PROJECT_CORRIDOR_GAP`. Résout la superposition des grilles
// entre projets quand on les range successivement.
export function getProjectOrigin(
  rank: number,
  config?: GridConfig
): { x: number; y: number } {
  if (rank < 0) return { x: 0, y: 0 }
  const { cellW, columns, gap } = { ...DEFAULT_GRID_CONFIG, ...config }
  const gridW = columns * cellW + (columns - 1) * gap
  return { x: rank * (gridW + PROJECT_CORRIDOR_GAP), y: 0 }
}

// Zone englobante de la grille d'un projet (pour `zoomToBounds`).
// `count = 0` renvoie tout de même une box d'1 cellule à l'origine, pour
// permettre de slider vers un projet vide (rendu d'attente logique).
export function getProjectZone(
  rank: number,
  count: number,
  config?: GridConfig
): { x: number; y: number; w: number; h: number } {
  const { cellW, cellH, columns, gap } = { ...DEFAULT_GRID_CONFIG, ...config }
  const origin = getProjectOrigin(rank, config)
  if (count <= 0) {
    return { x: origin.x, y: origin.y, w: cellW, h: cellH }
  }
  const cols = Math.min(columns, count)
  const rows = Math.ceil(count / columns)
  return {
    x: origin.x,
    y: origin.y,
    w: cols * cellW + (cols - 1) * gap,
    h: rows * cellH + (rows - 1) * gap
  }
}

// Grille ancrée au coin top-left `origin`, remplissage gauche → droite
// puis ligne suivante. Base de tous les rangements de projet.
export function computeGridLayoutAt(
  count: number,
  origin: { x: number; y: number },
  config?: GridConfig
): GridCell[] {
  if (count <= 0) return []
  const { cellW, cellH, columns, gap } = { ...DEFAULT_GRID_CONFIG, ...config }
  const cells: GridCell[] = []
  for (let i = 0; i < count; i++) {
    const col = i % columns
    const row = Math.floor(i / columns)
    cells.push({
      x: origin.x + col * (cellW + gap),
      y: origin.y + row * (cellH + gap),
      w: cellW,
      h: cellH
    })
  }
  return cells
}

// Grille centrée sur un point. Utile quand il n'y a pas de zone-projet
// de référence (par ex. tests unitaires, ou rangement ad-hoc hors projet).
export function computeGridLayout(
  count: number,
  viewportCenter: { x: number; y: number },
  config?: GridConfig
): GridCell[] {
  if (count <= 0) return []
  const { cellW, cellH, columns, gap } = { ...DEFAULT_GRID_CONFIG, ...config }
  const cols = Math.min(columns, count)
  const rows = Math.ceil(count / columns)
  const totalW = cols * cellW + (cols - 1) * gap
  const totalH = rows * cellH + (rows - 1) * gap
  return computeGridLayoutAt(
    count,
    { x: viewportCenter.x - totalW / 2, y: viewportCenter.y - totalH / 2 },
    config
  )
}

// Rectangle englobant d'une grille centrée sur un point. Retourne `null`
// si count=0 (cohérent avec l'ancienne API).
export function computeGridBounds(
  count: number,
  viewportCenter: { x: number; y: number },
  config?: GridConfig
): { x: number; y: number; w: number; h: number } | null {
  if (count <= 0) return null
  const { cellW, cellH, columns, gap } = { ...DEFAULT_GRID_CONFIG, ...config }
  const cols = Math.min(columns, count)
  const rows = Math.ceil(count / columns)
  const w = cols * cellW + (cols - 1) * gap
  const h = rows * cellH + (rows - 1) * gap
  return {
    x: viewportCenter.x - w / 2,
    y: viewportCenter.y - h / 2,
    w,
    h
  }
}

// Options communes `zoomToBounds` : inset laisse de la respiration,
// targetZoom cap à 100 % pour un projet minuscule, animation 400 ms.
const ZOOM_OPTIONS = {
  animation: { duration: 400 },
  inset: 240,
  targetZoom: 1
} as const

// Range les shapes du projet dans sa zone déterministe (corridor X par
// rang). Atomique : 1 `editor.run` englobe updateShape + zoomToBounds,
// donc 1 seul `Ctrl+Z` annule l'ensemble.
export function arrangeProjectInGrid(
  editor: Editor,
  projects: readonly { id: string }[],
  projectId: string,
  config?: GridConfig
): { moved: number } {
  const shapes = filterProjectShapes(editor, projectId)
  if (shapes.length === 0) return { moved: 0 }

  // Ordre stable : VSCode groupés avant Terminal (alphabétique de type),
  // puis lecture visuelle top-left → bottom-right dans chaque groupe.
  // Préserve l'intuition spatiale que l'utilisateur avait déjà.
  const sorted = [...shapes].sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1
    if (a.y !== b.y) return a.y - b.y
    return a.x - b.x
  })

  const rank = getProjectRank(projects, projectId)
  const origin = getProjectOrigin(rank, config)
  const cells = computeGridLayoutAt(sorted.length, origin, config)

  editor.run(() => {
    // Itération branche-par-branche : `updateShape` exige un type littéral
    // discriminant exact (`'vscode'` OU `'terminal'`), pas l'union. Le
    // filtre garantit déjà que seuls ces 2 types traversent ici. Seuls
    // x/y/w/h sont modifiés — projectId, folder, shell, cwd, index
    // restent intacts (partial update tldraw).
    sorted.forEach((s, i) => {
      const cell = cells[i]
      // `rotation: 0` : si une shape avait été tournée auparavant (ex.
      // par un raccourci ou une action future), la grille doit la remettre
      // d'équerre — sinon l'alignement visuel des cellules semble cassé
      // alors que les x/y sont pourtant parfaits.
      if (s.type === 'vscode') {
        editor.updateShape({
          id: s.id,
          type: 'vscode',
          x: cell.x,
          y: cell.y,
          rotation: 0,
          props: { w: cell.w, h: cell.h }
        })
      } else if (s.type === 'terminal') {
        editor.updateShape({
          id: s.id,
          type: 'terminal',
          x: cell.x,
          y: cell.y,
          rotation: 0,
          props: { w: cell.w, h: cell.h }
        })
      } else if (s.type === 'chat') {
        // Les ChatShape ont été ajoutées au lot IA. Même traitement :
        // w/h uniformisés à la taille de cellule du grid. Les autres
        // props (conversationId, model, projectId, toggles web/thinking)
        // restent intactes via le partial update tldraw.
        editor.updateShape({
          id: s.id,
          type: 'chat',
          x: cell.x,
          y: cell.y,
          rotation: 0,
          props: { w: cell.w, h: cell.h }
        })
      } else if (s.type === 'browser') {
        // BrowserShape : ajoutée après ChatShape. Partial update sur x/y
        // + taille cellule. L'url, l'historique et le projectId restent
        // intacts. Sans cette branche, le filtre a beau capturer la shape,
        // elle n'est jamais déplacée → reste à sa position d'origine.
        editor.updateShape({
          id: s.id,
          type: 'browser',
          x: cell.x,
          y: cell.y,
          rotation: 0,
          props: { w: cell.w, h: cell.h }
        })
      }
    })

    const zone = getProjectZone(rank, sorted.length, config)
    editor.zoomToBounds(zone, ZOOM_OPTIONS)
  })

  return { moved: sorted.length }
}

// Slide (+ zoom adapté) vers la zone déterministe du projet. Effet
// "glissement" horizontal : `zoomToBounds` anime linéairement la caméra
// de sa position actuelle vers la nouvelle zone → transition visuelle
// nette quand on enchaîne P1 → P2 → P3 (chaque zone a un X plus grand
// que la précédente).
//
// Les shapes affectées au projet mais encore non rangées sont ignorées
// ici : le slide mène à la zone DÉTERMINISTE du projet, pas à la bbox
// actuelle des shapes. Cliquer sur ▦ d'abord range les shapes dans la
// zone, ensuite le slide les ramènera toujours au même endroit.
export function slideToProject(
  editor: Editor,
  projects: readonly { id: string }[],
  projectId: string,
  config?: GridConfig
): void {
  const rank = getProjectRank(projects, projectId)
  if (rank < 0) return
  const count = filterProjectShapes(editor, projectId).length
  const zone = getProjectZone(rank, count, config)
  editor.zoomToBounds(zone, ZOOM_OPTIONS)
}
