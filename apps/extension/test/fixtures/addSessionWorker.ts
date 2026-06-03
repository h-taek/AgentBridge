// 별도 Node 프로세스에서 실행되는 워커 — crossProcess.test.ts가 fork로 띄운다.
// argv: [rootPath, folderPath, sessionId]
import { createWorkspaceStore } from '@agentbridge/core';

async function main(): Promise<void> {
  const [rootPath, folderPath, sessionId] = process.argv.slice(2);
  const store = createWorkspaceStore({ rootPathForTesting: rootPath });
  const wid = store.getOrCreateWorkspaceId(folderPath);
  await store.addSession(wid, 'claude', 'cli', sessionId);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
