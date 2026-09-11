// HTML 뷰어의 요소 전송 직렬화 큐 (0.7.0).
//
// sendPrompt는 붙여넣기와 개행을 SUBMIT_DELAY_MS(300ms) 간격으로 따로 보낸다.
// 같은 세션에 연달아 부르면 붙여넣기 A → 붙여넣기 B → 개행 → 개행이 나므로
// 호출부에서 세션별로 줄을 세운다. 기본 간격은 400ms다.

const DEFAULT_GAP_MS = 400;

const tails = new Map<string, Promise<void>>();

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function queueSend(
  sessionId: string,
  send: () => boolean,
  gapMs: number = DEFAULT_GAP_MS,
): Promise<boolean> {
  const prev = tails.get(sessionId) ?? Promise.resolve();

  let resolveResult!: (value: boolean) => void;
  let rejectResult!: (reason?: unknown) => void;
  const resultPromise = new Promise<boolean>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const next = prev.catch(() => {}).then(async () => {
    try {
      const ok = send();
      resolveResult(ok);
    } catch (err) {
      rejectResult(err);
    }
    await wait(gapMs);
  });

  tails.set(sessionId, next);

  next.finally(() => {
    if (tails.get(sessionId) === next) {
      tails.delete(sessionId);
    }
  });

  return resultPromise;
}
