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
| Auto-submit at off-peak | Locks the draft and sends it automatically when the current peak window ends (no keypress needed) |
| Wait until off-peak | Keeps your draft; nothing is sent — press Enter again later |
| Cancel | Keeps your draft; nothing is sent |

Off-peak, or when the provider is not monitored (e.g. not DeepSeek), Enter
behaves exactly as before.

## Install

### From npm (recommended)

Add the package name to the `plugin` array in `~/.config/opencode/tui.json`
and restart opencode — it is installed automatically:

```jsonc
{
  "plugin": ["opencode-peak-guard"]
}
```

### From source (development)

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
2. Enter is intercepted with a key intercept hook (`api.keymap.intercept`,
   priority above the host default) instead of a keymap binding. A binding
   unconditionally consumes the key once it matches — which shadows the host's
   own `return` → "confirm permission" binding (default priority 0) and breaks
   Enter-to-confirm on permission/question prompts. The hook decides per
   keypress: it consumes the key only when the session prompt is focused, no
   permission/question gate is pending, and the provider is inside a peak
   window; otherwise it passes the key through so the host handles it natively
   (submit the prompt, confirm a permission, etc.).
3. The handler checks: dialog open? → skip; prompt focused? → otherwise pass
   through; provider in `providers`? time in a peak window? → open the choice
   dialog via `api.ui.dialog`; **Send now** calls `TuiPromptRef.submit()`,
   **Auto-submit at off-peak** registers a timer for the window end that later
   submits the draft (see below), **Wait/Cancel** keep the draft untouched.
4. While any modal dialog is open the dialog guard makes the hook pass Enter
   through to the host, so dialogs keep their own Enter handling.

The auto-submit timer fires at the exact end of the current peak window and
then submits only if it is still safe and meaningful: the same session is
active, the draft is non-empty, and no modal dialog or host gate (pending
permission/question) blocks submission — blocked attempts retry for about a
minute before giving up with a toast. Any real submission (including a manual
Enter before the window ends, or the `forceKey`) cancels the pending timer, so
a draft is never sent twice.

While a lock is pending, pressing Enter never submits: it re-opens the choice
dialog (titled with the pending release time) so you can reschedule, send now,
or cancel. The draft stays visible and editable until it is sent — the lock
covers submission, not typing (the TUI slot API cannot render-lock the host's
prompt from a plugin).

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
- Auto-submit fires only while opencode stays running: if the process exits
  before the peak window ends, the draft simply stays in the input box.
- While an auto-submit lock is pending, the draft remains editable (the lock
  blocks submission, not typing).

## License

MIT
