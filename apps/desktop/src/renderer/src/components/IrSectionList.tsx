import type { IR, IrFileStatus, IrTestStatus } from '@shared/ir'
import { useT } from '../i18n'

// IR 6 섹션 stacked render. 현재 IR + archive 스냅샷 양쪽에서 사용.
// 본 컴포넌트는 컨테이너/모달 측에서 헤더·테두리를 가지므로 여기선 섹션 그 자체만 그린다.

const FILE_STATUS_BADGE: Record<IrFileStatus, { label: string; cls: string }> = {
  created: { label: 'A', cls: 'mem-badge-add' },
  modified: { label: 'M', cls: 'mem-badge-mod' },
  deleted: { label: 'D', cls: 'mem-badge-del' },
  read: { label: 'R', cls: 'mem-badge-read' }
}

const TEST_STATUS_CLS: Record<IrTestStatus, string> = {
  passed: 'mem-badge-pass',
  failed: 'mem-badge-fail',
  pending: 'mem-badge-pend',
  skipped: 'mem-badge-skip'
}

type Props = {
  ir: IR
}

export function IrSectionList({ ir }: Props): React.JSX.Element {
  const t = useT()
  return (
    <div className="mem-sections">
      <MemSection title={t.mem.sectionGoal} count={ir.intent.goal ? 1 : 0}>
        {ir.intent.goal ? (
          <div className="mem-intent">
            <div className="mem-intent-goal">{ir.intent.goal}</div>
            {ir.intent.role && (
              <div className="mem-intent-sub">
                {t.mem.role} · {ir.intent.role}
              </div>
            )}
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

      <MemSection title={t.mem.sectionDecisions} count={ir.decisions.length}>
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

      <MemSection title={t.mem.sectionFiles} count={ir.files.length}>
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

      <MemSection title={t.mem.sectionCommands} count={ir.commands.length}>
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

      <MemSection title={t.mem.sectionTests} count={ir.tests.length}>
        {ir.tests.length > 0 ? (
          <ul className="mem-list">
            {ir.tests.map((test) => (
              <li key={`${test.name}::${test.status}`} className="mem-row">
                <span className={`mem-badge ${TEST_STATUS_CLS[test.status]}`} title={test.status}>
                  {t.mem.testStatus[test.status]}
                </span>
                <div className="mem-row-main">
                  <div className="mem-row-title">{test.name}</div>
                  {test.failureSummary && <div className="mem-row-note">{test.failureSummary}</div>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyRow />
        )}
      </MemSection>

      <MemSection title={t.mem.sectionPending} count={ir.pending.length}>
        {ir.pending.length > 0 ? (
          <ul className="mem-list">
            {ir.pending.map((p) => (
              <li key={p.task} className="mem-row">
                <div className="mem-row-main">
                  <div className="mem-row-title">{p.task}</div>
                  {p.nextStep && (
                    <div className="mem-row-sub">
                      {t.mem.next} · {p.nextStep}
                    </div>
                  )}
                  {p.blockers && p.blockers.length > 0 && (
                    <div className="mem-row-note">
                      {t.mem.blocked} · {p.blockers.join(' / ')}
                    </div>
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
  const t = useT()
  return <div className="mem-empty">{t.mem.empty}</div>
}
