import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import {
  parseClaudeModels,
  parseCodexModels,
  parseAgyModels,
  buildModelTable,
  renderModelTable,
  validateModelSelections,
  HOST_AGENT_MODELS,
  type CliKind,
  type EnvProbe,
  type HarnessRunner,
  type HarnessTable,
} from '@agentbridge/core';
import { createHarnessRunner, createModelsHandler, type SpawnFn } from '../src/core/modelLookup';

// research/06 §5-1 실측 기반 claude control_response 픽스처
const CLAUDE_FIXTURE = {
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'req-1',
    response: {
      models: [
        {
          value: 'default',
          displayName: 'Default',
          resolvedModel: 'claude-opus-5-5',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        {
          value: 'opus',
          displayName: 'Opus',
          resolvedModel: 'claude-opus-5-5',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        {
          value: 'sonnet',
          displayName: 'Sonnet',
          resolvedModel: 'claude-sonnet-5-5',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        {
          value: 'haiku',
          displayName: 'Haiku',
          resolvedModel: 'claude-haiku-5-5',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        {
          value: 'claude-opus-4-6',
          displayName: 'Opus 4.6',
          resolvedModel: 'claude-opus-4-6',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'max'],
        },
        {
          value: 'claude-haiku-4-5-20251001',
          displayName: 'Haiku 4.5',
          resolvedModel: 'claude-haiku-4-5-20251001',
          supportsEffort: false,
        },
      ],
    },
  },
};

// research/06 §5-2 실측 기반 codex app-server model/list 쪽 픽스처
const CODEX_PAGES_FIXTURE = [
  {
    id: 2,
    result: {
      data: [
        {
          model: 'gpt-6.1-sol',
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'medium' },
            { reasoningEffort: 'high' },
            { reasoningEffort: 'xhigh' },
            { reasoningEffort: 'max' },
            { reasoningEffort: 'ultra' },
          ],
        },
        {
          model: 'gpt-6-luna',
          hidden: false,
          isDefault: false,
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'medium' },
            { reasoningEffort: 'high' },
            { reasoningEffort: 'xhigh' },
            { reasoningEffort: 'max' },
          ],
        },
      ],
      nextCursor: 'page-2',
    },
  },
  {
    id: 3,
    result: {
      data: [
        {
          model: 'gpt-5-nano',
          hidden: false,
          isDefault: false,
          supportedReasoningEfforts: [],
        },
      ],
      nextCursor: null,
    },
  },
];

// research/06 §3·§4 실측 기반 agy models stdout 픽스처
const AGY_STDOUT_FIXTURE = [
  'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
  'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
  'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
  'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-pro-orchestrator-g1-pro\tGemini Pro Orchestrator',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n');

describe('modelTable — 파서·조합·렌더 (0.8.0 §1·§2)', () => {
  it('parseClaudeModels — default 행을 빼고 supportsEffort가 거짓이면 빈 effort를 낸다', () => {
    const rows = parseClaudeModels(CLAUDE_FIXTURE);
    assert.equal(rows.some((r) => r.name === 'default'), false);
    assert.deepEqual(rows[0], {
      name: 'opus',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    assert.deepEqual(rows.find((r) => r.name === 'claude-opus-4-6'), {
      name: 'claude-opus-4-6',
      efforts: ['low', 'medium', 'high', 'max'],
    });
    assert.deepEqual(rows.find((r) => r.name === 'claude-haiku-4-5-20251001'), {
      name: 'claude-haiku-4-5-20251001',
      efforts: [],
    });
  });

  it('parseClaudeModels — 오류 응답이나 다른 형식은 예외를 던진다', () => {
    assert.throws(
      () =>
        parseClaudeModels({
          type: 'control_response',
          response: { subtype: 'error', error: 'unsupported' },
        }),
      /unsupported/,
    );
    assert.throws(() => parseClaudeModels({ wrong: true }), /형식이 다르다/);
  });

  it('parseCodexModels — nextCursor로 나뉜 쪽을 이어 model과 reasoningEffort를 모은다', () => {
    const rows = parseCodexModels(CODEX_PAGES_FIXTURE);
    assert.deepEqual(rows, [
      { name: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { name: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { name: 'gpt-5-nano', efforts: [] },
    ]);
  });

  it('parseAgyModels — 허용된 effort 꼬리만 묶고 꼬리 없는 id는 effort 없음으로 둔다', () => {
    const rows = parseAgyModels(
      [
        AGY_STDOUT_FIXTURE,
        'experimental-a-minimal\tExp A Minimal',
        'experimental-a-max\tExp A Max',
        'experimental-a-ultra\tExp A Ultra',
      ].join('\n'),
    );
    assert.deepEqual(rows, [
      { name: 'gemini-4-hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { name: 'gemini-3.8-flash', efforts: ['low', 'medium', 'high'] },
      { name: 'gemini-pro-orchestrator-g1-pro', efforts: [] },
      { name: 'gpt-oss-120b', efforts: ['medium'] },
      { name: 'experimental-a', efforts: ['minimal', 'max', 'ultra'] },
    ]);
  });

  it('parseAgyModels — effort 꼬리가 섞여 나와도 낮은 순으로 맞춘다', () => {
    const rows = parseAgyModels(
      ['gemini-4-argon-high\tA', 'gemini-4-argon-low\tA', 'gemini-4-argon-medium\tA'].join('\n'),
    );
    assert.deepEqual(rows, [{ name: 'gemini-4-argon', efforts: ['low', 'medium', 'high'] }]);
  });

  it('parseAgyModels — 탭 구분이 없는 낯선 출력은 형식 오류로 던진다', () => {
    assert.throws(() => parseAgyModels('not logged in\nplease login'), /형식이 다르다/);
  });

  it('buildModelTable — 셋을 동시에 돌리고 한 하니스가 실패·시한 초과여도 나머지를 낸다', async () => {
    const started: CliKind[] = [];
    let agyAborted = false;

    const run: HarnessRunner = async (harness, signal) => {
      started.push(harness);
      if (harness === 'claude') return CLAUDE_FIXTURE;
      if (harness === 'codex') throw new Error('codex 실행 실패');
      // agy는 시한 초과까지 대기
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          agyAborted = true;
          reject(new Error('aborted'));
        });
      });
    };

    const tables = await buildModelTable(['claude', 'codex', 'agy'], run, { timeoutMs: 40 });
    assert.deepEqual(started, ['claude', 'codex', 'agy']);
    assert.equal(agyAborted, true);

    assert.equal(tables[0]!.harness, 'claude');
    assert.ok('rows' in tables[0]!);
    assert.deepEqual(tables[1], { harness: 'codex', error: 'codex 실행 실패' });
    assert.equal(tables[2]!.harness, 'agy');
    assert.ok('error' in tables[2]! && /시간 초과/.test(tables[2]!.error));
  });

  it('buildModelTable — 빈 목록이면 그 하니스만 오류로 처리한다', async () => {
    const tables = await buildModelTable(['claude', 'agy'], async (h) => {
      if (h === 'claude') return CLAUDE_FIXTURE;
      return '';
    });
    assert.ok('rows' in tables[0]!);
    assert.deepEqual(tables[1], { harness: 'agy', error: '모델 목록이 비어 있다' });
  });

  it('renderModelTable — spec §2 모양과 조회 실패 문구를 그린다', () => {
    const text = renderModelTable([
      {
        harness: 'claude',
        rows: [
          { name: 'opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
          { name: 'claude-haiku-4-5-20251001', efforts: [] },
        ],
      },
      { harness: 'agy', error: '15초 시간 초과' },
    ]);

    assert.equal(
      text,
      [
        '## claude',
        '',
        '  opus                       low medium high xhigh max',
        '  claude-haiku-4-5-20251001  (effort 없음)',
        '',
        '## agy',
        '',
        '  조회 실패 (15초 시간 초과)',
      ].join('\n'),
    );
  });

  it('validateModelSelections — 표와 일치하면 빈 배열을 내고 어긋난 항목은 모두 모은다', () => {
    const tables: HarnessTable[] = [
      { harness: 'claude', rows: parseClaudeModels(CLAUDE_FIXTURE) },
      { harness: 'codex', rows: parseCodexModels(CODEX_PAGES_FIXTURE) },
      { harness: 'agy', rows: parseAgyModels(AGY_STDOUT_FIXTURE) },
    ];

    assert.deepEqual(
      validateModelSelections(
        { claude: 'opus', agy: 'gemini-pro-orchestrator-g1-pro' },
        { claude: 'high' },
        tables,
      ),
      [],
    );

    assert.deepEqual(
      validateModelSelections({ claude: 'opus' }, {}, tables),
      ['claude의 opus에 --effort가 없다. 받는 값: low medium high xhigh max'],
    );

    assert.deepEqual(
      validateModelSelections({}, { claude: 'high' }, tables),
      ['claude에 --effort만 있다. --model과 함께 쓴다'],
    );

    assert.deepEqual(
      validateModelSelections(
        { claude: 'claude-haiku-4-5-20251001' },
        { claude: 'low' },
        tables,
      ),
      ['claude의 claude-haiku-4-5-20251001은 effort를 받지 않는다'],
    );

    assert.deepEqual(
      validateModelSelections({ agy: 'gemini-4-hydrogen' }, { agy: 'max' }, tables),
      [
        'agy의 gemini-4-hydrogen은 --effort max를 받지 않는다. 받는 값: low medium high xhigh. 전체는 agent models로 본다',
      ],
    );

    assert.deepEqual(
      validateModelSelections({ agy: 'gemini-4-hydrogen-high' }, { agy: 'high' }, tables),
      [
        'agy에 gemini-4-hydrogen-high 모델이 없다. 받는 모델: gemini-4-hydrogen, gemini-3.8-flash, gemini-pro-orchestrator-g1-pro, gpt-oss-120b. 전체는 agent models로 본다',
      ],
    );

    const withError: HarnessTable[] = [
      tables[0]!,
      { harness: 'codex', error: '15초 시간 초과' },
    ];
    assert.deepEqual(
      validateModelSelections(
        { claude: 'missing-model', codex: 'gpt-6-luna' },
        { claude: 'high', codex: 'high' },
        withError,
      ),
      [
        'claude에 missing-model 모델이 없다. 받는 모델: opus, sonnet, haiku, claude-opus-4-6, claude-haiku-4-5-20251001. 전체는 agent models로 본다',
        'codex의 모델 목록을 받지 못해 검사할 수 없다 (15초 시간 초과)',
      ],
    );
  });
});

// ─── modelLookup 실행기 + 처리기 (가짜 spawn / 가짜 runner) ──────────────────

function makeFakeChild() {
  const child = new EventEmitter() as ChildProcess & EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kills: string[];
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = ((sig?: NodeJS.Signals | number) => {
    child.kills.push(String(sig ?? 'SIGTERM'));
    return true;
  }) as ChildProcess['kill'];
  return child;
}

describe('modelLookup — 가짜 실행기와 호스트 처리기', () => {
  const fakeEnvProbe = (resolved: Partial<Record<CliKind, string>>): EnvProbe => ({
    probe(cli) {
      const p = resolved[cli];
      return p ? { found: true, path: cli, resolvedPath: p } : { found: false };
    },
    getShellEnv() {
      return { PATH: '/usr/bin', TERM: 'xterm-256color' };
    },
  });

  it('createHarnessRunner — claude control_request/response와 프로세스 종료를 수행한다', async () => {
    let spawnedCmd = '';
    let spawnedArgs: string[] = [];
    let killed = false;

    const fakeSpawn = ((cmd: string, args: string[]) => {
      spawnedCmd = cmd;
      spawnedArgs = args;
      const child = makeFakeChild();
      child.kill = (() => {
        killed = true;
        return true;
      }) as ChildProcess['kill'];
      let buf = '';
      child.stdin.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl));
        // 다른 줄과 다른 request_id가 먼저 와도 무시하고 같은 request_id만 받아야 한다.
        child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
        child.stdout.write(
          JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: 'other-id', response: { models: [] } },
          }) + '\n',
        );
        child.stdout.write(
          JSON.stringify({
            ...CLAUDE_FIXTURE,
            response: { ...CLAUDE_FIXTURE.response, request_id: req.request_id },
          }) + '\n',
        );
      });
      return child;
    }) as unknown as SpawnFn;

    const runner = createHarnessRunner({
      envProbe: fakeEnvProbe({ claude: '/opt/bin/claude' }),
      spawn: fakeSpawn,
    });
    const raw = await runner('claude', new AbortController().signal);
    assert.equal(spawnedCmd, '/opt/bin/claude');
    assert.deepEqual(spawnedArgs, [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    assert.equal(killed, true);
    assert.equal(parseClaudeModels(raw).length, 5);
  });

  it('createHarnessRunner — codex initialize → initialized → model/list nextCursor를 따른다', async () => {
    const receivedMethods: string[] = [];
    let stdinEnded = false;

    const fakeSpawn = ((_cmd: string, args: string[]) => {
      assert.deepEqual(args, ['app-server']);
      const child = makeFakeChild();
      let buf = '';
      child.stdin.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) {
          if (!l.trim()) continue;
          const msg = JSON.parse(l);
          receivedMethods.push(msg.method);
          if (msg.method === 'initialize') {
            child.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\n');
          } else if (msg.method === 'model/list') {
            const page = msg.params?.cursor ? CODEX_PAGES_FIXTURE[1]! : CODEX_PAGES_FIXTURE[0]!;
            child.stdout.write(JSON.stringify({ id: msg.id, result: page.result }) + '\n');
          }
        }
      });
      child.stdin.on('end', () => {
        stdinEnded = true;
        child.emit('close', 0);
      });
      return child;
    }) as unknown as SpawnFn;

    const runner = createHarnessRunner({
      envProbe: fakeEnvProbe({ codex: '/opt/bin/codex' }),
      spawn: fakeSpawn,
    });
    const pages = (await runner('codex', new AbortController().signal)) as unknown[];
    assert.deepEqual(receivedMethods, ['initialize', 'initialized', 'model/list', 'model/list']);
    assert.equal(stdinEnded, true);
    assert.equal(parseCodexModels(pages).length, 3);
  });

  it('createHarnessRunner — agy models stdout을 반환하고 0이 아닌 종료는 실패한다', async () => {
    let failMode = false;
    const fakeSpawn = ((_cmd: string, args: string[]) => {
      assert.deepEqual(args, ['models']);
      const child = makeFakeChild();
      process.nextTick(() => {
        if (failMode) {
          child.stderr.write('agy error\n');
          child.emit('close', 1);
        } else {
          child.stdout.write(AGY_STDOUT_FIXTURE + '\n');
          child.emit('close', 0);
        }
      });
      return child;
    }) as unknown as SpawnFn;

    const runner = createHarnessRunner({
      envProbe: fakeEnvProbe({ agy: '/opt/bin/agy' }),
      spawn: fakeSpawn,
    });
    const out = await runner('agy', new AbortController().signal);
    assert.equal(parseAgyModels(out as string).length, 4);

    failMode = true;
    await assert.rejects(() => runner('agy', new AbortController().signal), /agy error/);
  });

  it('createModelsHandler — 기본 세 하니스를 돌리고 알 수 없는 하니스는 거절한다', async () => {
    const seen: CliKind[] = [];
    const handler = createModelsHandler({
      run: async (h) => {
        seen.push(h);
        if (h === 'claude') return CLAUDE_FIXTURE;
        if (h === 'codex') return CODEX_PAGES_FIXTURE;
        return AGY_STDOUT_FIXTURE;
      },
    });

    const out = await handler({ id: '1', kind: HOST_AGENT_MODELS, at: 0, payload: {} });
    assert.deepEqual(seen, ['claude', 'codex', 'agy']);
    assert.match(out, /^## claude/m);
    assert.match(out, /^## codex/m);
    assert.match(out, /^## agy/m);
    assert.match(out, /gemini-pro-orchestrator-g1-pro\s+\(effort 없음\)/);

    await assert.rejects(
      () => handler({ id: '2', kind: HOST_AGENT_MODELS, at: 0, payload: { harnesses: ['nope'] } }),
      /모르는 하니스/,
    );
  });
});
