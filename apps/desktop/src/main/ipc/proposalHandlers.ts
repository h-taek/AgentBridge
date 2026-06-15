import { ipcMain } from 'electron'
import { join } from 'node:path'
import {
  IpcChannel,
  type ProposalActionRequest,
  type ProposalApproveResult,
  type ProposalDiscardResult,
  type ProposalListRequest,
  type ProposalListResult
} from '@shared/ipc'
import {
  approveProposal,
  discardProposal,
  getGlobalDir,
  readProfileDocs,
  readProposals,
  resolveProfile
} from '@agentbridge/core'
import { broadcastProposalsUpdated } from '../modules/proposalBroadcast'

// gc-tree §D — 자동제안(장기기억) 승인 게이트 IPC.
//   proposal:list    — pending 제안 목록 + 읽기전용 문서 목록(이미 승인된 .md)
//   proposal:approve — 단건 승인(코어가 .md로 쓰고 제안 파일 제거) + broadcast
//   proposal:discard — 단건 버림(제안 파일만 제거) + broadcast
// 제안·문서는 default 프로필 단위로 모든 워크스페이스가 공유 — workspaceId는 resolveProfile 입력일 뿐.

async function handleProposalList(
  _e: unknown,
  req: ProposalListRequest
): Promise<ProposalListResult> {
  const globalDir = getGlobalDir()
  const profileId = resolveProfile(req.workspaceId)
  const proposals = await readProposals(globalDir, profileId)
  const docs = (await readProfileDocs(globalDir, profileId)).map((d) => ({
    category: d.category,
    slug: d.slug,
    title: d.title,
    summary: d.summary
  }))
  // 렌더러 "폴더 열기"가 openPath로 직접 열 default 프로필 디렉토리 절대경로.
  const profileDir = join(globalDir, 'profiles', profileId)
  return { proposals, docs, profileDir }
}

async function handleProposalApprove(
  _e: unknown,
  req: ProposalActionRequest
): Promise<ProposalApproveResult> {
  const globalDir = getGlobalDir()
  const profileId = resolveProfile(req.workspaceId)
  const r = await approveProposal(globalDir, profileId, req.id)
  broadcastProposalsUpdated(req.workspaceId)
  return { ok: r !== null, notFound: r === null }
}

async function handleProposalDiscard(
  _e: unknown,
  req: ProposalActionRequest
): Promise<ProposalDiscardResult> {
  const globalDir = getGlobalDir()
  const profileId = resolveProfile(req.workspaceId)
  const ok = await discardProposal(globalDir, profileId, req.id)
  broadcastProposalsUpdated(req.workspaceId)
  return { ok }
}

export function registerProposalHandlers(): void {
  ipcMain.handle(IpcChannel.ProposalList, handleProposalList)
  ipcMain.handle(IpcChannel.ProposalApprove, handleProposalApprove)
  ipcMain.handle(IpcChannel.ProposalDiscard, handleProposalDiscard)
}
