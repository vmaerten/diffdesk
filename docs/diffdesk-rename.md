# Renommage ghl → Diffdesk

L'app s'appelle Diffdesk depuis la PR #260 : bundle `Diffdesk.app` (`dev.diffdesk.desktop`), commande `diffdesk`, cask `diffdesk`, archive `diffdesk_<version>_darwin_arm64.zip`, site `diffdesk.vmaerten.fr`. `ghl` reste une seconde commande, liée par le cask et `task install` ; mise n'expose que `diffdesk`.

## Ce qui garde le nom ghl

- `.git/ghl/state.json`, pour de bon : le déplacer couperait les commentaires lors d'un retour à une version antérieure, et une app ghl encore ouverte écrirait toujours l'ancien fichier.
- Ce qui reconnaît le CLI de 0.1 et 0.2 : `legacyCLI` (`github.com/vmaerten/ghl/cmd/ghl`) dans `desktop/legacy.go` et dans `task install`, le champ `ghlGo` et le dossier `ghl-go-runtime-*` de son démon. Ce sont les noms que portent ces anciens binaires.
- `GHL_PORT` et `GHL_DESKTOP_PROBE` dans `test/goMise.ts`, que lisent les versions publiées avant le renommage.

## Première release Diffdesk (0.5.0)

- [x] `diffdesk.vmaerten.fr` sert le site, et `ghl.vmaerten.fr` y redirige.
- [x] Le tap a `Casks/diffdesk.rb` et `cask_renames.json`, plus de `Casks/ghl.rb` ; son README pointe vers `diffdesk`.
- [x] Sur une machine avec le cask `ghl`, `brew upgrade` remplace `ghl.app` par `Diffdesk.app` et garde la commande `ghl`, mais seulement après `brew trust --cask vmaerten/tap/diffdesk` : Homebrew fait confiance à un cask par son nom, et saute sinon la mise à jour sans rien dire. Il laisse une entrée `Caskroom/ghl` vide, que `brew doctor` signale. Le guide d'installation, le README du tap et les notes de 0.5.0 donnent les deux commandes.
- [x] `task release:mise:published VERSION=0.5.0 PREVIOUS=0.4.0` passe avec mise 2026.10.2 : installation, mise à jour depuis 0.4.0, retour arrière et désinstallation.
- [x] `https://diffdesk.vmaerten.fr` est le site web du dépôt GitHub.

## Nettoyage, une ou deux versions plus tard

- [ ] Retirer la lecture des réglages dans `Application Support/ghl` et `ghl Desktop` (`desktop/settings.go`).
- [ ] Au démarrage, supprimer une fois les restes de ghl, comme `desktop/legacy.go` le fait pour 0.1 et 0.2 : `Application Support/ghl`, `ghl Desktop`, et `Caches`, `Preferences` et `WebKit` sous `dev.ghl.desktop`.
- [ ] Retirer de `release:tap` la migration du cask `ghl`, une fois `Casks/ghl.rb` supprimé ; garder `cask_renames.json` dans le tap.
- [ ] Décider si l'alias `ghl` reste (cask, `task install`, aide).

## Renommage du dépôt

- [x] `vmaerten/ghl` → `vmaerten/diffdesk` sur GitHub. L'ancien nom redirige, téléchargements de release et API compris : le cask installé et `github:vmaerten/ghl` dans mise continuent de se mettre à jour. Le module Go, le cask, l'outil mise `github:vmaerten/diffdesk` et les liens des docs suivent.
- [x] `GHL_*` → `DIFFDESK_*`, et `DiffdeskReleaseVersion` / `DiffdeskCommit` dans l'Info.plist.
- [ ] À la release suivante, `task release:mise:published VERSION=X.Y.Z PREVIOUS=0.5.0` : l'outil sous son nouveau nom, et une mise à jour depuis une version qui lit encore `GHL_DESKTOP_PROBE`.
