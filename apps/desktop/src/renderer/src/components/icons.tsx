// Liquid Glass UI — inline SVG icons. stroke 기반, 1.6px, currentColor.

import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

export function SidebarLeftIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  )
}

export function SidebarRightIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </svg>
  )
}

export function GearIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.3 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}

export function ChevronRightIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <polyline points="9 6 15 12 9 18" />
    </svg>
  )
}

export function PlusIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

export function FolderIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

export function TrashIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

export function CloseIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  )
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <polyline points="21 12 21 6 15 6" />
      <path d="M21 6a9 9 0 1 1-3 6.7" />
    </svg>
  )
}

export function PencilIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M4 20h4l11-11a2.5 2.5 0 0 0-3.5-3.5L4 16.5V20z" />
      <line x1="14" y1="6" x2="18" y2="10" />
    </svg>
  )
}

export function HomeIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M3 11.5L12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
    </svg>
  )
}

export function InfoIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12" y2="8.01" />
    </svg>
  )
}

export function ThemeIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="3" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="21" />
      <line x1="3" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="21" y2="12" />
      <line x1="5.6" y1="5.6" x2="7" y2="7" />
      <line x1="17" y1="17" x2="18.4" y2="18.4" />
      <line x1="5.6" y1="18.4" x2="7" y2="17" />
      <line x1="17" y1="7" x2="18.4" y2="5.6" />
    </svg>
  )
}

export function GlobeIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  )
}

export function DatabaseIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  )
}

export function KeyboardIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <line x1="6" y1="10" x2="6.01" y2="10" />
      <line x1="10" y1="10" x2="10.01" y2="10" />
      <line x1="14" y1="10" x2="14.01" y2="10" />
      <line x1="18" y1="10" x2="18.01" y2="10" />
      <line x1="7" y1="14" x2="17" y2="14" />
    </svg>
  )
}

export function HelpIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 3.5" />
      <line x1="12" y1="17" x2="12" y2="17.01" />
    </svg>
  )
}

export function SparkleIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
      <path d="M19 16l.6 1.4L21 18l-1.4.6L19 20l-.6-1.4L17 18l1.4-.6z" />
    </svg>
  )
}

export function ArrowLeftIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  )
}

export function TerminalIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <polyline points="7 9 10 12 7 15" />
      <line x1="13" y1="15" x2="17" y2="15" />
    </svg>
  )
}

export function ArrowUpIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  )
}

export function ExternalLinkIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M14 4h6v6" />
      <line x1="10" y1="14" x2="20" y2="4" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  )
}
