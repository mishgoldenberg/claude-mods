import { expect, mock, test } from 'claude-code/testing'

// The pane draws on every surface, wide and narrow, with the shared header (docs/design.md).
test('activity pane draws on every surface', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: [] }))
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const bodyColumns of [30, 90]) {
      const ui = await $.ui.mount({
        plugin: 'activity',
        surface,
        component: 'Pane',
        requestId: 'activity',
        props: { title: 'activity', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
        viewport: { columns: bodyColumns, rows: 40 },
      })
      expect(await ui.find({ type: 'Text', text: 'activity' })).toBeDefined()
      await ui.unmount()
    }
  }
})
