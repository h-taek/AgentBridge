// localharness 프로토콜 클라이언트(TS 재구현, antigravity-sdk-python Apache-2.0 기반).
// 흐름(local_connection.py __aenter__ 정독): spawn localharness → stdin/stdout 부트스트랩
// (InputConfig 쓰기 → OutputConfig 읽기, LE4 길이접두 + protobuf binary) → ws://127.0.0.1:{port}
// (header x-goog-api-key=OutputConfig.api_key, 내부토큰) → InitializeConversationEvent(HarnessConfig) JSON 전송
// → 이후 InputEvent(JSON) 보내고 OutputEvent(JSON) 스트림 수신. WS 메시지는 proto3 JSON(camelCase).
//   사용자 Gemini 키는 HarnessConfig.models[].geminiApiEndpoint.apiKey 에 실린다.
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { InputConfig, OutputConfig } from './schema.js';

export interface HarnessStartOptions {
  apiKey: string; // 사용자 Gemini API 키
  model: string; // 에이전트 모델 (예: gemini-3.5-flash)
  cwd: string;
  binaryPath?: string; // 미지정 시 env ANTIGRAVITY_HARNESS_PATH → 'localharness'(PATH)
  storageDir?: string;
  context?: string; // 시스템 지시(IR/handoff) append
}

export interface HarnessClient {
  sendInput(text: string): void; // InputEvent{userInput}
  sendEvent(inputEvent: Record<string, unknown>): void; // 임의 InputEvent(확인/응답 등)
  onEvent(cb: (ev: Record<string, unknown>) => void): void; // 파싱된 OutputEvent(JSON)
  end(): void;
}

function resolveBinary(override?: string): string {
  return override || process.env.ANTIGRAVITY_HARNESS_PATH || 'localharness';
}

export async function startHarness(opts: HarnessStartOptions): Promise<HarnessClient> {
  const child: ChildProcess = spawn(resolveBinary(opts.binaryPath), [], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });

  // 부트스트랩: InputConfig 쓰기(LE4 길이접두 + protobuf binary)
  const ic = InputConfig.encode(
    InputConfig.create({ storage_directory: opts.storageDir ?? '', client_info: { language: 'typescript', version: '0', language_version: process.version } }),
  ).finish();
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32LE(ic.length, 0);
  child.stdin?.write(Buffer.concat([hdr, ic]));

  // OutputConfig 읽기(같은 프레이밍) → port + 내부 api_key
  const oc = await readBootstrap(child).catch((e: Error) => {
    child.kill();
    throw new Error(`localharness 부트스트랩 실패: ${e.message}. stderr: ${stderr.slice(0, 600)}`);
  });
  const port = oc.port as number;
  const internalKey = (oc.api_key ?? oc.apiKey) as string;

  const ws = await connectWs(`ws://127.0.0.1:${port}/`, internalKey).catch((e: Error) => {
    child.kill();
    throw new Error(`localharness WS 연결 실패(${port}): ${e.message}. stderr: ${stderr.slice(0, 600)}`);
  });

  // InitializeConversationEvent — config(HarnessConfig). 사용자 키는 models[].geminiApiEndpoint.apiKey.
  // (응답을 동기 대기하지 않음 — local_connection.py __aenter__와 동일. 이후 OutputEvent 스트림에서 처리.)
  ws.send(JSON.stringify({
    config: {
      models: [{ name: opts.model, types: ['MODEL_TYPE_TEXT'], geminiApiEndpoint: { apiKey: opts.apiKey } }],
    },
  }));

  const listeners: Array<(ev: Record<string, unknown>) => void> = [];
  ws.on('message', (data: WebSocket.RawData) => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    for (const cb of listeners) cb(ev);
  });

  return {
    sendInput(text: string) {
      ws.send(JSON.stringify({ userInput: text }));
    },
    sendEvent(e: Record<string, unknown>) {
      ws.send(JSON.stringify(e));
    },
    onEvent(cb: (ev: Record<string, unknown>) => void) {
      listeners.push(cb);
    },
    end() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      child.kill();
    },
  };
}

// stdout에서 [LE4 길이][protobuf OutputConfig] 한 프레임을 읽어 디코드.
function readBootstrap(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (!done && buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length >= 4 + len) {
          done = true;
          child.stdout?.off('data', onData);
          try {
            resolve(OutputConfig.toObject(OutputConfig.decode(buf.subarray(4, 4 + len)), { defaults: true }) as Record<string, unknown>);
          } catch (e) {
            reject(e as Error);
          }
        }
      }
    };
    child.stdout?.on('data', onData);
    child.once('exit', () => {
      if (!done) reject(new Error('OutputConfig 수신 전 localharness 종료'));
    });
  });
}

// WS 연결(하니스가 포트 리슨까지 잠깐 걸릴 수 있어 백오프 재시도 — local_connection.py와 동일).
function connectWs(url: string, key: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryConnect = (): void => {
      const ws = new WebSocket(url, { headers: { 'x-goog-api-key': key } });
      ws.once('open', () => resolve(ws));
      ws.once('error', (e: Error) => {
        if (attempt++ < 5) setTimeout(tryConnect, 100 * 2 ** attempt);
        else reject(e);
      });
    };
    tryConnect();
  });
}
