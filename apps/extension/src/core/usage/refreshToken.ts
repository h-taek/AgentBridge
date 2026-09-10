// 401·403이 났을 때 CLI에게 제 토큰을 갱신하게 시킨다. 우리가 OAuth를 구현하지 않고,
// 리프레시 토큰을 읽지도 않는다 — CLI를 한 번 띄웠다 닫으면 저가 알아서 한다.
//
// 명령 셋은 모델 턴을 소비하지 않는 호출이어야 한다. 사용량을 보려다 사용량을 쓰면 안 된다.
// 출력은 읽지 않는다. 우리가 원하는 부수효과는 자격증명 파일·Keychain이 갱신되는 것뿐이다.

import { spawn } from 'child_process';
import type { CliKind } from '@agentbridge/core';

const SPAWN_TIMEOUT_MS = 30_000;

export interface RefreshCommand {
  file: string;
  args: string[];
  /** 넘기면 표준입력으로 써 주고 닫는다. */
  stdin?: string;
}

// codex app-server는 stdio JSON-RPC다. initialize만 보내고 곧장 닫는다.
const CODEX_INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { clientInfo: { name: 'agentbridge', version: '1' } },
});

export function refreshCommand(cli: CliKind): RefreshCommand {
  if (cli === 'claude') {
    return {
      file: 'claude',
      args: [
        '-p', '/usage',
        '--output-format', 'json',
        '--tools', '',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--mcp-config', JSON.stringify({ mcpServers: {} }),
      ],
    };
  }
  if (cli === 'codex') {
    return { file: 'codex', args: ['app-server'], stdin: CODEX_INITIALIZE + '\n' };
  }
  return { file: 'agy', args: ['--print', '/usage', '--print-timeout', '25s'] };
}

export type RefreshRunner = (cmd: RefreshCommand) => Promise<void>;

export interface TokenRefresher {
  refresh(cli: CliKind): Promise<void>;
}

/**
 * CLI당 하나만 돈다. 이미 돌고 있으면 이번 주기는 건너뛴다 — 기다리지 않는다.
 * 폴링이 5분마다 도는데 갱신이 그보다 오래 걸리면 프로세스가 쌓이기 때문이다.
 */
export function createTokenRefresher(run: RefreshRunner): TokenRefresher {
  const running = new Set<CliKind>();
  return {
    async refresh(cli) {
      if (running.has(cli)) return;
      running.add(cli);
      try {
        await run(refreshCommand(cli));
      } catch {
        // 갱신 실패는 여기서 삼킨다. 호출부는 다음 요청의 401로 판단한다.
      } finally {
        running.delete(cli);
      }
    },
  };
}

/** 실제로 프로세스를 띄우는 구현. 출력을 읽지 않고, 시간이 지나면 죽인다. */
export function systemRefreshRunner(): RefreshRunner {
  return (cmd) =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };

      const child = spawn(cmd.file, cmd.args, { stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish();
      }, SPAWN_TIMEOUT_MS);

      child.on('error', finish);
      child.on('close', finish);
      child.stdin?.on('error', () => { /* 상대가 먼저 닫으면 EPIPE */ });
      if (cmd.stdin !== undefined) child.stdin?.write(cmd.stdin);
      child.stdin?.end();
    });
}
