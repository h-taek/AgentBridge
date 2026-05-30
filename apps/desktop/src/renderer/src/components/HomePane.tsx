import { useState } from 'react'
import type { CliKind, EnvProbeResult } from '@shared/ipc'
import { ArrowUpIcon } from './icons'
import claudeLogo from '../assets/logos/claude.png'
import codexLogo from '../assets/logos/codex.png'
import agyLogo from '../assets/logos/agy.png'

// 홈 화면 — 워크스페이스 미선택 상태에서 본문에 표시.
// 입력 + 모델 선택 → 기본 경로 하위에 워크스페이스 자동 생성 + 세션 spawn + 첫 메시지 submit.
//
// 디자인 톤: 가운데 큰 입력창 + 아래 모델 카드 셀렉터.
// 제출 시 App.tsx의 handleHomeSubmit이 home:submit IPC를 호출.

type Props = {
  env: EnvProbeResult | null
  busy: boolean
  onSubmit: (model: CliKind, message: string) => Promise<void>
}

const MODEL_META: Record<CliKind, { label: string; logo: string; desc: string }> = {
  claude: { label: 'Claude', logo: claudeLogo, desc: 'Anthropic' },
  codex: { label: 'Codex', logo: codexLogo, desc: 'OpenAI' },
  agy: { label: 'Antigravity', logo: agyLogo, desc: 'Google' }
}

export function HomePane({ env, busy, onSubmit }: Props): React.JSX.Element {
  const [model, setModel] = useState<CliKind>('claude')
  const [message, setMessage] = useState('')

  const isAvailable = (k: CliKind): boolean => env?.clis.find((c) => c.kind === k)?.found === true

  const canSubmit = message.trim().length > 0 && isAvailable(model) && !busy

  const submit = (): void => {
    if (!canSubmit) return
    const text = message
    setMessage('')
    void onSubmit(model, text)
  }

  return (
    <div className="home-pane">
      <div className="home-pane-inner">
        <div className="home-header">
          <h1 className="home-title">AgentBridge</h1>
          <p className="home-subtitle">
            메시지를 입력하고 모델을 선택해 새 워크스페이스를 시작하세요.
          </p>
        </div>

        <div className="home-input-wrap">
          <textarea
            className="home-input"
            placeholder="무엇을 도와드릴까요?"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              // 한글 IME composition 중에는 Enter가 변환 확정 키 — submit 안 함.
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={4}
            disabled={busy}
          />
          <div className="home-input-foot">
            <span className="hint">Enter로 시작</span>
            <button
              className="home-submit"
              onClick={submit}
              disabled={!canSubmit}
              title={canSubmit ? '시작' : '메시지와 사용 가능한 모델을 선택하세요'}
              aria-label="시작"
            >
              <ArrowUpIcon />
            </button>
          </div>
        </div>

        <div className="home-models" role="radiogroup" aria-label="모델 선택">
          {(['claude', 'codex', 'agy'] as CliKind[]).map((k) => {
            const meta = MODEL_META[k]
            const available = isAvailable(k)
            const selected = model === k
            return (
              <button
                key={k}
                className={`home-model${selected ? ' selected' : ''}${available ? '' : ' unavailable'}`}
                role="radio"
                aria-checked={selected}
                onClick={() => available && setModel(k)}
                disabled={!available || busy}
                title={available ? meta.desc : `${meta.label} CLI가 PATH에 없음`}
              >
                <img src={meta.logo} alt="" className="home-model-logo" />
                <div className="home-model-meta">
                  <div className="home-model-name">{meta.label}</div>
                  <div className="home-model-desc">{available ? meta.desc : '미설치'}</div>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
