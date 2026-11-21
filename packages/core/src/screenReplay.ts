// 서브의 replay.log를 가상 터미널(@xterm/headless)로 처음부터 끝까지 재생해
// 지금 보이는 화면 한 장을 글자로 만든다(0.8.0 spec/08 §1).
//
// index.ts에서는 다시 내보내지 않는다 — 익스텐션 본체 번들에 가상 터미널이
// 실리지 않도록 agentCli/agent.ts만 이 모듈을 직접 import한다.

import { promises as fsp } from 'fs';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { replayLogPath, replaySizePath } from './replayPaths';
import { readOwner } from './sessionOwner';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

export interface RenderedScreen {
  cols: number;
  rows: number;
  text: string;
}

type Size = { cols: number; rows: number };

function validSize(v: Partial<Size> | null): Size | null {
  if (!v) return null;
  const { cols, rows } = v;
  return Number.isInteger(cols) && cols! > 0 && Number.isInteger(rows) && rows! > 0
    ? { cols: cols!, rows: rows! }
    : null;
}

async function readReplaySize(sessionDir: string): Promise<Partial<Size> | null> {
  try {
    return JSON.parse(await fsp.readFile(replaySizePath(sessionDir), 'utf8')) as Partial<Size>;
  } catch {
    return null;
  }
}

/** 세션 폴더의 replay.log를 재생해 현재 화면을 만든다. 기록이 없거나 비었으면 null. */
export async function renderScreen(sessionDir: string): Promise<RenderedScreen | null> {
  let data: Buffer;
  try {
    data = await fsp.readFile(replayLogPath(sessionDir));
  } catch {
    return null;
  }
  if (data.length === 0) return null;

  // 탭의 마지막 크기로 재생한다. owner.json(PTY가 살아 있을 때) → replay-size.json(끝난 뒤에도 남는다)
  // → 익스텐션 기본값 120×30 순이다. 120×30은 replay-size.json이 생기기 전의 기록에만 쓰인다.
  const { cols, rows } = validSize(await readOwner(sessionDir)) ??
    validSize(await readReplaySize(sessionDir)) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };

  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';

    await new Promise<void>((resolve) => {
      term.write(data, resolve);
    });

    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) {
      const line = buf.getLine(buf.baseY + i);
      // translateToString(true)는 미기록 셀만 자르고 명시적 공백 문자는 남기므로 trimEnd로 줄 끝 공백을 마저 뺀다.
      lines.push(line ? line.translateToString(true).trimEnd() : '');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    return { cols, rows, text: lines.join('\n') };
  } finally {
    term.dispose();
  }
}
