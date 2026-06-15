// 데스크탑 렌더러 i18n 문자열 — English.
// `satisfies Messages` — ko.ts와 키·시그니처가 어긋나면 컴파일 에러로 잡힌다.
import type { Messages } from './ko'

export const en = {
  common: {
    close: 'Close',
    back: 'Back',
    openInFinder: 'Reveal in Finder',
    pickFolder: 'Choose folder',
    terminal: 'Terminal',
    cliNotInPath: (label: string) => `${label} CLI is not on PATH`,
    notInstalledParen: ' (not installed)',
    builtinTerminalTitle: 'Built-in terminal (zsh) — no AgentBridge memory',
    cancel: 'Cancel'
  },
  settings: {
    titles: {
      main: 'Settings',
      cli: 'CLI detection',
      shortcuts: 'Shortcuts',
      help: 'User guide',
      license: 'License'
    },
    closeEsc: 'Close (Esc)',
    locked: 'locked',
    refinePolicyLabel: {
      priority: 'Default (priority)',
      fixed: 'Fixed',
      active: 'Active model',
      off: 'Off'
    },
    refinePolicyDesc: {
      priority: 'Try CLIs in priority order · fall through to the next on failure/limit',
      fixed: 'Use only the chosen CLI · skip refine on failure',
      active: 'Use the last-chatted CLI · skip refine on failure',
      off: 'Refining disabled'
    },
    themeLabel: {
      dark: 'Dark',
      light: 'Light',
      system: 'System'
    },
    turnsDetailLabel: {
      full: 'Full',
      compact: 'Compact',
      minimal: 'Minimal'
    },
    turnsDetailDesc: {
      full: 'Store the response verbatim (up to 50KB).',
      compact: 'Store the first 4,000 + last 1,000 characters (default).',
      minimal: 'Store the first 800 + last 200 characters.'
    },
    priorityRow: {
      label: 'Priority',
      desc: 'Tried top to bottom',
      up: 'Move up',
      down: 'Move down'
    },
    updater: {
      idle: 'Not checked',
      skippedDev: 'Dev mode (auto-update disabled)',
      checking: 'Checking…',
      available: (v: string) => `New version v${v}`,
      availableSub: 'Downloading in the background',
      notAvailable: (v: string) => `Up to date (v${v})`,
      downloading: (verLabel: string, pct: number) => `Downloading${verLabel} · ${pct}%`,
      downloaded: (v: string) => `Download complete (v${v})`,
      downloadedSub: 'Will install on next quit',
      error: 'Error',
      none: '—'
    },
    main: {
      tagline: 'Context handoff for multi-AI coding agents',
      openRepo: 'Open GitHub repository',
      version: 'Version',
      runtime: 'Runtime',
      platform: 'Platform',
      dataLocation: 'Data location',
      groupApp: 'App',
      appearance: 'Appearance',
      appearanceLocked: 'Light/System will be supported after the stable release',
      language: 'Language',
      defaultPath: 'Default path',
      groupAgent: 'Agents',
      cliDetect: 'CLI detection',
      cliDetectTitle: 'View detected CLIs',
      cliDetectedCount: (found: number, total: number) => `${found}/${total} detected`,
      probing: 'probing…',
      refineModelPolicy: 'Refine model policy',
      refineModelPolicyTitle: 'Choose the refine (summary) LLM',
      fixedCli: 'Fixed CLI',
      fixedCliDesc: 'Refine only with the chosen CLI',
      useClaude: 'Use Claude for refine',
      useClaudeDesc: 'Headless claude -p uses separate credits, not your subscription · off excludes it from refine',
      useClaudeOn: 'On',
      useClaudeOff: 'Off',
      groupData: 'Data',
      dataManage: 'Data management',
      turnsDetail: 'Response retention',
      turnsDetailTitle: 'Length of responses stored in turns.jsonl',
      archiveCount: 'Archived snapshots',
      archiveCountDesc: 'Cap on accumulated past IR snapshots (excess auto-deleted)',
      archiveCountTitle: 'Max compressed_*.jsonl files kept in archive/',
      proposalEveryN: 'Auto-suggest',
      proposalEveryNDesc: 'Automatically extract long-term memory candidates from conversations (off = disabled)',
      proposalEveryNTitle: 'Turn auto-suggestion of long-term memory on or off',
      proposalOn: 'On',
      proposalOff: 'Off',
      groupInfo: 'About',
      checkUpdate: 'Check for updates',
      checkUpdateDevTitle: 'Auto-update is disabled in dev mode',
      checkUpdateTitle: 'Check for a new version now',
      releaseNotes: 'Release notes',
      releaseNotesTitle: 'Open the GitHub Releases page in a new window',
      shortcuts: 'Shortcuts',
      helpAndCautions: 'User guide · Cautions',
      license: 'License'
    },
    cliPage: {
      intro: 'PATH registration status of the CLI tools AgentBridge uses. Reload the app after installing to auto-detect them.',
      detectedGroup: 'Detected CLIs',
      versionUnknown: '(version not collected)',
      notInPath: 'Not on PATH',
      redetect: 'Re-detect (reload app)',
      redetectTitle: 'Reload the app to re-detect CLIs on PATH'
    },
    shortcuts: {
      groupWindow: 'Window',
      newWindow: 'New empty window',
      quit: 'Quit app',
      groupSidebar: 'Sidebar',
      toggleLeft: 'Toggle left sidebar',
      toggleRight: 'Toggle right sidebar',
      groupHome: 'Home screen',
      send: 'Send message',
      newline: 'New line',
      groupTerminal: 'Terminal (xterm)',
      newlineInput: 'New line (inside input box)',
      interrupt: 'Stop current response',
      groupModal: 'Modal',
      closeBack: 'Close settings · Back'
    },
    licensePage: {
      intro: 'AgentBridge is distributed under the MIT License. You may freely use, modify, and redistribute the software, provided the original copyright notice is retained.',
      viewInRepo: 'View the LICENSE file in the repository'
    }
  },
  app: {
    appNameExtension: 'the extension',
    appNameDesktop: 'the desktop app',
    inUseBy: (appName: string) => `In use by ${appName}`,
    inUseDesc:
      'This session is open live in another app. To avoid conflicts it will not be opened here. Close the session in the other app, then continue with the button below.',
    reopen: 'Reopen',
    noActiveSession: 'No active session',
    noActiveSessionDesc: 'Open a workspace from the left sidebar, or add a new tab with "+ Model".',
    confirmDeleteWorkspace: (title: string) =>
      `Delete the entire "${title}" workspace? This cannot be undone. Proceed?`,
    orphanCleaned: (n: number) =>
      `${n} empty session(s) were auto-cleaned — a forced quit left them unpersisted by the CLI.`,
    errInUse: 'In use by another app.',
    errStillInUse: 'Still in use by another app. Close the session in the other app, then try again.'
  },
  titleBar: {
    openLeft: 'Open left sidebar',
    openRight: 'Open right sidebar'
  },
  home: {
    subtitle: 'Type a message and pick a model to start a new workspace.',
    placeholder: 'How can I help?',
    startHint: 'Press Enter to start',
    start: 'Start',
    startDisabledTitle: 'Enter a message and pick an available model',
    modelSelect: 'Select model',
    cliNotInPath: (label: string) => `${label} CLI is not on PATH`,
    notInstalled: 'Not installed'
  },
  rightSidebar: {
    collapse: 'Collapse right sidebar',
    noSelection: 'None selected',
    empty: 'Open a workspace on the left to see its current memory (IR) here.',
    shellNoMemory: 'No memory',
    shellNoMemorySub: 'Plain terminal session — AgentBridge does not track context.'
  },
  codexTrust: {
    heading: 'codex `/hooks` manual approval required',
    approving: '...',
    approved: 'Approved trust in codex'
  },
  leftSidebar: {
    collapse: 'Collapse sidebar',
    toHome: 'Go to home',
    home: 'Home',
    newWorkspace: 'New workspace',
    pathLabel: 'Path',
    nameOptional: 'Name (optional)',
    folderNamePlaceholder: 'folder name',
    modelLabel: 'Model',
    create: 'Create',
    cliNotInstalledRestart: (model: string) =>
      `${model} CLI not installed — install it and restart the app`,
    sectionActive: 'Active',
    noWorkspaces: 'No workspaces — create one above',
    collapseTree: 'Collapse',
    expandTree: 'Expand',
    noResumableSession:
      'No resumable session — every session is unpersisted natively / its CLI is not installed',
    addSession: 'Add session',
    deleteWorkspace: 'Delete workspace',
    noSessions: 'No sessions',
    inUseByOther: 'In use by another app',
    builtinTerminalShort: 'Built-in terminal (zsh)',
    notPersistedNoResume: 'Model native session not persisted — cannot resume',
    cliNotInstalled: (label: string) => `${label} CLI not installed`,
    openWorkspaceAndActivate: (label: string) => `Open workspace + activate ${label}`,
    inUseBadge: 'In use',
    renameSession: 'Rename session',
    deleteSessionTitle: 'Delete session (cannot be undone)',
    deleteSession: 'Delete session',
    ctxOpen: 'Open workspace',
    ctxOpenNewWindow: 'Open in new window',
    ctxRename: 'Rename',
    ctxDelete: 'Delete'
  },
  sessionTabs: {
    memoryInjectDisabled: (reason: string) => `Memory injection disabled — ${reason}`,
    memoryDisabledBadge: 'Memory disabled',
    closeTabTitle: 'Close tab (reopen from the sidebar)',
    closeTab: 'Close tab',
    moreCount: (n: number) => `${n} more`,
    moreTabs: 'More tabs',
    addModelTab: 'Add another model tab',
    addModel: '+ Model'
  },
  time: {
    never: 'none yet',
    justNow: 'just now',
    secondsAgo: (n: number) => `${n}s ago`,
    minutesAgo: (n: number) => `${n}m ago`,
    hoursAgo: (n: number) => `${n}h ago`,
    daysAgo: (n: number) => `${n}d ago`
  },
  mem: {
    panelAria: 'Memory panel',
    groupInstructions: 'AI instructions',
    groupMemory: 'Memory',
    infoTip:
      'AgentBridge memory (IR) is re-injected into the next message even after `/clear`.\nTo clear the memory itself, reset it with the trash button.',
    infoTipAria: 'About memory behavior',
    refineNow: 'Refine now',
    resetMemory: 'Reset memory',
    prevSnapshots: 'Previous snapshots',
    collapse: 'Collapse',
    archiveMore: (n: number) => `+ ${n} more`,
    snapshotDetailTitle: 'Memory snapshot',
    currentMemoryTitle: 'Current memory',
    lastRefined: (abs: string) => `Last refined · ${abs}`,
    refineFailed: 'Refine failed',
    refineWarn: (e: string) => `Warning: ${e}`,
    resetFailed: 'Reset failed',
    restoreFailed: 'Restore failed',
    snapshotDeleteFailed: 'Snapshot delete failed',
    confirmDeleteCurrentWithArchive:
      'Clear the current memory and restore the latest snapshot as the current memory.\nThe restored snapshot is removed from the archive list. Continue?',
    confirmDeleteCurrentNoArchive:
      'Clear the current memory (no archive snapshot — switches to empty memory). Continue?',
    confirmDeleteSnapshot: (abs: string) =>
      `Delete this snapshot (${abs}).\nThis cannot be undone. Continue?`,
    resetBody:
      'Clears the IR (summary memory) of the current workspace. This cannot be undone. Archive snapshots are preserved.',
    resetAlsoTurns: 'Also reset recent turn records (turns.jsonl)',
    resetting: 'Resetting…',
    reset: 'Reset',
    noWorkspacePath: 'No workspace path.',
    notCreated: 'not created',
    openInEditor: 'Open in editor',
    createEmptyAndOpen: 'Create an empty file and open it',
    create: 'Create',
    refinePolicy: 'Refine policy',
    policyPriority: 'Default (priority)',
    policyFixed: 'Fixed',
    policyActiveHeadless: 'Active model (headless)',
    policyOff: 'Refining off',
    sevUnknown: 'Unknown',
    sevOk: 'OK',
    sevWarn: 'Warning',
    sevCritical: 'Critical',
    sevExceeded: 'Exceeded',
    nextRefineCli: (label: string) => `${label} · CLI for the next refine`,
    forcedFallbackNote: 'Marked as fallback due to a response error (released at UTC midnight)',
    aggregating: 'Aggregating…',
    willAutoRefine: 'Auto-refine soon',
    untilNextRefine: 'Until next refine',
    noIrYet:
      'No IR generated yet. It auto-refines after you start a conversation, or refine manually with ✨ at the top right.',
    goalUnset: '(goal unset)',
    sectionGoal: 'Goal',
    sectionDecisions: 'Decisions',
    sectionFiles: 'Files',
    sectionCommands: 'Commands',
    sectionTests: 'Tests',
    sectionPending: 'To-do',
    clearCurrentTitle: 'Clear current memory (restore the latest archive snapshot)',
    clearCurrent: 'Clear current memory',
    snapshotEyebrow: 'Snapshot',
    total: (n: number) => `Total ${n}`,
    deleteSnapshotTitle: 'Delete this snapshot',
    deleteSnapshot: 'Delete snapshot',
    detailAria: 'Memory detail',
    loading: 'Loading…',
    noIrToShow: 'No IR to show.',
    role: 'Role',
    next: 'Next',
    blocked: 'Blocked',
    empty: '(none)',
    testStatus: {
      passed: 'Pass',
      failed: 'Fail',
      pending: 'Pending',
      skipped: 'Skip'
    }
  },
  profile: {
    tabIr: 'Short-term · IR',
    tabProfile: 'Long-term · Memory',
    panelAria: 'Long-term memory panel',
    profileLabel: 'default',
    openFolder: 'Open folder',
    openFolderTitle: 'Open profile folder (edit .md manually)',
    queueTitle: 'Proposal queue',
    queueEmpty: 'No pending proposals',
    docsTitle: 'Profile docs',
    docsEmpty: 'No docs yet. They fill in automatically as you work.',
    approve: 'Approve',
    discard: 'Discard'
  },
  xterm: {
    dropPathFailed: 'Could not extract file path',
    attachFailed: 'Attach failed',
    someRejected: (reasons: string) => `Some rejected: ${reasons}`,
    attachTitle: '+ Attach files',
    pasteAbsoluteShell: 'Paste absolute path',
    pasteAbsoluteMention: 'Paste @absolute-path'
  }
} satisfies Messages
