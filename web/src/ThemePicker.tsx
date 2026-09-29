import { THEMES, type ThemeId } from './theme.ts'

export default function ThemePicker({
  theme,
  onChange,
}: {
  theme: ThemeId
  onChange: (value: string) => void
}) {
  return (
    <label className="theme-picker">
      <span className="theme-swatch" aria-hidden="true" />
      <span className="visually-hidden">Color theme</span>
      <select value={theme} onChange={(event) => onChange(event.target.value)}>
        {(['dark', 'light'] as const).map((mode) => (
          <optgroup key={mode} label={mode === 'dark' ? 'Dark' : 'Light'}>
            {THEMES.filter((option) => option.mode === mode).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}
