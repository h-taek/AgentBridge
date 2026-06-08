import { app } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'

// ConversationStore — legacy thread 데이터 위치 보존 + 디렉토리 ensure만 남김.
//
// M3 K 청크의 thread→workspace 마이그레이션 source로 `~/Library/Application Support/AgentBridge/
// threads/` 디렉토리를 *읽기*만 함. 새 생성/CRUD 흐름은 모두 workspaceStore로 이전.
// (M3 N 후속 정리 2026-05-11 — Phase 2 legacy cleanup)

export type ConversationDirs = {
  root: string
  threads: string
  logs: string
}

export async function ensureConversationDirs(): Promise<ConversationDirs> {
  const root = app.getPath('userData')
  const dirs: ConversationDirs = {
    root,
    threads: path.join(root, 'threads'),
    logs: path.join(root, 'logs')
  }
  await fs.mkdir(dirs.threads, { recursive: true })
  await fs.mkdir(dirs.logs, { recursive: true })
  return dirs
}
