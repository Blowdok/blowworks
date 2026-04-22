import { describe, it, expect } from 'vitest'
import {
  computeGridLayout,
  computeGridLayoutAt,
  computeGridBounds,
  DEFAULT_GRID_CONFIG,
  PROJECT_CORRIDOR_GAP,
  getProjectRank,
  getProjectOrigin,
  getProjectZone
} from '../../src/renderer/src/lib/project-layout.js'

// Invariants testés :
// - Pas de cellule si count <= 0.
// - Chaque cellule a bien la taille demandée.
// - Le centre du rectangle englobant des cellules == viewportCenter.
// - La disposition en lignes/colonnes respecte `columns`.

describe('computeGridLayout', () => {
  const center = { x: 1000, y: 500 }
  const { cellW, cellH, gap } = DEFAULT_GRID_CONFIG

  it('retourne [] pour count=0', () => {
    expect(computeGridLayout(0, center)).toEqual([])
  })

  it('count=1 centre la cellule sur viewportCenter', () => {
    const cells = computeGridLayout(1, center)
    expect(cells).toHaveLength(1)
    const c = cells[0]
    // centre de la cellule == viewportCenter
    expect(c.x + c.w / 2).toBeCloseTo(center.x, 5)
    expect(c.y + c.h / 2).toBeCloseTo(center.y, 5)
    expect(c.w).toBe(cellW)
    expect(c.h).toBe(cellH)
  })

  it('count=3 aligne les 3 cellules sur une seule ligne', () => {
    const cells = computeGridLayout(3, center)
    expect(cells).toHaveLength(3)
    // Même y pour toutes
    expect(cells[0].y).toBe(cells[1].y)
    expect(cells[1].y).toBe(cells[2].y)
    // x strictement croissants, espacés de (cellW + gap)
    expect(cells[1].x - cells[0].x).toBe(cellW + gap)
    expect(cells[2].x - cells[1].x).toBe(cellW + gap)
  })

  it('count=4 place 3 cellules en ligne 1 et 1 en ligne 2 (gauche-alignée)', () => {
    const cells = computeGridLayout(4, center)
    expect(cells).toHaveLength(4)
    expect(cells[0].y).toBe(cells[1].y)
    expect(cells[1].y).toBe(cells[2].y)
    expect(cells[3].y - cells[0].y).toBe(cellH + gap)
    // La 4e est alignée sous la 1re (col=0)
    expect(cells[3].x).toBe(cells[0].x)
  })

  it('count=7 respecte la disposition 3+3+1', () => {
    const cells = computeGridLayout(7, center)
    expect(cells).toHaveLength(7)
    // 3 lignes distinctes
    const ys = [...new Set(cells.map((c) => c.y))]
    expect(ys).toHaveLength(3)
    // Dernière cellule sous la 1re (col=0)
    expect(cells[6].x).toBe(cells[0].x)
  })

  it('count=9 forme une grille 3×3 complète', () => {
    const cells = computeGridLayout(9, center)
    expect(cells).toHaveLength(9)
    const xs = [...new Set(cells.map((c) => c.x))]
    const ys = [...new Set(cells.map((c) => c.y))]
    expect(xs).toHaveLength(3)
    expect(ys).toHaveLength(3)
  })

  it('respecte un override de columns / gap / cellW / cellH', () => {
    const cells = computeGridLayout(4, center, {
      columns: 2,
      gap: 10,
      cellW: 100,
      cellH: 100
    })
    expect(cells).toHaveLength(4)
    // 2 colonnes, 2 lignes
    const xs = [...new Set(cells.map((c) => c.x))]
    const ys = [...new Set(cells.map((c) => c.y))]
    expect(xs).toHaveLength(2)
    expect(ys).toHaveLength(2)
    // Espacement correct
    expect(cells[1].x - cells[0].x).toBe(100 + 10)
    expect(cells[2].y - cells[0].y).toBe(100 + 10)
  })

  it('invariant : le centre du rectangle englobant == viewportCenter quel que soit count', () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9, 12]) {
      const cells = computeGridLayout(count, center)
      const minX = Math.min(...cells.map((c) => c.x))
      const maxX = Math.max(...cells.map((c) => c.x + c.w))
      const minY = Math.min(...cells.map((c) => c.y))
      const maxY = Math.max(...cells.map((c) => c.y + c.h))
      expect((minX + maxX) / 2).toBeCloseTo(center.x, 5)
      expect((minY + maxY) / 2).toBeCloseTo(center.y, 5)
    }
  })
})

describe('computeGridBounds', () => {
  const center = { x: 1000, y: 500 }
  const { cellW, cellH, columns, gap } = DEFAULT_GRID_CONFIG

  it('retourne null pour count=0', () => {
    expect(computeGridBounds(0, center)).toBeNull()
  })

  it('count=1 retourne une box de la taille d\'une cellule, centrée', () => {
    const b = computeGridBounds(1, center)
    expect(b).not.toBeNull()
    expect(b!.w).toBe(cellW)
    expect(b!.h).toBe(cellH)
    expect(b!.x + b!.w / 2).toBeCloseTo(center.x, 5)
    expect(b!.y + b!.h / 2).toBeCloseTo(center.y, 5)
  })

  it('count=3 retourne une box 3 colonnes × 1 ligne', () => {
    const b = computeGridBounds(3, center)!
    expect(b.w).toBe(3 * cellW + 2 * gap)
    expect(b.h).toBe(cellH)
  })

  it('count=7 retourne une box 3 colonnes × 3 lignes', () => {
    const b = computeGridBounds(7, center)!
    expect(b.w).toBe(columns * cellW + (columns - 1) * gap)
    expect(b.h).toBe(3 * cellH + 2 * gap)
  })

  it('coïncide avec le rectangle englobant des cellules', () => {
    for (const count of [1, 3, 4, 7, 9]) {
      const cells = computeGridLayout(count, center)
      const bounds = computeGridBounds(count, center)!
      const minX = Math.min(...cells.map((c) => c.x))
      const maxX = Math.max(...cells.map((c) => c.x + c.w))
      const minY = Math.min(...cells.map((c) => c.y))
      const maxY = Math.max(...cells.map((c) => c.y + c.h))
      expect(bounds.x).toBeCloseTo(minX, 5)
      expect(bounds.y).toBeCloseTo(minY, 5)
      expect(bounds.x + bounds.w).toBeCloseTo(maxX, 5)
      expect(bounds.y + bounds.h).toBeCloseTo(maxY, 5)
    }
  })
})

describe('computeGridLayoutAt', () => {
  it('place la première cellule exactement à l\'origine', () => {
    const cells = computeGridLayoutAt(1, { x: 100, y: 200 })
    expect(cells[0].x).toBe(100)
    expect(cells[0].y).toBe(200)
  })

  it('respecte le flow 3 colonnes puis ligne suivante', () => {
    const cells = computeGridLayoutAt(4, { x: 0, y: 0 })
    const { cellW, cellH, gap } = DEFAULT_GRID_CONFIG
    expect(cells[2].x).toBe(2 * (cellW + gap))
    expect(cells[3].x).toBe(0)
    expect(cells[3].y).toBe(cellH + gap)
  })

  it('retourne [] pour count=0', () => {
    expect(computeGridLayoutAt(0, { x: 0, y: 0 })).toEqual([])
  })
})

describe('getProjectRank', () => {
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('retourne le rang 0-based pour un projet existant', () => {
    expect(getProjectRank(projects, 'a')).toBe(0)
    expect(getProjectRank(projects, 'b')).toBe(1)
    expect(getProjectRank(projects, 'c')).toBe(2)
  })

  it('retourne -1 pour un projet inconnu', () => {
    expect(getProjectRank(projects, 'zzz')).toBe(-1)
  })
})

describe('getProjectOrigin', () => {
  it('rank=0 → origine (0, 0)', () => {
    expect(getProjectOrigin(0)).toEqual({ x: 0, y: 0 })
  })

  it('chaque rang décale d\'une largeur de grille + PROJECT_CORRIDOR_GAP', () => {
    const { cellW, columns, gap } = DEFAULT_GRID_CONFIG
    const gridW = columns * cellW + (columns - 1) * gap
    const stride = gridW + PROJECT_CORRIDOR_GAP
    expect(getProjectOrigin(1).x).toBe(stride)
    expect(getProjectOrigin(2).x).toBe(2 * stride)
    expect(getProjectOrigin(3).x).toBe(3 * stride)
  })

  it('rank=-1 (projet introuvable) → origine (0, 0) par sécurité', () => {
    expect(getProjectOrigin(-1)).toEqual({ x: 0, y: 0 })
  })

  it('Y reste à 0 quel que soit le rang (corridor horizontal)', () => {
    for (const r of [0, 1, 5, 12]) {
      expect(getProjectOrigin(r).y).toBe(0)
    }
  })
})

describe('getProjectZone', () => {
  const { cellW, cellH, columns, gap } = DEFAULT_GRID_CONFIG

  it('count=0 retourne une box 1×1 placeholder à l\'origine', () => {
    const z = getProjectZone(0, 0)
    expect(z.x).toBe(0)
    expect(z.y).toBe(0)
    expect(z.w).toBe(cellW)
    expect(z.h).toBe(cellH)
  })

  it('count=3 retourne 1 ligne × 3 colonnes à l\'origine du rang', () => {
    const z = getProjectZone(1, 3)
    expect(z.w).toBe(3 * cellW + 2 * gap)
    expect(z.h).toBe(cellH)
    expect(z.x).toBe(getProjectOrigin(1).x)
  })

  it('count=7 retourne 3 lignes × 3 colonnes (dernière partielle)', () => {
    const z = getProjectZone(0, 7)
    expect(z.w).toBe(columns * cellW + (columns - 1) * gap)
    expect(z.h).toBe(3 * cellH + 2 * gap)
  })

  it('deux projets consécutifs ont des zones qui ne se chevauchent PAS', () => {
    const z0 = getProjectZone(0, 9)
    const z1 = getProjectZone(1, 9)
    expect(z0.x + z0.w).toBeLessThanOrEqual(z1.x)
    // Gap minimum entre zones = PROJECT_CORRIDOR_GAP (on en autorise plus).
    expect(z1.x - (z0.x + z0.w)).toBeGreaterThanOrEqual(PROJECT_CORRIDOR_GAP)
  })
})
