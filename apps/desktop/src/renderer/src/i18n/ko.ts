// 데스크탑 렌더러 i18n 문자열 — 한국어(소스 언어).
// en.ts가 `satisfies Messages`로 이 구조를 강제로 맞춘다(키 누락·시그니처 불일치 = 컴파일 에러).
// 주의: `as const`를 쓰지 않는다 — 쓰면 값이 리터럴 타입('닫기')으로 좁혀져 영어 값('Close')이 거부된다.

export const ko = {
  common: {
    close: '닫기',
    back: '뒤로',
    openInFinder: 'Finder에서 열기',
    pickFolder: '폴더 선택',
    terminal: '터미널',
    cliNotInPath: (label: string) => `${label} CLI가 PATH에 없음`,
    notInstalledParen: ' (미설치)',
    builtinTerminalTitle: '내장 터미널 (zsh) — AgentBridge 메모리 없음',
    cancel: '취소'
  },
  settings: {
    titles: {
      main: '설정',
      cli: 'CLI 감지',
      shortcuts: '단축키',
      help: '사용 설명서',
      license: '라이선스'
    },
    closeEsc: '닫기 (Esc)',
    locked: '잠금',
    refinePolicyLabel: {
      priority: '기본 (우선순위)',
      fixed: '고정',
      active: '활성 모델',
      off: '끔'
    },
    refinePolicyDesc: {
      priority: 'CLI 우선순위대로 시도 · 실패/한도 초과 시 다음 CLI로',
      fixed: '특정 CLI만 사용 · 실패 시 정제 스킵',
      active: '마지막 채팅 CLI 사용 · 실패 시 정제 스킵',
      off: '정제 사용 안 함'
    },
    themeLabel: {
      dark: '다크',
      light: '라이트',
      system: '시스템'
    },
    turnsDetailLabel: {
      full: '원문',
      compact: '압축',
      minimal: '최소'
    },
    turnsDetailDesc: {
      full: '응답 원본 그대로 저장 (최대 50KB).',
      compact: '응답의 앞 4,000자 + 뒤 1,000자만 저장 (기본값).',
      minimal: '응답의 앞 800자 + 뒤 200자만 저장.'
    },
    priorityRow: {
      label: '우선순위',
      desc: '위에서부터 시도',
      up: '위로',
      down: '아래로'
    },
    updater: {
      idle: '확인하지 않음',
      skippedDev: 'dev 모드 (자동 업데이트 비활성)',
      checking: '확인 중…',
      available: (v: string) => `새 버전 v${v}`,
      availableSub: '백그라운드에서 다운로드 중',
      notAvailable: (v: string) => `최신입니다 (v${v})`,
      downloading: (verLabel: string, pct: number) => `다운로드 중${verLabel} · ${pct}%`,
      downloaded: (v: string) => `다운로드 완료 (v${v})`,
      downloadedSub: '다음 종료 시 자동 설치 시도',
      error: '에러',
      none: '—'
    },
    main: {
      tagline: '멀티 AI 코딩 에이전트 컨텍스트 핸드오프',
      openRepo: 'GitHub 저장소 열기',
      version: '버전',
      runtime: '런타임',
      platform: '플랫폼',
      dataLocation: '데이터 위치',
      groupApp: '앱',
      appearance: '외관',
      appearanceLocked: '라이트/시스템은 정식 배포 이후 지원 예정',
      language: '언어',
      defaultPath: '기본 경로',
      groupAgent: '에이전트',
      cliDetect: 'CLI 감지',
      cliDetectTitle: '감지된 CLI 목록 보기',
      cliDetectedCount: (found: number, total: number) => `${found}/${total} 감지됨`,
      probing: 'probing…',
      refineModelPolicy: '요약 모델 정책',
      refineModelPolicyTitle: '요약(refine) LLM 선택',
      fixedCli: '고정 CLI',
      fixedCliDesc: '선택한 CLI로만 정제 시도',
      useClaude: 'Claude 정제 사용',
      useClaudeDesc: '헤드리스 claude -p는 구독이 아닌 별도 크레딧 소모 · 끄면 정제에서 제외',
      useClaudeOn: '사용',
      useClaudeOff: '사용 안 함',
      groupData: '데이터',
      dataManage: '데이터 관리',
      turnsDetail: '응답 보존 정도',
      turnsDetailTitle: 'turns.jsonl에 저장되는 응답 길이',
      archiveCount: '보관 스냅샷 개수',
      archiveCountDesc: '과거 IR 스냅샷 누적 상한 (초과분 자동 삭제)',
      archiveCountTitle: 'archive/ 디렉토리에 보관할 compressed_*.jsonl 최대 개수',
      groupInfo: '정보',
      checkUpdate: '업데이트 확인',
      checkUpdateDevTitle: 'dev 모드에선 자동 업데이트 비활성',
      checkUpdateTitle: '지금 새 버전 확인',
      releaseNotes: '릴리즈 노트 보기',
      releaseNotesTitle: 'GitHub Releases 페이지를 새 창으로 열기',
      shortcuts: '단축키',
      helpAndCautions: '사용 설명서 · 주의사항',
      license: '라이선스'
    },
    cliPage: {
      intro: 'AgentBridge가 사용하는 CLI 도구의 PATH 등록 상태. 설치 후 앱을 새로고침하면 자동 감지됩니다.',
      detectedGroup: '감지된 CLI',
      versionUnknown: '(version 미수집)',
      notInPath: 'PATH에 없음',
      redetect: '재감지 (앱 새로고침)',
      redetectTitle: '앱을 새로고침해서 PATH의 CLI를 다시 감지'
    },
    shortcuts: {
      groupWindow: '윈도우',
      newWindow: '새 빈 윈도우',
      quit: '앱 종료',
      groupSidebar: '사이드바',
      toggleLeft: '좌 사이드바 토글',
      toggleRight: '우 사이드바 토글',
      groupHome: '홈 화면',
      send: '메시지 전송',
      newline: '줄바꿈',
      groupTerminal: '터미널 (xterm)',
      newlineInput: '줄바꿈 (입력 박스 내부)',
      interrupt: '현재 응답 중단',
      groupModal: '모달',
      closeBack: '설정 닫기 · 뒤로'
    },
    licensePage: {
      intro: 'AgentBridge는 MIT 라이선스 하에 배포됩니다. 소프트웨어 자유로운 사용 · 수정 · 재배포가 가능하며, 원본 저작권 표기는 유지되어야 합니다.',
      viewInRepo: '저장소에서 LICENSE 파일 보기'
    }
  },
  app: {
    appNameExtension: '익스텐션',
    appNameDesktop: '데스크탑',
    inUseBy: (appName: string) => `${appName}에서 사용 중`,
    inUseDesc:
      '이 세션은 다른 앱에서 라이브로 열려 있습니다. 충돌을 막기 위해 여기서는 열지 않습니다. 상대 앱에서 세션을 닫은 뒤 아래 버튼으로 이어서 여세요.',
    reopen: '다시 열기',
    noActiveSession: '활성 세션 없음',
    noActiveSessionDesc: '좌 사이드바에서 워크스페이스를 열거나 "+ 모델"로 새 탭을 추가하세요',
    confirmDeleteWorkspace: (title: string) =>
      `"${title}" 워크스페이스 전체를 삭제합니다. 되돌릴 수 없습니다. 진행할까요?`,
    orphanCleaned: (n: number) =>
      `빈 세션 ${n}개가 강제 종료로 native 영속화되지 않아 자동 정리되었습니다.`,
    errInUse: '다른 앱에서 사용 중입니다.',
    errStillInUse: '아직 다른 앱에서 사용 중입니다. 상대 앱에서 세션을 닫은 뒤 다시 시도하세요.'
  },
  titleBar: {
    openLeft: '좌 사이드바 열기',
    openRight: '우 사이드바 열기'
  },
  home: {
    subtitle: '메시지를 입력하고 모델을 선택해 새 워크스페이스를 시작하세요.',
    placeholder: '무엇을 도와드릴까요?',
    startHint: 'Enter로 시작',
    start: '시작',
    startDisabledTitle: '메시지와 사용 가능한 모델을 선택하세요',
    modelSelect: '모델 선택',
    cliNotInPath: (label: string) => `${label} CLI가 PATH에 없음`,
    notInstalled: '미설치'
  },
  rightSidebar: {
    collapse: '우 사이드바 접기',
    noSelection: '선택 없음',
    empty: '좌측에서 워크스페이스를 열면 현재 메모리(IR) 상태가 여기에 표시됩니다.',
    shellNoMemory: '메모리 없음',
    shellNoMemorySub: '일반 터미널 세션 — AgentBridge가 컨텍스트를 추적하지 않습니다.'
  },
  codexTrust: {
    heading: 'codex `/hooks` 수동 승인 필요',
    approving: '...',
    approved: 'codex에서 trust 승인 완료'
  },
  leftSidebar: {
    collapse: '사이드바 접기',
    toHome: '홈 화면으로',
    home: '홈',
    newWorkspace: '새 워크스페이스',
    pathLabel: '경로',
    nameOptional: '이름 (선택)',
    folderNamePlaceholder: '폴더명',
    modelLabel: '모델',
    create: '만들기',
    cliNotInstalledRestart: (model: string) => `${model} CLI 미설치 — 설치 후 앱 재시작`,
    sectionActive: '활성',
    noWorkspaces: '워크스페이스 없음 — 상단에서 생성',
    collapseTree: '접기',
    expandTree: '펼치기',
    noResumableSession: '이어갈 수 있는 세션이 없음 — 모든 세션이 native 미영속화/CLI 미설치',
    addSession: '세션 추가',
    deleteWorkspace: '워크스페이스 삭제',
    noSessions: '세션 없음',
    inUseByOther: '다른 앱에서 사용 중',
    builtinTerminalShort: '내장 터미널 (zsh)',
    notPersistedNoResume: '모델 native 세션 미영속화 — resume 불가',
    cliNotInstalled: (label: string) => `${label} CLI 미설치`,
    openWorkspaceAndActivate: (label: string) => `워크스페이스 열기 + ${label} 활성`,
    inUseBadge: '사용 중',
    renameSession: '세션 이름 수정',
    deleteSessionTitle: '세션 삭제 (되돌릴 수 없음)',
    deleteSession: '세션 삭제',
    ctxOpen: '워크스페이스 열기',
    ctxOpenNewWindow: '새 창으로 열기',
    ctxRename: '이름 수정',
    ctxDelete: '삭제'
  },
  sessionTabs: {
    memoryInjectDisabled: (reason: string) => `메모리 주입 비활성 — ${reason}`,
    memoryDisabledBadge: '메모리 비활성',
    closeTabTitle: '탭 닫기 (사이드바에서 다시 열 수 있음)',
    closeTab: '탭 닫기',
    moreCount: (n: number) => `${n}개 더 보기`,
    moreTabs: '더 많은 탭',
    addModelTab: '다른 모델 탭 추가',
    addModel: '+ 모델'
  },
  time: {
    never: '아직 없음',
    justNow: '방금',
    secondsAgo: (n: number) => `${n}초 전`,
    minutesAgo: (n: number) => `${n}분 전`,
    hoursAgo: (n: number) => `${n}시간 전`,
    daysAgo: (n: number) => `${n}일 전`
  },
  mem: {
    panelAria: '메모리 패널',
    groupInstructions: 'AI 지시',
    groupMemory: '메모리',
    infoTip:
      'AgentBridge 메모리(IR)는 `/clear` 후에도 다음 메시지에 자동 재주입됩니다.\n메모리 자체를 비우려면 휴지통 버튼으로 초기화하세요.',
    infoTipAria: '메모리 동작 안내',
    refineNow: '지금 정제',
    resetMemory: '메모리 초기화',
    prevSnapshots: '이전 스냅샷',
    collapse: '접기',
    archiveMore: (n: number) => `+ ${n}개 더보기`,
    snapshotDetailTitle: '메모리 스냅샷',
    currentMemoryTitle: '현재 메모리',
    lastRefined: (abs: string) => `마지막 정제 · ${abs}`,
    refineFailed: '정제 실패',
    refineWarn: (e: string) => `경고: ${e}`,
    resetFailed: '초기화 실패',
    restoreFailed: '복원 실패',
    snapshotDeleteFailed: '스냅샷 삭제 실패',
    confirmDeleteCurrentWithArchive:
      '현재 메모리를 비우고 가장 최신 스냅샷을 현재 메모리로 복원합니다.\n복원된 스냅샷은 archive 목록에서 제거됩니다. 계속할까요?',
    confirmDeleteCurrentNoArchive:
      '현재 메모리를 비웁니다 (archive 스냅샷 없음 — 빈 메모리로 전환). 계속할까요?',
    confirmDeleteSnapshot: (abs: string) =>
      `이 스냅샷을 삭제합니다 (${abs}).\n되돌릴 수 없습니다. 계속할까요?`,
    resetBody:
      '현재 워크스페이스의 IR(요약 메모리)을 비웁니다. 되돌릴 수 없습니다. archive 스냅샷은 보존됩니다.',
    resetAlsoTurns: '최근 turn 기록(turns.jsonl)도 함께 초기화',
    resetting: '초기화 중…',
    reset: '초기화',
    noWorkspacePath: '워크스페이스 경로가 없습니다.',
    notCreated: '미생성',
    openInEditor: '에디터에서 열기',
    createEmptyAndOpen: '빈 파일 생성 후 열기',
    create: '만들기',
    refinePolicy: '정제 정책',
    policyPriority: '기본 (우선순위)',
    policyFixed: '고정',
    policyActiveHeadless: '활성 모델 헤드리스',
    policyOff: '정제 끔',
    sevUnknown: '미감지',
    sevOk: 'OK',
    sevWarn: '주의',
    sevCritical: '임박',
    sevExceeded: '초과',
    nextRefineCli: (label: string) => `${label} · 다음 refine에 사용될 CLI`,
    forcedFallbackNote: '응답 에러로 폴백 마킹됨 (UTC 자정 해제)',
    aggregating: '집계 중…',
    willAutoRefine: '곧 자동 정제됨',
    untilNextRefine: '다음 정제까지',
    noIrYet: '아직 IR이 생성되지 않았습니다. 대화 시작 후 자동 정제 또는 우측 위 ✨로 수동 정제.',
    goalUnset: '(목표 미설정)',
    sectionGoal: '목표',
    sectionDecisions: '결정',
    sectionFiles: '파일',
    sectionCommands: '명령',
    sectionTests: '테스트',
    sectionPending: '할 일',
    clearCurrentTitle: '현재 메모리 비우기 (archive 최신 스냅샷 복원)',
    clearCurrent: '현재 메모리 비우기',
    snapshotEyebrow: '스냅샷',
    total: (n: number) => `총 ${n}`,
    deleteSnapshotTitle: '이 스냅샷 삭제',
    deleteSnapshot: '스냅샷 삭제',
    detailAria: '메모리 상세',
    loading: '불러오는 중…',
    noIrToShow: '표시할 IR이 없습니다.',
    role: '역할',
    next: '다음',
    blocked: '막힘',
    empty: '(없음)',
    testStatus: {
      passed: '통과',
      failed: '실패',
      pending: '대기',
      skipped: '스킵'
    }
  },
  profile: {
    tabIr: '단기 · IR',
    tabProfile: '장기 · 메모리',
    panelAria: '장기 메모리 패널',
    profileLabel: 'default',
    openFolder: '폴더 열기',
    openFolderTitle: '프로필 폴더 열기 (수동 .md 편집)',
    queueTitle: '제안 승인 큐',
    queueEmpty: '대기 중인 제안이 없습니다',
    docsTitle: '프로필 문서',
    docsEmpty: '아직 문서가 없습니다. 쓸수록 자동으로 채워집니다.',
    approve: '승인',
    discard: '버림'
  },
  xterm: {
    dropPathFailed: '파일 경로 추출 실패',
    attachFailed: '첨부 실패',
    someRejected: (reasons: string) => `일부 거부: ${reasons}`,
    attachTitle: '+ 파일 첨부',
    pasteAbsoluteShell: '절대 경로 paste',
    pasteAbsoluteMention: '@절대경로 paste'
  }
}

export type Messages = typeof ko
