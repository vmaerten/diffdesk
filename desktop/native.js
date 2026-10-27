// The host interface DesktopApp expects, built on Wails v3's runtime. Served
// only to the app's own document; bridge.js follows it in the same script.
import { Call, Clipboard, Events, Window } from './wails/runtime.js'

const methods = [
  'Tabs',
  'ActivateTab',
  'CloseTab',
  'UpdateTabURL',
  'OpenRepository',
  'OpenSettings',
  'SaveTabView',
  'Settings',
  'SaveSettings',
  'RevealInFinder',
  'OpenFileMenu',
  'AppendDebugEvent',
  'DebugLog',
  'ClearDebugLog',
]
window.go = {
  main: {
    desktopApp: Object.fromEntries(
      methods.map((method) => [
        method,
        (...args) => Call.ByName(`main.desktopApp.${method}`, ...args),
      ]),
    ),
  },
}
window.runtime = {
  EventsOn: (name, callback) => Events.On(name, (event) => callback(event.data)),
  WindowSetTitle: (title) => Window.SetTitle(title),
  WindowMinimise: () => Window.Minimise(),
  WindowIsMinimised: () => Window.IsMinimised(),
  ClipboardSetText: async (text) => {
    await Clipboard.SetText(text)
    return true
  },
  ClipboardGetText: () => Clipboard.Text(),
}
