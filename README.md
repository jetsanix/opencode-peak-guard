# opencode-peak-guard

An [opencode](https://opencode.ai) **TUI plugin** that intercepts prompt
submission during **model peak-pricing windows** and offers to wait until
off-peak.

DeepSeek's official pricing page declares that during peak hours all billing
items are charged at **2x** the regular price. Peak hours are **09:00-12:00
and 14:00-18:00 Beijing time (UTC+8)**, daily. There is no API to query the
current price tier, so the schedule is computed locally from the clock.

## What it does

When you press **Enter** on the session prompt while the active model's
provider is in a peak window, instead of sending immediately you get a choice:

| Option | Behavior |
| ------ | -------- |
| Send now | Submits the message at the peak (x2) price |
| Wait until off-peak | Keeps your draft; nothing is sent — press Enter again later |
| Cancel | Keeps your draft; nothing is sent |

Off-peak, or when the provider is not monitored (e.g. not DeepSeek), Enter
behaves exactly as before.

## Install

```bash
# 1. Clone / symlink the plugin into opencode's plugin directory
mkdir -p ~/.config/opencode/plugins
ln -s /path/to/opencode-peak-guard ~/.config/opencode/plugins/opencode-peak-guard

# 2. Enable it in the TUI config.
# File plugins are referenced by path (a bare name is treated as an npm
# package and would fail to resolve), so use the absolute path:
#   { "plugin": ["oh-my-opencode-slim", "/home/<you>/.config/opencode/plugins/opencode-peak-guard"] }
#
# 3. Restart opencode
```

Requires opencode >= 1.18 (TUI plugin API, `@opencode-ai/plugin`).

> **Verified end-to-end** (opencode 1.18.12): with the plugin enabled, pressing
> Enter on the session prompt during a DeepSeek peak window shows the choice
> dialog and does not send until you pick an option. Two load-time gotchas were
> found and fixed during testing — `package.json` must expose a `./tui` export
> (opencode's entry resolution only looks for `exports["./tui"]` or a root
> index file), and the plugin must not rely on TSX/JSX (bun transpiles plugin
> sources with the CWD's JSX config, which defaults to React; see
> `src/index.ts` header for details).

## Options

Options are supplied as the plugin entry array in `tui.json`:

```jsonc
{
  "plugin": [
    ["opencode-peak-guard", {
      "providers": ["deepseek"],
      "windows": [[9, 12], [14, 18]],
      "multiplier": 2,
      "tzOffsetHours": 8,
      "dryRun": false,
      "forceKey": "ctrl+o"
    }]
  ]
}
```

| Option | Default | Description |
| ------ | ------- | ----------- |
| `providers` | `["deepseek"]` | Provider IDs subject to peak pricing (case-insensitive) |
| `windows` | `[[9,12],[14,18]]` | Peak windows `[startHour, endHour]` in schedule time |
| `multiplier` | `2` | Peak price multiplier (display only) |
| `tzOffsetHours` | `8` | UTC offset of the schedule clock (Beijing = 8) |
| `dryRun` | `false` | Never block: always send, but show a toast when peak pricing is active |
| `forceKey` | unset | Extra keybinding that force-sends the draft, bypassing the gate |

> Note: DeepSeek announced the peak/off-peak policy as "coming soon"; the
> effective date is TBD by official announcement. Until then the plugin is
> harmless — the gate simply never triggers (or use `dryRun: true` to preview).

## How it works (verified against opencode 1.18.x source)

1. The plugin registers the `session_prompt` TUI slot and re-renders the host's
   own `Prompt` component (identical UI) while capturing its `TuiPromptRef`.
2. A keymap layer (priority above the host default, scoped to `mode: "base"`)
   binds **Enter** to our command. The binding consumes the key event
   (`preventDefault`/`fallthrough` defaults), so the host submit never fires on
   its own.
3. The handler checks: dialog open? → skip; prompt focused? → otherwise forward
   Enter via `input.submit` (permission/question prompts keep native behavior);
   provider in `providers`? time in a peak window? → open the choice dialog via
   `api.ui.dialog`; **Send now** calls `TuiPromptRef.submit()`, **Wait/Cancel**
   keep the draft untouched.
4. While any modal dialog is open the keymap is in `"modal"` mode, so our
   "base"-scoped Enter binding is inactive and dialogs keep their own Enter
   handling.

See `docs/FEASIBILITY.md` for the full research behind this design.

## Development

```bash
bun install
bun test          # schedule logic unit tests
bunx tsc --noEmit # typecheck
```

## Limitations

- Peak windows are a local time-table; they follow official announcements
  (configurable via `windows`).
- Home-route prompt submission is not gated (session prompt only).
- Enter on a non-editor, non-dialog focus target while in base mode is consumed
  by the plugin and not re-dispatched (rare; documented in the source).
- Auto-send at off-peak is intentionally not implemented: the draft stays in
  the input box and you press Enter again.

## License

MIT
