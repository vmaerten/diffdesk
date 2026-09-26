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
        {THEMES.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
