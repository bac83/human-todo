export type TodoStatus = 'upcoming' | 'current' | 'done'
export type TodoPriority = 'high' | 'normal' | 'low'

export type Todo = {
  id: string
  title: string
  detail?: string
  priority: TodoPriority
  status: TodoStatus
  /** Who moved it to done: the person in the sidebar, or Claude through the tool. */
  resolvedBy?: 'human' | 'claude'
}

export type Collapsed = Record<TodoStatus, boolean>

declare module 'claude-code' {
  interface PluginState {
    'human-todo': {
      todos: Todo[]
      nextId: number
      collapsed: Collapsed
      /** The sidebar pane is shown; the collapsed one-liner draws otherwise. */
      isOpen: boolean
      /** The person closed the sidebar: new todos toast instead of reopening it. */
      isCollapsedByUser: boolean
    }
  }
}
