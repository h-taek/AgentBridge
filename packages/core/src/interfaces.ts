// 코어가 호스트 앱에 위임하는 사이드이펙트 인터페이스.
//
// 코어는 vscode/electron 모듈을 직접 import하지 않는다. 로깅, 시간, 워크스페이스 경로 계산 등
// 호스트별 구현은 인터페이스로 받고 각 앱이 주입한다.

export interface Logger {
  log(message: string): void;
  warn(message: string): void;
}

export const noopLogger: Logger = {
  log: () => {},
  warn: () => {},
};

export interface Clock {
  now(): number;
  isoNow(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};
