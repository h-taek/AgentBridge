// IR을 사람이 읽는 여섯 절로 렌더한다 (0.5.0 3단계 W1).
//
// 이 렌더는 원래 훅 헬퍼 안에 있었다. 3단계에서 맥락이 pull로 바뀌면서 같은 텍스트를 CLI의
// `context`가 내야 하므로 코어로 옮긴다. 헬퍼는 W8에서 주입을 걷을 때 이 자리를 잃는다.
//
// 값은 사람이 읽는 텍스트다. 소비자가 모델이라 그대로 맥락에 들어가는 편이 낫다(B-5).

import type { IR } from '../shared/ir';

function fmtList(items: unknown, indent = ''): string {
  if (!Array.isArray(items) || items.length === 0) return `${indent}(none)`;
  return items.map((s) => `${indent}- ${String(s)}`).join('\n');
}

export function renderIntent(ir: IR | null): string {
  const intent = ir?.intent ?? ({} as NonNullable<IR['intent']>);
  const lines = [`goal: ${intent.goal || '(unset)'}`];
  if (intent.role) lines.push(`role: ${intent.role}`);
  if (Array.isArray(intent.constraints) && intent.constraints.length > 0) {
    lines.push('constraints:');
    lines.push(fmtList(intent.constraints, '  '));
  }
  return lines.join('\n');
}

export function renderDecisions(ir: IR | null): string {
  const ds = ir?.decisions ?? [];
  if (ds.length === 0) return '(no decisions)';
  return ds
    .slice(-10)
    .map((d) => {
      const head = d.topic ? `${d.topic} → ${d.choice}` : d.choice;
      const lines = [`- ${head}`];
      if (d.rationale) lines.push(`  rationale: ${d.rationale}`);
      return lines.join('\n');
    })
    .join('\n');
}

export function renderFiles(ir: IR | null): string {
  const files = ir?.files ?? [];
  if (files.length === 0) return '(no file changes)';
  return files
    .slice(-15)
    .map((f) => `- [${f.status}] ${f.path}${f.summary ? ` — ${f.summary}` : ''}`)
    .join('\n');
}

export function renderCommands(ir: IR | null): string {
  const cs = ir?.commands ?? [];
  if (cs.length === 0) return '(no commands run)';
  return cs
    .slice(-10)
    .map((c) => {
      const ec = c.exitCode != null ? ` (exit ${c.exitCode})` : '';
      return `- \`${c.cmd}\`${ec}${c.summary ? ` — ${c.summary}` : ''}`;
    })
    .join('\n');
}

export function renderTests(ir: IR | null): string {
  const ts = ir?.tests ?? [];
  if (ts.length === 0) return '(no test results)';
  return ts
    .slice(-5)
    .map((t) => `- [${t.status}] ${t.name}${t.failureSummary ? ` — ${t.failureSummary}` : ''}`)
    .join('\n');
}

export function renderPending(ir: IR | null): string {
  const ps = ir?.pending ?? [];
  if (ps.length === 0) return '(no pending items)';
  return ps
    .slice(-5)
    .map((p) => {
      const lines = [`- ${p.task}`];
      if (Array.isArray(p.blockers) && p.blockers.length > 0) {
        lines.push(`  blockers: ${p.blockers.join(', ')}`);
      }
      if (p.nextStep) lines.push(`  next: ${p.nextStep}`);
      return lines.join('\n');
    })
    .join('\n');
}

// 여섯 절을 한 덩어리로. 절 제목은 소비자가 붙이지 않고 여기서 고정한다 — 헬퍼와 CLI가
// 같은 모양을 내야 사용자가 두 자리에서 같은 것을 본다.
export function renderIrSections(ir: IR | null): string {
  return [
    '### Intent',
    renderIntent(ir),
    '',
    '### Decisions',
    renderDecisions(ir),
    '',
    '### Files',
    renderFiles(ir),
    '',
    '### Commands',
    renderCommands(ir),
    '',
    '### Tests',
    renderTests(ir),
    '',
    '### Pending',
    renderPending(ir),
  ].join('\n');
}
