import type { ThemeRegistration } from '@pierre/diffs'

// A TextMate adaptation of JetBrains Darcula for Shiki.
// https://github.com/JetBrains/intellij-community/tree/master/platform/platform-resources
export default {
  name: 'ghl-darcula',
  displayName: 'JetBrains Darcula',
  type: 'dark',
  colors: {
    'editor.background': '#2b2b2b',
    'editor.foreground': '#a9b7c6',
    'editor.selectionBackground': '#214283',
    'editor.lineHighlightBackground': '#323232',
    'editorLineNumber.foreground': '#909090',
    'sideBar.background': '#3c3f41',
    'sideBar.foreground': '#bbbbbb',
    'list.activeSelectionBackground': '#214283',
    'list.activeSelectionForeground': '#ffffff',
    'list.hoverBackground': '#4c5052',
    focusBorder: '#589df6',
  },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#909090' } },
    { scope: ['keyword', 'storage', 'constant.language'], settings: { foreground: '#cc7832' } },
    { scope: ['string', 'constant.other.symbol'], settings: { foreground: '#a5c261' } },
    { scope: ['constant.numeric', 'constant.character'], settings: { foreground: '#6897bb' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#ffc66d' } },
    {
      scope: ['entity.name.type', 'support.type', 'support.class'],
      settings: { foreground: '#a9b7c6' },
    },
    { scope: ['variable', 'entity.other.attribute-name'], settings: { foreground: '#a9b7c6' } },
    {
      scope: ['variable.other.property', 'variable.other.constant'],
      settings: { foreground: '#9876aa' },
    },
    {
      scope: ['entity.name.tag', 'punctuation.definition.tag'],
      settings: { foreground: '#e8bf6a' },
    },
    { scope: 'meta.object-literal.key', settings: { foreground: '#9876aa' } },
    { scope: 'markup.heading', settings: { foreground: '#ffc66d', fontStyle: 'bold' } },
    { scope: 'markup.bold', settings: { fontStyle: 'bold' } },
    { scope: 'markup.italic', settings: { fontStyle: 'italic' } },
    { scope: 'markup.inline.raw', settings: { foreground: '#a5c261' } },
    { scope: 'invalid', settings: { foreground: '#f47067' } },
  ],
} satisfies ThemeRegistration
