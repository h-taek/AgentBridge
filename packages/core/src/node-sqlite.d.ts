// node:sqlite 최소 ambient 타입 — 현재 @types/node 버전에 미포함. 런타임엔 Node 22.5+/Electron 동봉.
// 사용하는 표면(읽기 전용 prepare/all/close)만 선언. 전체 API가 필요하면 확장.
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
    close(): void;
  }
}
