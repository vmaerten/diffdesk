# Runtime desktop : Wails v2, Wails v3 ou Electron

Statut : comparatif du 24 octobre 2026, avant de choisir le runtime qui succède à Wails v2.16. « Vérifié » signifie lu dans le code source, la documentation de la version citée ou des données de release ; le reste est marqué « non vérifié ».

## Résumé

Recommandation : **Wails v3**, en figeant une beta et en refaisant le portage sur `main`. Il lève les limites qui nous ont arrêtés en v2 (barre compacte, plusieurs fenêtres et onglets natifs, menus contextuels natifs), garde un seul processus Go et une archive de 7 Mio, et le portage a déjà passé tous les tests une fois.

Electron ferait mieux sur quatre points : même moteur en production que dans les tests (Chromium), placement libre des boutons de fenêtre, translucidité qui suit le focus, apparence changeable à chaud. Il coûte une archive environ 16 fois plus lourde (115 Mio au minimum contre 7,1), un processus principal en JavaScript à côté du serveur Go, une réécriture des menus, du packaging et du smoke natif, et une montée de version majeure tous les six mois au plus tard. Il n'apporte rien sur la signature ni les mises à jour automatiques, qui exigent un Developer ID dans les trois cas.

Electron deviendrait le bon choix si les écarts entre WebKit et Chromium se mettaient à coûter régulièrement, ou si ghl visait Windows et Linux avec un rendu identique partout.

## Ce dont ghl a besoin

- Un seul binaire `ghl` : la CLI (`ghl`, `ghl comments`) et l'app, qui reçoit les ouvertures par un socket Unix (`desktop/instance.go`).
- Le serveur de review Go (`go/internal/app`), aujourd'hui dans le même processus que la fenêtre.
- Une barre de titre unifiée avec la capsule de comparaison, des menus natifs avec raccourcis, la translucidité de la fenêtre, l'apparence claire ou sombre choisie dans Settings, un dialogue d'ouverture de dossier, le presse-papiers, la fenêtre ouverte agrandie.
- Bientôt peut-être : une barre plus basse (maquettes de [desktop-titlebar-mockup.html](./desktop-titlebar-mockup.html)), plusieurs fenêtres regroupées en onglets macOS, des menus contextuels sur les fichiers.
- Distribution : zip sur GitHub, cask Homebrew et mise, signature ad hoc, macOS 13 ou plus sur Apple Silicon.
- Tests : l'interface tourne dans Chrome headless avec des bindings simulés ; le smoke natif pilote la vraie fenêtre WebKit.

## Maturité

| | Wails v2 | Wails v3 | Electron |
| --- | --- | --- | --- |
| Version | 2.17.0, stable (18 octobre 2026) | 3.0.0-beta.34 (20 octobre 2026) | 45.0.0, stable (20 octobre 2026) |
| Rythme | Correctifs | Beta automatique de nuit, plusieurs par semaine | Une majeure toutes les 8 semaines |
| Support | Maintenu tant que v3 n'est pas sortie | API annoncée stable ; jalon « v3.0.0 GA » à 92 tickets fermés et 7 ouverts, échéance du 15 septembre dépassée, sans date | Les 3 dernières majeures, soit environ 6 mois chacune |
| macOS minimum | Ne limite pas ghl, compilé pour 13 | À vérifier | 13 depuis Electron 44 ; monte avec Chromium |

Des 7 tickets ouverts pour la 3.0, un seul touche macOS : préparer la couche AppKit pour macOS 27 ([#5760](https://github.com/wailsapp/wails/issues/5760)). Les autres visent Windows, Linux ou l'outillage. La beta.34 demande Go 1.26 ; `desktop/go.mod` est en 1.25.

## Architecture

- **Wails v2 et v3** : un processus Go tient la fenêtre et le serveur. Les menus, l'instance unique et les dialogues restent en Go ; le WKWebView et ses processus XPC appartiennent à macOS.
- **Electron** : un processus principal Node (menus, fenêtres, dialogues, IPC), un rendu Chromium, et le serveur Go lancé à côté par `child_process.spawn` (`utilityProcess` ne lance que du JavaScript, vérifié). La page charge le serveur en loopback, directement ou par `protocol.handle` qui relaie vers lui (motif de la documentation, vérifié). Il faut lire le port au démarrage du serveur, l'arrêter avec l'app et le faire quitter si Electron meurt (conception, non vérifiée).
- **CLI avec Electron** : `ghl` doit rester le binaire Go dans `Contents/MacOS`, puisque mise met ce dossier dans le `PATH` ; l'exécutable Electron prend un autre nom (non vérifié avec Forge ou electron-builder). Le socket d'instance passe au serveur Go, qui doit alors demander à Electron d'ouvrir la review : un aller-retour de plus. codiff fait l'inverse : sa CLI shell lance `open -n Codiff.app --args …`.

## Fonctions natives

| Besoin | Wails v2 | Wails v3 (beta.34) | Electron 45 |
| --- | --- | --- | --- |
| Barre de titre plus basse que 52 px | Non : 52 px avec barre d'outils, 28 px sans (vérifié) | Barre compacte de 38 px (`MacToolbarStyleUnifiedCompact`, vérifié) ; pas d'API pour placer les boutons de fenêtre | Hauteur libre : barre en HTML, boutons placés par `trafficLightPosition` (vérifié ; codiff : 40 px) ; pas de `NSToolbar` |
| Translucidité qui grise quand la fenêtre perd le focus | Non, toujours active (vérifié) | Non avec `MacBackdropTranslucent`, toujours active (vérifié) ; oui avec Liquid Glass | Oui, `visualEffectState: 'followWindow'` (vérifié) ; codiff passe la fenêtre en `transparent`, ce qui retire l'ombre native |
| Apparence claire ou sombre forcée | Non, fonctions vides sur macOS (vérifié) | Par fenêtre à sa création (vérifié) ; pas d'API trouvée pour la changer à chaud | Pour toute l'app, à chaud (`nativeTheme.themeSource`, vérifié) |
| Menus avec raccourcis | Oui ; menu de l'app figé, Settings dans File (vérifié) | Oui ; menu de l'app à vérifier | Oui, menu de l'app libre (vérifié) |
| Menus contextuels natifs | Non (vérifié) | Oui (vérifié) | Oui, `Menu.popup` (vérifié) |
| Plusieurs fenêtres, onglets macOS | Non (vérifié) | Oui, `TabbingMode` (vérifié) | Oui, `tabbingIdentifier` et `addTabbedWindow` (vérifié) ; le regroupement se fait dans le code, pas tout seul |
| Instance unique avec arguments et dossier courant | Partielle : socket maison (`instance.go`) | Intégrée, avec `WorkingDir` (vérifié) ; le socket maison peut rester | `requestSingleInstanceLock` et `second-instance` (vérifié) |
| Fenêtre agrandie, dialogues, presse-papiers | Oui | Oui (vérifié) | Oui (vérifié) |

## Moteur web

Wails affiche la page dans le WKWebView du système : la version de WebKit suit celle de macOS, donc un utilisateur sous macOS 13 a un moteur plus ancien que sous macOS 26. Les tests, eux, tournent dans Chrome headless. Le journal de [desktop-redesign.md](./desktop-redesign.md) relève déjà des écarts propres à WebKit (`overflow: clip` à partir de WebKit 16, sélection de texte dans la barre de titre, menu contextuel par défaut).

Electron embarque son Chromium (M156 pour Electron 45) : le même moteur partout, celui des tests, et les DevTools de Chrome. C'est son argument le plus solide pour ghl.

## Taille, mémoire et démarrage

| | Wails v2 (ghl aujourd'hui) | Wails v3 | Electron |
| --- | --- | --- | --- |
| Archive | 7,1 Mio (`ghl_0.3.1_darwin_arm64.zip`) | Du même ordre : binaire de 22,8 Mo contre 22,2 Mo en v2 (benchmark) | 115,1 Mio pour Electron 45 seul ; codiff 1.18.2 : 209,9 Mio (vérifié) |
| Installée | 22 Mo | Du même ordre | 252 Mio pour Electron seul ; codiff : 632 Mio, sans élagage (vérifié) |
| Processus | Un processus Go, plus les XPC WebKit | Idem | Principal, GPU, réseau, rendu, plus le serveur Go |

Notre benchmark v2 contre v3 (`desktop/wails-v2-v3-benchmark.json` sur la branche `desktop/wails-v3`, Apple M5 Pro, médianes de 3 paires, run interrompu avant la fin, empreinte physique de l'app et des XPC WebKit) :

| Mesure | Petit diff, v2 / v3 | 40 fichiers et 4 000 lignes changées, v2 / v3 |
| --- | --- | --- |
| Démarrage jusqu'au premier diff | 1 396 / 1 385 ms | 1 553 / 1 509 ms |
| Mémoire après chargement | 184 / 183 Mio | 245 / 250 Mio |
| Mémoire après 40 changements d'onglet | 229 / 229 Mio | 320 / 509 Mio, plages qui se recouvrent (319–489 / 399–528) |
| Changement d'onglet dans l'interface | 170 / 172 ms | 231 / 235 ms |
| Ouverture depuis le terminal | 410–438 / 802–840 ms | 485–525 / 894–914 ms |

L'ouverture depuis le terminal est nettement plus lente en v3. Ce portage passait par l'instance unique de Wails v3 ; `main` utilise depuis son propre socket, ce qui peut effacer l'écart (non vérifié).

Pour Electron, il n'existe pas de mesure fiable sur ghl. Les benchmarks publics se contredisent : celui d'Elanis (Electron 44 contre Wails v2.16, octobre 2026) donne environ 364 Mo contre 100 Mo et un démarrage de 582 ms contre 1 396 ms, mais il compte les pages partagées de Chromium et ignore les processus XPC de WebKit ; [tauri#5889](https://github.com/tauri-apps/tauri/issues/5889) trouve au contraire Electron plus léger que WKWebView sur de vraies applications web (2022). Trancher demande un prototype Electron mesuré comme le benchmark ci-dessus.

## Distribution et mises à jour

Les trois options restent en signature ad hoc sans Developer ID, avec le même passage par Gatekeeper : le cask retire la quarantaine, et sous macOS 15 l'utilisateur d'un zip téléchargé passe par Réglages Système. Electron demande de re-signer tout le bundle (quatre apps d'aide, le framework, Squirrel, le binaire Go) ; electron-builder sait signer en ad hoc (`identity: "-"`, vérifié). codiff, lui, signe avec un Developer ID et notarise (vérifié).

Aucune des trois options ne permet une mise à jour automatique sans Developer ID : Squirrel.Mac compare la signature de la mise à jour à celle de l'app, et une signature ad hoc ne vaut que pour un binaire précis (vérifié dans le source, non testé de bout en bout). Restent `brew upgrade --cask`, `mise up`, ou un avis de mise à jour dans l'app.

## Coût du changement

**Wails v3.** La branche `desktop/wails-v3` a porté l'app d'avant la refonte (#140) : services, fenêtres, menus, dialogues et événements v3, un `bridge.js` qui adapte le runtime v3 à l'interface React actuelle sans toucher au web. Elle passait `task desktop:test`, `task desktop:vet`, les tests Go et web, `task release:snapshot` et les 21 contrôles WebKit du smoke. Depuis, 24 commits ont modifié `desktop/` ; le code natif à reporter tient surtout dans `main.go` (24 appels à Wails) et `launch.go` (8). Estimation : une PR, plus le passage à Go 1.26.

**Electron.** Tout le code natif passe en JavaScript : processus principal, les 26 entrées de menu, dialogues, instance unique, lancement et arrêt du serveur Go. Puis le packaging (Forge ou electron-builder, signature ad hoc, binaire Go dans le bundle), la release (GoReleaser ne suffit plus), `bridge.js` et `simulator.ts` réécrits autour de l'IPC, et le smoke natif refait, mais pilotable avec Puppeteer comme le reste des tests. Node entre dans la chaîne de build de l'app. Estimation : plusieurs PRs, puis une montée de majeure Electron au moins tous les six mois.

## À mesurer avant de trancher définitivement

- L'ouverture depuis le terminal en v3, avec le socket d'instance de `main`.
- La mémoire en v3 sur un gros diff, avec plus de 3 paires de mesures.
- Un prototype Electron (fenêtre, serveur Go à côté, interface actuelle) mesuré avec le même protocole, si Electron reste une option.

Ces mesures ouvrent des fenêtres au premier plan.

## Sources

- Wails : [releases](https://github.com/wailsapp/wails/releases), [annonce de la beta](https://docs-preview.wails.io/blog/wails-v3-beta/), [jalon v3.0.0 GA](https://github.com/wailsapp/wails/milestone/10), code source de `github.com/wailsapp/wails/v3@v3.0.0-beta.34` et `v2@v2.16.0`.
- Electron : [notes de la 45.0.0](https://github.com/electron/electron/releases/tag/v45.0.0), [calendrier](https://releases.electronjs.org/schedule), [BrowserWindow](https://github.com/electron/electron/blob/v45.0.0/docs/api/browser-window.md), [nativeTheme](https://github.com/electron/electron/blob/v45.0.0/docs/api/native-theme.md), [protocol](https://github.com/electron/electron/blob/v45.0.0/docs/api/protocol.md), [utilityProcess](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md), [autoUpdater](https://github.com/electron/electron/blob/v45.0.0/docs/api/auto-updater.md), [onglets macOS (#40529)](https://github.com/electron/electron/issues/40529), [Squirrel.Mac](https://github.com/Squirrel/Squirrel.Mac/blob/HEAD/Squirrel/SQRLCodeSignature.m), [electron-builder, signature macOS](https://github.com/electron-userland/electron-builder/blob/master/website/docs/features/code-signing/code-signing-mac.md).
- [codiff](https://github.com/nkzw-tech/codiff) au commit `ab0653c` : `electron/main.cjs`, `forge.config.cjs`, `electron/updater.cjs`, releases.
- Benchmarks : [Elanis, web-to-desktop-framework-comparison](https://github.com/Elanis/web-to-desktop-framework-comparison), [tauri#5889](https://github.com/tauri-apps/tauri/issues/5889), et le benchmark v2/v3 de la branche `desktop/wails-v3`.
- Apple : [contenu d'un bundle](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle), [Gatekeeper sous macOS 15](https://developer.apple.com/news/?id=saqachfa).
