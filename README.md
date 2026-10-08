# human-todo

A Claude Code mod that keeps a sidebar of the things **you** have to do during a session —
the login only you can run, the design only you can approve, the device only you can test on.
Claude adds them; you tick them off; Claude is told.

![human-todo sidebar next to a Claude Code session: six todos waiting on the user, grouped into Current and Upcoming](docs/screenshot.png)

## Features

- **Three groups**: Current, Upcoming, Done — each collapsible (click or Enter on its header).
- **Resolve in place**: press `○` to mark a todo done, `✓` to reopen it.
- **Claude gets told**: every change wakes Claude, which picks up the work that was waiting
  on you right away. Or have it read the change with your next message (see Settings).
- **Theme colors**: current = theme `warning`, upcoming = `suggestion`, done = `success`,
  high priority = `error` with `!`. Follows whatever theme you picked in `/config`.
- **Collapsible sidebar**: collapses to a single line above the prompt
  (`◂ todos  1 current  2 upcoming  ctrl+x t`).
- **Shortcut**: `ctrl+x t` toggles the sidebar — identical on Windows and macOS.
- **Keyboard only**: opening with `ctrl+x t` (or `/human-todo`) gives the sidebar the keyboard,
  the ring on the first open todo. `1`–`9` resolve/reopen the rows as numbered, `c`/`u`/`d` fold
  Current/Upcoming/Done, Tab/Enter walk and press, Esc hands the keys back (sidebar stays).
  After a resolve the ring moves to the next todo of that section. Collapsed: `ctrl+x tab`, then
  `t` or Enter, opens it. (Focus is only taken over an empty prompt; else `ctrl+x tab`.)
- `/human-todo` toggles the sidebar too; `/human-todo add <text>` adds a todo of your own.

## Install

Requires a Claude Code build with function-hook mods (2.1.289 or newer). At the prompt of a
terminal session, type:

```
/plugin install human-todo --marketplace bac83/human-todo
```

Answer `y` to add the marketplace, then pick a scope (user = every session) and set the
options. The sidebar is active right away, no restart.

Update later with `claude plugin update human-todo@human-todo`, then `/reload-plugins`.

## Settings (`/config`)

| Setting | Default | What it does |
| --- | --- | --- |
| `shortcut` | `ctrl+x t` | Chord that toggles the sidebar. Empty = no shortcut, and the binding the mod added is removed. |
| `wakeClaude` | `true` | On: resolving a todo starts a turn so Claude reacts at once (each toggle is a turn). Off: Claude reads it with its next request. |

### About the shortcut

Claude Code has no keybinding actions of a plugin's own, so the sidebar's toggle buttons borrow the
built-in action `app:toggleDiffPreSession` (no default key). On load the mod adds
`"ctrl+x t": "app:toggleDiffPreSession"` to the `Global` context of `~/.claude/keybindings.json`
(or `$CLAUDE_CONFIG_DIR/keybindings.json`). A binding you made for that action yourself is kept.
Setting `shortcut` to empty takes the mod's own binding back out.

## Tools Claude gets

| Tool | Purpose |
| --- | --- |
| `mcp__human-todo__add_todo` | Hand the user an action item (`title`, `detail`, `priority`, `status`). |
| `mcp__human-todo__update_todo` | Move, reword or close a todo by id. |
| `mcp__human-todo__list_todos` | List this session's todos. |

Todos live for the session (they survive a mod reload, not a restart).

## What the mod hooks

Every hook is in `hooks/register.tsx`.

| Event | Scope | What the hook does |
| --- | --- | --- |
| `session.start` | the session | Registers the three tools and `/human-todo`, binds the shortcut, then lets the session start unchanged. |
| `command.run` | `/human-todo` only | Answers the mod's own command: toggles the sidebar, or with `add <text>` adds a todo. No other command reaches it. |
| `tool.call` | its three tools only | Answers `add_todo`, `update_todo` and `list_todos`, the mod's own tools. No other tool call reaches it. |
| `prompt.compose` | the system prompt | Appends one section, `human-todo:guide`, after everything else; every other section is passed on unchanged. |
| `ui.close` | every pane | Notes when its own sidebar closed and whether you closed it; every close is passed on unchanged. |
| `ui.focus` | its own sidebar | Remembers which row has the focus ring; the focus change is passed on unchanged. |
| `ui.render` | `AbovePrompt` | Draws the one-line band above the prompt while the sidebar is collapsed; otherwise leaves the band to Claude Code. |
| `ui.render` | its own sidebar pane | Draws the sidebar. |

## Data & privacy

human-todo makes no network requests of its own. It reads only its own session state and
`keybindings.json`. What it does beyond drawing the sidebar:

- **Todos** live in the session's state and are gone when the session ends.
- **Notes to Claude.** When you resolve or reopen a todo, the mod adds one line to your
  conversation with Claude, which reaches Claude like any message you send. With `wakeClaude` on,
  the line is submitted as a prompt that starts a turn; off, or when that prompt is refused, it is
  appended for Claude's next request. The line holds only the todo's id and title:

  ```
  <human-todo>The user marked their todo t3 "Run gcloud auth login" as done. Continue any work that was waiting on it.</human-todo>
  <human-todo>The user reopened their todo t3 "Run gcloud auth login"; it is current again.</human-todo>
  ```

  Nothing else goes into these prompts: no other conversation text, file contents or settings.
- **A section of the system prompt.** Claude may see the three tools by name only, so the mod
  appends a fixed section, `human-todo:guide`, to the system prompt: when to put an action on your
  list, one action per todo (several steps as several todos), and when to move or close one. It is
  the same text in every session and holds none of your data.
- **One settings file.** To bind the shortcut, the mod edits Claude Code's keybindings file,
  `~/.claude/keybindings.json` (or `keybindings.json` in `$CLAUDE_CONFIG_DIR`). It adds or removes
  only its own binding and keeps everything else in the file (see
  [About the shortcut](#about-the-shortcut)). It remembers the chord it added in the plugin's local
  store, so it can take that binding out again. It writes no other file.
- **Its own tools and command.** The three tools above are the mod's own: it registers them at
  session start and answers them itself. `/human-todo` is its own command, which it answers itself
  (toggle the sidebar, or add a todo). It hooks no other tool or command, takes no permission
  decision and changes no other setting.

## Uninstall

1. In `/config`, set the human-todo `shortcut` to empty. The mod removes the binding it added to
   `keybindings.json`; a binding you made yourself stays.
2. `/plugin uninstall human-todo@human-todo`

Uninstalled first? Delete `"ctrl+x t": "app:toggleDiffPreSession"` from the `Global` block of
`~/.claude/keybindings.json` by hand. Left in place, the chord opens Claude Code's built-in diff
preview instead.

## Develop

Run it from a clone instead of the installed copy:

```sh
git clone https://github.com/bac83/human-todo.git
claude --plugin-dir ./human-todo
```

To load the clone in every session without the flag, add the folder to `CLAUDE_CODE_PLUGIN_DIRS`
in the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/human-todo" } }
```

(Windows: `C:\\path\\to\\human-todo`; several folders are separated with `;` on Windows, `:` on macOS/Linux.)

Checks:

```sh
claude plugin validate .
claude plugin test .
tsc -p .            # after one load, which lays .claude-plugin/types/
```

`describeChange()` in `hooks/register.tsx` decides the words Claude reads when you change a todo.

## License

MIT, see [LICENSE](LICENSE).
