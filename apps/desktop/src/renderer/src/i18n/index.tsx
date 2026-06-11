// 데스크탑 렌더러 i18n — 직접 만든 미니 t() (라이브러리 미사용).
// 동작: settings.language를 읽어 해당 언어 메시지 테이블을 context로 흘린다.
// 토글 시 main이 settings:set 직후 SettingsUpdated를 broadcast → onUpdated가 lang을 갱신 →
// context value가 바뀌어 useT() 소비자 전체가 재렌더된다(멀티 윈도우 포함).
import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { LanguageCode } from '@shared/ipc'
import { ko, type Messages } from './ko'
import { en } from './en'

export type { Messages } from './ko'

const TABLES: Record<LanguageCode, Messages> = { ko, en }

const I18nContext = createContext<Messages>(ko)
const LangContext = createContext<LanguageCode>('ko')

export function LanguageProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [lang, setLang] = useState<LanguageCode>('ko')

  useEffect(() => {
    window.agentbridge.settings
      .get()
      .then((s) => setLang(s.language))
      .catch(() => undefined)
    const off = window.agentbridge.settings.onUpdated((s) => setLang(s.language))
    return off
  }, [])

  return (
    <LangContext.Provider value={lang}>
      <I18nContext.Provider value={TABLES[lang]}>{children}</I18nContext.Provider>
    </LangContext.Provider>
  )
}

// 현재 언어의 메시지 객체를 반환한다. 사용: const t = useT(); t.settings.titles.main
// 보간이 필요한 값은 함수다: t.settings.updater.available(version)
export function useT(): Messages {
  return useContext(I18nContext)
}

// 현재 언어 코드. 리치 마크업(<code>/<strong>)이 섞여 문자열 테이블에 못 담는
// 콘텐츠를 언어별 JSX로 분기할 때 쓴다. 예: const lang = useLang(); lang === 'en' ? <En/> : <Ko/>
export function useLang(): LanguageCode {
  return useContext(LangContext)
}
