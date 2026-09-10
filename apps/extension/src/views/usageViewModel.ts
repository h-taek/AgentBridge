// 사용량 줄이 그릴 것을 계산한다. 순수 함수라 웹뷰도 vscode도 모른다.
//
// 웹뷰 스크립트는 템플릿 문자열 안이라 tsc가 안 본다. 판정은 전부 여기서 하고 웹뷰는 받은 것을
// 그리기만 한다. 문구 조립(l10n)은 호출부 몫이라 여기서는 숫자만 준다.

import modelColors from '@agentbridge/assets/colors.json';
import { CLI_DISPLAY_NAME, CLI_KINDS, type CliKind, type UsageSnapshot } from '@agentbridge/core';
import type { UsageMap } from '../core/usage/usageStore';

/** 줄 안쪽 폭이 이보다 좁으면 숫자를 알약 밑선에 겹친다. */
export const NARROW_BELOW_PX = 265;

/** 잔량이 이보다 적으면 숫자만 빨갛게 한다. 알약 색은 건드리지 않는다. */
export const WARN_BELOW_PERCENT = 15;

export interface UsageTooltip {
  cliLabel: string;
  sessionRemaining: number | null;
  weeklyRemaining: number | null;
  /** 5시간 창 회복까지 남은 ms. 이미 지났으면 0, 벤더가 안 주면 null. */
  resetsInMs: number | null;
}

export interface UsageMeterView {
  cli: CliKind;
  color: string;
  /** 0~1. 채움 길이의 근거이며 반올림하지 않는다. */
  fillRatio: number;
  /** 알약 옆·아래에 쓸 문구. 값이 없으면 대시. */
  label: string;
  warn: boolean;
  dim: boolean;
  tooltip: UsageTooltip;
}

export interface UsageStripView {
  hidden: boolean;
  mode: 'wide' | 'narrow';
  meters: UsageMeterView[];
}

const COLORS = modelColors as Record<CliKind, string>;

const windowOf = (s: UsageSnapshot, id: 'session' | 'weekly') =>
  s.windows.find((w) => w.id === id);

const remainingOf = (usedPercent: number): number => Math.min(100, Math.max(0, 100 - usedPercent));

function meter(cli: CliKind, snapshot: UsageSnapshot, now: number): UsageMeterView {
  const session = snapshot.status === 'ok' ? windowOf(snapshot, 'session') : undefined;
  const weekly = snapshot.status === 'ok' ? windowOf(snapshot, 'weekly') : undefined;

  const sessionRemaining = session ? remainingOf(session.usedPercent) : null;
  const resetsAt = session?.resetsAt ?? null;

  return {
    cli,
    color: COLORS[cli],
    fillRatio: sessionRemaining === null ? 0 : sessionRemaining / 100,
    label: sessionRemaining === null ? '—' : `${Math.round(sessionRemaining)}%`,
    warn: sessionRemaining !== null && sessionRemaining < WARN_BELOW_PERCENT,
    dim: sessionRemaining === null,
    tooltip: {
      cliLabel: CLI_DISPLAY_NAME[cli],
      sessionRemaining,
      weeklyRemaining: weekly ? remainingOf(weekly.usedPercent) : null,
      resetsInMs: resetsAt === null ? null : Math.max(0, resetsAt - now),
    },
  };
}

export function buildUsageStrip(map: UsageMap, widthPx: number, now: number): UsageStripView {
  // 자격증명이 없는 CLI는 맵에 없다. 화면에서도 아예 뺀다.
  const meters = CLI_KINDS.flatMap((cli) => {
    const snapshot = map[cli];
    return snapshot ? [meter(cli, snapshot, now)] : [];
  });
  return {
    hidden: meters.length === 0,
    mode: widthPx < NARROW_BELOW_PX ? 'narrow' : 'wide',
    meters,
  };
}
