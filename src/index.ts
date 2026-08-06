/**
 * opencode-peak-guard — TUI plugin.
 *
 * Intercepts Enter on the session prompt while the active model's provider
 * is in a peak-pricing window (DeepSeek: 09:00-12:00 / 14:00-18:00 Beijing
 * time, all billing items x2). When peak pricing is active the user is
 * asked how to proceed:
 *
 *   1. Send now             — submit at the peak price,
 *   2. Wait until off-peak  — keep the draft; nothing is sent,
 *   3. Cancel               — keep the draft, do not send.
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
}

export const CostGuard: TuiPlugin = async (api, rawOptions) => {
  const options: CostGuardOptions = resolveOptions(rawOptions)
  const state: GuardState = {
    promptRef: undefined,
    sessionID: undefined,
    dialogOpen: false,
  }

  api.slots.register({
    slots: {
      // Direct component call (no JSX): see file header for rationale.
      session_prompt: (
        _ctx: Readonly<TuiSlotContext>,
        props: SessionPromptSlotProps,
      ) => {
        state.sessionID = props.session_id
        return api.ui.Prompt({
          sessionID: props.session_id,
          visible: props.visible,
          disabled: props.disabled,
          ref: (ref) => {
            state.promptRef = ref
            props.ref?.(ref)
          },
          onSubmit: props.on_submit,
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

  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect({
        title: `${providerLabel(model?.providerID)} peak pricing is active (x${options.multiplier})`,
        placeholder: "How do you want to proceed?",
        options: [
          {
            title: "Send now",
            value: "now",
            description: `Submit immediately at x${options.multiplier} the normal price`,
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
          if (option.value === "now") {
            prompt?.submit()
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
