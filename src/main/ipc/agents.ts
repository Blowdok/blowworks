import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  IPC_CHANNELS,
  AgentCreateInput,
  AgentUpdateInput,
  AgentRunSynthesizerInput
} from '@shared/ipc-contract.js'
import * as agents from '../services/agents-manager.js'

// Handlers IPC pour le namespace `agents`. Les runners peuvent throw —
// leur erreur remonte au renderer via `ipcMain.handle` rejection, qui
// devient une promesse rejetée côté appelant (`window.blow.agents.run…`).

export function registerAgentsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.agents.list, () => agents.listAgents())

  ipcMain.handle(IPC_CHANNELS.agents.get, (_evt, raw) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(raw)
    return agents.getAgent(id)
  })

  ipcMain.handle(IPC_CHANNELS.agents.create, (_evt, raw) => {
    const input = AgentCreateInput.parse(raw)
    return agents.createAgent(input)
  })

  ipcMain.handle(IPC_CHANNELS.agents.update, (_evt, raw) => {
    const input = AgentUpdateInput.parse(raw)
    return agents.updateAgent(input)
  })

  ipcMain.handle(IPC_CHANNELS.agents.delete, (_evt, raw) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(raw)
    return agents.deleteAgent(id)
  })

  ipcMain.handle(IPC_CHANNELS.agents.runSynthesizer, (_evt, raw) => {
    const { conversationId } = AgentRunSynthesizerInput.parse(raw)
    return agents.runSynthesizer(conversationId)
  })

  ipcMain.handle(IPC_CHANNELS.agents.runWikiBuilder, () => agents.runWikiBuilder())
}
