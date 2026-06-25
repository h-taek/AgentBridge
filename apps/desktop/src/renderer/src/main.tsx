import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import modelColors from '@agentbridge/assets/colors.json'
import App from './App'
import { LanguageProvider } from './i18n'

// 모델 색 단일 원본(@agentbridge/assets/colors.json)을 :root --model-* 변수로 주입.
// dot·탭·로딩 화면 등 모든 CSS가 var(--model-*)로 이 값을 참조한다.
const rootStyle = document.documentElement.style
for (const [model, color] of Object.entries(modelColors)) {
  rootStyle.setProperty(`--model-${model}`, color)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>
)
