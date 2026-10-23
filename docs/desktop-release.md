# Release de l'app desktop

Statut : décisions validées le 23 octobre 2026 ; spike de distribution fait le même jour.

## Objectif

`ghl` devient l'app desktop. On l'installe avec mise ou avec un tap Homebrew, et la version navigateur disparaît : plus de daemon partagé sur 7777, plus de `ghl.localhost`, plus d'interface GitHub dans le navigateur. Les commentaires et le Viewed restent dans `.git/ghl/state.json` (schéma v1 inchangé), donc rien n'est perdu à la mise à jour.

## Décisions

- **Une seule commande `ghl`**, qui est l'exécutable du bundle. `ghl [target] [--repo] [--base]` ouvre ou active un onglet, comme `ghl-desktop` aujourd'hui. `ghl comments [--json]`, `ghl --version` et `ghl --help` répondent dans le terminal sans ouvrir de fenêtre : l'export des commentaires reste le pont vers les agents. `--port`, `--no-open`, `--no-daemon`, `--idle`, `--print`, `--import-state` et `GHL_PORT` disparaissent.
- **Bundle renommé `ghl.app`**, exécutable `Contents/MacOS/ghl`. Le suffixe « Desktop » n'a plus de sens, et un chemin sans espace simplifie mise et le cask. Le bundle id `dev.ghl.desktop` ne change pas. Les réglages passent de `Application Support/ghl Desktop/` à `Application Support/ghl/`, avec reprise de l'ancien fichier au premier lancement.
- **Une seule archive** : `ghl_<version>_darwin_arm64.zip`, qui contient `ghl.app`, `LICENSE` et les notices. Elle garde le préfixe des anciennes archives CLI, donc `mise use github:vmaerten/ghl` et `mise upgrade` passent du CLI à l'app sans changer d'identifiant d'outil.
- **macOS Apple Silicon uniquement, à partir de macOS 13.** Linux et macOS Intel, publiés en v0.2.0 pour le CLI, ne sont plus servis : leurs utilisateurs restent sur 0.2.0. Un binaire universel (arm64 + amd64 via `lipo`) reste possible plus tard. macOS 13 est le minimum de la toolchain Go actuelle (le CLI 0.2.0 déclare déjà `minos 13.0`).
- **Pas de notarisation** : signature ad hoc comme aujourd'hui. Le compte Apple Developer (99 $/an) reste l'option si Gatekeeper devient bloquant.
- **Le navigateur reste un outil de dev et de test**, pas un produit : `task dev` et les suites Puppeteer servent `DesktopApp` (mode Vite `go-desktop`) dans Chrome avec des bindings Wails simulés, comme `test/desktopTabs.ts` le fait déjà.
- **Version v0.3.0**, changement cassant annoncé dans le CHANGELOG.

## Distribution

### mise

La commande reste celle d'aujourd'hui :

```bash
mise use -g github:vmaerten/ghl@0.3.0
```

Le backend GitHub de mise reconnaît un dossier `*.app` à la racine de l'archive et ajoute son `Contents/MacOS` au PATH ([doc du backend](https://mise.jdx.dev/dev-tools/backends/github.html)). Avec l'exécutable nommé `ghl`, aucune option `rename_exe` ou `bin_path` n'est nécessaire. mise télécharge avec son propre client HTTP, qui ne pose pas l'attribut `com.apple.quarantine` : l'app signée ad hoc se lance sans dialogue Gatekeeper. Le lanceur retrouve son bundle depuis le dossier d'installation de mise, via PATH comme via les shims. Tout ceci est vérifié au spike avec mise 2026.8.10.

L'app vit dans `~/.local/share/mise/installs/…`, donc pas dans `/Applications` ni dans Spotlight. C'est le canal pour qui lance `ghl` depuis le terminal.

### Homebrew

Un tap `vmaerten/homebrew-tap` (dépôt public à créer) contient `Casks/ghl.rb` :

```ruby
cask "ghl" do
  version "0.3.0"
  sha256 "…"

  url "https://github.com/vmaerten/ghl/releases/download/v#{version}/ghl_#{version}_darwin_arm64.zip"
  name "ghl"
  desc "Review the PR you are about to open, without opening it"
  homepage "https://github.com/vmaerten/ghl"

  depends_on arch: :arm64
  depends_on macos: ">= :ventura"

  app "ghl.app"
  binary "#{appdir}/ghl.app/Contents/MacOS/ghl"

  # Ad hoc signature, no notarisation: without this, Gatekeeper blocks the first launch.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/ghl.app"]
  end

  zap trash: "~/Library/Application Support/ghl"
end
```

```bash
brew install --cask vmaerten/tap/ghl
```

Homebrew 5 a déprécié `--no-quarantine` et désactive depuis septembre 2026 les casks du tap officiel qui échouent à Gatekeeper ([annonce 5.0.0](https://brew.sh/2025/11/12/homebrew-5.0.0/)). Le tap officiel est donc hors de portée sans notarisation. Pour un tap tiers, le spike sur Homebrew 7.0.10 montre :

- brew pose la quarantaine et `spctl` rejette l'app : sans l'étape de `postflight_steps`, Gatekeeper bloque le premier lancement ;
- avec elle, la quarantaine disparaît, même dans `/Applications`, et l'app se lance sans dialogue ;
- `postflight do … end` est déprécié au profit de `postflight_steps`, qui tourne dans un bac à sable avec `{{appdir}}` accessible en écriture ;
- Homebrew 7 refuse de charger un cask d'un tap non approuvé. `brew install --cask vmaerten/tap/ghl`, avec le nom complet, approuve le cask automatiquement ; un `brew install --cask ghl` après `brew tap` demande d'abord `brew trust`. La doc donne donc toujours le nom complet ;
- `brew audit --cask --strict --online` exige un `depends_on macos` cohérent avec le binaire (voir PR 05).

Le cask est généré à chaque release : un template dans le dépôt, rendu avec la version et le SHA-256 lu dans `checksums.txt`, puis poussé sur le tap par `gh api`. Le `GITHUB_TOKEN` du workflow ne peut pas écrire dans un autre dépôt : il faut un token fin `HOMEBREW_TAP_TOKEN` (contents: write sur le tap seul) en secret du dépôt. Le cask n'est poussé qu'après la publication de la release, puisqu'il pointe vers son URL publique. Si la poussée échoue, la release reste publiée et `task release:tap TAG=vX.Y.Z` la rejoue.

## Découpage en PRs

Pile `gh stack` sous le préfixe `desktop-release/`. Le spike n'a pas de PR.

### 00 · Spike de distribution, sans code — fait

La release v0.2.0 ne contient pas de zip desktop. Le spike a donc reconditionné un build de `main` dans la disposition cible (`ghl.app`, exécutable `ghl`, signature ad hoc refaite) dans `ghl_0.3.0_darwin_arm64.zip`, servi par une fausse API GitHub locale via `MISE_URL_REPLACEMENTS`. Les tests ont tourné sans toucher à la configuration mise, aux réglages ni au daemon 0.2.0 en place. Le tap `vmaerten/spike`, son approbation et l'app installée ont été supprimés à la fin.

- **mise 2026.8.10** : détection automatique du zip, `ghl.app/Contents/MacOS` dans le PATH, signature valide, aucune quarantaine. `ghl --help` répond via `mise exec` et via le shim, et la fenêtre s'ouvre depuis le dossier d'installation de mise.
- **Homebrew 7.0.10** : sans étape de post-installation, quarantaine présente et `spctl` qui rejette l'app. Avec `postflight_steps`, l'app installée dans `/Applications` et lancée par le lien de `bin` s'ouvre sans dialogue. Audit strict hors ligne propre ; l'audit en ligne relève le `minos 26.0` ci-dessous.
- **Version minimale de macOS** : le binaire desktop déclare `minos 26.0`, car cgo compile pour la version du SDK installé (27.0). En l'état, l'app ne se lancerait pas avant macOS 26. Corrigé dans la PR 05.

### 01 · `desktop-release/01-ui-harness` — Tests UI sur l'app desktop

Généraliser le harnais de `test/desktopTabs.ts` (Vite en mode `go-desktop`, bindings Wails simulés, Chrome headless) et y faire tourner `test/run.ts` et `test/suites/*`, qui testent aujourd'hui l'interface navigateur. Adapter les sélecteurs aux zones desktop (barre de titre, sidebar, panneau de commentaires). `task dev` sert `DesktopApp` dans le navigateur. Cette PR doit précéder toute suppression, pour garder la couverture des commentaires, de l'arbre, de la recherche et du Viewed.

### 02 · `desktop-release/02-remove-web-ui` — Supprimer l'interface navigateur

Supprimer le rendu `App` hors desktop dans `main.tsx`, les branches `GO_DESKTOP` et `GO_POC`, les composants réservés au navigateur (`RepoBar`, `ThemePicker`, contrôles d'en-tête GitHub, mise en page mobile), le thème lu dans le `localStorage` et le CSS GitHub de `styles.css`. Les modes Vite `go` et `go-poc` disparaissent ; `go-desktop` devient le seul build.

### 03 · `desktop-release/03-go-runtime` — Serveur intégré seulement

Supprimer `go/cmd/ghl`, `go/cmd/ghl-go-poc`, l'ouverture du navigateur, le daemon partagé (port 7777, inactivité, découverte et remplacement du runtime) et l'hôte `ghl.localhost`. Exposer une entrée de bibliothèque, par exemple `app.Serve(ctx, listener, assets)`, que `desktop/backend.go` appelle à la place de `app.Main(--daemon --port 0 --idle 0)`. Garder l'API, l'état, les révisions, les images et l'export. Retirer les tests et tâches devenus sans objet : `goCLI`, `goDaemon`, `goLocalInstall`, `goPoc`, `goDev` et `poc:*`.

### 04 · `desktop-release/04-ghl-command` — L'app devient `ghl`

Renommer le bundle en `ghl.app` et l'exécutable en `ghl` (`Info.plist`, Taskfile, `desktop/release.py`, smoke). Traiter `comments`, `--version` et `--help` avant le relancement via LaunchServices, sans fenêtre. Reprendre les réglages de l'ancien dossier `ghl Desktop`. `task install` remplace `desktop:install`.

### 05 · `desktop-release/05-release-archive` — Archive unique

GoReleaser : retirer les builds et archives CLI, produire `ghl_<version>_darwin_arm64.zip`. Compiler avec `MACOSX_DEPLOYMENT_TARGET=13.0`, écrire `LSMinimumSystemVersion` 13.0 dans `Info.plist`, et faire vérifier par `release:verify` le `minos` du binaire (`otool -l`, `LC_BUILD_VERSION`). Adapter `release:verify`, `releaseGuards.ts`, `release:publish` et la fixture mise (`test/goMise.ts`) : installation de l'app, PATH, mise à jour depuis une archive 0.2.0 synthétique, retour arrière, désinstallation. Réduire `release:acceptance` et `release:bench` à ce qui a encore un sens sans daemon.

### 06 · `desktop-release/06-homebrew-tap` — Tap Homebrew

Template du cask, tâche `release:tap` appelée par `task release` après la publication, secret `HOMEBREW_TAP_TOKEN` dans `release.yml`, tests de l'ordre et des échecs dans `test/releaseTask.py` sans écriture réelle. `brew audit --cask --strict --online` sur le cask rendu fait partie de la vérification. Création du dépôt du tap et du secret à la main.

### 07 · `desktop-release/07-docs` — Documentation

README centré sur l'app ; `installation.md` couvre mise et Homebrew ; `releases.md` et `desktop/README.md` fusionnés là où ils se répètent. Supprimer `migration.md`, `go-poc.md` et les benchmarks du runtime navigateur. Entrée CHANGELOG v0.3.0 : app seule, Linux et Intel abandonnés, réglages repris, un daemon 0.2.0 encore en marche s'arrête seul après 30 minutes d'inactivité.

### Release v0.3.0

Prérequis : correction de [#136](https://github.com/vmaerten/ghl/issues/136). Puis `package.json` à 0.3.0, tag `v0.3.0`, workflow. Ensuite : `task release:mise:published VERSION=0.3.0 PREVIOUS=0.2.0`, et `brew install --cask vmaerten/tap/ghl` sur une session macOS sans outils de dev.

## Risques

- **Gatekeeper dans le cask** : le retrait de la quarantaine fonctionne sur Homebrew 7.0.10. Si brew durcit encore les taps tiers, il reste la notarisation, ou mise seul.
- **macOS 13 à 25 non testés** : la machine de dev et le runner sont sous macOS 26. Le `minos` sera vérifié dans l'archive, pas le lancement réel sur une version plus ancienne.
- **Lancements à froid concurrents** ([#136](https://github.com/vmaerten/ghl/issues/136)) : avec `ghl` comme commande principale, deux appels rapprochés au premier lancement deviennent plus probables. Corrigé avant la release.
- **Mise à jour pendant que l'app tourne** : brew et mise remplacent le bundle, le processus en cours garde l'ancien code jusqu'à `Cmd+Q`. Pas de mise à jour automatique.

## Hors périmètre

- Notarisation et signature Developer ID.
- Mise à jour automatique (Sparkle ou équivalent).
- Tap officiel `homebrew/cask` et nom court dans le registre mise.
- Linux, Intel, Windows.

## Journal des écarts

| PR | Constat | Ce qu'on a fait |
| --- | --- | --- |
| 00 | La release v0.2.0 ne contient pas de zip desktop : le packaging (#138) est arrivé après le tag. | Spike sur un build local de `main` reconditionné, servi par une fausse API GitHub. |
| 00 | Homebrew 7 déprécie `postflight do … end`. | Cask réécrit avec `postflight_steps` et `run`, `{{appdir}}` dans les arguments. |
| 00 | Homebrew 7 n'installe un cask tiers qu'une fois approuvé ; le nom complet l'approuve automatiquement. | La doc donne toujours `brew install --cask vmaerten/tap/ghl`. |
| 00 | Le binaire desktop déclare `minos 26.0` (SDK 27.0, cgo sans cible de déploiement). | Cible macOS 13 et vérification du `minos` ajoutées à la PR 05 ; `depends_on macos` dans le cask. |
