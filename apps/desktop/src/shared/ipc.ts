// IPC 채널 단일 소스 — Main / Preload / Renderer 모두 이 모듈을 참조한다.
// 채널 추가 시 이 파일에서만 정의하고 invoke/handle 측 양쪽에서 같은 타입을 import한다.

export type AppHealth = {
  ok: true
  version: string
  electron: string
  node: string
  chrome: string
  platform: NodeJS.Platform
  arch: string
  // 사용자 데이터 디렉토리 (~/Library/Application Support/AgentBridge/)
  userDataDir: string
  // main 프로세스 cwd — Renderer 워크스페이스 입력의 기본값으로 사용 (dev 편의).
  // 사용자는 input에서 자유롭게 덮어쓸 수 있다.
  cwd: string
}

// 'agy' = Antigravity CLI (구 Gemini CLI). 2026년 리브랜드 — 기존 'gemini' 값은 workspaceStore /
// settings 로드 시 자동 마이그레이션.
export type CliKind = 'claude' | 'codex' | 'agy'

export type CliPresence = {
  kind: CliKind
  found: boolean
  // 절대경로(found=true 한정)
  path?: string
  // `<cli> --version` stdout 첫 줄 (성공 시) 또는 stderr 메시지(실패 시)
  version?: string
  error?: string
}

export type EnvProbeResult = {
  // 사용자 shell의 PATH (zsh -ilc로 캡처)
  shellPath: string
  shellPathError?: string
  clis: CliPresence[]
  capturedAt: string // ISO 8601
}

// PTY 스모크 테스트 — M0 검증용. M1에서 thread별 PTY 관리로 확장.
export type PtyStartRequest = {
  // 실행할 명령. M0에서는 'bash --login -i' 같은 단순 셸 검증.
  command: string
  args: string[]
  cwd?: string
  cols?: number
  rows?: number
  // 환경변수 추가/덮어쓰기. 미지정 시 process.env + TERM=xterm-256color
  env?: Record<string, string>
}

export type PtyStartResult = {
  sessionId: string
  pid: number
}

export type PtyDataEvent = {
  sessionId: string
  data: string
}

export type PtyExitEvent = {
  sessionId: string
  exitCode: number | null
  signal: number | null
}

// CLI 어댑터 spawnInteractive 결과 — PTY 핸들 + 모델 native 세션 식별자.
// - response sessionId: PTY 내부 식별자 (write/resize/kill용)
// - modelSessionId: 모델 native 식별자 (다음 resume 시 사용)
//   Claude/Gemini는 즉시 값. Codex는 ~/.codex/sessions watch로 *비동기 캡처* — 새 세션 spawn 시 null,
//   캡처 완료 시 sessions:modelSessionCaptured 이벤트로 통보.
export type CliSpawnInteractiveResult = PtyStartResult & {
  modelSessionId: string | null
}

// ir:load — 영속화된 IR을 그대로 반환. 빈 IR(ir.json이 '{}' 또는 ENOENT)이면 ir=null.
// 메모리 패널이 화면 진입 / 활성 워크스페이스 변경 / 정제 완료 후 호출한다.
export type IrLoadRequest = {
  workspaceId: string
}

export type IrLoadResult = {
  ir: import('./ir').IR | null
  // ir.json 파일 mtime (ISO 8601). null이면 파일이 아직 없음 / 빈 IR.
  // ir.meta.updatedAt과 다를 수 있음 (저장 직후엔 거의 동일).
  fileMtime: string | null
}

// ir:refine — 활성 workspace의 replay.log + 직전 IR을 RefineDispatcher 경유로 정제해
// IR JSON 생성·영속화. 호출 시점은 임의(IrPanel 또는 자동 trigger). 활성 PTY 영향 없음.
// O 청크 이후엔 turns.jsonl 끝 N개 + 직전 IR 기반으로 *교체 예정*.
export type IrRefineRequest = {
  workspaceId: string
  // 헤드리스 spawn timeout (ms). 미설정 시 어댑터 default(60s).
  timeoutMs?: number
}

// ir:updated — main → renderer broadcast 페이로드.
export type IrUpdatedEvent = {
  workspaceId: string
  // 'manual' = ir:refine IPC, 'auto' = compactionScheduler 자동 trigger.
  source: 'manual' | 'auto'
}

export type IrRefineResult = {
  // refine 성공 + 파싱·검증 통과 → IR JSON 영속화 완료.
  ok: boolean
  // ok=false 시 진단용. ok=true일 때도 비치명 경고는 채울 수 있음(예: 일부 필드 누락).
  error?: string
  // 정제 결과 IR — ok=true 시 항상 채워짐. ok=false면 partial(파싱 실패 단계 직전까지)일 수 있음.
  ir?: import('./ir').IR
  // refine raw assistantText (디버깅/IR 모달 표시용).
  rawAssistantText: string
  // refine 자체 실행 진단.
  durationMs: number
  exitCode: number | null
  stderr: string
  rawLineCount: number
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
}

// ─── Workspace + Sessions (M3 K 청크) ─────────────────────────────────────
// architecture §14.2 / §14.3 / §14.10. workspace = thread를 대체하는 상위 컨테이너.
// 한 workspace 안에 *여러 session*(=모델별 PTY 인스턴스)이 동시 활성 가능.
//
// 데이터 위치: ~/Library/Application Support/AgentBridge/workspaces/<workspaceId>/
//   - workspace.json   : WorkspaceMeta
//   - ir.json          : 압축된 IR
//   - turns.jsonl      : raw 턴 로그 (workspace 단위 단일 파일)
//   - archive/         : 압축된 turns + IR snapshots
//   - sessions/<sid>/  : 세션별 메타 + replay.log
//   - settings/        : claude --settings flag로 가리킬 격리 settings.json
//
// K 청크는 *non-destructive* 마이그레이션 — 기존 threads/ 데이터를 workspaces/로 복사하되
// threads/는 그대로 유지. 기존 threads:* IPC + UI는 변경 없이 작동.
// L 청크에서 UI를 새 IPC로 전환하면서 threads/ archive 처리.

// 세션 종류 — 'cli'는 claude/codex/gemini 어댑터 경유. 'shell'은 일반 zsh/bash PTY로
// AgentBridge hook / IR refine / turnRecorder / quota 모두 bypass(내장 터미널 세션).
// 기존 디스크 데이터엔 필드 자체가 없으므로 optional + load 시 'cli' 폴백.
export type SessionKind = 'cli' | 'shell'

export type SessionMeta = {
  sessionId: string
  model: CliKind
  // CLI native session ID (claude --session-id <UUID> / codex thread_id / gemini index UUID).
  // null이면 spawn 직후 비동기 캡처 대기 중 (codex 패턴). shell 세션은 항상 null.
  modelSessionId: string | null
  createdAt: string // ISO 8601
  // 세션이 닫혔는지 여부. UI에서는 closedAt이 null인 세션만 "활성 탭"으로 간주.
  // 닫혀도 record는 보관 (history/replay 접근용).
  closedAt: string | null
  // 사용자가 지정한 탭 이름. 비어있으면 UI는 모델명을 fallback으로 표시.
  title?: string
  // 'shell'이면 일반 터미널 세션 — 어댑터 / hook / TurnRecorder / IR refine 전부 bypass.
  // 미지정/누락 시 'cli'로 간주 (기존 디스크 데이터 호환).
  kind?: SessionKind
  // 가장 최근 채팅(turn 완료) 시점. SessionTabs 정렬에 사용 — 최근 채팅 세션을 좌측 끝으로.
  // turn flush 시 turnRecorder가 갱신. 채팅 안 한 세션은 undefined.
  lastChattedAt?: string
}

export type WorkspaceMeta = {
  workspaceId: string
  title: string
  createdAt: string
  updatedAt: string
  // 사용자가 지정한 cwd. 워크스페이스 안 모든 sessions가 이 cwd에서 spawn됨.
  workspacePath: string
  sessions: SessionMeta[]
  // single-active 시절 (M1/M2) 호환 — 기본 활성 세션. multi-tab UI 도입 후엔 UI가 active 탭을 추적.
  primarySessionId: string | null
  // background compaction lock. 다중 탭이 동시 trigger 시 한 번만 실행되도록.
  // null = 진행 중 아님. 5분 stale timeout 후 강제 해제 정책.
  compactionInProgress: { sessionId: string; startedAt: string } | null
  // M3 M 청크 — codex `/hooks` 사용자 trust 상태 (per workspace). claude/gemini는 자동 로드라 미사용.
  //   - undefined / 'pending': 첫 codex 세션 spawn 시 UI 배너 표시
  //   - 'trusted': 사용자가 codex 안에서 `/hooks` 명령 후 UI "승인 완료" 버튼 클릭
  // 마이그레이션 시점 워크스페이스는 codex 세션이 있어도 이전 흐름에서 신뢰됐을 수 있으나, 우리가
  // 알 수 없으므로 보수적으로 'pending'으로 표시. 사용자가 한 번 토글하면 영구.
  codexHookTrust?: 'pending' | 'trusted'
}

export type WorkspaceCreateRequest = {
  initialModel: CliKind
  workspacePath: string
  title?: string
}

// 워크스페이스 + 첫 세션을 한 번에 생성. 반환 시 첫 session 메타 포함.
export type WorkspaceCreateResult = {
  workspace: WorkspaceMeta
  firstSession: SessionMeta
}

export type WorkspaceListEntry = WorkspaceMeta & {
  // 메모리 derive — 활성 PTY 보유한 sessions 수. 디스크 메타에 저장 안 함.
  activeSessionCount: number
}

// 워크스페이스 안 새 session(=탭) 추가 + PTY spawn (L1 청크에서 PTY 통합).
// kind='shell'이면 model 값은 UI 표시 목적의 placeholder(보통 'claude') — 어댑터 dispatch 안 함.
export type SessionCreateRequest = {
  workspaceId: string
  model: CliKind
  cols?: number
  rows?: number
  // 미지정 시 'cli'. 'shell'이면 일반 zsh/bash PTY 세션(AgentBridge hook bypass).
  kind?: SessionKind
}

// 기존 세션 활성화 (= 탭 재오픈) — closedAt mark null + PTY 재spawn (`--resume`으로 모델 native 세션 합류).
export type SessionOpenRequest = {
  workspaceId: string
  sessionId: string
  cols?: number
  rows?: number
}

// sessions:close 발원처 식별. main.log에 source 함께 찍어 "왜 사라졌나" 추적.
//   sidebar-trash    : 좌 사이드바 세션 행의 휴지통 버튼 (hard delete)
//   tab-x            : 상단 탭의 X 버튼 (soft close)
//   workspace-switch : 다른 워크스페이스로 전환 시 closeAllAttachments
//   workspace-create : 새 워크스페이스 만들 때 기존 정리
//   workspace-add    : 다른 ws에 세션 추가 진입 시 기존 ws 정리
//   home-go          : 홈 화면으로 이동 시 closeAllAttachments
//   home-submit      : 홈 화면 첫 제출 시 기존 정리
//   workspace-removed: 다른 윈도우에서 워크스페이스 hard delete 동기화
//   unknown          : source 미명시 (마이그레이션/누락 케이스)
export type SessionCloseSource =
  | 'sidebar-trash'
  | 'tab-x'
  | 'workspace-switch'
  | 'workspace-create'
  | 'workspace-add'
  | 'home-go'
  | 'home-submit'
  | 'workspace-removed'
  | 'unknown'

export type SessionCloseRequest = {
  workspaceId: string
  sessionId: string
  // permanent=true면 작업 이력 유무와 무관하게 즉시 hard delete (디스크 + sessions[]).
  // 사용자가 탭 x로 명시 close — 다음 reopen 시 부활하면 안 되는 케이스.
  // 워크스페이스 "닫기"는 permanent 미설정 — 빈 세션만 자동 hard delete, 작업 이력
  // 있는 세션은 closedAt 마킹으로 보존(다음 reopen 시 부활).
  permanent?: boolean
  // 발원처 식별 — main.log 진단용. 누락 시 'unknown'.
  source?: SessionCloseSource
}

// L1 — sessions:create / sessions:open 결과. PTY spawn 결과 + replay 포함.
// thread 시절 ThreadActivateResult와 동등 형태.
export type SessionActivateResult = {
  workspace: WorkspaceMeta
  session: SessionMeta
  pty: CliSpawnInteractiveResult
  // 기존 replay.log 스냅샷 (xterm.js 화면 복원용). create 시엔 빈 문자열.
  replay: string
  // Hook 설치 실패로 IR 주입(매 메시지 IR 컨텍스트 inject) 비활성 상태일 때 reason 포함.
  // shell 세션은 hook 무관이라 항상 undefined. cli 세션이면 정상 설치 시에도 undefined.
  // UI는 이 값이 있으면 "메모리 비활성" 배지 표시.
  hookDisabledReason?: string
}

// L1 — codex처럼 modelSessionId가 spawn 후 비동기 캡처되는 경우 발사. workspace + session 단위.
export type SessionModelSessionCapturedEvent = {
  workspaceId: string
  sessionId: string
  modelSessionId: string
}

// 워크스페이스/세션 이름 수정.
export type WorkspaceRenameRequest = {
  workspaceId: string
  title: string
}

export type SessionRenameRequest = {
  workspaceId: string
  sessionId: string
  // 빈 문자열 → title을 undefined로 reset (모델명 fallback).
  title: string
}

// 홈 화면에서 새 워크스페이스 + 세션 + 첫 메시지 한 번에. cwd는 settings.defaultBasePath 하위에
// 자동 생성된 폴더. 어댑터 formatChatSubmit으로 모델별 submit step 발사.
export type HomeSubmitRequest = {
  model: CliKind
  message: string
  cols?: number
  rows?: number
}

export type HomeSubmitResult = {
  workspace: WorkspaceMeta
  session: SessionMeta
  pty: CliSpawnInteractiveResult
  // SessionActivateResult와 동일 의미 — hook 설치 실패 시 reason. UI는 "메모리 비활성" 배지 표시.
  hookDisabledReason?: string
}

// ─── M3 M 청크 — Hook trust 상태 ──────────────────────────────────────────
// codex만 `/hooks` 슬래시 명령으로 사용자 수동 trust 승인이 필요(probe 08). claude/gemini는
// hook config 파일 자동 로드. UI는 codex 탭이 활성화된 워크스페이스에서 trustStatus가 'pending'
// 이면 안내 배너를 띄우고, 사용자가 codex 안에서 `/hooks`로 trust 후 "승인 완료" 버튼을 눌러
// status를 'trusted'로 마킹한다 (수동 토글 — AgentBridge는 codex 내부 trust 상태를 감지할 수 없음).
export type HookTrustStatus = 'trusted' | 'pending' | 'not-required'

export type HookTrustEntry = {
  workspaceId: string
  // codex만 'pending' 시작 가능. claude/gemini는 항상 'not-required'.
  codex: HookTrustStatus
}

export type HookTrustSetRequest = {
  workspaceId: string
  // 사용자가 "trust 승인 완료" 버튼 누른 시점에 true. 'pending' → 'trusted' 전환.
  trusted: boolean
}

// ─── M3.5 UI-E 후속 — Memory 관리 패널 확장 ─────────────────────────────
// architecture §15.4 archive/, §15.3 turns.jsonl. 메모리 패널이 IR 외에 추가 데이터 카드
// (Turn 흐름 / AI 지시 파일 / Archive 히스토리)를 같이 다루기 위한 IPC.

// archive:list — 워크스페이스 archive 디렉토리의 compressed_*.jsonl 인덱스.
// 각 파일 첫 줄(IR snapshot 메타)만 파싱해 카드 렌더에 필요한 최소 정보 반환.
export type ArchiveSnapshotMeta = {
  // load 시 다시 식별 — archivePath (절대경로) 그대로 전달.
  archivePath: string
  archivedAt: string
  updatedAt: string
  intentGoal: string
  counts: {
    decisions: number
    files: number
    commands: number
    tests: number
    pending: number
  }
}

export type ArchiveListRequest = { workspaceId: string }
export type ArchiveListResult = { snapshots: ArchiveSnapshotMeta[] }

// archive:load — 특정 스냅샷의 IR 전체 read (read-only 상세 모달용).
export type ArchiveLoadRequest = {
  workspaceId: string
  archivePath: string
}

export type ArchiveLoadResult = {
  archivedAt: string
  ir: import('./ir').IR
}

// turns:updated — turnRecorder.appendTurn 직후 broadcast.
export type TurnsUpdatedEvent = { workspaceId: string }

// turns:summary — 현재 turns.jsonl count/bytes + 자동 compaction 임계까지 남은 양.
export type TurnsSummaryRequest = { workspaceId: string }

export type TurnsSummaryResult = {
  count: number
  bytes: number
  countThreshold: number
  bytesThreshold: number
  keepRecent: number
  // 임계까지 남은 양 — 음수(또는 0)면 임계 도달 또는 초과(다음 turn에서 trigger 예정).
  remainingCount: number
  remainingBytes: number
}

// instructions:list — cwd 안 AI 영구 지시사항 파일 (AGENTS.md / CLAUDE.md / GEMINI.md).
// 워크스페이스 cwd 확보 후 stat. 존재 여부 + mtime + size.
// 'gemini' tag는 legacy 잔존 — agy CLI는 ~/.gemini/ base를 공유하므로 GEMINI.md 파일 자체는
// 그대로 유지(agy가 읽는지는 사용자 검증). 이름만 'gemini' 유지해 데이터 호환 보장.
export type InstructionFileKind = 'agents' | 'claude' | 'gemini'

export type InstructionFileInfo = {
  kind: InstructionFileKind
  filename: string
  absolutePath: string
  exists: boolean
  mtime: string | null
  sizeBytes: number | null
}

export type InstructionsListRequest = { workspaceId: string }

export type InstructionsListResult = {
  files: InstructionFileInfo[]
}

// instructions:create — 빈 AI 지시 파일 생성. 이미 있으면 no-op.
export type InstructionsCreateRequest = {
  workspaceId: string
  kind: InstructionFileKind
}

export type InstructionsCreateResult = {
  absolutePath: string
  created: boolean
}

// ─── M3.6 D 청크 — 메모리 초기화 ──────────────────────────────────────────
// `/clear`는 모델 native context만 비우고 AgentBridge hook은 매 메시지마다 IR 재inject한다.
// 사용자가 정말 IR을 비우고 싶을 때 호출 — ir.json을 '{}'로 atomic write + 옵션으로
// turns.jsonl도 빈 파일로 rewrite. archive 스냅샷은 보존.
export type MemoryResetRequest = {
  workspaceId: string
  // turns.jsonl도 같이 초기화할지 — 기본 false면 IR만 비움.
  alsoTurns: boolean
}

export type MemoryResetResult = {
  ok: boolean
  // 진단용 (실패 시).
  error?: string
}

// ─── archive 스냅샷 개별 삭제 ───────────────────────────────────────────
// 사용자가 메모리 패널의 이전 스냅샷 카드 휴지통을 눌렀을 때.
// archive:load와 동일한 안전 가드(basename pattern + lstat + realpath prefix) 통과 후 unlink.
export type ArchiveDeleteRequest = {
  workspaceId: string
  archivePath: string
}

export type ArchiveDeleteResult = {
  ok: boolean
  error?: string
}

// memory:promoteLatestArchive — CurrentIrCard 휴지통 클릭의 동작.
// 단순 reset 대신 archive 최신 스냅샷을 ir.json으로 복원(promote)하고 그 archive 파일은
// 소비(unlink). archive 비어있으면 빈 IR로 reset과 동일 동작. broadcast ir:updated.
export type MemoryPromoteArchiveRequest = {
  workspaceId: string
}

export type MemoryPromoteArchiveResult = {
  ok: boolean
  // archive에서 promote한 경우 그 스냅샷의 archivedAt. 빈 IR로 떨어진 경우 null.
  promotedFromArchivedAt: string | null
  error?: string
}

// ─── M3.6 C 청크 — 멀티 윈도우 ────────────────────────────────────────────
// 각 워크스페이스를 별도 BrowserWindow로 띄울 수 있다. 한 워크스페이스 = 한 윈도우 정책(중복
// 열림 불허) — 이미 열린 윈도우가 있으면 focus만. workspaceId=null은 홈 윈도우(HomePane).
export type WindowOpenWorkspaceRequest = {
  workspaceId: string | null
}

// 부팅 직후 renderer가 자기 윈도우의 workspaceId를 조회. URL query 파싱 없이 단일 IPC로 단순화.
// homewindow면 workspaceId=null — App.tsx는 HomePane을 자동 렌더.
export type WindowBootstrap = {
  workspaceId: string | null
}

// 워크스페이스 변경(create/rename/delete)이 모든 윈도우의 좌 사이드바 list에 반영되어야 하므로
// 전역 fan-out broadcast. removedWorkspaceId가 채워지면 그 워크스페이스는 hard delete된 것 —
// renderer는 자기 openWorkspaceId가 그 값이면 home으로 폴백한다.
export type WorkspacesChangedEvent = {
  removedWorkspaceId: string | null
}

// 한 워크스페이스 = 한 윈도우 정책 강화 — 좌 사이드바 클릭 / 부팅 attach / 새 워크스페이스 진입 등
// 모든 ws 진입 경로가 main에 claim을 요청한다. 결과에 따라 renderer가 분기:
//   'claimed'        : sender 윈도우가 이 ws에 정식 매핑됨. attach 진행.
//   'already-mine'   : 이미 sender 윈도우가 이 ws에 매핑됨. attach 진행(또는 no-op).
//   'focused-other'  : 이미 다른 윈도우가 이 ws를 잡고 있어 main이 그 윈도우 focus. attach skip.
export type WindowClaimWorkspaceRequest = {
  workspaceId: string
}

export type WindowClaimWorkspaceResult = {
  outcome: 'claimed' | 'already-mine' | 'focused-other'
}

// ─── M3.6 B 청크 — 드래그 앤 드롭 파일 첨부 ──────────────────────────────
// 사용자가 xterm 영역에 OS 파일을 드롭하면 절대 경로를 PTY에 inject한다.
//   cli   — 어댑터 formatChatSubmit으로 "다음 파일을 읽어줘: <path...>" 메시지 + Enter
//   shell — 공백 분리 + quote 처리된 경로만 write (Enter 안 함 — 사용자가 cd / cat 등 명령에 사용)
// 디렉토리는 Phase 2 (트리 인덱싱 필요) — 첫 cut에선 reject.
export type AttachFilesRequest = {
  workspaceId: string
  sessionId: string
  paths: string[]
}

export type AttachFileAccepted = { path: string; sizeBytes: number }
export type AttachFileRejected = { path: string; reason: string }

export type AttachFilesResult = {
  ok: boolean
  accepted: AttachFileAccepted[]
  rejected: AttachFileRejected[]
  // 진단용 — 실패 시 비어있지 않음.
  error?: string
}

// ─── Refine 정책 (M3 N → 2026 재설계) ────────────────────────────────────
// 4단계 정책:
//   priority : CLI 우선순위 list로 시도. 실패/quota 초과 시 다음 CLI로 fallback (기본값)
//   fixed    : 단일 CLI 고정. 실패 시 정제 스킵 (fallback 없음)
//   active   : 마지막 채팅 CLI. 실패 시 정제 스킵
//   off      : 정제 안 함 — hook은 빈 컨텍스트만 inject
//
// 모델 선택:
//   - agy: CLI flag로 지정 불가. 사용자 default 따름 (interactive에서 변경한 게 영구 적용)
//   - codex: `-c model="<id>"` 형식. cheap default: gpt-5.4-mini
//   - claude: `--model <id>` 형식. cheap default: claude-haiku-4-5
//
// legacy 값 마이그레이션 (settings 로드 시):
//   auto / agy-flash → priority
export type RefineModelPolicy = 'priority' | 'fixed' | 'active' | 'off'

// UI 외관 — 현재 다크만 잠금. 라이트/시스템은 정식 배포 후 활성화 예정 — 토글 UI는 disabled.
export type ThemeMode = 'dark' | 'light' | 'system'

// 언어 — 현재 한글만 잠금. 영어는 i18n 도입 후 활성화 예정 — 토글 UI는 disabled.
export type LanguageCode = 'ko' | 'en'

// turns.jsonl의 assistant body 보존 정도. settings에서 사용자가 선택. 3단계.
//   full    : 원문에 가깝게 보존 (~50KB까지). 디스크 사용량 큼. 디버깅/리뷰 용도.
//   compact : 핵심만 추출 (~500자). 균형 잡힌 기본값.
//   minimal : 최소 요약 (~200자). 가벼움. 디테일 손실.
export type TurnsAssistantDetail = 'full' | 'compact' | 'minimal'

export type AppSettings = {
  refineModel: RefineModelPolicy
  // priority 정책 시 CLI 우선순위 (앞에서부터 시도). 기본: ['agy', 'codex', 'claude']
  refinePriorityOrder: CliKind[]
  // fixed 정책 시 사용할 단일 CLI. 기본: 'agy'
  refineFixedCli: CliKind
  // 다크/라이트/시스템 — 현재 'dark'로 잠금.
  theme: ThemeMode
  // 표시 언어 — 현재 'ko'로 잠금.
  language: LanguageCode
  // 홈 화면 새 워크스페이스 생성 시 사용할 베이스 경로. 비어있으면 main 프로세스가
  // `${homedir}/AgentBridge`를 fallback으로 사용. 사용자가 수정 가능.
  defaultBasePath: string
  // turns.jsonl 안 assistantBody 보존 정도. sliceAssistant의 cap 단계 결정.
  turnsAssistantDetail: TurnsAssistantDetail
}

// 각 CLI의 정제용 default model. cheap 모델 (토큰 소모량 최소) 기준.
//   agy:    CLI flag로 모델 지정 불가 — 사용자 default 따름. null 표기.
//   codex:  `-c model="gpt-5.4-mini"` (OpenAI mini variant)
//   claude: `--model "claude-haiku-4-5"` (Haiku — Opus 대비 약 1/20 비용)
// 사용자가 수정 가능 (UI에서 외부화 예정. 현재는 hardcoded default).
export const REFINE_DEFAULT_MODEL: Record<CliKind, string | null> = {
  agy: null,
  codex: 'gpt-5.4-mini',
  claude: 'claude-haiku-4-5'
}

// quota severity (Phase 2 — per-CLI 슬래시 명령 응답 기반):
//   unknown  : 한 번도 캡처 못 함 — UI에 안내만
//   ok       : <80%
//   warn     : 80~94%
//   critical : 95~99%
//   exceeded : >=100% 또는 forcedFallback 마킹 상태
export type QuotaSeverity = 'unknown' | 'ok' | 'warn' | 'critical' | 'exceeded'

export type QuotaSnapshot = {
  // 슬래시 명령 응답에서 마지막 캡처한 사용률(%). null이면 한 번도 못 봄.
  usedPercent: number | null
  // 마지막 캡처 시각 (ISO 8601). null이면 한 번도 못 봄.
  lastSeenAt: string | null
  severity: QuotaSeverity
  shouldFallback: boolean
  // 응답 에러로 강제 폴백 마킹 상태. UTC 자정 자동 해제.
  forcedFallback: boolean
}

// quota:get 결과 — 세 CLI snapshot 일괄.
export type QuotaSnapshotsByCli = Record<CliKind, QuotaSnapshot>

// quota:updated broadcast 페이로드 — CLI별로 변경 발사.
export type QuotaUpdatedEvent = {
  cli: CliKind
  snapshot: QuotaSnapshot
}

// quota:probe 요청 — 어느 CLI를 probe할지.
export type QuotaProbeRequest = {
  cli: CliKind
}

// quota:probe 결과 — background CLI PTY spawn + 슬래시 명령 응답 캡처 + cleanup.
export type QuotaProbeResult = {
  ok: boolean
  cli: CliKind
  // 캡처된 최신 snapshot (ok=false면 기존 영속 값 그대로).
  snapshot: QuotaSnapshot
  // 진단용 — timeout / pty-exited / spawn-failed 등.
  reason?: string
  durationMs: number
}

// 자동 업데이트 in-app 진행 상태. main이 autoUpdater 이벤트를 통합해 한 payload로 broadcast.
//   idle          — 부팅 직후 아직 체크 전
//   skipped-dev   — dev 모드라 폴링 자체 안 함
//   checking      — checkForUpdates in-flight
//   available     — 새 버전 발견. autoDownload=true라 곧 downloading으로 전환
//   not-available — 현재가 최신
//   downloading   — 청크 받는 중. percent 0-100
//   downloaded    — 다운로드 완료. 다음 종료 시 자동 설치 (ad-hoc 단계에선 macOS가 거부할 수 있음)
//   error         — autoUpdater 에러. message에 사유.
export type AppUpdaterStatus =
  | { phase: 'idle' }
  | { phase: 'skipped-dev' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'not-available'; version: string }
  | { phase: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string }

// renderer가 'appUpdater:check' invoke 시 받는 즉시 응답.
//   ok=true면 체크 trigger 됐고 이후 status 이벤트로 후속 보고.
//   ok=false면 trigger 자체 실패(예: dev 모드, in-flight 중복).
export type AppUpdaterCheckResult = {
  ok: boolean
  reason?: string
  // 트리거 시점의 즉시 status (UI 즉시 반영용)
  status: AppUpdaterStatus
}

export const IpcChannel = {
  AppHealth: 'app:health',
  AppOpenPath: 'app:openPath',
  AppOpenExternal: 'app:openExternal',
  EnvProbe: 'env:probe',
  PtyStart: 'pty:start',
  PtyWrite: 'pty:write',
  PtyResize: 'pty:resize',
  PtyKill: 'pty:kill',
  PtyData: 'pty:data',
  PtyExit: 'pty:exit',
  DialogPickWorkspace: 'dialog:pickWorkspace',
  IrLoad: 'ir:load',
  IrRefine: 'ir:refine',
  // 자동 compaction / 사용자 정제 완료 직후 main → renderer 통보. 영속화된 IR을 다시 읽도록 알림.
  IrUpdated: 'ir:updated',
  // 메모리 패널 — archive 히스토리 / turns 흐름 / cwd 안 AI 지시 파일.
  ArchiveList: 'archive:list',
  ArchiveLoad: 'archive:load',
  ArchiveDelete: 'archive:delete',
  TurnsSummary: 'turns:summary',
  // turns.jsonl 새 record append 직후 main → renderer broadcast. UI가 turns 흐름 카드 즉시 갱신.
  TurnsUpdated: 'turns:updated',
  InstructionsList: 'instructions:list',
  InstructionsCreate: 'instructions:create',
  // ─── M3 K 청크 — workspace + sessions ───
  WorkspacesList: 'workspaces:list',
  WorkspacesCreate: 'workspaces:create',
  WorkspacesOpen: 'workspaces:open',
  WorkspacesDelete: 'workspaces:delete',
  WorkspacesGet: 'workspaces:get',
  WorkspacesRename: 'workspaces:rename',
  // 홈 화면 첫 제출 — 워크스페이스 생성 + 세션 spawn + 첫 메시지 submit 일괄.
  HomeSubmit: 'home:submit',
  SessionsCreate: 'sessions:create',
  SessionsOpen: 'sessions:open',
  SessionsClose: 'sessions:close',
  SessionsList: 'sessions:list',
  SessionsRename: 'sessions:rename',
  SessionsModelSessionCaptured: 'sessions:modelSessionCaptured',
  // ─── M3 M 청크 — hook trust 상태 ───
  HooksTrustGet: 'hooks:trustGet',
  HooksTrustSet: 'hooks:trustSet',
  // ─── M3 N 청크 — settings + gemini quota ───
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  // saveSettings 직후 main → renderer 전역 broadcast. 여러 패널/윈도우가 같은 settings를 표시할 때
  // 한쪽 변경이 다른 쪽에 즉시 반영되도록.
  SettingsUpdated: 'settings:updated',
  QuotaGet: 'quota:get',
  // gemini PTY background spawn으로 footer "% used" 캡처. 사용자 명시 + 자동 trigger 양쪽 사용.
  QuotaProbe: 'quota:probe',
  // quota state 변경 시 main → renderer broadcast. 백그라운드 probe / 응답 에러 마킹 / 모순 reconcile 시 발사.
  QuotaUpdated: 'quota:updated',
  // ─── M3.6 B 청크 — 드래그 앤 드롭 파일 첨부 ───
  AttachFiles: 'attach:files',
  // ─── M3.6 D 청크 — 메모리 초기화 ───
  MemoryReset: 'memory:reset',
  MemoryPromoteArchive: 'memory:promoteLatestArchive',
  // ─── M3.6 C 청크 — 멀티 윈도우 ───
  // 새 윈도우(또는 기존 매칭 윈도우 focus)에 워크스페이스를 연다. workspaceId=null이면 빈 홈 윈도우.
  WindowOpenWorkspace: 'window:openWorkspace',
  // 부팅 직후 renderer가 main에 "내 윈도우가 어느 워크스페이스인지" 조회. URL query 없이 단일 IPC로 처리.
  WindowGetBootstrap: 'window:getBootstrap',
  // 한 워크스페이스 = 한 윈도우 정책. renderer가 ws attach 전에 main에 claim 요청.
  WindowClaimWorkspace: 'window:claimWorkspace',
  // 자기 윈도우를 home 상태로 되돌림 (handleGoHome 진입 시).
  WindowReleaseWorkspace: 'window:releaseWorkspace',
  // 워크스페이스 create/rename/delete 전역 통보. delete는 removedWorkspaceId 채워짐.
  WorkspacesChanged: 'workspaces:changed',
  // ─── 자동 업데이트 — in-app 수동 체크 + 진행 상태 broadcast ───
  // renderer가 "지금 확인" 버튼 등으로 즉시 체크 trigger. 백그라운드 polling과 별개로 발사.
  AppUpdaterCheck: 'appUpdater:check',
  // 마지막 status 즉시 조회 (renderer 모달 마운트 시 초기 표시용. trigger 없음).
  AppUpdaterGet: 'appUpdater:get',
  // main → renderer broadcast. autoUpdater 이벤트(checking / available / downloading / downloaded / error)를
  // 통합 status payload로 전달.
  AppUpdaterStatus: 'appUpdater:status'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]
