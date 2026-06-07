// modelSessionId + cwd → CLI transcript 파일 경로. 호스트 배선이 CaptureSession.transcriptPath로 주입.
//   claude: ~/.claude/projects/<enc-cwd>/<modelSessionId>.jsonl   (enc-cwd = 비영숫자 → '-')
//   codex:  ~/.codex/sessions/Y/M/D/rollout-*-<modelSessionId>.jsonl  (glob, 최신)
//   agy:    ~/.gemini/antigravity-cli/conversations/<modelSessionId>.db (없으면 .pb)
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { CliKind } from '../shared/cli';

// claude project 디렉토리 인코딩: cwd의 비영숫자 문자를 전부 '-'로. (실측 검증)
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

async function findCodexRollout(modelSessionId: string): Promise<string | null> {
  const base = join(homedir(), '.codex', 'sessions');
  let best: string | null = null;
  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(`${modelSessionId}.jsonl`)) {
        best = full; // 동일 id는 유일 — 첫 매치로 충분
      }
    }
  }
  await walk(base);
  return best;
}

export async function resolveTranscriptPath(
  model: CliKind,
  modelSessionId: string,
  cwd: string,
): Promise<string | null> {
  if (model === 'claude') {
    return join(homedir(), '.claude', 'projects', encodeClaudeProjectDir(cwd), `${modelSessionId}.jsonl`);
  }
  if (model === 'agy') {
    // agy는 대화별 brain 디렉토리에 평문 jsonl transcript를 쓴다(modelSessionId = 대화 UUID = 디렉토리명).
    // 구 sqlite(.db)/protobuf 대신 이 파일을 읽는다(M2-8: node:sqlite 제거).
    return join(
      homedir(),
      '.gemini',
      'antigravity-cli',
      'brain',
      modelSessionId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
  }
  // codex
  return findCodexRollout(modelSessionId);
}
