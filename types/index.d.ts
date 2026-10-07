export type LessonAction = 'create' | 'update' | 'add_reference' | 'archive'

export type Lesson = {
  id: string
  run: string
  ts: number
  action: LessonAction
  name: string
  path: string
  summary: string
  reason: string
  body: string
  source: 'live' | 'mine'
}

declare module 'claude-code' {
  interface PluginState {
    skillmine: {
      expanded: string[]
      lessons: Lesson[]
      busy: string | null
    }
  }
}
