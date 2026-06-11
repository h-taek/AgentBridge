// 데스크탑 렌더러 i18n 문자열 — 한국어(소스 언어).
// en.ts가 `satisfies Messages`로 이 구조를 강제로 맞춘다(키 누락·시그니처 불일치 = 컴파일 에러).
// 주의: `as const`를 쓰지 않는다 — 쓰면 값이 리터럴 타입('닫기')으로 좁혀져 영어 값('Close')이 거부된다.

export const ko = {
  common: {
    close: '닫기',
    back: '뒤로',
    openInFinder: 'Finder에서 열기',
    pickFolder: '폴더 선택'
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
  }
}

export type Messages = typeof ko
