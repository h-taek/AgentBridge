// 기존 두 저장소(데스크탑 Application Support / 익스텐션 globalStorage)를
// ~/.agentbridge/ 통일 저장소로 병합하는 일회성 스크립트 (V-12).
//
// 사용법:
//   node scripts/migrate-storage.mjs --dry-run   # 무엇이 어떻게 합쳐질지 출력만
//   node scripts/migrate-storage.mjs             # 실제 수행
//
// 전제: packages/core가 빌드되어 있어야 함 (npm --prefix packages/core run build)
// 옛 저장소는 삭제하지 않는다 (수동 백업 — 검증 후 직접 정리).

import { createRequire } from 'module';
import { homedir } from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { deterministicWorkspaceId } = require(path.join(repoRoot, 'packages/core/dist/index.js'));

const DRY_RUN = process.argv.includes('--dry-run');

const OLD_ROOTS = [
  { app: 'desktop', root: path.join(homedir(), 'Library/Application Support/AgentBridge') },
  {
    app: 'extension',
    root: path.join(
      homedir(),
      'Library/Application Support/Antigravity IDE/User/globalStorage/h-taek.agentbridge',
    ),
  },
];
const NEW_ROOT = path.join(homedir(), '.agentbridge');

// ── 수집: 옛 워크스페이스 전부 읽기 ──────────────────────────────────────

function listOldWorkspaces() {
  const found = [];
  for (const { app, root } of OLD_ROOTS) {
    const wsDir = path.join(root, 'workspaces');
    if (!fs.existsSync(wsDir)) continue;
    for (const id of fs.readdirSync(wsDir)) {
      const dir = path.join(wsDir, id);
      const metaPath = path.join(dir, 'workspace.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (!meta.workspacePath) {
          console.warn(`  [skip] ${app}/${id} — workspacePath 없음 (손상)`);
          continue;
        }
        found.push({ app, id, dir, meta });
      } catch {
        console.warn(`  [skip] ${app}/${id} — workspace.json 파싱 실패`);
      }
    }
  }
  return found;
}

// ── 병합 유틸 ─────────────────────────────────────────────────────────────

function turnSortKey(line) {
  try {
    const obj = JSON.parse(line);
    // TurnRecord의 시각 필드 = startedAt (ISO). 없으면 completedAt 폴백.
    return obj.startedAt ?? obj.completedAt ?? '';
  } catch {
    return '';
  }
}

function readTurnLines(dir) {
  const p = path.join(dir, 'turns.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
}

function fileMtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
}

// ── 메인 ─────────────────────────────────────────────────────────────────

function main() {
  console.log(`마이그레이션 ${DRY_RUN ? '(dry-run)' : ''} → ${NEW_ROOT}\n`);
  const old = listOldWorkspaces();
  console.log(`옛 워크스페이스 ${old.length}개 발견:\n`);

  // 폴더 경로별로 그룹 (NFC 정규화: macOS HFS+는 NFD, VS Code 익스텐션은 NFC를 쓰므로 통일)
  const byFolder = new Map(); // key = NFC 정규화 경로
  for (const ws of old) {
    const key = ws.meta.workspacePath.normalize('NFC');
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(ws);
  }

  let merged = 0;
  for (const [folderPath, group] of byFolder) {
    // deterministicWorkspaceId에도 NFC 경로를 넘겨 결정적 ID가 인코딩에 무관하게 동일하게 나오도록 함
    const newId = deterministicWorkspaceId(folderPath);
    const newDir = path.join(NEW_ROOT, 'workspaces', newId);
    const sources = group.map((g) => `${g.app}/${g.id.slice(0, 8)}`).join(' + ');
    console.log(`▸ ${folderPath}`);
    console.log(`    ${sources} → ${newId.slice(0, 8)}…`);

    if (DRY_RUN) {
      merged++;
      continue;
    }

    fs.mkdirSync(path.join(newDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(newDir, 'archive'), { recursive: true });

    // 1) turns.jsonl — 시간순 병합
    const allTurns = group.flatMap((g) => readTurnLines(g.dir));
    allTurns.sort((a, b) => (turnSortKey(a) < turnSortKey(b) ? -1 : 1));
    if (allTurns.length > 0) {
      fs.writeFileSync(path.join(newDir, 'turns.jsonl'), allTurns.join('\n') + '\n', 'utf8');
    }

    // 2) ir.json — mtime 최신을 live로, 나머지는 archive에 보존
    const withIr = group
      .map((g) => ({ g, irPath: path.join(g.dir, 'ir.json'), mtime: fileMtime(path.join(g.dir, 'ir.json')) }))
      .filter((x) => x.mtime > 0)
      .sort((a, b) => b.mtime - a.mtime);
    if (withIr.length > 0) {
      fs.copyFileSync(withIr[0].irPath, path.join(newDir, 'ir.json'));
      for (const { g, irPath } of withIr.slice(1)) {
        fs.copyFileSync(irPath, path.join(newDir, 'archive', `migrated_ir_${g.app}_${g.id.slice(0, 8)}.json`));
      }
    }

    // 3) workspace.json — sessions[] 병합 (sessionId 충돌 없음 — 전부 랜덤 UUID였음)
    const allSessions = group.flatMap((g) => (Array.isArray(g.meta.sessions) ? g.meta.sessions : []));
    const newest = group.slice().sort((a, b) => ((a.meta.updatedAt ?? '') < (b.meta.updatedAt ?? '') ? 1 : -1))[0];
    const now = new Date().toISOString();
    const newMeta = {
      workspaceId: newId,
      title: newest.meta.title ?? folderPath.split('/').pop(),
      createdAt: group.map((g) => g.meta.createdAt).sort()[0] ?? now,
      updatedAt: now,
      workspacePath: folderPath, // 이미 NFC 정규화됨 (byFolder 키 기준)
      sessions: allSessions,
      primarySessionId: newest.meta.primarySessionId ?? allSessions[0]?.sessionId ?? null,
      compactionInProgress: null,
      codexHookTrust: group.find((g) => g.meta.codexHookTrust === 'trusted') ? 'trusted' : newest.meta.codexHookTrust,
    };
    fs.writeFileSync(path.join(newDir, 'workspace.json'), JSON.stringify(newMeta, null, 2), 'utf8');

    // 4) sessions/<sid>/ 디렉토리 + archive/ + settings/ 복사
    for (const g of group) {
      copyDirRecursive(path.join(g.dir, 'sessions'), path.join(newDir, 'sessions'));
      copyDirRecursive(path.join(g.dir, 'archive'), path.join(newDir, 'archive'));
      copyDirRecursive(path.join(g.dir, 'settings'), path.join(newDir, 'settings'));
    }
    merged++;
  }

  console.log(`\n완료: 워크스페이스 ${merged}개 ${DRY_RUN ? '병합 예정' : '병합됨'}.`);
  if (!DRY_RUN) {
    console.log('옛 저장소는 보존됨 — 새 저장소 검증 후 직접 삭제:');
    for (const { root } of OLD_ROOTS) console.log(`  ${root}`);
    console.log('\n주의: settings/claude-settings.json 내부의 hook 명령은 옛 경로를 가리킨다.');
    console.log('각 앱을 한 번 실행하면 hookInstaller가 새 경로로 다시 쓴다 (자동 복구).');
  }
}

main();
