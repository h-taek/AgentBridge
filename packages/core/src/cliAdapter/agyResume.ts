// Agy(Antigravity) resume.
//
// 저장 위치:
//   - conversations: `~/.gemini/antigravity-cli/conversations/<UUID>.db` (SQLite)
//     ※ agy CLI 2026-06-02 업데이트 전에는 `<UUID>.pb` (protobuf) — 구버전 호환 위해 둘 다 인식.
//
// resume: `--conversation <UUID>`. 새 세션의 UUID는 agy가 발급하고 우리는 훅으로 받는다.
//
// 이 모듈은 *아는 id가 아직 살아 있는지* 확인만 한다. 폴더를 뒤져 모르는 id를 알아맞히지 않는다.
// 확인이 필요한 이유: agy는 없는 id를 줘도 거부하지 않고 경고만 찍은 뒤 자기 id로 새 대화를
// 만든다(research 06 §6). 앞에서 막지 않으면 이어받은 줄 알았는데 새 대화인 상태가 된다.

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';

const AGY_BASE_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');

function getConversationsDir(): string {
  return path.join(AGY_BASE_DIR, 'conversations');
}

// agy CLI 2026-06-02 업데이트로 conversation 저장 포맷이 .pb(protobuf) → .db(SQLite)로 변경됨.
// 신포맷 우선, 구버전 사용자 호환을 위해 .pb도 함께 처리한다. (V-17 실기 검증에서 발견)
const CONVERSATION_EXTENSIONS = ['.db', '.pb'] as const;

function getConversationFilePathCandidates(uuid: string, dir: string): string[] {
  return CONVERSATION_EXTENSIONS.map((ext) => path.join(dir, `${uuid}${ext}`));
}

async function hasAgyConversationFile(modelSessionId: string, dir: string): Promise<boolean> {
  for (const file of getConversationFilePathCandidates(modelSessionId, dir)) {
    try {
      const stat = await fs.stat(file);
      if (stat.isFile() && stat.size > 0) return true;
    } catch {
      /* 다음 확장자 후보 시도 */
    }
  }
  return false;
}

export type ResumeResolveOptions = {
  sessionId: string | null;
  // 대화 폴더 override(테스트용). 기본 ~/.gemini/antigravity-cli/conversations.
  conversationsDir?: string;
  logger?: Logger;
};

export async function resolveResumeArgs(opts: ResumeResolveOptions): Promise<string[]> {
  const log = opts.logger ?? noopLogger;
  if (!opts.sessionId) {
    throw new Error(
      'agy resume — modelSessionId가 비어있습니다. 이 thread를 삭제하고 새 워크스페이스를 만드세요.',
    );
  }
  const dir = opts.conversationsDir ?? getConversationsDir();
  const exists = await hasAgyConversationFile(opts.sessionId, dir);
  if (!exists) {
    throw new Error(
      `agy conversation ${opts.sessionId}을(를) ${dir}에서 찾을 수 없습니다 — 메시지 교환 전 닫힌 빈 세션은 agy가 영속화하지 않습니다.`,
    );
  }
  log.log(`agyResume: UUID 직접 전달 — ${opts.sessionId}`);
  return ['--conversation', opts.sessionId];
}
