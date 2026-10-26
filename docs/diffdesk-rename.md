# Renommage ghl → Diffdesk

L'app s'appelle Diffdesk depuis la PR #260 : bundle `Diffdesk.app` (`dev.diffdesk.desktop`), commande `diffdesk`, cask `diffdesk`, archive `diffdesk_<version>_darwin_arm64.zip`, site `diffdesk.vmaerten.fr`. `ghl` reste une seconde commande, liée par le cask et `task install` ; mise n'expose que `diffdesk`.

## Gardé exprès jusqu'au renommage du dépôt

- Le dépôt `vmaerten/ghl`, donc le chemin du module Go `github.com/vmaerten/ghl`, l'outil mise `github:vmaerten/ghl` et les URL de release.
- `.git/ghl/state.json` : le déplacer couperait les commentaires lors d'un retour à une version antérieure, et une app ghl encore ouverte écrirait toujours l'ancien fichier.
- Les variables `GHL_*` et les clés `GHLReleaseVersion` / `GHLCommit` de l'Info.plist, internes aux tests et à la release.

## Première release Diffdesk (0.5.0)

- [x] `diffdesk.vmaerten.fr` sert le site, et `ghl.vmaerten.fr` y redirige.
- [x] Le tap a `Casks/diffdesk.rb` et `cask_renames.json`, plus de `Casks/ghl.rb` ; son README pointe vers `diffdesk`.
- [x] Sur une machine avec le cask `ghl`, `brew upgrade` remplace `ghl.app` par `Diffdesk.app` et garde la commande `ghl`, mais seulement après `brew trust --cask vmaerten/tap/diffdesk` : Homebrew fait confiance à un cask par son nom, et saute sinon la mise à jour sans rien dire. Il laisse une entrée `Caskroom/ghl` vide, que `brew doctor` signale. Le guide d'installation, le README du tap et les notes de 0.5.0 donnent les deux commandes.
- [ ] `task release:mise:published VERSION=0.5.0 PREVIOUS=0.4.0` : la mise à jour de ghl vers diffdesk. Il faut mise 2026.10.2.
- [ ] Mettre `https://diffdesk.vmaerten.fr` en site web du dépôt GitHub ; la description ne nomme pas l'app.

## Nettoyage, une ou deux versions plus tard

- [ ] Retirer la lecture des réglages dans `Application Support/ghl` et `ghl Desktop` (`desktop/settings.go`).
- [ ] Au démarrage, supprimer une fois les restes de ghl, comme `desktop/legacy.go` le fait pour 0.1 et 0.2 : `Application Support/ghl`, `ghl Desktop`, et `Caches`, `Preferences` et `WebKit` sous `dev.ghl.desktop`.
- [ ] Retirer de `release:tap` la migration du cask `ghl`, une fois `Casks/ghl.rb` supprimé ; garder `cask_renames.json` dans le tap.
- [ ] Décider si l'alias `ghl` reste (cask, `task install`, aide).

## Renommage du dépôt, en dernier

- [ ] `vmaerten/ghl` → `vmaerten/diffdesk` : GitHub redirige l'ancien nom, mais il faut mettre à jour le module Go, les URL du cask, de mise (`github:vmaerten/diffdesk`) et des docs.
- [ ] Préfixe `GHL_*` → `DIFFDESK_*`.
- [ ] `.git/ghl/` → `.git/diffdesk/`, avec relecture de l'ancien fichier et un plan pour les retours en arrière.
