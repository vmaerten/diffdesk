# License sources

`react-remove-scroll-bar@2.3.8` declares MIT but its npm archive omits the license
text. The adjacent file copies the upstream license at commit
[8ca9ba5ea52de03308fe8ced94f7b159a44d28ff](https://github.com/theKashey/react-remove-scroll-bar/blob/8ca9ba5ea52de03308fe8ced94f7b159a44d28ff/LICENSE).
The notice generator uses it only for this exact package version. A dependency
upgrade with missing license material fails until its source is reviewed.

`lru_map` includes its complete MIT text in its packaged README. Other package
LICENSE and NOTICE files are read directly from the installed dependency tree.

Shiki's published packages omit notices for the vendored Oniguruma engine,
grammars and themes. The generator appends these files for the corresponding
`@shikijs/*` versions and rejects other versions until they are reviewed:

| File                            | Source                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shiki-oniguruma-4.4.2.LICENSE` | [Shiki v4.4.2 bindings license](https://github.com/shikijs/shiki/blob/2aec8566cf186a92f4e094e6a92c335de3181ecd/packages/engine-oniguruma/src/oniguruma/LICENSE) |
| `vscode-oniguruma-1.7.0.NOTICE` | [VS Code Oniguruma v1.7.0 notices](https://github.com/microsoft/vscode-oniguruma/blob/v1.7.0/NOTICES.txt), including Oniguruma 6.9.5_rev1                       |
| `tm-grammars-1.32.0.NOTICE`     | `package/NOTICE` from [the published npm archive](https://registry.npmjs.org/tm-grammars/-/tm-grammars-1.32.0.tgz)                                              |
| `tm-themes-1.12.3.NOTICE`       | `package/NOTICE` from [the published npm archive](https://registry.npmjs.org/tm-themes/-/tm-themes-1.12.3.tgz)                                                  |
| `tm-themes-1.12.12.NOTICE`      | `package/NOTICE` from [the published npm archive](https://registry.npmjs.org/tm-themes/-/tm-themes-1.12.12.tgz), for `@shikijs/themes@4.5.0`                    |

These versions come from [Shiki v4.4.2's lockfile](https://github.com/shikijs/shiki/blob/2aec8566cf186a92f4e094e6a92c335de3181ecd/pnpm-lock.yaml)
and, for `tm-themes-1.12.12`, [Shiki v4.5.0's](https://github.com/shikijs/shiki/blob/f7d0167873fd676fe4e190bc9b53832fba9ee01d/pnpm-lock.yaml).
The grammar and theme notices are preserved in full, including their individual
copyright statements and license texts.
