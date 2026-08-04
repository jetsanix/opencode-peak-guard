/**
 * opencode-cost-guard — TUI plugin.
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
 * - A keymap layer (priority above the host default, `mode: "base"`) binds
 *   Enter to our own command. The binding's default `preventDefault` /
 *   `fallthrough` semantics consume the key, so the host submit never runs
 *   on its own.
 * - When the prompt is not focused (permission/question prompts, other
 *   textareas) Enter is forwarded via `input.submit` so native behavior is
 *   preserved. While the host gates the prompt (pending permission or
 *   question) native Enter does nothing, and we mirror that.
 * - Modals push the `"modal"` keymap mode, so our "base"-scoped binding is
 *   inactive while any dialog is open (including our own DialogSelect).
 */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPromptRef,
  TuiSlotContext,
} from "@opencode-ai/plugin/tui"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
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

const ENTER_COMMAND = "costguard.enter"
const FORCE_COMMAND = "costguard.force"

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

  const layerDispose = api.keymap.registerLayer({
    priority: 10_000,
    mode: "base",
    bindings: [
      { key: "return", cmd: ENTER_COMMAND },
      ...(options.forceKey
        ? [{ key: options.forceKey, cmd: FORCE_COMMAND }]
        : []),
    ],
    commands: [
      {
        name: ENTER_COMMAND,
        run: () => {
          void handleEnter(api, options, state)
        },
      },
      {
        name: FORCE_COMMAND,
        run: () => {
          void handleForce(api, state)
        },
      },
    ],
  })

  api.lifecycle.onDispose(() => {
    layerDispose()
  })
}

async function handleEnter(
  api: TuiPluginApi,
  options: CostGuardOptions,
  state: GuardState,
): Promise<void> {
  if (state.dialogOpen || api.ui.dialog.open) return
  const ref = state.promptRef

  // Some other input is focused (e.g. the permission prompt): forward Enter
  // so native behavior is preserved. `input.submit` is the managed-textarea
  // command that the default Enter binding dispatches.
  if (!ref?.focused) {
    const focused = api.renderer.currentFocusedEditor
    if (
      focused instanceof TextareaRenderable ||
      focused instanceof InputRenderable
    ) {
      await api.keymap.dispatchCommand("input.submit")
    }
    return
  }

  // The host disables the prompt while permission/question prompts are
  // pending; native Enter then does nothing. Mirror that (parity).
  const sessionID = state.sessionID
  const hasPendingGate =
    sessionID !== undefined &&
    (api.state.session.permission(sessionID).length > 0 ||
      api.state.session.question(sessionID).length > 0)
  if (hasPendingGate) return

  const model = sessionID ? api.state.session.get(sessionID)?.model : undefined
  if (!isTargetProvider(model?.providerID, options.providers)) {
    ref.submit()
    return
  }

  const now = new Date()
  if (!isPeakTime(now, options)) {
    ref.submit()
    return
  }

  const offPeakLabel = formatScheduleClock(
    nextOffPeakEnd(now, options),
    options.tzOffsetHours,
  )

  if (options.dryRun) {
    ref.submit()
    api.ui.toast({
      variant: "info",
      title: "Cost Guard (dry-run)",
      message: `Peak pricing x${options.multiplier} active for ${model?.providerID}. Would offer to wait until ${offPeakLabel}. Sent anyway.`,
    })
    return
  }

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
  id: "opencode-cost-guard",
  tui: CostGuard,
}
