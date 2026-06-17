// CLI quota 상태 추적 — 순수 로직.
//
// 호스트(desktop / extension)는 QuotaStore 어댑터를 주입하면 됨:
//   - desktop: fs 기반 (`<userData>/cli_quota.json`)
//   - extension: vscode globalState 또는 메모리
//
// PTY spawn 기반 `/usage` `/status` 슬래시 명령 probe는 호스트(desktop) 책임.
// 코어는 응답 정규식 파싱(extractQuotaPercent) + 상태 저장/severity 계산만.

import type { CliKind } from './shared/cli';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';

// % used 기반 임계값. agy/codex/claude 동일 적용.
export const QUOTA_WARN_PERCENT = 80;
export const QUOTA_CRITICAL_PERCENT = 95;
export const QUOTA_EXCEEDED_PERCENT = 100;

export type QuotaSeverity = 'unknown' | 'ok' | 'warn' | 'critical' | 'exceeded';

export type CliQuotaSnapshot = {
  // 슬래시 명령 응답에서 마지막 캡처한 % used. null이면 아직 한 번도 못 봄.
  usedPercent: number | null;
  lastSeenAt: string | null;
  severity: QuotaSeverity;
  shouldFallback: boolean;
  // 응답 에러로 강제 폴백 마킹된 상태 (UTC 자정 자동 해제).
  forcedFallback: boolean;
};

// store에 영속되는 raw state (호스트 storage adapter용).
export type QuotaFile = {
  usedPercent: number | null;
  lastSeenAt: string | null;
  forcedFallbackDate: string | null;
  forcedFallback: boolean;
};

export type QuotaFileMap = Partial<Record<CliKind, QuotaFile>>;

export const EMPTY_QUOTA_FILE: QuotaFile = {
  usedPercent: null,
  lastSeenAt: null,
  forcedFallbackDate: null,
  forcedFallback: false,
};

// 호스트가 주입할 영속 어댑터. read/write 시그니처만 강제, 내부 구현은 자유.
export interface QuotaStore {
  read(): Promise<QuotaFileMap>;
  write(map: QuotaFileMap): Promise<void>;
}

// ─── 순수 함수 ─────────────────────────────────────────────────────────

export function todayKey(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function severityFor(usedPercent: number | null, forcedFallback: boolean): QuotaSeverity {
  if (forcedFallback) return 'exceeded';
  if (usedPercent == null) return 'unknown';
  if (usedPercent >= QUOTA_EXCEEDED_PERCENT) return 'exceeded';
  if (usedPercent >= QUOTA_CRITICAL_PERCENT) return 'critical';
  if (usedPercent >= QUOTA_WARN_PERCENT) return 'warn';
  return 'ok';
}

export function shouldFallbackFor(severity: QuotaSeverity): boolean {
  return severity === 'critical' || severity === 'exceeded';
}

export function parseQuotaFile(raw: unknown): QuotaFile {
  const o = (raw ?? {}) as Partial<QuotaFile>;
  return {
    usedPercent: typeof o.usedPercent === 'number' ? o.usedPercent : null,
    lastSeenAt: typeof o.lastSeenAt === 'string' ? o.lastSeenAt : null,
    forcedFallbackDate: typeof o.forcedFallbackDate === 'string' ? o.forcedFallbackDate : null,
    forcedFallback: o.forcedFallback === true,
  };
}

export function rolloverIfNeeded(state: QuotaFile): QuotaFile {
  if (!state.forcedFallback) return state;
  if (state.forcedFallbackDate === todayKey()) return state;
  return { ...state, forcedFallback: false, forcedFallbackDate: null };
}

export function reconcileForcedFallback(state: QuotaFile): QuotaFile {
  if (
    state.forcedFallback &&
    typeof state.usedPercent === 'number' &&
    state.usedPercent < QUOTA_CRITICAL_PERCENT
  ) {
    return { ...state, forcedFallback: false, forcedFallbackDate: null };
  }
  return state;
}

export function snapshotFrom(state: QuotaFile): CliQuotaSnapshot {
  const severity = severityFor(state.usedPercent, state.forcedFallback);
  return {
    usedPercent: state.usedPercent,
    lastSeenAt: state.lastSeenAt,
    severity,
    shouldFallback: shouldFallbackFor(severity),
    forcedFallback: state.forcedFallback,
  };
}

// ─── 슬래시 명령 응답 파싱 (per CLI) ─────────────────────────────────────

// agy `/usage` → "Models & Quota" 멀티그룹 화면 (2026-06 개편, CLI 1.0.8 실측).
//   격리 박스에서 정제는 항상 기본 모델(Gemini)로 도므로 GEMINI 그룹의 Five Hour 한도만 본다.
//   막대 줄 퍼센트 = *남은* quota (실측: `[██░] 96.81%` → "97% remaining"). usedPercent = 100 - N.
//   100.00% = `Quota available`(완전 미사용). 소수점 포함. "Five Hour Limit" 라벨을 먼저 앵커로
//   잡아 바로 위 Weekly 퍼센트를 건너뛴다.
const AGY_GEMINI_5H_RE =
  /GEMINI\s+MODELS\b[\s\S]*?Five[\s-]*Hour\s+Limit\b[\s\S]*?(\d+(?:\.\d+)?)\s*%/i;
// codex: `5h limit: ... N% left` — N = 남은 quota → usedPercent = 100 - N.
const CODEX_STATUS_RE = /5h\s*limit:[\s\S]{0,200}?(\d+)\s*%\s+left/i;
// claude: `Current session ... N%used` — N = 사용된 quota 그대로.
const CLAUDE_USAGE_RE = /Current\s+session[\s\S]{0,200}?(\d+)\s*%\s*used/i;

export function extractQuotaPercent(cli: CliKind, stripped: string): number | null {
  let m: RegExpExecArray | null;
  let n: number;
  switch (cli) {
    case 'agy':
      m = AGY_GEMINI_5H_RE.exec(stripped);
      if (!m) return null;
      n = Number.parseFloat(m[1]);
      if (!Number.isFinite(n) || n < 0 || n > 100) return null;
      return Math.round(100 - n);
    case 'codex':
      m = CODEX_STATUS_RE.exec(stripped);
      if (!m) return null;
      n = Number.parseInt(m[1], 10);
      if (!Number.isFinite(n) || n < 0 || n > 100) return null;
      return 100 - n;
    case 'claude':
      m = CLAUDE_USAGE_RE.exec(stripped);
      if (!m) return null;
      n = Number.parseInt(m[1], 10);
      if (!Number.isFinite(n) || n < 0 || n > 100) return null;
      return n;
  }
}

// quota 에러 휴리스틱 — 자연어 응답에 'quota' 단어가 우연 등장하는 false positive를
// 막기 위해 *에러 컨텍스트와 결합된 강한 패턴*만 매칭.
const QUOTA_STRONG_PATTERNS: RegExp[] = [
  /quota\s*(?:exceeded|exhausted|limit|reached|hit|error)/i,
  /exceed(?:ed|ing)?\s+(?:your\s+)?quota/i,
  /out\s+of\s+quota/i,
  /rate[\s_-]*limit(?:ed|ing|\s+exceeded|\s+reached|\s+error)?/i,
  /resource[\s_-]*exhausted/i,
  /(?:http\s*\/?\s*)?status[:\s]+429\b/i,
  /\b429\s+(?:too\s+many|error|status|response|resource|client)/i,
  /too\s+many\s+requests/i,
];

export function looksLikeQuotaError(
  stderr: string,
  assistantText: string,
  exitCode?: number | null,
): boolean {
  if (QUOTA_STRONG_PATTERNS.some((re) => re.test(stderr))) return true;
  if (exitCode != null && exitCode !== 0) {
    if (QUOTA_STRONG_PATTERNS.some((re) => re.test(assistantText))) return true;
  }
  return false;
}

// ─── 팩토리: store + onChange 주입 ──────────────────────────────────────

export type QuotaTrackerOptions = {
  store: QuotaStore;
  // 변경 시 호스트가 broadcast (electron IPC, vscode webview message 등). 옵셔널.
  onChange?: (cli: CliKind, snapshot: CliQuotaSnapshot) => void;
  logger?: Logger;
};

export interface QuotaTracker {
  getSnapshot(cli: CliKind): Promise<CliQuotaSnapshot>;
  getAllSnapshots(): Promise<Record<CliKind, CliQuotaSnapshot>>;
  recordPercent(cli: CliKind, percent: number): Promise<CliQuotaSnapshot>;
  markForcedFallback(cli: CliKind): Promise<CliQuotaSnapshot>;
}

export function createQuotaTracker(opts: QuotaTrackerOptions): QuotaTracker {
  const log = opts.logger ?? noopLogger;
  const emit = (cli: CliKind, snap: CliQuotaSnapshot): void => {
    try {
      opts.onChange?.(cli, snap);
    } catch (err) {
      log.warn(`quotaTracker onChange 실패: ${String(err)}`);
    }
  };

  // 쓰기를 동반하는 작업(getSnapshot 롤오버 자체쓰기·recordPercent·markForcedFallback)을 한 번에
  // 하나씩 직렬화한다. 셋 다 store 전체 맵을 read → 한 칸 수정 → write 하므로, 시작 워밍이 3개 CLI를
  // 같은 tick에 probe하면 둘이 같은 옛 맵을 읽고 한쪽 갱신이 사라질 수 있다(lost-update). 압축처럼
  // 위에서 직렬화해 주는 락이 없어 여기서 in-process 큐로 막는다.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  // 내부 구현 — 메서드 간 호출(recordPercent→getSnapshot)은 직렬화 재진입(자기 큐를 기다리는 교착)을
  // 피하려 impl을 직접 부른다. 공개 메서드만 serialize로 감싼다.
  const getSnapshotImpl = async (cli: CliKind): Promise<CliQuotaSnapshot> => {
    const map = await opts.store.read();
    const raw = map[cli] ?? EMPTY_QUOTA_FILE;
    const afterRollover = rolloverIfNeeded(raw);
    const afterReconcile = reconcileForcedFallback(afterRollover);
    if (
      afterReconcile.forcedFallback !== raw.forcedFallback ||
      afterReconcile.forcedFallbackDate !== raw.forcedFallbackDate
    ) {
      await opts.store.write({ ...map, [cli]: afterReconcile });
      const snap = snapshotFrom(afterReconcile);
      emit(cli, snap);
      return snap;
    }
    return snapshotFrom(afterReconcile);
  };

  const recordPercentImpl = async (cli: CliKind, percent: number): Promise<CliQuotaSnapshot> => {
    if (!Number.isFinite(percent) || percent < 0 || percent > 1000) {
      return getSnapshotImpl(cli);
    }
    const map = await opts.store.read();
    let state = rolloverIfNeeded(map[cli] ?? EMPTY_QUOTA_FILE);
    // 같은 %여도 lastSeenAt은 갱신 — 측정 신선도(stale 판단)는 값 변화와 무관하게 유지되어야
    // probeQuotaIfStale 류의 재측정 스킵이 올바르게 동작한다.
    state = { ...state, usedPercent: percent, lastSeenAt: new Date().toISOString() };
    state = reconcileForcedFallback(state);
    await opts.store.write({ ...map, [cli]: state });
    log.log(`quota 캡처: ${cli} usedPercent=${percent}`);
    const snap = snapshotFrom(state);
    emit(cli, snap);
    return snap;
  };

  const markForcedFallbackImpl = async (cli: CliKind): Promise<CliQuotaSnapshot> => {
    const map = await opts.store.read();
    let state = rolloverIfNeeded(map[cli] ?? EMPTY_QUOTA_FILE);
    state = { ...state, forcedFallback: true, forcedFallbackDate: todayKey() };
    await opts.store.write({ ...map, [cli]: state });
    log.warn(`quota 강제 폴백 마킹: ${cli}`);
    const snap = snapshotFrom(state);
    emit(cli, snap);
    return snap;
  };

  return {
    getSnapshot: (cli) => serialize(() => getSnapshotImpl(cli)),

    // 순수 읽기 — 쓰기가 없어 lost-update 위험이 없으므로 직렬화 대상이 아니다.
    async getAllSnapshots() {
      const map = await opts.store.read();
      const out = {} as Record<CliKind, CliQuotaSnapshot>;
      for (const k of ['agy', 'codex', 'claude'] as CliKind[]) {
        const raw = map[k] ?? EMPTY_QUOTA_FILE;
        out[k] = snapshotFrom(reconcileForcedFallback(rolloverIfNeeded(raw)));
      }
      return out;
    },

    recordPercent: (cli, percent) => serialize(() => recordPercentImpl(cli, percent)),

    markForcedFallback: (cli) => serialize(() => markForcedFallbackImpl(cli)),
  };
}
