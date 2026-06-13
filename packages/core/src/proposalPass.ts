// 자동제안 종단 오케스트레이터(§D.1). compaction 후 앱이 호출.
// runAnalysis 주입 가능 — 기본 = runProposalAnalysis(실제 spawn). 테스트는 가짜 출력 주입.
import type { EnvProbe } from './envProbe';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';
import { runProposalAnalysis, type RefineDecision, type RefineModelChoice } from './refineDispatcher';
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

// 매 compaction 후 앱이 호출하는 게이트 — 카운터는 매번 증가, 분석 패스는 everyN의 배수에서만.
// (분석은 헤드리스 spawn이라 비용 큼 → 빈도를 카운터로 제어.)
export async function maybeRunProposalPass(
  args: RunProposalPassArgs & { everyN: number },
): Promise<ProposalPassResult & { ran: boolean }> {
  await bumpCompactionCount(args.workspaceRoot);
  if (!(await shouldRunProposalPass(args.workspaceRoot, args.everyN))) {
    return { written: 0, skipped: 0, ran: false };
  }
  const res = await runProposalPass(args);
  return { ...res, ran: true };
}
