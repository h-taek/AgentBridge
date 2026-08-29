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
import { readProfileDocs, ensureProfile } from './globalStore';

export type RunProposalPassArgs = {
  workspaceRoot: string;
  globalDir: string;
  // 사용자 프로필(global/profiles/default). scope=user인 제안이 여기로 간다.
  profileId: string;
  // 프로젝트 지식 폴더 이름(global/projects/ 아래, git remote로 정해짐). 없으면 scope=project인
  // 제안은 버린다 — remote 없는 저장소는 프로젝트 지식 없이 0.5.0 이전과 같이 돌아간다.
  projectProfileId?: string | null;
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

  // 중복방지용 기존 인덱스 — 두 프로필을 합쳐 넣는다. 갈라 넣으면 이미 프로젝트 쪽에 있는 사실을
  // 사용자 쪽에 다시 제안하는(그 반대도) 중복이 생긴다.
  const userDocs = await readProfileDocs(args.globalDir, args.profileId).catch(() => []);
  const projectDocs = args.projectProfileId
    ? await readProfileDocs(args.globalDir, args.projectProfileId, 'project').catch(() => [])
    : [];
  const existingIndex = [...userDocs, ...projectDocs].map((d) => ({
    category: d.category,
    title: d.title,
  }));

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

  // scope로 갈라 각 프로필에 쓴다. 중복 판정은 합본 인덱스로 하되 저장은 제 자리로 간다.
  const forUser = parsed.proposals.filter((p) => p.scope !== 'project');
  const forProject = args.projectProfileId
    ? parsed.proposals.filter((p) => p.scope === 'project')
    : [];
  const droppedProject = parsed.proposals.length - forUser.length - forProject.length;

  let written = 0;
  let skipped = 0;
  if (forUser.length) {
    const r = await writeProposals(args.globalDir, args.profileId, forUser, {
      existingDocTitles: existingIndex,
    });
    written += r.written.length;
    skipped += r.skipped.length;
  }
  if (forProject.length && args.projectProfileId) {
    // 프로젝트 지식 폴더는 첫 제안이 나올 때 만들어진다 — remote 없는 저장소에 빈 폴더를 남기지 않는다.
    await ensureProfile(args.globalDir, args.projectProfileId, 'project');
    const r = await writeProposals(
      args.globalDir,
      args.projectProfileId,
      forProject,
      { existingDocTitles: existingIndex },
      'project',
    );
    written += r.written.length;
    skipped += r.skipped.length;
  }

  // 성공(분석+파싱 완료) 시에만 커서 전진 — 실패 시 재처리되도록.
  if (collected.newCursor) await writeProposalCursor(args.workspaceRoot, collected.newCursor);
  const droppedNote = droppedProject > 0 ? `, dropped ${droppedProject} project-scoped (no git remote)` : '';
  log.log(`proposalPass: wrote ${written}, skipped ${skipped}${droppedNote}, cursor → ${collected.newCursor}`);
  return { written, skipped };
}

// 워크스페이스당 분석 패스 1개만 동시 실행(중복 헤드리스 spawn 방지). 프로세스별 상태 —
// 데스크탑(메인)·익스텐션(확장 호스트)은 별도 프로세스라 각자 자기 Set을 갖는다(기존 동작 유지).
const inFlight = new Set<string>();

export type RunProposalTriggerArgs = {
  workspaceId: string;
  workspaceRoot: string;
  globalDir: string;
  profileId: string;
  projectProfileId?: string | null;
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
        projectProfileId: args.projectProfileId,
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
