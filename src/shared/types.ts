// Types partagés entre main, preload et renderer.

export type ShapeKind = 'terminal' | 'vscode' | 'iframe'

export type ShellKind = 'powershell' | 'cmd' | 'bash' | 'pwsh'

export interface ProjectRecord {
  id: string
  name: string
  color: string
  createdAt: number
}

export interface TerminalConfig {
  shell: ShellKind
  cwd: string
  env?: Record<string, string>
  cols: number
  rows: number
}

export interface VSCodeShapeConfig {
  folder: string
}

export interface IframeShapeConfig {
  url: string
  title?: string
}

export type ShapeConfig = TerminalConfig | VSCodeShapeConfig | IframeShapeConfig

export interface CanvasShapeRecord {
  id: string
  projectId: string | null
  type: ShapeKind
  config: ShapeConfig
}
