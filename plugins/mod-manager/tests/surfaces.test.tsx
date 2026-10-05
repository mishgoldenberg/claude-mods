import { expect, test } from 'claude-code/testing'

// The pane draws on every surface, wide and narrow, with the shared header (docs/design.md).
test('mod-manager pane draws on every surface', async $ => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const bodyColumns of [30, 90]) {
      const ui = await $.ui.mount({
        plugin: 'mod-manager',
        surface,
        component: 'Pane',
        requestId: 'mod-manager',
        props: { title: 'mod-manager', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
        viewport: { columns: bodyColumns, rows: 40 },
      })
      expect(await ui.find({ type: 'Text', text: 'mod-manager' })).toBeDefined()
      await ui.unmount()
    }
  }
})
