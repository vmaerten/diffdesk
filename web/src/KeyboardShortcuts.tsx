import { GO_POC } from './capabilities.ts'

export default function KeyboardShortcuts() {
  return (
    <dl className="shortcut-list">
      {!GO_POC && (
        <div>
          <dt>
            <kbd>b</kbd>
          </dt>
          <dd>Choose base</dd>
        </div>
      )}
      {!GO_POC && (
        <div>
          <dt>
            <kbd>t</kbd>
          </dt>
          <dd>Choose target</dd>
        </div>
      )}
      {!GO_POC && (
        <div>
          <dt>
            <kbd>l</kbd>
          </dt>
          <dd>Choose commit</dd>
        </div>
      )}
      <div>
        <dt>
          <kbd>j</kbd> <kbd>k</kbd>
        </dt>
        <dd>Move between files</dd>
      </div>
      <div>
        <dt>
          <kbd>v</kbd>
        </dt>
        <dd>Mark viewed</dd>
      </div>
      <div>
        <dt>
          <kbd>c</kbd>
        </dt>
        <dd>Comment selection</dd>
      </div>
      <div>
        <dt>
          <kbd>r</kbd>
        </dt>
        <dd>Refresh</dd>
      </div>
      <div>
        <dt>
          <kbd>⌘/Ctrl</kbd> <kbd>f</kbd>
        </dt>
        <dd>Search changed code</dd>
      </div>
    </dl>
  )
}
