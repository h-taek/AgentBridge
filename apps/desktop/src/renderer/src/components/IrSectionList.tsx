import type { IR, IrFileStatus, IrTestStatus } from '@shared/ir'

// IR 6 섹션 stacked render. 현재 IR + archive 스냅샷 양쪽에서 사용.
// 본 컴포넌트는 컨테이너/모달 측에서 헤더·테두리를 가지므로 여기선 섹션 그 자체만 그린다.

const FILE_STATUS_BADGE: Record<IrFileStatus, { label: string; cls: string }> = {
  created: { label: 'A', cls: 'mem-badge-add' },
  modified: { label: 'M', cls: 'mem-badge-mod' },
  deleted: { label: 'D', cls: 'mem-badge-del' },
  read: { label: 'R', cls: 'mem-badge-read' }
}

const TEST_STATUS_BADGE: Record<IrTestStatus, { label: string; cls: string }> = {
  passed: { label: '통과', cls: 'mem-badge-pass' },
  failed: { label: '실패', cls: 'mem-badge-fail' },
  pending: { label: '대기', cls: 'mem-badge-pend' },
  skipped: { label: '스킵', cls: 'mem-badge-skip' }
}

type Props = {
  ir: IR
}

export function IrSectionList({ ir }: Props): React.JSX.Element {
  return (
    <div className="mem-sections">
      <MemSection title="목표" count={ir.intent.goal ? 1 : 0}>
        {ir.intent.goal ? (
          <div className="mem-intent">
            <div className="mem-intent-goal">{ir.intent.goal}</div>
            {ir.intent.role && <div className="mem-intent-sub">역할 · {ir.intent.role}</div>}
            {ir.intent.constraints && ir.intent.constraints.length > 0 && (
              <ul className="mem-list-plain">
                {ir.intent.constraints.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <EmptyRow />
        )}
      </MemSection>

      <MemSection title="결정" count={ir.decisions.length}>
        {ir.decisions.length > 0 ? (
          <ul className="mem-list">
            {ir.decisions.map((d) => (
              <li key={`${d.topic}::${d.choice}`} className="mem-row">
                <div className="mem-row-main">
                  <div className="mem-row-title">{d.topic}</div>
                  <div className="mem-row-sub">{d.choice}</div>
                  {d.rationale && <div className="mem-row-note">{d.rationale}</div>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyRow />
        )}
      </MemSection>

      <MemSection title="파일" count={ir.files.length}>
        {ir.files.length > 0 ? (
          <ul className="mem-list">
            {ir.files.map((f) => {
              const badge = FILE_STATUS_BADGE[f.status]
              return (
                <li key={f.path} className="mem-row">
                  <span className={`mem-badge ${badge.cls}`} title={f.status}>
                    {badge.label}
                  </span>
                  <div className="mem-row-main">
                    <div className="mem-row-title mono">{f.path}</div>
                    {f.summary && <div className="mem-row-note">{f.summary}</div>}
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <EmptyRow />
        )}
      </MemSection>

      <MemSection title="명령" count={ir.commands.length}>
        {ir.commands.length > 0 ? (
          <ul className="mem-list">
            {ir.commands.map((c) => {
              const exit = c.exitCode
              const exitCls =
                exit === undefined
                  ? 'mem-badge-skip'
                  : exit === 0
                    ? 'mem-badge-pass'
                    : 'mem-badge-fail'
              return (
                <li
                  key={`${c.cmd}::${exit ?? '-'}::${c.summary ?? ''}::${c.fullOutputRef ?? ''}`}
                  className="mem-row"
                >
                  <span className={`mem-badge ${exitCls}`} title={`exit ${exit ?? '-'}`}>
                    {exit === undefined ? '−' : String(exit)}
                  </span>
                  <div className="mem-row-main">
                    <div className="mem-row-title mono">{c.cmd}</div>
                    {c.summary && <div className="mem-row-note">{c.summary}</div>}
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <EmptyRow />
        )}
      </MemSection>

      <MemSection title="테스트" count={ir.tests.length}>
        {ir.tests.length > 0 ? (
          <ul className="mem-list">
            {ir.tests.map((t) => {
              const badge = TEST_STATUS_BADGE[t.status]
              return (
                <li key={`${t.name}::${t.status}`} className="mem-row">
                  <span className={`mem-badge ${badge.cls}`} title={t.status}>
                    {badge.label}
                  </span>
                  <div className="mem-row-main">
                    <div className="mem-row-title">{t.name}</div>
                    {t.failureSummary && <div className="mem-row-note">{t.failureSummary}</div>}
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <EmptyRow />
        )}
      </MemSection>

      <MemSection title="할 일" count={ir.pending.length}>
        {ir.pending.length > 0 ? (
          <ul className="mem-list">
            {ir.pending.map((p) => (
              <li key={p.task} className="mem-row">
                <div className="mem-row-main">
                  <div className="mem-row-title">{p.task}</div>
                  {p.nextStep && <div className="mem-row-sub">다음 · {p.nextStep}</div>}
                  {p.blockers && p.blockers.length > 0 && (
                    <div className="mem-row-note">막힘 · {p.blockers.join(' / ')}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyRow />
        )}
      </MemSection>
    </div>
  )
}

function MemSection({
  title,
  count,
  children
}: {
  title: string
  count: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mem-section">
      <div className="mem-section-head">
        <span className="mem-section-title">{title}</span>
        <span className={`mem-section-count${count === 0 ? ' empty' : ''}`}>{count}</span>
      </div>
      <div className="mem-section-body">{children}</div>
    </div>
  )
}

function EmptyRow(): React.JSX.Element {
  return <div className="mem-empty">(없음)</div>
}
