// 장기 기억 정리 스킬 본문 (0.9.0 spec/04).
//
// 기억을 지우는 길은 사용자가 파일을 직접 지우는 것뿐이라 낡은 항목과 같은 말을 하는 항목이
// 쌓인다. 정리 절차는 이 스킬 본문이 전부다 — 승인은 대화에서 받고 모델이 파일을 직접 고친다.
// 승인 대기열을 거치지 않으므로 정리용 CLI 명령은 없고, 본문은 실행 줄도 싣지 않는다.
//
// `agentbridge` 스킬과 따로 둔다. 드물게 쓰는 긴 절차라 그 스킬을 열 때마다 함께 읽힐 이유가
// 없다. 설치·갱신·제거는 `agentbridge` 스킬과 같은 자리, 같은 시점이다(skillInstaller).
//
// 본문은 영어다(기존 스킬과 같은 규칙). 기억 폴더의 절대경로는 설치 위치(cliPath)에서 정해
// 본문에 박는다 — cliPath는 <저장소 루트>/bin/agentbridge.js이고 기억 폴더는 <저장소 루트>/global이다.

import { dirname, join } from 'node:path';

export const CLEANUP_SKILL_DIR_NAME = 'agentbridge-memory-cleanup';

export function renderCleanupSkillMarkdown(opts: { execPath: string; cliPath: string }): string {
  const globalDir = join(dirname(dirname(opts.cliPath)), 'global');
  return `---
name: agentbridge-memory-cleanup
description: >-
  Use only when the user asks to clean up, refresh, prune, deduplicate or merge
  AgentBridge long-term memory — "기억 정리해", "메모리 중복 합쳐", "오래된 기억
  지워", "기억 최신화해", "clean up memory". Works on the memory files directly:
  settles every pending proposal first, then reads user knowledge and every
  project's knowledge, checks facts against the current code, shows a plan, and
  after the user approves it in chat, edits, deletes and moves the files —
  with a backup taken at the start and a final check against it at the end.
---

# Cleaning up AgentBridge memory

## What this does

Long-term memory grows one entry at a time, during conversations, and nothing
prunes it. Over time four things go wrong: several entries say the same thing;
facts that were true then are no longer true; a one-off event is kept as if it
were a rule; and an entry sits in the wrong scope — the same rule recorded
separately in several projects, or one project's detail kept in user
knowledge. This skill reads the whole memory at once and fixes those.

- The target is user knowledge and the project knowledge of every project. It
  is the same no matter which project this session was opened in. The IR (the
  compacted working state) is not a target.
- Work on the files directly. Do not use AgentBridge CLI commands for any part
  of this — \`memory project\`, \`memory pending\` and \`memory withdraw\` reach only
  the project this session was opened in, and cleanup covers all of them.
- Change only what the user approves in this conversation. That approval
  replaces the panel's approval queue; do not route anything through it.
- Take a backup before the first change, verify against it at the end, and
  delete it when done.
- Write every plan, question, status line and report in the language of the
  user's latest message. Keep commands, paths, ids and Markdown headings as
  they are.

## How memory is laid out

The memory folder is \`${globalDir}\`.

- User knowledge is \`profiles/default/\`. Project knowledge is
  \`projects/<folder>/\`, one folder per repository. The folder name comes from
  the repository's normalized git \`origin\`, or from the workspace path when
  there is no remote; clones of the same remote share one folder.
- \`projects/<folder>/workspaces.json\` lists the repository paths that use that
  folder: \`{ "workspaces": ["<absolute path>", ...] }\`. If the file is missing
  or a path is not on disk, that project cannot be checked against its code.
- An entry is one file, \`docs/<category>/<slug>.md\`, and its id is
  \`<category>/<slug>\`. A folder without \`docs/\` has no entries.
- The app reads every \`.md\` under \`docs/\`, recursively. A file directly under
  \`docs/\` is read as category \`general\`; deeper paths are read too. The
  standard layout is exactly one level: \`docs/<category>/<slug>.md\`.
- Sections, in this order: \`# <title>\`, \`## Summary\`, \`## Tags\` (only when
  present), \`## Index Entries\`, \`## Details\`. The Summary is the conclusion —
  what to do, in a sentence or two. Details are the grounds: why it was
  decided, the user's own words, past cases. Lines under Tags and Index
  Entries start with \`- \`.
- Every turn the hook scores the user's prompt against each entry's title,
  Summary, Index Entries, category, path and body, and injects the ids of up to
  three entries above a threshold. A word missing from Index Entries makes the
  entry harder to find.
- An entry is pinned when its \`## Tags\` has the line \`- pinned\`. Pinned entries
  are injected into the first turn of every new session, apart from normal
  matching: a pinned user entry in every project, a pinned project entry in
  that project only.
- \`[[<id>]]\` in a body is a link to another entry.
- \`proposals/<id>.json\` is a proposal waiting for approval: a new entry, or a
  change to an existing one (it has a \`targetSlug\`). The file name is
  \`<category>__<slug>__<hash>.json\`.
- An old \`index.md\` may sit at the top of a folder. Nothing reads it. Leave it
  alone.

## Steps

### 1. Prepare

1. Look for backups an earlier cleanup left behind: folders named
   \`agentbridge-memory-backup-*\` under \`$TMPDIR\` and \`/tmp\`. If there are any,
   say they are left from a cleanup that did not finish and ask whether to
   delete them. A run whose restore could not be confirmed keeps its backup on
   purpose, so do not delete one without the user's answer, and do not restore
   from one unless the user asks.
2. Ask the user not to use the memory panel until you say cleanup is done.
   Approving, discarding or pinning there would touch the files you are
   changing.
3. Check, before touching anything live, that you can write, rename and delete
   inside the memory folder and write to a temporary folder. If any of these is
   blocked, change nothing and report what is blocked.
4. Back up. Copy \`profiles/\` and \`projects/\` of the memory folder into a new
   folder of this run, \`$TMPDIR/agentbridge-memory-backup-<date-time>/\` (use
   \`/tmp\` if \`TMPDIR\` is unset or not writable). Confirm the copy has the same
   files with the same contents. Keep it outside the memory folder, where the
   panel's recursive file watch does not reach. Tell the user the path. This
   backup is the starting state you verify against and the place you restore
   from.
5. Whenever you stop to wait for the user while the backup exists — for the
   proposal decisions, for the plan approval, for a question — say where the
   backup is and that it will be deleted if cleanup is dropped. If the user
   ends the conversation there, the backup would otherwise stay behind.

### 2. Settle every proposal

Finish all pending proposals before cleaning up. If a proposal is still
waiting when you delete or move its entry, approving it later writes the entry
back at its old path: a deleted entry returns, a moved one exists twice.

1. Read every \`proposals/*.json\` in every scope.
2. For each, show the scope, whether it is a new entry or a change, its title
   and summary; for a change, also the current entry and what would change.
   The user decides, one by one, to accept or discard.
3. Accept the way the panel does: write \`docs/<category>/<slug>.md\` in the
   section format above — for a change, \`<slug>\` is its \`targetSlug\` and the
   existing \`## Tags\` stays; for a new entry, \`<slug>\` is
   \`<slug part of the file name>-<hash part of the file name>\`. Then delete the
   proposal file.
4. Discard by deleting the proposal file only.
5. Confirm no \`.json\` is left in any \`proposals/\`. Do not go on until that
   holds.

### 3. Read and check against the present

1. Read every scope's \`docs/\` the way the app does. Note separately any file
   that is not an entry (not \`.md\`) and any entry that does not follow the
   standard layout or sections. These are pre-existing exceptions.
2. Where an entry states facts — versions, file or command names, settings, how
   a tool behaves, folder layout, the state of some work — check them against
   the present. Project knowledge: that repository's code, docs, config and git
   history (paths from \`workspaces.json\`). User knowledge: the repositories it
   concerns and newer entries. If repositories disagree, or none is
   available, mark the fact as unverified.

### 4. Decide

Give each entry exactly one final disposition. Any content or link edit needed
to reach it belongs to that disposition.

- **Keep.**
- **Refresh** — a fact changed but the rule it supports still holds. Write the
  current fact; keep the old one in Details, dated, only when it is needed as
  grounds.
- **Delete** — the entry only records a past state ("we are at stage X", "the
  latest version is Y"); or a source you checked — the repository's code or
  docs — already states the whole rule in every scope where it applies; or it
  is how one task was done, or a single incident. An instruction the user gave
  for the future stays, even if it came from one incident.
- **Merge** — two or more entries give the same instruction under the same
  conditions. When several match one question they crowd the three injection
  slots and each says it a little differently. Entries titled
  \`Sub evaluation — <harness> <model>\` merge only when both harness and model
  match, and every dated case and its evidence is kept.
- **Move** — the entry is in the wrong scope.
  - The same rule in three or more different project folders is this user's
    general rule. Generalize it into one user entry and delete the project
    copies; if user knowledge already has the rule, merge into that entry.
  - A rule repeated in only two projects stays where it is. Two can be
    coincidence.
  - A user entry that concerns one project only moves to that project; in
    every other project it is injected for nothing. If the content does not
    say which project, ask.
- **Links** — when cleanup is done no entry links to another. Injection
  carries ids only, so an entry that leans on a link does not say everything
  on its own. For each link, either merge the two entries (under the same merge
  rules) or delete the link and write what the entry needs into it directly.
  If the target is missing or matches entries in more than one scope, carry
  over only what you can verify and ask about the rest.
- When the evidence conflicts or cannot be checked, do not delete — ask.

### 5. Show the plan and wait for approval

Change no file in the memory folder before the user approves.

- Refresh: scope, id, what changes into what, and the evidence (the file or
  commit you checked).
- Delete: scope, id, title, one-line reason. Mark pinned entries.
- Merge: the entry that stays, the entries that go, one-line reason.
- Move: the exact path before and after, one-line reason. For a move up to user
  knowledge, the projects it was found in. Say so when a pin starts or stops
  appearing in some projects because of the move.
- Links: each linked entry and how it is resolved.
- Pre-existing exceptions from step 3, and whether to fix them (a fix becomes a
  plan item of its own).
- Questions: what you could not decide.
- Keep: a count per scope and the list of ids only.

Describe each changed file well enough that its final content is settled. If a
destination already has a file, or two items claim the same path, defer that
item unless the user approves a merge or a different path. Change the plan
wherever the user says so. If a partial approval leaves links in place, say so
in the plan.

### 6. Apply

1. Right before the first write, compare the memory folder with the backup
   again. If anything changed while the user was reading the plan, redo the
   plan for the affected items and get approval again.
2. Before each change, write down the path, its state before and its expected
   state after. This run log is what you restore from if something fails.
3. Apply only what was approved.
   - Refresh: edit the sections that change; edit the Summary too if the
     conclusion changes.
   - Delete: remove the file.
   - Merge: keep the file with the most content. Rewrite the Summary as the
     conclusion of the whole group. Make Index Entries the union of the group,
     so words that found a removed entry still find this one. Join the Details
     so no grounds or case is lost. If any entry in the group was pinned, keep
     \`- pinned\`. Write and check the kept file before removing the others.
   - Move up while merging: if user knowledge already has the rule, merge into
     that file. Otherwise move the project entry with the most content to the
     user folder's \`docs/<category>/\` and generalize wording that was tied to
     one project.
   - Move: move the file to the target folder's \`docs/<category>/\`, creating it
     if needed. Check right before writing that the destination is still free.
     Correct a wrong category when the plan says so.
   - Links: delete the link and write in what the plan says.
   - Create no entry file except at an approved move destination or an
     accepted proposal from step 2.
4. If any write, move or delete fails, or the run is interrupted, go to
   **Restore**.

### 7. Verify

Build the expected final state from the backup and the approved items, and
compare the live memory folder with it.

1. File set: added, removed and changed paths, compared both ways, match the
   expected state exactly — no unplanned new file, no unplanned change.
2. Contents: every changed file has its approved content; every other file
   equals the backup.
3. Paths: every changed or new entry is exactly \`docs/<category>/<slug>.md\`,
   not empty, and no id appears twice within one scope. Pre-existing
   exceptions equal the backup.
4. Format: every changed or new entry has \`# <title>\`, \`## Summary\`,
   (\`## Tags\`), \`## Index Entries\` and \`## Details\` in that order, none empty,
   with \`- \` lines under Tags and Index Entries.
5. Pins: every entry pinned at the start is still pinned, or the file it was
   merged or moved into is — except a pinned entry whose deletion was approved.
6. Search words: every Index Entry of an entry removed by a merge is in the
   kept file.
7. Links: no remaining entry links to another, including links to missing
   targets. A link left because of a partial approval is reported as
   incomplete, not as a failure.
8. Proposals: every \`proposals/\` is empty.
9. Non-entry files — \`workspaces.json\`, any old \`index.md\`, \`profile.json\` —
   equal the backup.

If any check fails, go to **Restore**. Do not patch your way through: a fix
outside the plan is a change the user never approved.

### 8. Finish

1. Delete the backup and confirm it is gone.
2. Report: proposals accepted and discarded; entries refreshed, deleted,
   merged (groups), moved, and with links removed; how many remain per scope;
   that the backup was deleted. Tell the user the panel can be used again.

## Restore

- Restore only the paths in the run log: put each changed file back to its
  state before, and remove each file this run created. Leave every path not in
  the log alone — it may have been changed elsewhere during cleanup.
- Confirm that every path in the run log now equals the backup.
- When that is confirmed, delete the backup, confirm it is gone, and report
  which step or check failed and that the memory is back to its starting
  state.
- If you cannot confirm the restore, do not delete the backup. It is then the
  only copy of the original memory. Report the paths you could not restore and
  where the backup is.
- If the user drops cleanup at any point — says to stop, or moves on to
  something else — before any write, delete the backup, confirm it is gone,
  and say so. After a write, restore first as above.
`;
}
