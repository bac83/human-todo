import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Collapsed, Todo, TodoPriority, TodoStatus } from '../types'

const PLUGIN = 'human-todo'
const PANE = 'human-todo'
const TITLE = 'Human todo'
const PANE_COLUMNS = 44

// The engine has no keybinding action of a plugin's own, so the sidebar's
// toggle Buttons borrow one that has no default key and whose engine handler
// is only mounted inside the diff panel. The chord the person binds to it
// (written to keybindings.json on load) presses whichever toggle is mounted.
const ACTION = 'app:toggleDiffPreSession'

const todos = atom({ plugin: 'human-todo', key: 'todos' } as const, [])
const nextId = atom({ plugin: 'human-todo', key: 'nextId' } as const, 1)
const collapsed = atom({ plugin: 'human-todo', key: 'collapsed' } as const, {
  upcoming: false,
  current: false,
  done: true,
})
const isOpen = atom({ plugin: 'human-todo', key: 'isOpen' } as const, false)
const isCollapsedByUser = atom({ plugin: 'human-todo', key: 'isCollapsedByUser' } as const, false)
// The element key the pane's focus ring is on, as last seen moving; lost on a reload.
let ring: string | undefined

const SECTIONS: { status: TodoStatus; label: string; color: string; hotkey: string }[] = [
  { status: 'current', label: 'Current', color: 'warning', hotkey: 'c' },
  { status: 'upcoming', label: 'Upcoming', color: 'suggestion', hotkey: 'u' },
  { status: 'done', label: 'Done', color: 'success', hotkey: 'd' },
]

const PRIORITY_RANK: Record<TodoPriority, number> = { high: 0, normal: 1, low: 2 }

type $ = EngineInterface

export const register: Register = (on, options) => {
  const chord = String(options.shortcut ?? 'ctrl+x t').trim()
  const wakeClaude = options.wakeClaude !== false
  let shortcutHint = chord

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'add_todo',
      description:
        'Hand the user (the human) an action item only they can do: run an interactive login, ' +
        'approve or decide something, test on a device, supply a secret, review a page. ' +
        'It shows in their todo sidebar; you are told when they resolve it. ' +
        'Use status "current" for what they can do now, "upcoming" for future steps they cannot do yet ' +
        '(they cannot tick those off); move one to "current" with update_todo once it can be done. ' +
        'Do not use it for your own work.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative, e.g. "Run gcloud auth login"' },
          detail: { type: 'string', description: 'Optional: exact command, link or context' },
          priority: { type: 'string', enum: ['high', 'normal', 'low'], default: 'normal' },
          status: { type: 'string', enum: ['current', 'upcoming'], default: 'upcoming' },
        },
        required: ['title'],
      },
    })
    await $.tool.register({
      name: 'update_todo',
      description:
        "Change one of the user's todos by id: move it between upcoming and current, " +
        'mark it done when you saw it happen, or reword it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['upcoming', 'current', 'done'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'normal', 'low'] },
        },
        required: ['id'],
      },
    })
    await $.tool.register({
      name: 'list_todos',
      description: "List the user's todos of this session with their ids and status.",
    })
    await $.command.register({
      name: 'human-todo',
      description: 'Toggle the human-todo sidebar, or add your own: /human-todo add <text>',
      argumentHint: '[add <text>]',
      immediate: true,
    })

    shortcutHint = (await ensureShortcut($, chord)) ?? '/human-todo'
    // Placed panes only: one left waiting undrawn after a reload has no toggle to press.
    const pane = await paneState($)
    await update($, isOpen, () => pane.isUp)

    return next(e)
  })

  on('command.run', { command: 'human-todo' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    const title = /^add\s+(.+)$/i.exec(args)?.[1]
    if (title !== undefined) {
      const todo = await addTodo($, { title, status: 'current', priority: 'normal' })
      return { text: `Added ${todo.id}: ${todo.title}` }
    }
    await toggleSidebar($)
    return { text: (await read($, isOpen)) ? 'Human todo sidebar opened.' : 'Human todo sidebar collapsed.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, isOpen, () => false)
      if (e.origin.kind === 'person') await update($, isCollapsedByUser, () => true)
    }
    return next(e)
  })

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (!('deny' in moved) || moved.deny === undefined) ring = e.element
    return moved
  })

  on('tool.call', { tool: 'mcp__human-todo__add_todo' }, async ($, e) => {
    const input = e as unknown as Partial<Todo>
    if (typeof input.title !== 'string' || input.title.trim() === '') {
      return { deny: 'add_todo needs a non-empty title.' }
    }
    const todo = await addTodo($, {
      title: input.title.trim(),
      detail: input.detail?.trim() || undefined,
      priority: asPriority(input.priority),
      status: input.status === 'current' ? 'current' : 'upcoming',
    })
    if ((await read($, isOpen)) === false) {
      if (await read($, isCollapsedByUser)) {
        $.ui.toast(`New todo for you: ${todo.title} (${shortcutHint})`)
      } else {
        await openPane($)
      }
    }
    return { result: `Added ${todo.id} (${todo.status}, ${todo.priority}): ${todo.title}` }
  })

  on('tool.call', { tool: 'mcp__human-todo__update_todo' }, async ($, e) => {
    const input = e as unknown as Partial<Todo>
    const before = await read($, todos)
    let found: Todo | undefined
    await update($, todos, list =>
      list.map(todo => {
        if (todo.id !== input.id) return todo
        found = {
          ...todo,
          title: input.title?.trim() || todo.title,
          detail: input.detail === undefined ? todo.detail : input.detail.trim() || undefined,
          priority: input.priority ? asPriority(input.priority) : todo.priority,
          status: asStatus(input.status) ?? todo.status,
        }
        if (found.status === 'done' && todo.status !== 'done') found.resolvedBy = 'claude'
        if (found.status !== 'done') found.resolvedBy = undefined
        return found
      }),
    )
    if (found === undefined) return { deny: `No todo with id ${String(input.id)}.` }
    // Claude moved the row the ring is on: re-home it as a press there would.
    const was = before.find(todo => todo.id === found?.id)
    if (was !== undefined && was.status !== found.status && ring === `toggle-${was.id}`) {
      await moveRing($, nextFocusKey(before, was), `section-${was.status}`)
    }
    return { result: `Updated ${found.id} (${found.status}): ${found.title}` }
  })

  on('tool.call', { tool: 'mcp__human-todo__list_todos' }, async $ => {
    const list = await read($, todos)
    if (list.length === 0) return { result: 'The user has no todos in this session.' }
    return {
      result: list
        .map(
          todo =>
            `${todo.id} [${todo.status}] (${todo.priority}) ${todo.title}${todo.detail ? ` — ${todo.detail}` : ''}`,
        )
        .join('\n'),
    }
  })

  // Collapsed sidebar: one line above the prompt carrying the toggle, so the
  // shortcut has a Button mounted to press while the pane is closed.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // isOpen subscribes the band to collapses; the engine's record catches a pane placed meanwhile.
    if (e.props.hasSurvey || (await read($, isOpen)) || (await paneState($)).isUp) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, todos)
    const current = list.filter(todo => todo.status === 'current').length
    const upcoming = list.filter(todo => todo.status === 'upcoming').length
    const hasUrgent = list.some(todo => todo.status !== 'done' && todo.priority === 'high')

    return (
      <Box flexDirection="row" gap={1}>
        <Button
          key="expand"
          label="◂ todos"
          plain
          hotkey="t"
          autoFocus
          action={ACTION}
          onPress={() => toggleSidebar($)}
        />
        {current + upcoming === 0 && <Text dimColor>nothing waiting on you</Text>}
        {current > 0 && (
          <Text color={hasUrgent ? 'error' : 'warning'} bold>
            {current} current
          </Text>
        )}
        {upcoming > 0 && <Text color="suggestion">{upcoming} upcoming</Text>}
        <Text dimColor>{shortcutHint}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, todos)
    const folded = await read($, collapsed)
    const width = Math.max(16, e.props.bodyColumns)
    const open = list.filter(todo => todo.status !== 'done').length
    // Rows with a toggle, in the order drawn: 1-9 press the first nine, the
    // first current one takes the ring. Upcoming is the future: nothing to tick.
    const visible = SECTIONS.flatMap(section =>
      folded[section.status] || section.status === 'upcoming'
        ? []
        : sortTodos(list.filter(todo => todo.status === section.status)),
    )
    const firstOpen = visible.find(todo => todo.status === 'current')

    const row = (todo: Todo) => {
      const isDone = todo.status === 'done'
      const isHigh = todo.priority === 'high' && !isDone
      const index = visible.indexOf(todo)
      return (
        <Box key={todo.id} flexDirection="column" width={width}>
          <Box flexDirection="row" gap={1}>
            {todo.status === 'upcoming' ? (
              <Text dimColor>·</Text>
            ) : (
              <Button
                key={`toggle-${todo.id}`}
                label={isDone ? '✓' : '○'}
                plain
                dimColor={isDone}
                hotkey={index >= 0 && index < 9 ? String(index + 1) : undefined}
                autoFocus={todo === firstOpen ? true : undefined}
                onPress={async () => {
                  // Read now, not at draw: Claude may have changed the list since.
                  const fresh = await read($, todos)
                  const now = fresh.find(other => other.id === todo.id)
                  if (now === undefined || now.status === 'upcoming') return
                  const key = nextFocusKey(fresh, now)
                  await setStatus($, now.id, now.status === 'done' ? 'current' : 'done', wakeClaude)
                  await moveRing($, key, `section-${now.status}`)
                }}
              />
            )}
            <Text
              color={isDone ? 'inactive' : isHigh ? 'error' : undefined}
              bold={isHigh || (todo.status === 'current' && !isDone)}
              dimColor={isDone || todo.priority === 'low'}
              strikethrough={isDone}
              wrap="wrap"
            >
              {isHigh ? '! ' : ''}
              {todo.title}
            </Text>
          </Box>
          {todo.detail && !isDone && (
            <Box paddingLeft={2}>
              <Text dimColor wrap="wrap">
                {todo.detail}
              </Text>
            </Box>
          )}
          {isDone && todo.resolvedBy === 'claude' && (
            <Box paddingLeft={2}>
              <Text dimColor>closed by Claude</Text>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="space-between" width={width}>
          <Text color="claude" bold>
            {open === 0 ? 'All clear' : `${open} waiting on you`}
          </Text>
          <Button
            key="collapse"
            label="▸"
            plain
            dimColor
            autoFocus={firstOpen === undefined ? true : undefined}
            action={ACTION}
            onPress={() => toggleSidebar($)}
          />
        </Box>
        {SECTIONS.map(section => {
          const items = sortTodos(list.filter(todo => todo.status === section.status))
          const isFolded = folded[section.status]
          return (
            <Box key={section.status} flexDirection="column" marginTop={1}>
              <Button
                key={`section-${section.status}`}
                label={`${isFolded ? '▸' : '▾'} ${section.label} (${items.length})`}
                plain
                hotkey={section.hotkey}
                onPress={async () => {
                  await update($, collapsed, all => ({ ...all, [section.status]: !all[section.status] }) as Collapsed)
                  // A fold by hotkey can hide the row the ring is on: hand it to the header.
                  await moveRing($, `section-${section.status}`)
                }}
              />
              {!isFolded && items.length === 0 && (
                <Box paddingLeft={2}>
                  <Text dimColor>none</Text>
                </Box>
              )}
              {!isFolded && items.map(row)}
            </Box>
          )
        })}
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            {shortcutHint} toggles · 1-9 ○/✓ · c/u/d fold · tab
          </Text>
        </Box>
      </Box>
    )
  })
}

async function openPane($: $, focus = false) {
  const opened = await $.ui.open({
    id: PANE,
    title: TITLE,
    columns: PANE_COLUMNS,
    ...(focus && { focus: true as const }),
  })
  await update($, isOpen, () => opened.isPlaced)
}

/**
 * The pane as the engine records it: up only when placed (one opened unasked
 * on a narrow terminal waits undrawn, and is placed later when it widens).
 * Unreadable, the isOpen atom stands in.
 */
async function paneState($: $): Promise<{ isUp: boolean; isFocused: boolean }> {
  const panes = await $.ui.panes().catch(() => undefined)
  if (panes === undefined) return { isUp: await read($, isOpen), isFocused: true }
  const pane = panes.find(other => other.id === PANE && other.isPlaced)
  return { isUp: pane !== undefined, isFocused: pane?.isFocused ?? false }
}

async function toggleSidebar($: $) {
  const pane = await paneState($)
  if (pane.isUp && pane.isFocused) {
    try {
      await $.ui.close({ id: PANE })
    } catch (error) {
      $.ui.toast(`human-todo: sidebar not collapsed (${String(error)})`)
      return
    }
    await update($, isCollapsedByUser, () => true)
    // Our ui.close hook did not hear this close in the test kit; set it here too.
    await update($, isOpen, () => false)
    return
  }
  // Closed, or up without the keys (Claude opened it, Esc handed them back):
  // open it, or give it the keys, before a second press collapses it.
  await update($, isCollapsedByUser, () => false)
  await openPane($, true)
}

/** Moves the pane's focus ring onto `key`, else `fallback`; nothing while the pane lacks the keys. */
async function moveRing($: $, key: string, fallback?: string) {
  const moved = await $.ui.focus({ requestId: PANE, key }).catch((error: unknown) => ({ deny: String(error) }))
  if (!('deny' in moved) || moved.deny === undefined) {
    ring = key
    return
  }
  if (fallback !== undefined && fallback !== key) await moveRing($, fallback)
}

async function tellClaude($: $, text: string, wakeClaude: boolean) {
  const note = `<human-todo>${text}</human-todo>`
  if (wakeClaude) {
    // A refused wake (a hook's drop, or a rejection) still tells Claude, with its next request.
    void $.prompt.submit({ text: note }).then(
      submitted => (submitted.drop === undefined ? undefined : appendNote($, note)),
      () => appendNote($, note),
    )
    return
  }
  await appendNote($, note)
}

async function appendNote($: $, note: string) {
  const appended = await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
    .catch((error: unknown) => ({ deny: String(error) }))
  if ('deny' in appended && appended.deny !== undefined) {
    $.ui.toast(`human-todo: Claude was not told (${appended.deny}). Tell it yourself.`)
  }
}

async function setStatus($: $, id: string, status: TodoStatus, wakeClaude: boolean) {
  let changed: Todo | undefined
  await update($, todos, list =>
    list.map(todo => {
      if (todo.id !== id || todo.status === status) return todo
      changed = { ...todo, status, resolvedBy: status === 'done' ? 'human' : undefined }
      return changed
    }),
  )
  if (changed === undefined) return
  await tellClaude($, describeChange(changed), wakeClaude)
}

async function addTodo($: $, fields: Omit<Todo, 'id'>): Promise<Todo> {
  let id = 0
  await update($, nextId, n => {
    id = n
    return n + 1
  })
  const todo: Todo = { ...fields, id: `t${id}` }
  await update($, todos, list => [...list, todo])
  return todo
}

/**
 * The words Claude reads when the person changes a todo in the sidebar.
 * Rewrite to taste: how much context Claude needs to pick the work back up.
 */
function describeChange(todo: Todo): string {
  if (todo.status === 'done') {
    return `The user marked their todo ${todo.id} "${todo.title}" as done. Continue any work that was waiting on it.`
  }
  return `The user reopened their todo ${todo.id} "${todo.title}"; it is ${todo.status} again.`
}

/**
 * Where the focus ring lands after `todo` is resolved or reopened and leaves
 * its section: the next todo there, else the one before it, else the header.
 */
function nextFocusKey(list: Todo[], todo: Todo): string {
  const peers = sortTodos(list.filter(other => other.status === todo.status))
  const at = peers.findIndex(other => other.id === todo.id)
  const neighbour = peers[at + 1] ?? peers[at - 1]
  return neighbour === undefined ? `section-${todo.status}` : `toggle-${neighbour.id}`
}

function sortTodos(list: Todo[]): Todo[] {
  return [...list].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
}

function asPriority(value: unknown): TodoPriority {
  return value === 'high' || value === 'low' ? value : 'normal'
}

function asStatus(value: unknown): TodoStatus | undefined {
  return value === 'upcoming' || value === 'current' || value === 'done' ? value : undefined
}

type Keybindings = { bindings?: { context: string; bindings: Record<string, string | null> }[] }

/**
 * Binds `chord` to the borrowed action in ~/.claude/keybindings.json (Global
 * context), keeping any binding the person made for it themselves. An empty
 * `chord` takes out the binding the mod installed. Answers the chord in force,
 * or undefined when there is none.
 */
async function ensureShortcut($: $, chord: string): Promise<string | undefined> {
  const home = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await homeClaudeDir($))
  if (home === undefined) return undefined
  const path = `${home.replace(/[\\/]+$/, '')}/keybindings.json`

  let file: Keybindings = {}
  if (await $.fs.exists(path)) {
    try {
      file = JSON.parse(await $.fs.read(path)) as Keybindings
    } catch {
      $.ui.log(`${PLUGIN}: ${path} is not valid JSON; shortcut not installed, use /human-todo`)
      return undefined
    }
  }
  const blocks = Array.isArray(file.bindings) ? file.bindings : []
  const installed = (await $.store.get('installedChord')) as string | undefined
  const bound = blocks
    .flatMap(block => Object.entries(block.bindings ?? {}))
    .find(([, action]) => action === ACTION)?.[0]

  if (bound !== undefined && (bound === chord || bound !== installed)) return bound
  if (chord === '') {
    if (bound === undefined) return undefined
    for (const block of blocks) delete block.bindings[bound]
    await writeKeybindings($, path, file, blocks)
    await $.store.delete('installedChord')
    $.ui.log(`${PLUGIN}: removed ${bound} (in ${path})`)
    return undefined
  }

  let global = blocks.find(block => block.context === 'Global')
  if (global === undefined) {
    global = { context: 'Global', bindings: {} }
    blocks.push(global)
  }
  const taken = global.bindings[chord]
  if (taken !== undefined && taken !== null && taken !== ACTION) {
    $.ui.log(`${PLUGIN}: ${chord} is already bound to ${taken}; pick another shortcut in /config`)
    return undefined
  }
  if (bound !== undefined) {
    for (const block of blocks) delete block.bindings[bound]
  }
  global.bindings[chord] = ACTION

  await writeKeybindings($, path, file, blocks)
  await $.store.set('installedChord', chord)
  $.ui.log(`${PLUGIN}: bound ${chord} to toggle the sidebar (in ${path})`)
  return chord
}

async function writeKeybindings($: $, path: string, file: Keybindings, blocks: NonNullable<Keybindings['bindings']>) {
  const next = {
    $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
    $docs: 'https://code.claude.com/docs/en/keybindings',
    ...file,
    bindings: blocks,
  }
  await $.fs.write(path, JSON.stringify(next, null, 2) + '\n')
}

async function homeClaudeDir($: $): Promise<string | undefined> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home === undefined ? undefined : `${home}/.claude`
}
