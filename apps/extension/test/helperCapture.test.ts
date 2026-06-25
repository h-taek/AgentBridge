import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';

// 번들된 헬퍼(에스빌드 self-contained CJS). Task 2의 rebundle 이후 최신.
const HELPER = join(__dirname, '..', 'resources', 'bin', 'agentbridge-memory.js');

function runHelper(args: string[], stdin: string, extraEnv: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('node', [HELPER, ...args], { env: { ...process.env, ...extraEnv } });
    p.stdout.on('data', () => {});
    p.stderr.on('data', () => {});
    p.stdin.write(stdin);
    p.stdin.end();
    p.on('close', () => resolve());
  });
}

describe('agentbridge-memory — sessions/<token>/captured.json', () => {
  let userData: string;
  const WS = 'ws-1111';
  const TOKEN = 'sess-aaaa';
  const baseArgs = (event: string, agent: string): string[] => [
    'inject', '--agent', agent, '--workspace', WS, '--user-data', userData, '--event', event,
  ];

  beforeEach(async () => {
    userData = await fs.mkdtemp(join(tmpdir(), 'agentbridge-helpercap-'));
    // 세션 디렉토리를 미리 생성 (헬퍼는 mkdir하지 않고 그대로 쓴다).
    await fs.mkdir(join(userData, 'workspaces', WS, 'sessions', TOKEN), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(userData, { recursive: true, force: true });
  });

  it('codex: stdin session_id를 sessions/<token>/captured.json에 쓴다', async () => {
    await runHelper(
      baseArgs('UserPromptSubmit', 'codex'),
      JSON.stringify({ session_id: '019e-codex', prompt: 'hi' }),
      { AGENTBRIDGE_WS_SESSION: TOKEN },
    );
    const capturedPath = join(userData, 'workspaces', WS, 'sessions', TOKEN, 'captured.json');
    const raw = await fs.readFile(capturedPath, 'utf8');
    const obj = JSON.parse(raw);
    assert.equal(obj.modelSessionId, '019e-codex');
    assert.equal(obj.agent, 'codex');
  });

  it('토큰 env가 없으면 캡처 파일을 만들지 않는다', async () => {
    await runHelper(
      baseArgs('UserPromptSubmit', 'codex'),
      JSON.stringify({ session_id: 'x', prompt: 'hi' }),
      {},
    );
    const capturedPath = join(userData, 'workspaces', WS, 'sessions', TOKEN, 'captured.json');
    assert.equal(existsSync(capturedPath), false);
  });

  it('claude는 캡처 대상이 아니다', async () => {
    await runHelper(
      baseArgs('UserPromptSubmit', 'claude'),
      JSON.stringify({ session_id: 'x', prompt: 'hi' }),
      { AGENTBRIDGE_WS_SESSION: TOKEN },
    );
    const capturedPath = join(userData, 'workspaces', WS, 'sessions', TOKEN, 'captured.json');
    assert.equal(existsSync(capturedPath), false);
  });
});
