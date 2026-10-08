import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'human-todo',
  component: 'Pane',
  requestId: 'human-todo',
  props: {
    title: 'Human todo',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'human-todo',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const RESOLVED =
  '<human-todo>The user marked their todo t1 "Run gcloud auth login" as done. Continue any work that was waiting on it.</human-todo>'

/** The texts of the notes the mod appended for Claude to read. */
function notes(session: ReturnType<typeof mock.session>): string[] {
  return session
    .appended()
    .flatMap(row => row.message.content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])))
}

test('Claude adds todos, the person resolves one, Claude is told', async ($, on) => {
  // A narrow terminal: the pane waits unplaced, so the collapsed band draws.
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } }))
  // No prompt.submit beneath: the wake fails and the note is appended for the next request.
  const session = mock.session(on)

  const added = await $.tool.call({
    tool: 'mcp__human-todo__add_todo',
    title: 'Run gcloud auth login',
    priority: 'high',
    status: 'current',
  })
  expect(added.text ?? String(added.result)).toContain('t1')
  await $.tool.call({ tool: 'mcp__human-todo__add_todo', title: 'Approve the design' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /1 current/ }))?.props.color).toBe('error')
    expect(await band.find({ type: 'Text', text: /1 upcoming/ })).toBeDefined()
    await band.unmount()
  }

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ key: 'section-current' }))?.props.label).toBe('▾ Current (1)')
  expect((await pane.find({ key: 'section-upcoming' }))?.props.label).toBe('▾ Upcoming (1)')
  expect((await pane.find({ key: 'section-done' }))?.props.label).toBe('▸ Done (0)')

  await pane.press({ key: 'toggle-t1' })
  expect((await pane.find({ key: 'section-current' }))?.props.label).toBe('▾ Current (0)')
  expect((await pane.find({ key: 'section-done' }))?.props.label).toBe('▸ Done (1)')
  expect(notes(session)).toEqual([RESOLVED])

  await pane.press({ key: 'section-done' })
  expect(await pane.find({ key: 'toggle-t1' })).toBeDefined()
  await pane.press({ key: 'section-upcoming' })
  expect(await pane.find({ key: 'toggle-t2' })).toBeUndefined()
  await pane.unmount()

  const listed = await $.tool.call({ tool: 'mcp__human-todo__list_todos' })
  expect(String(listed.result)).toContain('t1 [done]')
})

test('Claude moves and closes a todo by id', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.tool.call({ tool: 'mcp__human-todo__add_todo', title: 'Test on iPhone' })
  const moved = await $.tool.call({ tool: 'mcp__human-todo__update_todo', id: 't1', status: 'current' })
  expect(String(moved.result)).toContain('(current)')
  const missing = await $.tool.call({ tool: 'mcp__human-todo__update_todo', id: 't9', status: 'done' })
  expect(missing.deny).toContain('No todo')
})

test('collapsing the sidebar leaves the one-line band above the prompt', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  await $.tool.call({ tool: 'mcp__human-todo__add_todo', title: 'Test on iPhone', status: 'current' })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'collapse' })
  await pane.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'expand' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /1 current/ })).toBeDefined()
  await band.unmount()
})

// Where the ring lands after a resolve ($.ui.focus) has no stand-in in the kit:
// the engine resolves the ring before any hook runs. Checked by hand.
test('the sidebar is driven by keyboard: focus on open, hotkeys, autoFocus', async ($, on) => {
  const opens: { focus?: true }[] = []
  on('ui.open', ($, e) => {
    opens.push(e)
    return { value: { isPlaced: false, reason: 'narrow' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  for (const title of ['Run gcloud auth login', 'Approve the design']) {
    await $.tool.call({ tool: 'mcp__human-todo__add_todo', title, status: 'current' })
  }
  await $.tool.call({ tool: 'mcp__human-todo__add_todo', title: 'Test on iPhone' })
  // Claude's own adds open the pane without taking the keyboard.
  expect(opens.every(open => open.focus === undefined)).toBe(true)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const expand = await band.find({ key: 'expand' })
  expect(expand?.props.hotkey).toBe('t')
  expect(expand?.props.autoFocus).toBe(true)
  await band.press({ key: 'expand' })
  expect(opens.at(-1)?.focus).toBe(true)
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: true }, surface: 'terminal' })
  expect((await pane.find({ key: 'section-current' }))?.props.hotkey).toBe('c')
  expect((await pane.find({ key: 'section-upcoming' }))?.props.hotkey).toBe('u')
  expect((await pane.find({ key: 'section-done' }))?.props.hotkey).toBe('d')
  expect((await pane.find({ key: 'toggle-t1' }))?.props.hotkey).toBe('1')
  expect((await pane.find({ key: 'toggle-t1' }))?.props.autoFocus).toBe(true)
  expect((await pane.find({ key: 'toggle-t2' }))?.props.hotkey).toBe('2')
  // Upcoming is the future: nothing there to tick yet.
  expect(await pane.find({ key: 'toggle-t3' })).toBeUndefined()

  // Done is folded: t1 leaves view and the numbers follow what is drawn.
  await pane.press({ key: 'toggle-t1' })
  expect((await pane.find({ key: 'toggle-t2' }))?.props.hotkey).toBe('1')
  expect((await pane.find({ key: 'toggle-t2' }))?.props.autoFocus).toBe(true)
  // Nothing current left: the collapse button takes the ring.
  await pane.press({ key: 'toggle-t2' })
  expect((await pane.find({ key: 'collapse' }))?.props.autoFocus).toBe(true)

  // Claude moves the upcoming todo to current once it can be done.
  await $.tool.call({ tool: 'mcp__human-todo__update_todo', id: 't3', status: 'current' })
  expect((await pane.find({ key: 'toggle-t3' }))?.props.hotkey).toBe('1')

  await pane.press({ key: 'section-done' })
  expect((await pane.find({ key: 'toggle-t1' }))?.props.hotkey).toBe('2')
  await pane.unmount()
})

test('resolving a todo wakes Claude with the note', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const submitted: string[] = []
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.tool.call({ tool: 'mcp__human-todo__add_todo', title: 'Approve the design', status: 'current' })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'toggle-t1' })
  await pane.unmount()
  expect(submitted).toEqual([
    '<human-todo>The user marked their todo t1 "Approve the design" as done. Continue any work that was waiting on it.</human-todo>',
  ])
})

test('a refused wake still tells Claude with the next request', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', () => ({ drop: 'busy' }))
  const session = mock.session(on)
  await $.tool.call({ tool: 'mcp__human-todo__add_todo', title: 'Approve the design', status: 'current' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'toggle-t1' })
  await pane.unmount()
  expect(notes(session)).toEqual([
    '<human-todo>The user marked their todo t1 "Approve the design" as done. Continue any work that was waiting on it.</human-todo>',
  ])
})

test('a refused note asks the person to tell Claude', { options: { wakeClaude: false } }, async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.append', () => ({ deny: 'read-only run' }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.tool.call({ tool: 'mcp__human-todo__add_todo', title: 'Approve the design', status: 'current' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'toggle-t1' })
  await pane.unmount()
  expect(toasts.join(' ')).toContain('Claude was not told (read-only run)')
})

test('the chord focuses a pane Claude opened before it collapses it', async ($, on) => {
  const opens: { focus?: true }[] = []
  on('ui.open', ($, e) => {
    opens.push(e)
    return { value: { isPlaced: true } }
  })
  const closes: string[] = []
  on('ui.close', ($, e) => {
    closes.push(e.id)
    return { value: undefined }
  })
  let isFocused = false
  on('ui.panes', () => ({
    value: [{ id: 'human-todo', title: 'Human todo', isShown: true, isFocused, isPlaced: true }],
  }))
  await $.tool.call({ tool: 'mcp__human-todo__add_todo', title: 'Approve the design', status: 'current' })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'collapse' })
  expect(closes).toEqual([])
  expect(opens.at(-1)?.focus).toBe(true)

  isFocused = true
  await pane.press({ key: 'collapse' })
  expect(closes).toEqual(['human-todo'])
  await pane.unmount()
})

test('a pane placed later is seen by the chord: it collapses instead of reopening', async ($, on) => {
  // Opened unasked on a narrow terminal: unplaced, isOpen false.
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } }))
  const closes: string[] = []
  on('ui.close', ($, e) => {
    closes.push(e.id)
    return { value: undefined }
  })
  // Then the terminal widened: the engine placed it, and the person focused it.
  on('ui.panes', () => ({
    value: [{ id: 'human-todo', title: 'Human todo', isShown: true, isFocused: true, isPlaced: true }],
  }))
  await $.tool.call({ tool: 'mcp__human-todo__add_todo', title: 'Approve the design', status: 'current' })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'collapse' })
  expect(closes).toEqual(['human-todo'])
  await pane.unmount()
})

const KEYBINDINGS = '/cfg/keybindings.json'

/** The engine hands fs hooks a native absolute path: on Windows `/cfg/x` arrives as `C:\cfg\x`. */
const posix = (path: string) => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

/**
 * A session starting over a config folder of one keybindings.json and the mod's
 * store, answered beneath the mod. Answers the file as it stands afterwards.
 */
function fakeConfig(on: On, file: object, store: Record<string, unknown>) {
  const files: Record<string, string> = { [KEYBINDINGS]: JSON.stringify(file) }
  on('env.get', ($, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/cfg' : undefined }))
  on('fs.exists', ($, e) => ({ value: posix(e.path) in files }))
  on('fs.read', ($, e) => ({ value: files[posix(e.path)] ?? '' }))
  on('fs.write', ($, e) => {
    files[posix(e.path)] = e.text
    return { value: undefined }
  })
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__human-todo__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return () => JSON.parse(files[KEYBINDINGS] ?? '{}')
}

test('an empty shortcut removes the binding the mod installed', { options: { shortcut: '' } }, async ($, on) => {
  const store: Record<string, unknown> = { installedChord: 'ctrl+x t' }
  const keybindings = fakeConfig(
    on,
    { bindings: [{ context: 'Global', bindings: { 'ctrl+x t': 'app:toggleDiffPreSession', 'ctrl+k': 'chat:stash' } }] },
    store,
  )
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect(keybindings().bindings[0].bindings).toEqual({ 'ctrl+k': 'chat:stash' })
  expect(store.installedChord).toBeUndefined()
})

test('an empty shortcut keeps a binding the person made themselves', { options: { shortcut: '' } }, async ($, on) => {
  const store: Record<string, unknown> = {}
  const keybindings = fakeConfig(
    on,
    { bindings: [{ context: 'Global', bindings: { 'ctrl+y': 'app:toggleDiffPreSession' } }] },
    store,
  )
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect(keybindings().bindings[0].bindings).toEqual({ 'ctrl+y': 'app:toggleDiffPreSession' })
})

test('the system prompt tells Claude when to add todos and to split steps', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  const guide = sections.find(section => section.id === 'human-todo:guide')
  expect(sections[0]?.id).toBe('intro')
  expect(guide?.scope).toBe('session')
  expect(guide?.text).toContain('mcp__human-todo__add_todo')
  expect(guide?.text).toContain('One action per todo')
})
