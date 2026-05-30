import { useEffect, useRef, useState } from 'react'

// 인라인 편집 input — workspace/session 이름 수정용.
// 마운트 시 자동 focus + 전체 선택. Enter/blur는 저장, Esc는 취소.
// keydown은 stopPropagation 처리 — ⌘B 등 글로벌 단축키 충돌 방지.

type Props = {
  initialValue: string
  onSave: (value: string) => void
  onCancel: () => void
  className?: string
  placeholder?: string
  maxLength?: number
}

export function InlineRenameInput({
  initialValue,
  onSave,
  onCancel,
  className,
  placeholder,
  maxLength
}: Props): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const ref = useRef<HTMLInputElement>(null)
  const savedRef = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  const commit = (): void => {
    if (savedRef.current) return
    savedRef.current = true
    onSave(value)
  }

  return (
    <input
      ref={ref}
      type="text"
      className={className}
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          savedRef.current = true
          onCancel()
        }
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
    />
  )
}
