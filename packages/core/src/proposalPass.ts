// 자동제안 종단 오케스트레이터(§D.1). compaction 후 앱이 호출.
// runAnalysis 주입 가능 — 기본 = runProposalAnalysis(실제 spawn). 테스트는 가짜 출력 주입.
import type { EnvProbe } from './envProbe';
import type { CliKind } from './shared/cli';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';
import {
  runProposalAnalysis,
  resolveRefineDecisionFromConfig,
  type RefineDecision,
  type RefineModelChoice,
  type RefinePolicyConfig,
} from './refineDispatcher';
import { buildProposalPrompt } from './proposalPrompt';
import { parseProposalOutput } from './proposalParse';
import { collectProposalTurns, writeProposalCursor, bumpCompactionCount, shouldRunProposalPass } from './proposalCursor';
import { writeProposals } from './proposalStore';
import { readProfileDocs } from './globalStore';

export type RunProposalPassArgs = {
  workspaceRoot: string;
  globalDir: string;
  profileId: string;
  decision: RefineDecision;
  envProbe: EnvProbe;
  logger?: Logger;
  timeoutMs?: number;
  // 주입 가능 — 기본은 실제 디스패처. 테스트/대체 구현용.
  runAnalysis?: (args: {
    decision: RefineDecision; prompt: string; envProbe: EnvProbe; logger?: Logger; timeoutMs?: number;
  }) => Promise<Pick<RefineModelChoice, 'result'>>;
};

export type ProposalPassResult = {
  written: number;
  skipped: number;
  skippedReason?: 'no-new-turns' | 'analysis-failed' | 'parse-failed';
};

export async function runProposalPass(args: RunProposalPassArgs): Promise<ProposalPassResult> {
  const log = args.logger ?? noopLogger;
  const analyze = args.runAnalysis ?? ((a) => runProposalAnalysis(a));

  const collected = await collectProposalTurns(args.workspaceRoot);
  if (collected.newCount === 0) {
    return { written: 0, skipped: 0, skippedReason: 'no-new-turns' };
  }

  // 중복방지용 기존 프로필 인덱스(카테고리·제목).
  const docs = await readProfileDocs(args.globalDir, args.profileId).catch(() => []);
  const existingIndex = docs.map((d) => ({ category: d.category, title: d.title }));

  const prompt = buildProposalPrompt({ turns: collected.turns, existingIndex });

  let assistantText: string;
  try {
    const choice = await analyze({
      decision: args.decision, prompt, envProbe: args.envProbe, logger: log, timeoutMs: args.timeoutMs,
    });
    assistantText = choice.result.assistantText;
  } catch (err) {
    log.warn(`proposalPass: analysis failed — ${err instanceof Error ? err.message : String(err)}`);
    return { written: 0, skipped: 0, skippedReason: 'analysis-failed' };
  }

  const parsed = parseProposalOutput(assistantText);
  if (!parsed.ok) {
    log.warn(`proposalPass: parse failed — ${parsed.error}`);
    return { written: 0, skipped: 0, skippedReason: 'parse-failed' };
  }

  const { written, skipped } = await writeProposals(args.globalDir, args.profileId, parsed.proposals, {
    existingDocTitles: existingIndex,
  });

  // 성공(분석+파싱 완료) 시에만 커서 전진 — 실패 시 재처리되도록.
  if (collected.newCursor) await writeProposalCursor(args.workspaceRoot, collected.newCursor);
  log.log(`proposalPass: wrote ${written.length}, skipped ${skipped.length}, cursor → ${collected.newCursor}`);
  return { written: written.length, skipped: skipped.length };
}

// 워크스페이스당 분석 패스 1개만 동시 실행(중복 헤드리스 spawn 방지). 프로세스별 상태 —
// 데스크탑(메인)·익스텐션(확장 호스트)은 별도 프로세스라 각자 자기 Set을 갖는다(기존 동작 유지).
const inFlight = new Set<string>();

export type RunProposalTriggerArgs = {
  workspaceId: string;
  workspaceRoot: string;
  globalDir: string;
  profileId: string;
  activeModel: CliKind;
  refineConfig: RefinePolicyConfig;
  envProbe: EnvProbe;
  logger?: Logger;
  timeoutMs?: number;
  everyN: number;
  // 제안 목록이 갱신됐을 때 호스트가 UI에 통지(데스크탑 broadcast / 익스텐션 notify).
  onUpdated: () => void;
  // 테스트/대체 구현용 — runProposalPass로 그대로 전달.
  runAnalysis?: RunProposalPassArgs['runAnalysis'];
};

// 매 compaction(ir:updated) 후 호스트가 부르는 단일 진입점(§D.1·§G5) — 데스크탑/익스텐션 공용.
// 카운터 증가는 in-flight 가드 *밖*에서 — 분석이 도는 동안 들어온 compaction도 빠짐없이 센다
// (everyN 주기 드리프트 방지). 비싼 헤드리스 분석만 워크스페이스당 1개로 직렬화.
// fire-and-forget: 절대 throw하지 않는다(호출자의 compaction 흐름을 막지 않음).
export async function runProposalTrigger(args: RunProposalTriggerArgs): Promise<void> {
  const log = args.logger ?? noopLogger;
  try {
    await bumpCompactionCount(args.workspaceRoot);
    if (!(await shouldRunProposalPass(args.workspaceRoot, args.everyN))) return;
    if (inFlight.has(args.workspaceId)) return;
    inFlight.add(args.workspaceId);
    try {
      const decision = resolveRefineDecisionFromConfig(args.refineConfig, args.activeModel);
      await runProposalPass({
        workspaceRoot: args.workspaceRoot,
        globalDir: args.globalDir,
        profileId: args.profileId,
        decision,
        envProbe: args.envProbe,
        logger: args.logger,
        timeoutMs: args.timeoutMs,
        runAnalysis: args.runAnalysis,
      });
      args.onUpdated();
    } finally {
      inFlight.delete(args.workspaceId);
    }
  } catch (err) {
    log.warn(`proposalTrigger: ${err instanceof Error ? err.message : String(err)}`);
  }
}
