/**
 * opencode-peak-guard — TUI plugin.
 *
 * Intercepts Enter on the session prompt while the active model's provider
 * is in a peak-pricing window (DeepSeek: 09:00-12:00 / 14:00-18:00 Beijing
 * time, all billing items x2). When peak pricing is active the user is
 * asked how to proceed:
 *
 *   1. Send now                — submit at the peak price,
 *   2. Auto-submit at off-peak — lock the draft; it is sent automatically
 *      when the current peak window ends (requires opencode to stay
 *      running). While locked, Enter cannot submit: it opens this dialog
 *      again so the lock can be managed,
 *   3. Wait until off-peak     — keep the draft; nothing is sent,
 *   4. Cancel                  — keep the draft, do not send.
 *
 * Implementation notes (verified against opencode 1.18.x source and by
 * end-to-end testing in the TUI):
 * - The `session_prompt` slot (mode "replace") is registered so the host
 *   `ui.Prompt` keeps rendering (identical UI) while we capture its
 *   `TuiPromptRef` (focused / submit / focus / set).
 * - Host UI components are invoked as plain function calls
 *   (`api.ui.Prompt({...})`, `api.ui.DialogSelect({...})`) instead of JSX.
 *   opencode loads plugins with bun's plain `import()`; bun's TSX
 *   transpilation resolves the JSX runtime from the CWD project config and
 *   defaults to React, so `.tsx` plugin sources fail to load unless
 *   pre-compiled. Direct calls sidestep the JSX runtime entirely and match
 *   how the published oh-my-opencode-slim plugin ships.
 * - opencode's plugin entry resolution only considers `exports["./tui"]`
 *   for TUI plugins (or an index file at the package root), so package.json
 *   must expose a `./tui` subpath export.
 * - Enter is intercepted with a key intercept hook (`api.keymap.intercept`,
 *   priority above the host default) instead of a keymap binding. A binding
 *   unconditionally consumes the key once it matches, which shadows the
 *   host's own `return` binding on the permission/question prompts (the host
 *   binds `return` to confirm permission selection at default priority) and
 *   breaks Enter-to-confirm. An intercept hook lets us decide per-keypress:
 *   consume the key only when the session prompt is focused, not gated, and
 *   the provider is inside a peak window; otherwise pass the key through so
 *   the host handles it natively (submit the prompt, confirm a permission,
 *   etc.).
 * - While any modal dialog is open (including our own DialogSelect) the
 *   dialog guard makes us pass Enter through to the host.
 */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPromptRef,
  TuiSlotContext,
} from "@opencode-ai/plugin/tui"
import type { CostGuardOptions } from "./config"
import { resolveOptions } from "./config"
import {
  formatScheduleClock,
  isPeakTime,
  isTargetProvider,
  msUntilOffPeak,
  nextOffPeakEnd,
} from "./peak"

export interface CostGuardPluginOptions {
  providers?: string[]
  windows?: [number, number][]
  multiplier?: number
  tzOffsetHours?: number
  dryRun?: boolean
  forceKey?: string
}

const FORCE_COMMAND = "costguard.force"

/**
 * Structural subset of the keymap `intercept("key", ...)` context that this
 * plugin relies on (the full type comes from @opentui/keymap).
 */
type KeyInterceptContext = {
  event: {
    name: string
    eventType: string
    ctrl: boolean
    meta: boolean
    shift: boolean
    option: boolean
    super?: boolean
  }
  consume: (options?: { preventDefault?: boolean; stopPropagation?: boolean }) => void
}

/** Props the host passes to the `session_prompt` slot renderer. */
type SessionPromptSlotProps = {
  session_id: string
  visible?: boolean
  disabled?: boolean
  on_submit?: () => void
  ref?: (ref: TuiPromptRef | undefined) => void
}

/** Mutable state shared between the plugin closure and the command handlers. */
interface GuardState {
  promptRef: TuiPromptRef | undefined
  sessionID: string | undefined
  dialogOpen: boolean
  /** Last `disabled` prop seen by the slot renderer (host gates the prompt). */
  promptDisabled: boolean
  /** Pending auto-submit timer (the "Auto-submit at off-peak" choice). */
  autoSubmitTimer: ReturnType<typeof setTimeout> | undefined
  /** Session the pending auto-submit was scheduled for. */
  autoSubmitSessionID: string | undefined
  /** Retry count while a dialog/gate blocks the auto-submit. */
  autoSubmitAttempts: number
}

/** Retry cadence while a modal dialog or host gate blocks the auto-submit. */
const AUTO_SUBMIT_RETRY_MS = 5_000

/** Give up after this many retries (~1 minute of blocked submission). */
const AUTO_SUBMIT_MAX_RETRIES = 12

export const CostGuard: TuiPlugin = async (api, rawOptions) => {
  const options: CostGuardOptions = resolveOptions(rawOptions)
  const state: GuardState = {
    promptRef: undefined,
    sessionID: undefined,
    dialogOpen: false,
    promptDisabled: false,
    autoSubmitTimer: undefined,
    autoSubmitSessionID: undefined,
    autoSubmitAttempts: 0,
  }

  api.slots.register({
    slots: {
      // Direct component call (no JSX): see file header for rationale.
      session_prompt: (
        _ctx: Readonly<TuiSlotContext>,
        props: SessionPromptSlotProps,
      ) => {
        state.sessionID = props.session_id
        state.promptDisabled = props.disabled === true
        return api.ui.Prompt({
          sessionID: props.session_id,
          visible: props.visible,
          disabled: props.disabled,
          ref: (ref) => {
            state.promptRef = ref
            props.ref?.(ref)
          },
          // Any real submission (Enter, force key, our auto-submit) cancels a
          // pending auto-submit timer so a draft is never sent twice.
          onSubmit: () => {
            cancelAutoSubmit(state)
            props.on_submit?.()
          },
        })
      },
    },
  })

  // Intercept Enter at a priority above the host's layers. Unlike a keymap
  // binding — which consumes the key whenever it matches — the hook can pass
  // the key through to the host unless the cost guard actually wants to act:
  // a plain `return` binding here would shadow the host's own `return` →
  // "confirm permission" binding (default priority 0) and make it impossible
  // to confirm permission prompts with Enter.
  const offIntercept = api.keymap.intercept(
    "key",
    (ctx: KeyInterceptContext) => {
      void handleKey(api, options, state, ctx)
    },
    { priority: 10_000 },
  )

  // The force key stays a keymap binding: it is a non-conflicting key, and
  // the keymap engine does the exact key matching for us.
  const layerDispose = api.keymap.registerLayer({
    priority: 10_000,
    mode: "base",
    bindings: options.forceKey
      ? [{ key: options.forceKey, cmd: FORCE_COMMAND }]
      : [],
    commands: [
      {
        name: FORCE_COMMAND,
        run: () => {
          void handleForce(api, state)
        },
      },
    ],
  })

  api.lifecycle.onDispose(() => {
    offIntercept()
    layerDispose()
    cancelAutoSubmit(state)
  })
}

async function handleKey(
  api: TuiPluginApi,
  options: CostGuardOptions,
  state: GuardState,
  ctx: KeyInterceptContext,
): Promise<void> {
  // Only plain Enter presses — mirror the old `{ key: "return" }` binding,
  // which matches a modifier-less return keypress.
  const event = ctx.event
  if (event.eventType !== "press" || event.name !== "return") return
  if (event.ctrl || event.meta || event.shift || event.option || event.super) return

  // A dialog is open (including our own DialogSelect): the host handles keys
  // in "modal" mode; never intercept.
  if (state.dialogOpen || api.ui.dialog.open) return
  const ref = state.promptRef

  // Some other input is focused (permission/question docks, other textareas):
  // pass Enter through so the host handles it natively — the permission
  // prompt binds `return` to confirm its selected option.
  if (!ref?.focused) return

  // The host gates the prompt while permission/question prompts are pending;
  // pass Enter through and keep native behavior.
  const sessionID = state.sessionID
  const hasPendingGate =
    sessionID !== undefined &&
    (api.state.session.permission(sessionID).length > 0 ||
      api.state.session.question(sessionID).length > 0)
  if (hasPendingGate) return

  const model = sessionID ? api.state.session.get(sessionID)?.model : undefined
  if (!isTargetProvider(model?.providerID, options.providers)) return

  const now = new Date()
  if (!isPeakTime(now, options)) return

  const offPeakLabel = formatScheduleClock(
    nextOffPeakEnd(now, options),
    options.tzOffsetHours,
  )

  if (options.dryRun) {
    api.ui.toast({
      variant: "info",
      title: "Cost Guard (dry-run)",
      message: `Peak pricing x${options.multiplier} active for ${model?.providerID}. Would offer to wait until ${offPeakLabel}. Sent anyway.`,
    })
    // Do not consume: let the host submit normally.
    return
  }

  // Consume the key (synchronously) so the host's submit binding never runs,
  // then offer the peak-pricing choice instead.
  ctx.consume()

  // A lock is already pending for this session: the dialog is a way to
  // reschedule or release it (Enter can never submit while locked).
  const lockPending = state.autoSubmitSessionID === sessionID

  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect({
        title: `${providerLabel(model?.providerID)} peak pricing is active (x${options.multiplier})${
          lockPending ? ` — auto-submit pending until ${offPeakLabel}` : ""
        }`,
        placeholder: "How do you want to proceed?",
        options: [
          {
            title: "Send now",
            value: "now",
            description: `Submit immediately at x${options.multiplier} the normal price`,
          },
          {
            title: lockPending ? "Reschedule auto-submit" : "Auto-submit at off-peak",
            value: "auto",
            description: `Lock the draft; send automatically at ${offPeakLabel} (Beijing time) when the peak window ends`,
          },
          {
            title: "Wait until off-peak",
            value: "wait",
            description: `Keep the draft; resume after ${offPeakLabel} (Beijing time)`,
          },
          {
            title: "Cancel",
            value: "cancel",
            description: "Keep the draft and do not send",
          },
        ],
        onSelect: (option) => {
          api.ui.dialog.clear()
          const prompt = state.promptRef
          cancelAutoSubmit(state)
          if (option.value === "now") {
            prompt?.submit()
          } else if (option.value === "auto") {
            scheduleAutoSubmit(api, options, state)
            prompt?.focus()
          } else if (option.value === "wait") {
            api.ui.toast({
              variant: "info",
              title: "Draft kept",
              message: `Off-peak resumes at ${offPeakLabel} (Beijing time). Press Enter to send later.`,
            })
            prompt?.focus()
          } else {
            prompt?.focus()
          }
        },
      }),
    () => {
      state.dialogOpen = false
    },
  )
  state.dialogOpen = true
}

/** Force-send the draft, skipping the peak-pricing gate. */
async function handleForce(api: TuiPluginApi, state: GuardState): Promise<void> {
  const ref = state.promptRef
  if (api.ui.dialog.open || !ref?.focused) return
  ref.submit()
}

/** Drop a pending auto-submit timer (if any) and reset its bookkeeping. */
function cancelAutoSubmit(state: GuardState): void {
  if (state.autoSubmitTimer !== undefined) {
    clearTimeout(state.autoSubmitTimer)
    state.autoSubmitTimer = undefined
  }
  state.autoSubmitSessionID = undefined
  state.autoSubmitAttempts = 0
}

/**
 * Schedule the draft to be submitted when the current peak window ends.
 * The timer is keyed to the session that was active when scheduled.
 */
function scheduleAutoSubmit(
  api: TuiPluginApi,
  options: CostGuardOptions,
  state: GuardState,
): void {
  const now = new Date()
  const offPeak = nextOffPeakEnd(now, options)
  state.autoSubmitSessionID = state.sessionID
  state.autoSubmitAttempts = 0
  state.autoSubmitTimer = setTimeout(() => {
    state.autoSubmitTimer = undefined
    void fireAutoSubmit(api, options, state, offPeak)
  }, msUntilOffPeak(now, options))

  api.ui.toast({
    variant: "info",
    title: "Draft locked",
    message: `The draft is locked until ${formatScheduleClock(offPeak, options.tzOffsetHours)} (Beijing time); it will be sent automatically. Press Enter to manage the lock.`,
  })
}

/**
 * Fire the scheduled auto-submit. Submits only when it is safe and still
 * meaningful to do so; otherwise gives up with a toast (the draft is never
 * sent at peak price, twice, or into the wrong session).
 */
async function fireAutoSubmit(
  api: TuiPluginApi,
  options: CostGuardOptions,
  state: GuardState,
  offPeak: Date,
): Promise<void> {
  const prompt = state.promptRef

  // The scheduled session is no longer active: the draft may belong to a
  // different conversation now. Keep it; do not submit.
  if (!prompt || state.sessionID !== state.autoSubmitSessionID) {
    api.ui.toast({
      variant: "info",
      title: "Auto-submit skipped",
      message: "The active session changed; your draft was kept.",
    })
    return
  }

  // Safety net for pathological configurations (e.g. a 24h peak window where
  // the computed "off-peak" moment is still inside a window): never send at
  // the peak price.
  if (isPeakTime(new Date(), options)) {
    api.ui.toast({
      variant: "warning",
      title: "Still peak pricing",
      message: "Peak pricing is still active; your draft was kept.",
    })
    return
  }

  if (prompt.current.input.trim().length === 0) {
    api.ui.toast({
      variant: "info",
      title: "Auto-submit skipped",
      message: "The draft is empty; nothing was sent.",
    })
    return
  }

  // A modal dialog or a host gate (pending permission/question, generation in
  // flight) blocks submission right now. Retry shortly, then give up.
  if (api.ui.dialog.open || state.promptDisabled) {
    if (state.autoSubmitAttempts < AUTO_SUBMIT_MAX_RETRIES) {
      state.autoSubmitAttempts += 1
      state.autoSubmitTimer = setTimeout(() => {
        state.autoSubmitTimer = undefined
        void fireAutoSubmit(api, options, state, offPeak)
      }, AUTO_SUBMIT_RETRY_MS)
    } else {
      api.ui.toast({
        variant: "warning",
        title: "Auto-submit gave up",
        message: "A dialog or pending prompt blocked submission; your draft was kept.",
      })
    }
    return
  }

  state.autoSubmitSessionID = undefined
  prompt.submit()
  api.ui.toast({
    variant: "success",
    title: "Sent at off-peak",
    message: `Draft submitted automatically at ${formatScheduleClock(new Date(), options.tzOffsetHours)} (Beijing time).`,
  })
}

function providerLabel(providerID: string | undefined): string {
  if (!providerID) return "Model"
  return providerID.charAt(0).toUpperCase() + providerID.slice(1)
}

/**
 * opencode loads plugins through the default export. For TUI plugins the
 * default export must be an object with `tui()`; file-based plugins must
 * also export `id`.
 */
export default {
  id: "opencode-peak-guard",
  tui: CostGuard,
}
