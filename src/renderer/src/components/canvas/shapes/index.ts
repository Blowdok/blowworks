import type { TLAnyShapeUtilConstructor } from 'tldraw'
import { TerminalShapeUtil } from './TerminalShape.js'
import { VSCodeShapeUtil } from './VSCodeShape.js'
import { ChatShapeUtil } from './ChatShape.js'

// Liste des shape utilitaires personnalisées à enregistrer dans <Tldraw>.
// Les shapes sont désormais déclarées via `declare module 'tldraw'` dans leur
// fichier respectif, donc aucun cast `any` n'est nécessaire.
export const customShapeUtils: TLAnyShapeUtilConstructor[] = [
  TerminalShapeUtil,
  VSCodeShapeUtil,
  ChatShapeUtil
]

export { TerminalShapeUtil, VSCodeShapeUtil, ChatShapeUtil }
export type { TerminalShape } from './TerminalShape.js'
export type { VSCodeShape } from './VSCodeShape.js'
export type { ChatShape } from './ChatShape.js'
