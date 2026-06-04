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

/**
 * 옛 장부(workspaces.json)를 읽어 workspaceId → folderPath 역방향 맵을 반환.
 * 장부 구조: { folderPath: workspaceId }
 */
function buildLedgerReverseMap(root) {
  const ledgerPath = path.join(root, 'workspaces.json');
  if (!fs.existsSync(ledgerPath)) return {};
  try {
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    // 뒤집기: { workspaceId: folderPath }
    return Object.fromEntries(Object.entries(ledger).map(([folder, id]) => [id, folder]));
  } catch {
    console.warn(`  [warn] ${ledgerPath} 장부 파싱 실패 — 장부 폴백 비활성`);
    return {};
  }
}

function listOldWorkspaces() {
  const found = [];
  for (const { app, root } of OLD_ROOTS) {
    const wsDir = path.join(root, 'workspaces');
    if (!fs.existsSync(wsDir)) continue;

    // 이 root의 장부에서 역방향 맵(workspaceId → folderPath) 구성
    const ledgerPathById = buildLedgerReverseMap(root);

    for (const id of fs.readdirSync(wsDir)) {
      const dir = path.join(wsDir, id);
      const metaPath = path.join(dir, 'workspace.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        // workspacePath가 없으면 장부 역방향 맵에서 폴백으로 복구
        const workspacePath = meta.workspacePath || ledgerPathById[id];
        if (!workspacePath) {
          console.warn(
            `  [skip] ${app}/${id} — 옛 스키마이고 장부에서도 경로 복구 실패 (수동 확인 필요)`,
          );
          continue;
        }
        if (!meta.workspacePath) {
          console.log(`  [복구] ${app}/${id} — 장부에서 경로 복구: ${workspacePath}`);
        }
        found.push({ app, id, dir, meta, workspacePath });
      } catch {
        console.warn(`  [skip] ${app}/${id} — workspace.json 파싱 실패`);
      }
    }
  }
  return found;
}

// ── 병합 유틸 ─────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 옛 익스텐션 분리 스키마(sessions.json)를 코어 SessionMeta 형태로 변환.
// 코어 workspaceStore.ts의 tryReadLegacySessions와 동일한 매핑.
function readLegacySessionsJson(dir) {
  const p = path.join(dir, 'sessions.json');
  if (!fs.existsSync(p)) return [];
  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const now = new Date().toISOString();
  const out = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.sessionId !== 'string' || !UUID_RE.test(s.sessionId)) continue;
    if (typeof s.model !== 'string') continue;
    out.push({
      sessionId: s.sessionId,
      model: s.model,
      modelSessionId: typeof s.modelSessionId === 'string' ? s.modelSessionId : null,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : now,
      closedAt:
        s.active === false
          ? typeof s.lastActiveAt === 'string'
            ? s.lastActiveAt
            : now
          : null,
      title: typeof s.name === 'string' ? s.name : undefined,
      kind: 'cli',
      lastChattedAt: typeof s.lastActiveAt === 'string' ? s.lastActiveAt : undefined,
    });
  }
  return out;
}

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
  // ws.workspacePath = 복구된 경로(장부 폴백 포함), ws.meta.workspacePath는 없을 수 있음
  const byFolder = new Map(); // key = NFC 정규화 경로
  for (const ws of old) {
    const key = ws.workspacePath.normalize('NFC');
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

    // 3) workspace.json — sessions[] 병합. 세 소스를 sessionId 기준 dedup(먼저 본 것 우선):
    //    (a) 기존 새 workspace.json sessions[] — 재실행 시 마이그레이션 이후 추가분 보존(멱등)
    //    (b) 옛 workspace.json sessions[] — 정상 스키마(modelSessionId 보유), richest
    //    (c) 옛 sessions.json — 분리 스키마. {}-워크스페이스(workspace.json={})는 세션이
    //        여기에만 있어 (b)가 비므로, 이걸 병합해야 세션이 살아난다. 런타임 repair는
    //        workspace.json이 {}일 때만 발동하므로 마이그레이션이 직접 흡수해야 함.
    const seen = new Set();
    const allSessions = [];
    const pushUnique = (s) => {
      if (s && typeof s.sessionId === 'string' && !seen.has(s.sessionId)) {
        seen.add(s.sessionId);
        allSessions.push(s);
      }
    };
    const existingNewMeta = path.join(newDir, 'workspace.json');
    if (fs.existsSync(existingNewMeta)) {
      try {
        const em = JSON.parse(fs.readFileSync(existingNewMeta, 'utf8'));
        if (Array.isArray(em.sessions)) em.sessions.forEach(pushUnique);
      } catch {
        /* 손상 시 무시 — 아래 소스로 복원 */
      }
    }
    for (const g of group) (Array.isArray(g.meta.sessions) ? g.meta.sessions : []).forEach(pushUnique);
    for (const g of group) readLegacySessionsJson(g.dir).forEach(pushUnique);
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
    // (sessions.json 자체는 복사하지 않는다 — 위 3)에서 sessions[]로 직접 병합했으므로
    //  불필요하고, 옆에 남으면 혼동만 준다.)
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
