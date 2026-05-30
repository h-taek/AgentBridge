# Shift+Enter ↔ 한글 IME race

xterm.js 기반 PTY 입력에서 Shift+Enter를 모델 TUI 줄바꿈 시퀀스(`\x1b\r`)로 매핑할 때, macOS 한글 IME composition 중 두 가지 깨짐 증상이 발생했다. 그 진단과 해결 과정을 기록한다.

코드: [src/renderer/src/components/XtermView.tsx](../../src/renderer/src/components/XtermView.tsx) — Shift+Enter 핸들러.

---

## 1. 문제

### 1.1 매핑 배경

모델 TUI(claude / codex / agy)는 입력박스 안에서:
- 단독 `\r` (Enter) → 메시지 submit
- `\x1b\r` (Option+Enter / ESC+CR) → 입력박스 내부 줄바꿈

macOS Terminal.app과 iTerm2의 기본 동작:
- Option 키 = Meta key 컨벤션 → Option+키 = `\x1b` prefix + 키 → Option+Enter = `\x1b\r`
- Shift+키는 modifier 무시 → Shift+Enter = `\r` (submit)

Shift+Enter로 줄바꿈을 의도한 사용자 경험을 위해 앱에서 직접 remap:
```
keydown(Shift+Enter) → preventDefault + pty.write('\x1b\r')
```

이 단순 매핑은 영어/공백 후엔 정상 동작.

### 1.2 한글 IME composition 중 증상

`한글 테스트 중입니다` 중 마지막 "다" composition 도중(공백 commit 전) Shift+Enter:
- (a) `\x1b\r`이 두 번 출력 → 줄바꿈이 두 번 발생
- (b) `"다"`가 두 줄바꿈 *뒤*에 입력 → 마지막 글자가 다음 줄로 끌려옴

영어 + 공백 + Shift+Enter는 정상. 한글 composition 중일 때만 깨짐.

---

## 2. 진단

XtermView.tsx에 일시적으로 디버그 instrumentation을 넣어 main.log로 흐름 추적:
- `term.onData` (PTY로 가는 모든 바이트)
- textarea의 `compositionstart` / `compositionupdate` / `compositionend` / `input`
- `attachCustomKeyEventHandler` 에 들어오는 모든 Enter 키 이벤트

### 2.1 결정적 로그 (한글 "력" composition 중 Shift+Enter 한 번)

```
T+4060.0ms  input              ← "력" composition 마지막 input
T+4461.0ms  keydown            ← Shift+Enter
T+4461.3ms  handler: emit \x1b\r
T+4461.9ms  compositionupdate "력"
T+4462.2ms  input
T+4462.3ms  compositionend "력"
T+4462.8ms  keyup
T+4463.0ms  keydown            ← !! 두 번째 keydown (IME 재발사)
T+4463.0ms  handler: emit \x1b\r
T+4469.5ms  term.onData → PTY "력"  ← 한글 commit된 글자가 PTY로
T+4544.0ms  keyup
```

### 2.2 결론

1. **macOS 한글 IME가 Shift+Enter keydown을 두 번 발사한다.** 사용자는 한 번 눌렀어도:
   - 첫 keydown — IME가 commit 신호로 받아들임
   - compositionend — commit 완료
   - 두 번째 keydown — IME가 enter를 재발사하여 textarea가 newline 처리하게 함 (macOS Korean IME 표준 동작)
2. **두 keydown 사이의 시간차는 ~2ms.** 사람 손으로는 불가능한 속도라 사용자 본인은 한 번 누른 줄 안다.
3. **commit된 글자는 두 keydown이 끝난 *후*에 `term.onData`로 흐른다.** compositionend(T+4462.3) → 두 번째 keydown(T+4463.0) → onData(T+4469.5).
4. **결과 PTY 바이트열**: `\x1b\r` → `\x1b\r` → `"력"`
5. **모델 입력박스 결과**: 줄바꿈 → 줄바꿈 → "력" → 사용자가 본 "한 줄 비어있고 다음 줄에 끌려간 글자".

핵심은 두 가지:
- **중복 emit** (IME 재발사 keydown으로 인한)
- **타이밍 race** (commit된 글자가 우리 `\x1b\r` *뒤에* 도착)

---

## 3. 시도하고 실패한 방법들

### 3.1 keyup에서 emit
가설: keydown↔keyup 사이에 IME가 commit 완료할 거라 keyup 시점에 emit하면 PTY 순서가 자연히 "글자 → `\x1b\r`".

결과: IME는 keyup *후*에 commit하는 케이스가 있고, 두 번째 keydown까지 발사된다. 효과 없음.

### 3.2 textarea blur/focus trick
가설: textarea.blur()는 IME 표준 동작으로 composition을 강제 commit시킴. blur + focus 후 `\x1b\r` emit.

결과: macOS 한글 IME에서는 글자 자체가 사라지는 부작용. IME state 손상.

### 3.3 `new KeyboardEvent('Escape')` dispatchEvent
가설: 실 키보드에서 ESC가 IME composition을 강제 commit시키므로, ESC KeyboardEvent를 dispatch해 동일 효과.

결과:
- dispatchEvent로 만든 이벤트는 `isTrusted: false` — macOS native input system이 IME에 전달 안 함. IME가 commit 안 함.
- 부작용으로 xterm.js의 ESC 처리 path가 동작해 `\x1b` 한 바이트가 PTY로 누출. 화면 더 깨짐.

### 3.4 공백 자동 prepend + 고정 지연
가설: Shift+Enter 시 `" "` + 100ms 후 `\x1b\r`을 보내면 IME가 그 사이 commit 완료할 시간 확보.

결과: 지연은 IME 처리 시간을 벌어주지만, 두 번째 keydown으로 인한 중복 emit과 잔여 `\r` leak이 그대로라 두 줄바꿈 증상 미해결.

---

## 4. 최종 해결 — 상태 머신 (이벤트 driven)

### 4.1 구조

```
Shift+Enter keydown 감지
  ├─ 50ms lock — 직전 emit 후 50ms 안의 두 번째 keydown(=IME 재발사) 무시
  └─ isComposingState 분기
      ├─ false (composition 없음) → 즉시 \x1b\r emit
      └─ true (composition 중)
          ├─ pendingShiftEnter = true
          ├─ 200ms fallback timer 시작
          └─ term.onData에 데이터 흐르면 (= commit된 글자 PTY로 흐름)
              → 그 직후 \x1b\r emit + pending = false + timer clear
```

### 4.2 핵심 결정

| 결정 | 이유 |
|---|---|
| `compositionstart`/`compositionend`로 `isComposingState` 직접 추적 | `e.isComposing` 플래그가 macOS 한글 IME에서 신뢰 불가 |
| keydown 시점의 `isComposingState` 값으로 분기 | "Shift+Enter가 발생한 그 순간의 composing 여부"를 snapshot |
| onData에서 commit된 글자 흐른 직후 emit | compositionend ↔ onData 사이 ~7ms 갭을 자연 흡수. 마법 숫자 없음 |
| 50ms lock | IME의 두 번째 keydown 재발사 흡수. 사람 입력 속도에는 영향 없음 |
| 200ms fallback timeout | composition 없거나 onData가 안 들어오는 예외 케이스 안전망 |
| `preventDefault` + `return false` | xterm.js의 default `\r` emit 차단 |

### 4.3 결과 PTY 시퀀스 (한글 commit 중 Shift+Enter 한 번)

```
"한글 입력" (입력 진행 중) →
사용자 Shift+Enter →
isComposingState=true → pending=true →
IME compositionend →
onData "력" → pty.write "력" → (pending 트리거) → pty.write "\x1b\r"

PTY 도착: "력" → "\x1b\r"
모델 입력박스: "한글 입력력" + 줄바꿈
```

영어/공백 후 Shift+Enter:
```
isComposingState=false → 즉시 pty.write "\x1b\r"
```

---

## 5. 알려진 한계

- macOS 환경 + 한글 IME에 대해서만 라이브 검증됨. Windows IME, 일본어 IME 등은 미검증. 기본 구조(compositionstart/end + onData 트리거)는 동일하게 동작할 가능성이 높지만, lock 시간(50ms) 또는 IME 재발사 패턴이 다를 수 있음.
- macOS Terminal.app은 native NSTextInputContext가 Option modifier를 "IME bypass"로 인식해 동일한 race가 없다. 우리는 Chromium textarea를 통과하므로 그 우회가 없어 직접 처리해야 한다.

## 6. 참조

- 코드: [src/renderer/src/components/XtermView.tsx](../../src/renderer/src/components/XtermView.tsx)
- xterm.js `attachCustomKeyEventHandler`: keydown/keypress/keyup 모두 가로채는 hook
- macOS Korean IME 동작: composition 중 enter 입력 시 commit + enter 재발사가 표준
