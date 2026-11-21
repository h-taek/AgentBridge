// 장기 기억 정리 스킬 본문 (0.9.0 spec/04).
//
// 기억을 지우는 길은 사용자가 파일을 직접 지우는 것뿐이라 낡은 항목과 같은 말을 하는 항목이
// 쌓인다. 정리 절차는 이 스킬 본문이 전부다 — 승인은 대화에서 받고 모델이 파일을 직접 고친다.
// 승인 대기열을 거치지 않으므로 정리용 CLI 명령은 없다.
//
// `agentbridge` 스킬과 따로 둔다. 드물게 쓰는 긴 절차라 그 스킬을 열 때마다 함께 읽힐 이유가
// 없다. 설치·갱신·제거는 `agentbridge` 스킬과 같은 자리, 같은 시점이다(skillInstaller).
//
// 본문은 영어다(기존 스킬과 같은 규칙). 실행 줄은 `agentbridge` 스킬과 같은 renderRunPrefix를
// 쓴다 — 인용이 갈리면 공백이 든 런타임 경로에서 한쪽만 깨진다.

import { renderRunPrefix } from './skillTemplate';

export const CLEANUP_SKILL_DIR_NAME = 'agentbridge-memory-cleanup';

export function renderCleanupSkillMarkdown(opts: { execPath: string; cliPath: string }): string {
  const run = renderRunPrefix(opts);
  return `---
name: agentbridge-memory-cleanup
description: >-
  Use only when the user asks to clean up, prune, deduplicate or merge
  AgentBridge long-term memory — "기억 정리해", "메모리 중복 합쳐",
  "clean up memory". Reads every user and project entry, shows a plan, and
  after the user approves it in chat, edits the memory files directly.
---

# Cleaning up AgentBridge memory

Every command is:

    ${run} <command>

Long-term memory here is user knowledge and this repository's project
knowledge. Other repositories' project knowledge and the IR are out of scope.

## Where entries live

\`memory user --full\` and \`memory project --full\` name the folder of that scope
on their third line (\`폴더: <path>\`). In that folder:

- Each entry is one file, \`docs/<category>/<slug>.md\`. Its id
  \`<category>/<slug>\` is that path.
- Sections, in order: \`# <title>\`, \`## Summary\`, \`## Tags\` (only when present),
  \`## Index Entries\`, \`## Details\`. Search reads the title, Summary and Index
  Entries.
- An entry is pinned when its \`## Tags\` section has the line \`- pinned\`.
- \`index.md\` is derived and nothing reads it. Do not edit it.
- \`proposals/\` is the approval queue. Do not edit it.

## Steps

1. Read everything: \`memory user --full\`, \`memory project --full\`,
   \`memory pending\`.
2. Sort each entry into keep, delete or merge.
   - Delete: it falls below the recording bar in the hook's section 1-4 (how
     to do one task, a single incident); the repository's code or docs already
     say it; a newer entry or the current code contradicts it.
   - Merge: two or more entries state the same rule. Never merge a user entry
     with a project entry.
3. Show the plan and wait for the user's approval. For each entry: its id,
   title, verdict and a one-line reason. For a merge group, show which entry
   stays and which go. Change the plan where the user says so. Touch no file
   before approval.
4. Apply only what was approved, by editing files.
   - Delete: remove that file.
   - Merge: keep the file of the entry with the most content, fold the others'
     content into it, and remove the others. Do not rename or move the kept
     file; its title may change. If any entry in the group was pinned, the
     kept file keeps \`- pinned\`.
   - Create no files. A new entry still goes through \`memory add\`.
5. If \`memory pending\` lists a change to an entry you removed (\`고침 <id>\`),
   tell the user, and withdraw it with \`memory withdraw <proposal-id>\` if they
   say so.
6. Report how many entries you removed, how many merge groups you applied, and
   how many entries remain.

The approval in step 3 is the only approval. Do not send these changes through
the queue.
`;
}
