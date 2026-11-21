// 하니스별 모델·effort 표 파싱과 조합 (0.8.0 spec/06 §1·§2).
//
// 모델 목록은 저장해 두지 않고 부를 때마다 각 하니스에서 새로 받는다.
// 이 모듈은 파싱·동시 조회 조합·텍스트 렌더링만 맡고, 실제 프로세스 실행은 호스트(익스텐션)에 둔다.

import type { CliKind } from './shared/cli';

export type ModelRow = { name: string; efforts: string[] }; // efforts가 빈 배열이면 effort 없음
export type HarnessTable = { harness: CliKind; rows: ModelRow[] } | { harness: CliKind; error: string };
export type HarnessRunner = (harness: CliKind, signal: AbortSignal) => Promise<unknown>;

export const MODEL_LOOKUP_TIMEOUT_MS = 15_000;

const AGY_EFFORT_SUFFIXES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function extractClaudeModels(controlResponse: unknown): unknown[] | null {
  if (Array.isArray(controlResponse)) return controlResponse;
  const root = asRecord(controlResponse);
  if (!root) return null;

  // control_response 봉투 오류 응답 검사
  const topResp = asRecord(root.response);
  if (root.subtype === 'error') {
    throw new Error(typeof root.error === 'string' && root.error ? root.error : 'claude list_models 오류');
  }
  if (topResp?.subtype === 'error') {
    throw new Error(
      typeof topResp.error === 'string' && topResp.error ? topResp.error : 'claude list_models 오류',
    );
  }

  const innerResp = asRecord(topResp?.response);
  if (Array.isArray(innerResp?.models)) return innerResp.models;
  if (Array.isArray(topResp?.models)) return topResp.models;
  if (Array.isArray(root.models)) return root.models;
  return null;
}

/** claude `list_models` 제어 응답을 모델 행 목록으로 바꾼다. `default` 행은 제외한다. */
export function parseClaudeModels(controlResponse: unknown): ModelRow[] {
  const rawModels = extractClaudeModels(controlResponse);
  if (!rawModels) {
    throw new Error('claude 응답 형식이 다르다');
  }

  const rows: ModelRow[] = [];
  const seen = new Set<string>();
  for (const item of rawModels) {
    const rec = asRecord(item);
    if (!rec || typeof rec.value !== 'string' || !rec.value) continue;
    if (rec.value === 'default') continue;
    if (seen.has(rec.value)) continue;
    seen.add(rec.value);

    const efforts =
      rec.supportsEffort === true && Array.isArray(rec.supportedEffortLevels)
        ? rec.supportedEffortLevels.filter((e): e is string => typeof e === 'string' && e.length > 0)
        : [];
    rows.push({ name: rec.value, efforts });
  }
  return rows;
}

function extractCodexPageData(page: unknown): unknown[] | null {
  const rec = asRecord(page);
  if (!rec) return null;
  if (rec.error !== undefined) {
    const errRec = asRecord(rec.error);
    const msg = errRec && typeof errRec.message === 'string' ? errRec.message : 'codex model/list 오류';
    throw new Error(msg);
  }
  const result = asRecord(rec.result);
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(rec.data)) return rec.data;
  return null;
}

/** codex app-server `model/list` 쪽 배열을 모델 행 목록으로 바꾼다. */
export function parseCodexModels(pages: unknown[]): ModelRow[] {
  if (!Array.isArray(pages)) {
    throw new Error('codex 응답 형식이 배열이 아니다');
  }

  const rows: ModelRow[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const data = extractCodexPageData(page);
    if (!data) {
      throw new Error('codex model/list 응답 형식이 다르다');
    }
    for (const item of data) {
      const rec = asRecord(item);
      if (!rec || typeof rec.model !== 'string' || !rec.model) continue;
      if (seen.has(rec.model)) continue;
      seen.add(rec.model);

      const efforts = Array.isArray(rec.supportedReasoningEfforts)
        ? rec.supportedReasoningEfforts
            .map((e) => asRecord(e)?.reasoningEffort)
            .filter((e): e is string => typeof e === 'string' && e.length > 0)
        : [];
      rows.push({ name: rec.model, efforts });
    }
  }
  return rows;
}

function splitAgySuffix(id: string): { base: string; effort: string | null } {
  for (const suffix of AGY_EFFORT_SUFFIXES) {
    const tail = `-${suffix}`;
    if (id.endsWith(tail) && id.length > tail.length) {
      return { base: id.slice(0, -tail.length), effort: suffix };
    }
  }
  return { base: id, effort: null };
}

/** `agy models` stdout(`<id>\t<표시 이름>`)을 기본 모델 이름과 effort 목록으로 묶는다. */
export function parseAgyModels(stdout: string): ModelRow[] {
  if (typeof stdout !== 'string') {
    throw new Error('agy 출력 형식이 문자열이 아니다');
  }

  const grouped = new Map<string, string[]>();
  const lines = stdout.split(/\r?\n/);
  let nonEmptyCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    nonEmptyCount += 1;

    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    if (!id || /\s/.test(id)) continue;

    const { base, effort } = splitAgySuffix(id);
    let list = grouped.get(base);
    if (!list) {
      list = [];
      grouped.set(base, list);
    }
    if (effort && !list.includes(effort)) {
      list.push(effort);
    }
  }

  if (grouped.size === 0 && nonEmptyCount > 0) {
    throw new Error('agy models 출력 형식이 다르다');
  }

  // agy는 같은 모델의 effort 꼬리를 낮은 순으로 늘어놓지 않는다(실측: high·medium·low). 낮은 순으로 맞춘다.
  const rank = (e: string): number => AGY_EFFORT_SUFFIXES.indexOf(e as (typeof AGY_EFFORT_SUFFIXES)[number]);
  return Array.from(grouped.entries(), ([name, efforts]) => ({
    name,
    efforts: [...efforts].sort((a, b) => rank(a) - rank(b)),
  }));
}

function parseForHarness(harness: CliKind, raw: unknown): ModelRow[] {
  switch (harness) {
    case 'claude':
      return parseClaudeModels(raw);
    case 'codex':
      if (!Array.isArray(raw)) throw new Error('codex 응답 형식이 배열이 아니다');
      return parseCodexModels(raw);
    case 'agy':
      if (typeof raw !== 'string') throw new Error('agy 출력 형식이 문자열이 아니다');
      return parseAgyModels(raw);
  }
}

function formatTimeoutLabel(timeoutMs: number): string {
  return timeoutMs >= 1000 && timeoutMs % 1000 === 0
    ? `${timeoutMs / 1000}초`
    : `${timeoutMs}ms`;
}

async function lookupOne(
  harness: CliKind,
  run: HarnessRunner,
  timeoutMs: number,
): Promise<HarnessTable> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${formatTimeoutLabel(timeoutMs)} 시간 초과`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    const runPromise = Promise.resolve().then(() => run(harness, controller.signal));
    // 시한 초과로 race가 먼저 끝나도 뒤늦게 reject될 때 미처리 거부 경고가 나지 않게 흡수한다.
    runPromise.catch(() => {});
    const raw = await Promise.race([runPromise, timeoutPromise]);
    const rows = parseForHarness(harness, raw);
    if (rows.length === 0) {
      return { harness, error: '모델 목록이 비어 있다' };
    }
    return { harness, rows };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { harness, error: msg || '알 수 없는 오류' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 주어진 하니스들의 모델·effort 표를 동시에 조회해 만든다. 하나가 실패해도 나머지는 반환한다. */
export function buildModelTable(
  harnesses: CliKind[],
  run: HarnessRunner,
  opts: { timeoutMs?: number } = {},
): Promise<HarnessTable[]> {
  const timeoutMs = opts.timeoutMs ?? MODEL_LOOKUP_TIMEOUT_MS;
  return Promise.all(harnesses.map((h) => lookupOne(h, run, timeoutMs)));
}

/** 모델 표를 spec §2 형식의 텍스트로 그린다. */
export function renderModelTable(tables: HarnessTable[]): string {
  return tables
    .map((table) => {
      const lines = [`## ${table.harness}`, ''];
      if ('error' in table) {
        lines.push(`  조회 실패 (${table.error})`);
      } else {
        const width = Math.max(...table.rows.map((r) => r.name.length)) + 2;
        for (const r of table.rows) {
          const effortText = r.efforts.length > 0 ? r.efforts.join(' ') : '(effort 없음)';
          lines.push(`  ${r.name.padEnd(width)}${effortText}`);
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * `agent start`가 받은 하니스별 모델·effort를 조회한 표에 대어 검사하고 거절 문구 목록을 반환한다.
 * 빈 배열이면 모두 통과한 것이다.
 */
export function validateModelSelections(
  models: Partial<Record<CliKind, string>>,
  efforts: Partial<Record<CliKind, string>>,
  tables: HarnessTable[],
): string[] {
  const errors: string[] = [];

  for (const [harness, effort] of Object.entries(efforts) as [CliKind, string | undefined][]) {
    if (effort !== undefined && !models[harness]) {
      errors.push(`${harness}에 --effort만 있다. --model과 함께 쓴다`);
    }
  }

  for (const [harness, model] of Object.entries(models) as [CliKind, string | undefined][]) {
    if (model === undefined) continue;
    const effort = efforts[harness];
    const table = tables.find((t) => t.harness === harness);
    if (!table) {
      errors.push(`${harness}의 모델 목록을 받지 못해 검사할 수 없다 (조회 결과 없음)`);
      continue;
    }
    if ('error' in table) {
      errors.push(`${harness}의 모델 목록을 받지 못해 검사할 수 없다 (${table.error})`);
      continue;
    }

    const row = table.rows.find((r) => r.name === model);
    if (!row) {
      const available = table.rows.map((r) => r.name).join(', ');
      errors.push(
        `${harness}에 ${model} 모델이 없다. 받는 모델: ${available}. 전체는 agent models로 본다`,
      );
      continue;
    }

    if (row.efforts.length === 0) {
      if (effort !== undefined) {
        errors.push(`${harness}의 ${model}은 effort를 받지 않는다`);
      }
      continue;
    }

    if (effort === undefined) {
      errors.push(`${harness}의 ${model}에 --effort가 없다. 받는 값: ${row.efforts.join(' ')}`);
      continue;
    }

    if (!row.efforts.includes(effort)) {
      errors.push(
        `${harness}의 ${model}은 --effort ${effort}를 받지 않는다. 받는 값: ${row.efforts.join(' ')}. 전체는 agent models로 본다`,
      );
    }
  }

  return errors;
}
