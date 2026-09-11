// HTML 뷰어 — 내보낸 파일 집합 감시 (0.7.0 spec 3.4).
//
// 감시 대상은 서빙 루트가 아니라 서버가 실제로 내보낸 파일 집합이다. 루트를 통째로 감시하면
// 워크스페이스 전체가 대상이 되어 node_modules 변화에도 화면이 다시 그려진다.
//
// 파일마다 감시자를 달지 않고 상위 디렉터리별로 하나씩 단다. 목업 하나가 같은 폴더의 파일
// 여럿을 부르는 것이 보통이라 감시자 수가 줄고, 파일이 통째로 갈리는 저장(rename)에도 감시가
// 끊기지 않는다 — 디렉터리는 그대로 있기 때문이다.

import * as fs from 'fs';
import * as path from 'path';

export interface ViewerWatch {
  update(files: string[]): void; // 서버가 내보낸 목록이 늘면 다시 부른다
  close(): void;
  size(): number; // 감시 중인 디렉터리 수. 테스트와 진단용
}

// 에이전트의 저장 한 번이 파일 여럿을 건드리는 것을 한 번으로 묶는 간격.
const DEBOUNCE_MS = 120;

export function watchServedFiles(onChange: () => void, debounceMs: number = DEBOUNCE_MS): ViewerWatch {
  // 파일 → 마지막으로 본 상태. 디렉터리 감시자는 이웃 파일의 변화도 함께 알리므로, 우리가
  // 내보낸 파일이 정말 바뀌었을 때만 통과시킨다.
  const seen = new Map<string, string>();
  const watchers = new Map<string, fs.FSWatcher>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const signature = (file: string): string => {
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 'missing';
    }
  };

  const changed = (file: string): boolean => {
    if (!seen.has(file)) return false;
    const now = signature(file);
    if (seen.get(file) === now) return false;
    seen.set(file, now);
    return true;
  };

  const trigger = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) onChange();
    }, debounceMs);
  };

  const watchDir = (dir: string): void => {
    if (closed || watchers.has(dir)) return;
    try {
      const watcher = fs.watch(dir, (_event, filename) => {
        if (closed) return;
        // 파일명은 플랫폼에 따라 안 올 수 있다. 그때는 그 폴더의 감시 대상을 전부 다시 본다.
        const targets = filename
          ? [path.join(dir, filename)]
          : [...seen.keys()].filter((f) => path.dirname(f) === dir);
        if (targets.some(changed)) trigger();
      });
      // 폴더가 지워지거나 권한이 바뀌어도 프로세스를 죽이지 않는다.
      watcher.on('error', () => undefined);
      watchers.set(dir, watcher);
    } catch {
      // 감시를 못 걸면 그 폴더의 변화는 놓친다. 뷰어는 계속 산다.
    }
  };

  return {
    update(files: string[]): void {
      if (closed) return;
      for (const file of files) {
        const abs = path.resolve(file);
        if (!seen.has(abs)) seen.set(abs, signature(abs));
        watchDir(path.dirname(abs));
      }
    },

    close(): void {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      seen.clear();
    },

    size(): number {
      return watchers.size;
    },
  };
}
