import { Loader2, RefreshCw } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '../../store'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import {
  getDisplayedUsagePercentage,
  normalizeUsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { barColor, clampUsedPercent } from './tooltip'
import { formatRateLimitWindowChipLabel } from '@/lib/window-label-formatter'
import { formatResetDuration } from '../../../../shared/rate-limit-reset-format'
import { formatUsagePercentageLabel } from './usage-percentage-label'
import { translate } from '@/i18n/i18n'

/** Keep account previews current without switching accounts or polling usage again. */
export function InlineUsageBars({
  limits,
  isFetching
}: {
  limits: ProviderRateLimits
  isFetching: boolean
}): React.JSX.Element {
  const display = normalizeUsagePercentageDisplay(
    useAppStore((state) => state.usagePercentageDisplay)
  )
  // Why: inactive accounts can have weekly limits without a session window.
  const now = useResetCountdownClock([
    limits.session?.resetsAt,
    limits.weekly?.resetsAt,
    limits.fableWeekly?.resetsAt
  ])
  // Why: rows compare several accounts at once, so every countdown keeps its window name.
  const withCountdown = (name: string, resetsAt: number | null): string =>
    resetsAt != null ? `${name} ${formatResetDuration(resetsAt - now)}` : name
  const usageWindows = [
    limits.session
      ? {
          key: 'session',
          used: clampUsedPercent(limits.session.usedPercent),
          // Why: live reset countdown (#5399); '5h' window length only when resetsAt is unknown.
          label:
            limits.session.resetsAt != null
              ? withCountdown(
                  translate('auto.components.status.bar.StatusBar.sessionWindow', 'Session'),
                  limits.session.resetsAt
                )
              : formatRateLimitWindowChipLabel(limits.session, now)
        }
      : null,
    limits.weekly
      ? {
          key: 'weekly',
          used: clampUsedPercent(limits.weekly.usedPercent),
          label: withCountdown(
            translate('auto.components.status.bar.StatusBar.5c938d39ac', 'wk'),
            limits.weekly.resetsAt
          )
        }
      : null,
    limits.fableWeekly
      ? {
          key: 'fableWeekly',
          used: clampUsedPercent(limits.fableWeekly.usedPercent),
          label: withCountdown(
            translate('auto.components.status.bar.StatusBar.54e8d6bb2d', 'Fable'),
            limits.fableWeekly.resetsAt
          )
        }
      : null
  ].filter((window): window is { key: string; used: number; label: string } => window !== null)

  // Why: a fixed two-line cell keeps every account row the same shape whether or not reset times are known.
  return (
    <div
      className={`grid w-full items-center gap-x-1.5 ${isFetching ? 'animate-pulse' : ''}`}
      style={{
        gridTemplateColumns: `repeat(${Math.max(1, usageWindows.length)}, minmax(0, 1fr))`
      }}
    >
      {usageWindows.map((window) => (
        <div key={window.key} className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1">
            <div className="h-[4px] min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              {/* Why: fill follows the selected percentage; color still signals consumption urgency. */}
              <div
                className={`h-full rounded-full ${barColor(window.used)}`}
                style={{ width: `${getDisplayedUsagePercentage(window.used, display)}%` }}
              />
            </div>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {formatUsagePercentageLabel(window.used, display)}
            </span>
          </div>
          <span className="truncate text-[10px] tabular-nums text-muted-foreground">
            {window.label}
          </span>
        </div>
      ))}
      {usageWindows.length === 0 && limits.status === 'error' ? (
        <span className="text-[10px] text-muted-foreground">
          {translate('auto.components.status.bar.StatusBar.f19a63e7cd', 'Sign in to see usage')}
        </span>
      ) : null}
    </div>
  )
}

export function isUnavailableInactiveUsage(limits: ProviderRateLimits | null | undefined): boolean {
  return limits?.status === 'error' && !limits.session && !limits.weekly && !limits.fableWeekly
}

export function InlineUsageSignInAction({
  isFetching,
  isSigningIn,
  disabled,
  onSignInPointerDown,
  onSignIn
}: {
  isFetching: boolean
  isSigningIn: boolean
  disabled: boolean
  onSignInPointerDown?: () => void
  onSignIn: () => void
}): React.JSX.Element {
  return (
    <div className={`flex w-full items-center gap-2 ${isFetching ? 'animate-pulse' : ''}`}>
      <span className="min-w-0 flex-1 text-[10px] text-muted-foreground">
        {translate('auto.components.status.bar.StatusBar.f19a63e7cd', 'Sign in to see usage')}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={disabled}
        className="h-6 shrink-0 px-2 text-muted-foreground hover:text-foreground"
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onSignInPointerDown?.()
        }}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onSignIn()
        }}
      >
        {isSigningIn ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
        {translate('auto.components.status.bar.StatusBar.c35af53b73', 'Sign in')}
      </Button>
    </div>
  )
}

export function InlineUsageSkeleton(): React.JSX.Element {
  return (
    <div className="flex w-full animate-pulse items-center gap-2">
      <div className="h-[4px] flex-1 rounded-full bg-muted" />
      <div className="h-[4px] flex-1 rounded-full bg-muted" />
    </div>
  )
}
