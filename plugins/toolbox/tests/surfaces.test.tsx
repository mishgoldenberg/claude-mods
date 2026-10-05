import { expect, test } from 'claude-code/testing'

// The pane draws on every surface, wide and narrow, with the shared header (docs/design.md).
test('toolbox pane draws on every surface', async $ => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const bodyColumns of [30, 90]) {
      const ui = await $.ui.mount({
        plugin: 'toolbox',
        surface,
        component: 'Pane',
        requestId: 'toolbox',
        props: { title: 'toolbox', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
        viewport: { columns: bodyColumns, rows: 40 },
      })
      expect(await ui.find({ type: 'Text', text: 'toolbox' })).toBeDefined()
      await ui.unmount()
    }
  }
})
