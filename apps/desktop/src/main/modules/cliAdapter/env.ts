// CLIAdapter 공용 spawn env 빌더.
//
// 정책 (architecture §7.4):
// - 사용자 shell env 상속 (process.env)
// - PATH는 EnvProbe가 캡처한 사용자 shell PATH로 덮어쓴다 (Electron GUI launch 시 PATH 빈약 문제 우회)
// - PTY 표시용 TERM/COLORTERM 명시
// - keep-out 키: AgentBridge가 *추가하지 않는다*. 이미 사용자 shell에 export돼 있으면 그대로 통과.
//   - OPENAI_API_KEY: Codex의 ChatGPT 구독을 silently 무시하므로
//   - GEMINI_SYSTEM_MD: Gemini의 system prompt를 full replacement로 덮어써 기본 동작을 차단하므로

export const ADAPTER_ENV_KEEP_OUT: ReadonlyArray<string> = ['OPENAI_API_KEY', 'GEMINI_SYSTEM_MD']

export type AdapterEnvOptions = {
  shellPath: string
  // 어댑터가 명시 추가하려는 키. keep-out 리스트에 들면 무시한다.
  extra?: Record<string, string>
}

export function buildAdapterEnv(opts: AdapterEnvOptions): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') base[k] = v
  }
  base.PATH = opts.shellPath
  base.TERM = 'xterm-256color'
  base.COLORTERM = 'truecolor'

  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      if (ADAPTER_ENV_KEEP_OUT.includes(k)) continue
      base[k] = v
    }
  }
  return base
}
