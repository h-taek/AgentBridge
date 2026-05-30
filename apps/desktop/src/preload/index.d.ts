import type { ElectronAPI } from '@electron-toolkit/preload'
import type { AgentBridgeApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    agentbridge: AgentBridgeApi
  }
}
