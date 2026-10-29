# Writing a Diffdesk walkthrough

A walkthrough tells a reviewer where to start and in which order to read a change. It is a short tour of stops; each stop is one idea of the change, with the hunks that carry it, possibly across several files.

1. Run `diffdesk walkthrough hunks` (add `--code` to read the hunks) for the IDs of the comparison's hunks. An ID is `<path>#<n>`, the n-th hunk of that file's patch, counting from 1.
2. Write the JSON below and pass it to `diffdesk walkthrough set <file>`, or `-` for standard input, with the same target and `--base` as `hunks`.
3. Fix whatever `set` reports and run it again; it saves nothing until the whole document is valid.

```json
{
  "version": 1,
  "title": "What the change does, in a few words",
  "focus": "One sentence: what a reviewer should check first.",
  "chapters": [
    {
      "title": "Model",
      "stops": [
        {
          "title": "A semantic title, not a file name",
          "summary": "One sentence on what this stop changes.",
          "prose": "Optional: why, and what to look for. Two or three sentences.",
          "hunks": ["src/model.go#2", "src/state.go#1"]
        }
      ]
    }
  ],
  "support": [{ "note": "Lockfile and changelog", "hunks": ["go.sum#1", "CHANGELOG.md#1"] }]
}
```

Rules:

- Order stops for the reviewer: the core idea first, then what depends on it, tests with the code they cover or last.
- 1 to 6 chapters, 14 stops at most in all, 1 to 14 hunks per stop. A small change needs one chapter and two or three stops. Never one stop per file.
- Each hunk appears once at most. Put lockfiles, generated code, renames and mechanical edits in `support`; hunks cited nowhere are listed there anyway.
- Do not repeat paths, line numbers or code: Diffdesk shows them. Inline code goes between backticks; no other formatting.
- Describe what the diff does. Do not invent risks, tests or intentions it does not show.
