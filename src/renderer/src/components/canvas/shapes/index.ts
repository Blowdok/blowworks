import type { TLAnyShapeUtilConstructor } from 'tldraw'
import { TerminalShapeUtil } from './TerminalShape.js'
import { VSCodeShapeUtil } from './VSCodeShape.js'
import { ChatShapeUtil } from './ChatShape.js'
import { BrowserShapeUtil } from './BrowserShape.js'
import { ExplorerShapeUtil } from './ExplorerShape.js'
import { NotepadShapeUtil } from './NotepadShape.js'

// Liste des shape utilitaires personnalisées à enregistrer dans <Tldraw>.
// Les shapes sont désormais déclarées via `declare module 'tldraw'` dans leur
// fichier respectif, donc aucun cast `any` n'est nécessaire.
export const customShapeUtils: TLAnyShapeUtilConstructor[] = [
  TerminalShapeUtil,
  VSCodeShapeUtil,
  ChatShapeUtil,
  BrowserShapeUtil,
  ExplorerShapeUtil,
  NotepadShapeUtil
]

export {
  TerminalShapeUtil,
  VSCodeShapeUtil,
  ChatShapeUtil,
  BrowserShapeUtil,
  ExplorerShapeUtil,
  NotepadShapeUtil
}
export type { TerminalShape } from './TerminalShape.js'
export type { VSCodeShape } from './VSCodeShape.js'
export type { ChatShape } from './ChatShape.js'
export type { BrowserShape } from './BrowserShape.js'
export type { ExplorerShape } from './ExplorerShape.js'
export type { NotepadShape } from './NotepadShape.js'
