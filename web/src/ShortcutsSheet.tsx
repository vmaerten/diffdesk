import DesktopSheet from './DesktopSheet.tsx'
import KeyboardShortcuts from './KeyboardShortcuts.tsx'

export default function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <DesktopSheet
      open={open}
      title="Keyboard Shortcuts"
      className="shortcuts-sheet"
      onClose={onClose}
    >
      <KeyboardShortcuts />
    </DesktopSheet>
  )
}
