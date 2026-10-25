# Refonte de l'UI desktop

Statut : livré en 0.3.0 le 24 octobre 2026 (#154–#164). Design validé le 22 octobre 2026. Référence visuelle : [maquette](./desktop-redesign-mockup.html), à ouvrir dans un navigateur ; la barre au-dessus de la fenêtre ouvre Settings, affiche trois onglets et le panneau de commentaires.

## Objectif

L'app desktop affiche aujourd'hui l'interface navigateur dans une fenêtre : barre de titre native, onglets, puis trois bandeaux GitHub (environ 270 px sur 832 avant la première ligne de diff), des boutons qui doublent les menus, un panneau de commentaires modal et le menu contextuel WebKit. La refonte donne au shell desktop la grammaire d'une app macOS, sur le modèle de [codiff](https://github.com/nkzw-tech/codiff) : une barre de titre unifiée, une sidebar translucide, des fichiers en cartes et des menus natifs.

## Décisions

- **Périmètre** : seul le shell desktop change. La version navigateur garde son interface GitHub.
- **Wails v2 uniquement.** La v3 (plusieurs fenêtres, menus contextuels natifs, onglets natifs macOS) fera l'objet d'un chantier séparé après la refonte.
- **Onglets** dans la barre de titre. Avec un seul onglet, seul le chemin du repo s'affiche.
- **Apparence** Système, Clair ou Sombre, avec un thème syntaxique clair et un thème syntaxique sombre choisis parmi les 10 thèmes existants. Les couleurs de l'interface restent neutres ; seul le code prend les couleurs du thème.
- **Polices** : interface en SF Pro, non configurable. Police et taille du code configurables, SF Mono par défaut, aucune police embarquée.
- **Réglages** stockés côté Go dans `~/Library/Application Support/ghl Desktop/settings.json`, pas dans le `localStorage` du WebView.
- **Faisabilité des cartes** : codiff utilise les mêmes bibliothèques (`@pierre/diffs` 1.6.1, `@pierre/trees`). Nous sommes en `@pierre/diffs` ^1.3.5 et utilisons déjà `unsafeCSS` et `renderHeaderMetadata`.

## Spec visuelle

### Tokens

| Token | Clair | Sombre | Usage |
| --- | --- | --- | --- |
| `--app-bg` | `#f8f8f6` | `#141414` | Fond de la zone de diff |
| `--code-bg` | `#ffffff` | `#1c1c1c` | Cartes de fichier, aperçus |
| `--chrome-bg` | `rgb(246 246 244 / .72)` | `rgb(30 30 30 / .7)` | Barre de titre, sur fond translucide |
| `--sidebar-bg` | `rgb(255 255 255 / .5)` | `rgb(38 38 38 / .55)` | Sidebar et panneau de commentaires, sur fond translucide |
| `--border` | `rgb(17 17 17 / .1)` | `rgb(230 230 230 / .1)` | Séparateurs, bordures de carte |
| `--wash` | `rgb(127 127 127 / .1)` | `rgb(127 127 127 / .14)` | Survol, fond des contrôles |
| `--text` | `#111111` | `rgb(235 235 235)` | Texte principal |
| `--text-2` | `rgb(17 17 17 / .76)` | `rgb(230 230 230 / .78)` | Texte secondaire |
| `--muted` | `rgb(17 17 17 / .48)` | `rgb(230 230 230 / .48)` | Libellés, numéros de ligne |
| `--selection` | `#c2e8ff90` | `#a5a5a540` | Fichier sélectionné dans la sidebar |
| `--accent` | `#3d87f5` | `#3d87f5` | Focus, lignes sélectionnées, bouton par défaut |
| `--add` / `--del` | `rgb(31 122 68)` / `rgb(184 49 47)` | `rgb(111 208 148)` / `rgb(238 126 126)` | Statistiques, signes, gouttière |

Fond des lignes ajoutées ou supprimées : 8–9 % de `--add`/`--del`, gouttière à 15–17 %. Le thème syntaxique fournit uniquement les couleurs des tokens.

### Typographie

- Interface : `-apple-system` 13 px, texte secondaire 12 px.
- Libellés de section : 10.5 px, semi-gras, majuscules, espacement 0.06em, `--muted`.
- Chemins, refs et compteurs : SF Mono 12 px semi-gras.
- Code : `--font-code` et `--code-size` (12 px par défaut), hauteur de ligne = arrondi de taille × 1.65.

### Dimensions

| Élément | Valeur |
| --- | --- |
| Barre de titre | 40 px, boutons de fenêtre en retrait de 12 px |
| Boutons icône | 28 px, rayon 8 |
| Capsule de comparaison | 30 px, rayon 15 |
| Sidebar | 272 px par défaut, redimensionnable comme aujourd'hui |
| Rangée de fichier | 24 px, rayon 6, indentation de 14 px par niveau |
| Carte de fichier | rayon 12, marge 12 px, en-tête collant de 44 px |
| Pied de page | 32 px |
| Panneau de commentaires | 320 px |
| Settings | 640 px de large |

### Zones

- **Barre de titre** : boutons de fenêtre, afficher/masquer la sidebar, `+` (⌘O), onglets ; au centre la capsule `base → cible │ commit` ; à droite Unified/Split en icônes, le menu d'options, Copy avec le nombre de commentaires, et le bouton du panneau de commentaires.
- **Onglets** : avec un onglet, chemin `~/…/` atténué suivi du nom du repo, sans fond. Avec plusieurs, pastilles portant le nom du repo, × au survol et sur l'onglet actif, largeur minimale ~110 px, `»` pour les onglets qui ne tiennent pas. La capsule et les actions ne rétrécissent jamais.
- **Menu d'options** : Working tree, Untracked files (avec leur nombre), Ignore whitespace, en cases à cocher.
- **Sidebar** : en-tête « CHANGES n » avec plier/déplier en icônes ; statut A/M/D coloré, coche des fichiers vus ; pied « x of n viewed », `+/−` et barre de progression.
- **Cartes** : chevron, chemin en mono avec le dossier atténué, badge `+n −n`, statut, copier le nom, bouton Viewed discret. Cocher Viewed replie la carte. Séparateurs « n unmodified lines » pour déplier le contexte.
- **Fil de commentaire** : carte sous la ligne commentée, auteur, plage de lignes, éditer et supprimer au survol.
- **Pied de page** : source de la base, inclusions, notes de révision, et « Next fichier `j` ».
- **Panneau de commentaires** : panneau à droite qui pousse le diff, une carte par commentaire (emplacement en mono, texte), « Copy all as Markdown ⇧⌘C » en bas.
- **Settings** : feuille attachée à la fenêtre principale, puisque Wails v2 n'a qu'une fenêtre. Sections Appearance (vignettes System/Light/Dark, thèmes syntaxiques clair et sombre) et Code (police, taille), puis aperçu clair et sombre côte à côte. Application immédiate, sans bouton Enregistrer.

### Comportements natifs

- Curseur par défaut partout, sauf dans le code et les commentaires.
- Interface non sélectionnable ; le code, les commentaires et les champs le restent.
- Les zones vides de la barre de titre déplacent la fenêtre (`--wails-draggable: drag`) ; les contrôles en sont exclus (`no-drag`).
- Pas de menu contextuel dessiné en HTML : Wails v2 n'expose pas de menus contextuels natifs. Le menu WebKit reste limité aux champs et au texte sélectionné, par la règle `--default-contextmenu: auto` du runtime (active tant que `EnableDefaultContextMenu` vaut `true`). Les actions sur un fichier passent par le menu Review.
- Les listes sans recherche utilisent `<select>` : dans WKWebView, ils ouvrent un vrai menu macOS.
- Anneau de focus : 3 px de `--accent` à 45 %.
- Aucune fenêtre modale web : le panneau de commentaires ne bloque pas la fenêtre principale. Settings est une feuille, l'équivalent macOS d'un dialogue attaché à la fenêtre.

### Menus et raccourcis

| Menu | Élément | Raccourci | Remplace |
| --- | --- | --- | --- |
| File | Settings… | ⌘, | Sélecteur de thème (Wails v2 fige le menu de l'app) |
| File | Open repository…, Close tab | ⌘O, ⌘W | Existants |
| View | Refresh | ⌘R | Bouton Refresh (déplacé depuis File) |
| View | Unified, Split | ⌘1, ⌘2 | Bascule de la barre d'outils |
| View | Show sidebar, Show comments | ⌃⌘S, ⌥⌘0 | Bouton Files, bouton Comments |
| View | Working tree, Untracked files, Ignore whitespace | —, —, ⌥⌘W | Cases à cocher des bandeaux |
| Go | Next file, Previous file, Choose base, Choose target, Choose commit | voir ci-dessous | — |
| Review | Mark as viewed, Comment selection | voir ci-dessous | — |
| Review | Copy file path, Reveal in Finder, Reset viewed | — | Bouton Reset de la sidebar |
| Review | Copy all comments | ⇧⌘C | Bouton Copy all |
| Help | Keyboard Shortcuts | — | Bouton `?` |

Les raccourcis à une lettre (`j`, `k`, `b`, `t`, `l`, `c`, `v`, `r`) restent gérés en JS et sont listés dans Help → Keyboard Shortcuts. Leurs éléments de menu n'ont pas d'accélérateur : une touche sans modificateur capturerait la saisie dans les champs.

## Découpage en PRs

Branches `desktop-ui/NN-<couche>`, une worktree par PR sous `../worktrees/github-like/desktop-ui/`. Les PRs forment une pile linéaire gérée avec `gh-stack` : la PR 01 cible `main`, chaque PR suivante cible la précédente.

```
main ─ 01 ─ 02 ─ 03 ─ 04 ─ 05 ─ 06 ─ 07 ─ 08
```

Chaque PR met à jour les sélecteurs de `desktop/native-smoke.js` qu'elle touche, notamment `.repo-name`, `.comments-trigger`, `.comments-panel[open]`, `.desktop-tab-close`, `.desktop-empty` et `.viewed-toggle input`.

### 01 · `desktop-ui/01-review-chrome` — Découper l'en-tête de `App.tsx`

Refactor sans changement visuel.

- Extraire de `App.tsx` (909 lignes) les morceaux de l'en-tête en composants qui reçoivent l'état et les callbacks : contexte du repo et actions, contrôles de révision (base, cible, commit, inclusions, notes), navigation de pile, outils de review (layout, commentaires, copie).
- `App` garde l'état, les données et les raccourcis clavier. Le point d'injection du layout desktop arrive avec la PR 04, qui en est le premier utilisateur.
- Validation : tests existants et comparaison avant/après dans le navigateur.

### 02 · `desktop-ui/02-tokens` — Palette neutre et apparence système

- `desktop.css` : tokens de la spec, typographie 13 px, curseur par défaut, interface non sélectionnable.
- Modèle d'apparence `system | light | dark` avec un thème syntaxique clair et un sombre. Le thème actif suit l'apparence effective, et `prefers-color-scheme` en mode Système. Par défaut : GitHub Light et GitHub Dark dimmed. `theme.ts` garde ses 10 palettes pour le navigateur.
- Fenêtre : `WebviewIsTransparent` et `WindowIsTranslucent` dans `mac.Options`, `BackgroundColour` transparent au lieu du gris GitHub codé en dur. `EnableDefaultContextMenu` reste à `true` : le désactiver supprimerait aussi Copier/Coller dans les champs.
- Contraste des 10 thèmes sur le fond neutre : non traité, à décider (voir questions ouvertes).
- Test : résolution apparence → thème effectif, notamment en mode Système avec le macOS en sombre.

### 03 · `desktop-ui/03-settings` — Feuille Settings

- Feuille attachée à la fenêtre principale, ouverte par File → Settings… (⌘,) ; Échap et Done la ferment.
- Contenu de la spec : apparence, deux thèmes syntaxiques, police du code (SF Mono, Menlo, JetBrains Mono, Fira Code, Other… avec champ libre), taille de 10 à 18 pt, aperçu clair et sombre.
- Détection des polices installées par mesure des glyphes ; repli sur SF Mono avec un message.
- Persistance Go via une liaison Wails : `settings.json` versionné, appliqué avant le premier rendu d'une review pour éviter un flash de thème.
- Retire le `ThemePicker` du desktop.
- Tests Go : fichier absent → défauts ; version inconnue ou valeurs hors bornes → défauts ; aller-retour lecture/écriture. Smoke : changer l'apparence et vérifier qu'elle s'applique.

### 04 · `desktop-ui/04-titlebar` — Barre de titre unifiée et onglets

- `mac.TitleBarHiddenInset()`, boutons de fenêtre en retrait, barre HTML de 40 px translucide ; `--wails-draggable: drag` sur la barre et `no-drag` sur ses contrôles.
- Bouton sidebar, `+`, onglets déplacés de `.desktop-tabbar` vers la barre, avec le comportement de la spec et le `»` de débordement. La navigation clavier actuelle est conservée : flèches, Home/End, ⌃Tab.
- Écran vide restylé : fond neutre, « Open repository… ⌘O ».
- Les bandeaux web restent affichés sous la barre jusqu'à la PR 05.
- Test : répartition des onglets entre la barre et le `»` selon la largeur disponible.

### 05 · `desktop-ui/05-review-toolbar` — Contrôles dans la barre, pied de page et menus

- Capsule `base → cible │ commit` : les sélecteurs existants deviennent des popovers ancrés. Unified/Split en icônes, menu d'options, Copy avec le nombre de commentaires, bouton du panneau de commentaires.
- Le desktop n'affiche plus l'appbar, la reviewbar ni les review-tools.
- Navigation de pile `gh stack` déplacée dans le popover de la cible.
- Pied de page : source de la base, inclusions, notes de révision, fichier suivant.
- Les bandeaux d'avertissement (opération Git en cours, notice) restent sous la barre.
- Menus View, Go, Review et Help selon le tableau.
- Smoke : Unified/Split depuis le menu ; ⇧⌘C vérifié dans le presse-papiers.

### 06 · `desktop-ui/06-sidebar` — Sidebar translucide

- Sidebar pleine hauteur sous la barre, fond translucide, en-tête, rangées et pied de la spec. Masquer avec ⌃⌘S ; largeur redimensionnable conservée.
- Menu Review : Mark as viewed / unviewed, Copy file path, Reveal in Finder et Reset viewed, appliqués au fichier actif.
- Reveal in Finder ajoute une liaison Go qui refuse tout chemin hors du checkout ; un test Go couvre ce refus.

### 07 · `desktop-ui/07-file-cards` — Fichiers en cartes

- En-tête `@pierre/diffs` restylé avec `unsafeCSS` et `renderHeaderMetadata` : chevron, chemin, badge `+/−`, statut, copier le nom, Viewed. Cocher Viewed replie la carte.
- Cartes arrondies, séparateurs de contexte et fils de commentaires inline selon la spec.
- Vérifier si l'écart entre `@pierre/diffs` ^1.3.5 et la 1.6.1 de codiff impose une mise à jour.

### 08 · `desktop-ui/08-comments-inspector` — Panneau de commentaires non modal

Ne dépend que de la PR 05 ; placée en fin de pile pour garder une chaîne linéaire.

- En desktop, `CommentsPanel` devient un panneau droit de 320 px qui pousse le diff : plus de `<dialog>` modal ni de fond assombri. Redimensionnable, ⌥⌘0, état ouvert conservé dans la vue sauvegardée (`commentsOpen`).
- `App` coupe aujourd'hui tous les raccourcis quand le panneau est ouvert (`if (commentsOpen) return`). Avec un panneau non modal, `j`, `k`, `v` et les autres doivent continuer à marcher tant que le focus n'est pas dans un champ du panneau.
- Le tiroir de la version navigateur ne change pas.
- Smoke : édition et suppression depuis le panneau, navigation `j`/`k` panneau ouvert.

## Journal des écarts et contraintes Wails v2

Chaque écart avec ce plan et chaque particularité de Wails v2 rencontrée en route, pour comparer plus tard avec Electron et Wails v3. « Vérifié » signifie lu dans le code source (Wails v2.16, Wails v3 beta.34, codiff pour Electron) ; le reste est à vérifier.

| PR | Constat | Type | Ce qu'on a fait | Electron | Wails v3 |
| --- | --- | --- | --- | --- | --- |
| 01 | Le layout desktop injectable n'avait pas d'utilisateur dans la PR 01. | Écart | Reporté à la PR où la barre de titre en a besoin. | — | — |
| 02 | `EnableDefaultContextMenu: false` supprime le menu partout, champs compris ; `true` applique `--default-contextmenu: auto` (champs et texte sélectionné seulement). Vérifié dans le runtime v2. | Contrainte v2 | Laissé à `true`, contrairement au plan. | Aucun menu par défaut : l'app construit le sien. | À vérifier. |
| 02 | `BackgroundColour` est fixé au lancement : un gris sombre codé en dur s'affichait aussi en apparence claire. | Contrainte v2 | Fond transparent + `WindowIsTranslucent` : le matériau système s'affiche jusqu'au premier rendu. | `backgroundColor` choisi à la création selon `nativeTheme`, ou transparent avec vibrancy (vérifié dans codiff). | `MacBackdropTranslucent` (vérifié). |
| 02 | La translucidité v2 est un `NSVisualEffectView` toujours actif, au matériau par défaut : il ne devient pas gris quand la fenêtre perd le focus. Vérifié. | Contrainte v2 | Accepté. | `vibrancy: 'under-window'`, `visualEffectState: 'followWindow'` (vérifié dans codiff). | `MacBackdropTranslucent` et `MacBackdropLiquidGlass` (vérifiés) ; état inactif à vérifier. |
| 03 | Le menu de l'app est un rôle figé (About, Hide, Hide Others, Show All, Quit) : impossible d'y ajouter Settings sans perdre Hide. Vérifié. | Contrainte v2 | Settings… (⌘,) dans le menu File ; sous Wails v3, dans le menu ghl. | Menu d'app entièrement libre, avec des rôles par élément (`hide`, `quit`…). | Menu d'app libre : About, Services, Hide, Hide Others, Show All et Quit sont des rôles par élément (vérifié dans `roles.go`). Le Show All de son rôle `AppMenu` est le rôle `UnHide`, sans sélecteur : il ne fait rien. Le rôle `ShowAll` appelle `unhideAllApplications:` (vérifié dans `menuitem_selectors_darwin.go`). |
| 03 | Une seule fenêtre en v2. | Contrainte v2 | Settings en feuille attachée à la fenêtre principale ; sous Wails v3, une fenêtre à part, avec ses volets dans la barre d'outils. | Plusieurs `BrowserWindow`. | Plusieurs fenêtres (vérifié). |
| 03 | Les appels de bindings successifs pourraient être traités dans le désordre. Non vérifié. | Précaution | Sauvegarde des réglages regroupée après 300 ms ; sous Wails v3, la fenêtre Settings sauve chaque changement, un appel à la fois, et seulement le dernier arrivé entre-temps. | IPC ordonnée par canal (à vérifier). | Chaque appel tourne dans sa goroutine : l'ordre n'est pas garanti (vérifié dans `assetserver_webview.go`). |
| 03 | `@pierre/diffs` estime la hauteur des lignes avant de les mesurer : changer la taille du code fausserait le défilement. | Ajout au plan | `itemMetrics.lineHeight` suit la taille. | Identique (côté web). | Identique. |
| 03 | Les smoke tests auraient modifié les vrais réglages. | Ajout au plan | `GHL_DESKTOP_SETTINGS` pointe vers un fichier temporaire. | — | — |
| 03 | Filtrage des thèmes par contraste non fait. | Écart | Question ouverte. | — | — |
| 04 | Les boutons de fenêtre ne peuvent pas être déplacés ; avec `TitleBarHiddenInset`, macOS les centre dans une barre d'outils de 52 px. Vérifié. | Contrainte v2 | Barre de 52 px au lieu des 40 px de la maquette. | `trafficLightPosition` (vérifié dans codiff : barre de 40 px). | Options `MacTitleBar` vérifiées ; position des boutons à vérifier. |
| 04 | En plein écran, les boutons de fenêtre disparaissent mais la marge de 84 px reste. | Non traité | À reprendre. | codiff retire la marge en plein écran (vérifié). | À vérifier. |
| 04 | Pas de menu natif ouvrable depuis le JS. | Contrainte v2 | Menu « … » des onglets en trop : un `<select>` invisible posé sur l'icône, que WebKit ouvre en menu macOS. | `Menu.popup()`. | Menus contextuels natifs (vérifié). |
| 04 | Le bouton sidebar suppose de pouvoir masquer la sidebar dans `App`. | Écart | Déplacé à la PR 06. | — | — |
| 04 | Le chemin du checkout n'était pas connu des onglets. | Ajout au plan | Transmis par Go, relatif au home. | — | — |
| 05 | Le « layout fourni par `DesktopApp` » est devenu un portail React : `App` garde tout son état et rend ses contrôles dans un emplacement de la barre de titre. | Écart | `toolbar` passé à `App` ; sans lui, rendu navigateur inchangé. | — | — |
| 05 | Navigation de pile `gh stack` placée dans la barre d'état plutôt que dans le popover de la cible. | Écart | Réutilise `StackNav` tel quel. | — | — |
| 05 | Pas de coche dans les menus pour Working tree, Untracked et Ignore whitespace : l'état vit dans la page, il faudrait le renvoyer à Go puis rafraîchir le menu (`MenuUpdateApplicationMenu`). | Reporté | Éléments de menu « Include… » sans coche. | Même aller-retour, par IPC (à vérifier). | À vérifier. |
| 05 | Ordre des menus macOS (App, File, Edit, View, Go, Review, Window, Help) et menu Window standard ajoutés. | Ajout au plan | `menu.WindowMenu()` de Wails. | Rôle `windowMenu`. | À vérifier. |
| 05 | Le panneau de commentaires reste modal jusqu'à la PR 08 ; ⌥⌘0 l'ouvre et le ferme. | Transitoire | — | — | — |
| 05 | À 800 px (largeur minimale), la capsule et les actions laissent environ 90 px aux onglets. | Non traité | À reprendre si gênant. | — | — |
| 05 | Le smoke reconnaissait la review par `.repo-name`, absent du desktop. | Ajout au plan | `data-repo` sur `.app`. | — | — |
| 05 | Retour de test : l'icône à curseurs et l'icône de copie avec son compteur ne disaient pas ce qu'elles font. | Écart (maquette) | Boutons texte « Options ▾ » et « Copy N ». | — | — |
| 04→06 | Sur macOS, `WindowSetLightTheme`, `WindowSetDarkTheme` et `WindowSetSystemDefaultTheme` sont des fonctions vides en v2 : le matériau de la fenêtre suit toujours macOS. Clair forcé sous un macOS sombre donnait une barre et une sidebar claires sur matériau sombre. Vérifié. | Contrainte v2 | Barre et sidebar opaques quand l'apparence de l'app diffère de celle de macOS (`data-material`), contrôlé par le smoke. Correctif dans la PR 04. | `nativeTheme.themeSource` change l'apparence de l'app, vibrancy comprise (à vérifier). | À vérifier. |
| 06 | Le bouton sidebar annoncé en PR 04 arrive ici, avec ⌃⌘S. | Écart | État gardé dans le `localStorage` du WebView. | — | — |
| 06 | Le matériau de la fenêtre ne se choisit pas en v2 (`NSVisualEffectView` sans matériau précisé, vérifié) : pas de matériau « sidebar » natif. Un voile de 6 % donnait une sidebar et un panneau bleutés et plus clairs (`#474c56`) que la barre de titre (`#2d2e32`). | Contrainte v2 | Une seule teinte de chrome (`--chrome-bg`) pour la barre, la sidebar et le panneau : `#2d3033` mesuré. | Type de vibrancy au choix (`sidebar`, `under-window`…). | Types de backdrop (vérifié) ; matériau précis à vérifier. |
| 06 | Libellé de menu « Toggle Sidebar » au lieu de « Show / Hide Sidebar » : le libellé ne suit pas l'état sans aller-retour vers Go. | Contrainte v2 | Libellé fixe. | Libellé modifiable depuis le main process (à vérifier). | À vérifier. |
| 06 | Pas de menu contextuel sur les fichiers. | Contrainte v2 | Copy File Path, Reveal in Finder et Reset Viewed dans le menu Review, sur le fichier actif. | `Menu.popup()`. | Menus contextuels natifs (vérifié). |
| 06 | Reveal in Finder : le chemin vient de la page. | Ajout au plan | Go le résout dans le checkout de l'onglet, liens symboliques compris, et refuse le reste ; test Go. | — | — |
| 06 | Vues et totaux de lignes déplacés de la barre d'état vers le pied de la sidebar, comme le prévoyait la spec. | Écart (PR 05) | — | — | — |
| 06 | Lignes de l'arbre à 24 px et sélection neutre non faites : l'arbre `@pierre/trees` vit dans un shadow DOM, on a seulement rendu son fond transparent. | Reporté | — | — | — |
| 07 | Le fond des en-têtes collants vient du thème de `@pierre/diffs`, pas de nos variables. | Constat (bibliothèque) | Règle `[data-sticky]` qui lit `--file-header-bg`, avec le fond du thème en repli : le navigateur ne change pas. | Identique (côté web). | Identique. |
| 07 | Les cartes arrondies doivent rogner leur contenu sans casser les en-têtes collants. | Constat (WebKit) | `overflow: clip` (WebKit 16+) au lieu de `hidden`, qui ferait de chaque carte un conteneur de défilement. | Chromium supporte `clip` aussi. | Identique (WebKit). |
| 07 | Pas de libellé de statut (Modified, Added) dans l'en-tête : il faudrait un drapeau desktop dans `useReviewDiff`. L'icône de type de changement reste. | Écart | — | — | — |
| 07 | Les compteurs `+n −n` sont deux éléments séparés dans le shadow DOM : pas de pastille commune comme dans la maquette. | Écart | Compteurs colorés conservés. | — | — |
| 07 | Pas de mise à jour de `@pierre/diffs` nécessaire (1.3.5, contre 1.6.1 chez codiff). | Vérifié | — | — | — |
| 08 | Panneau de commentaires de 320 px, non redimensionnable : `Resizer` ne gère que la sidebar de gauche. | Reporté | — | — | — |
| 08 | Le panneau reste monté, masqué par `hidden`, pour garder le brouillon d'édition ; le smoke cible `.comments-panel:not([hidden])` au lieu de `[open]`. | Ajout au plan | — | — | — |
| 08 | « View in diff » laisse désormais le panneau ouvert en desktop. | Ajout au plan | — | — | — |
| 08 | Les fixtures du smoke n'ont qu'un fichier : `j`/`k` ne peuvent pas y changer de fichier. | Écart (test) | Le smoke vérifie à la place qu'un raccourci (`b`) marche panneau ouvert, hors brouillon en cours. | — | — |
| Review | La version navigateur doit être retirée (décision du 23 octobre) : ses deux régressions trouvées en review (couleur des en-têtes collants, touches bloquées par la visionneuse d'images) ne sont pas corrigées, et la duplication avec les composants du navigateur (`ReviewTools`, en-tête) n'est pas factorisée. | Décision | — | — | — |
| Review | Accent clair `#2a66c9` au lieu de `#3d87f5`, et un seul niveau de texte atténué (`--text-dim` à 60 % / 56 %) au lieu de `--text-2` et `--muted` : contraste AA et modèle de variables existant. | Écart (spec) | Conservé. | — | — |
| Review | Unified/Split en texte plutôt qu'en icônes, comme Options et Copy. | Écart (spec) | Conservé. | — | — |
| Review | Cartes : ni marge de 12 px, ni en-tête de 44 px, ni dossier atténué dans le chemin. Espacement et hauteur d'en-tête viennent de `@pierre/diffs` et de ses estimations de défilement ; le chemin est un seul texte dans son shadow DOM. | Contrainte (bibliothèque) | Conservé. | Identique. | Identique. |
| Review | Valeurs de réglages hors bornes testées en TS, pas en Go : Go ne connaît pas le schéma. | Écart (test) | — | — | — |
| Review | Raccourcis clavier affichés dans une feuille (menu Help), non prévue par le spec. | Ajout | Seule surface possible avec une fenêtre unique. | Fenêtre ou popover natif. | Seconde fenêtre possible. |
| Review | Commits `refactor` qui changent un comportement (`3eb28ca`, `7c74f76`) : historique déjà publié, non réécrit. Les corrections de la review vont dans une PR 09 en haut de la pile. | Constat | — | — | — |
| Wails v3 | La page v3 a pour origine `wails://localhost` : le contrôle d'origine du serveur, qui ne regardait que l'hôte, l'acceptait comme `localhost`. Relevé par `backend_test.go`. | Contrainte v3 | Le serveur n'accepte plus que les origines `http` et `https`. | Page servie en `http://127.0.0.1` ou par un schéma maison (`protocol.handle`). | — |
| Wails v3 | Un corps de requête peut arriver en flux, avec une longueur nulle et sans `Content-Length` : `ReverseProxy` le relayait vide et l'écriture des commentaires échouait. Constaté dans le premier portage. | Contrainte v3 | Longueur marquée inconnue avant le relais (`backend.go`). | — | — |
| Wails v3 | v3 ne crée plus `window.go` ni `window.runtime` : ses bindings et son runtime sont un module ES, alors que le shell React les lit dès son montage. | Écart | Le gestionnaire d'assets ajoute `native.js` en tête d'`index.html` ; il reconstruit les deux objets à partir du runtime v3, suivi de `bridge.js`. | Script `preload` avec `contextBridge` (prototype `spike/electron`). | — |
| Settings | `SetSize` garde l'origine du cadre, son coin bas-gauche : une fenêtre qui change de hauteur bouge par le haut, alors que les réglages macOS gardent leur haut en place d'un volet à l'autre. Vérifié dans `webview_window_darwin.go`. | Contrainte v3 | Une hauteur fixe, celle du volet le plus haut ; le volet défile au-delà. | `setBounds` avec animation (à vérifier). | — |
| Settings | Le menu appartient à l'app : ⌘W (Close Review) fermait la review derrière Settings, et fermer la review laissait Settings garder l'app ouverte. | Contrainte v3 | Go regarde la fenêtre active (`Window.Current()`) : ⌘W ferme Settings quand elle est devant. Fermer la review ferme Settings. | Rôle `close` sur la fenêtre active (à vérifier). | — |
| Barre compacte | Wails v2 crée une barre d'outils macOS sans jamais régler son `toolbarStyle` : macOS prend le style unifié de 52 px. Vérifié dans `WailsContext.m`. | Contrainte v2 | Essai en Objective-C (`NSWindowToolbarStyleUnifiedCompact` au démarrage) : barre de 38 px, boutons centrés, vérifié par capture. Non retenu. Sous Wails v3 : `MacToolbarStyleUnifiedCompact` à la création de la fenêtre, activable dans Settings ; appliqué au lancement suivant, v3 n'ayant pas de méthode pour changer le style ensuite. | `trafficLightPosition` (vérifié dans codiff). | `MacToolbarStyleUnifiedCompact` (vérifié). |

## Onglets : propositions

Maquette : [desktop-tabs-mockup.html](./desktop-tabs-mockup.html), six propositions dans le style actuel de l'app, avec un tableau comparatif.

**Constat.** Un onglet identifie un repo *et* une comparaison (base, cible). Les onglets actuels n'affichent que le nom du repo : deux reviews du même repo avec des comparaisons différentes apparaissent toutes deux comme « github-like ». Ils partagent aussi la barre de titre avec la capsule de comparaison et les actions : 3 à 5 onglets tiennent à 1280 px, un seul à 800 px.

| # | Proposition | Framework | Pour | Contre |
| --- | --- | --- | --- | --- |
| 1 | Onglets dans la barre de titre (actuel) | v2, fait | Aucune hauteur en plus ; avec une review, le chemin du checkout est très lisible. | Reviews du même repo indiscernables ; peu de place ; aucune info par review. |
| 2 | Barre d'onglets dédiée, sous la barre de titre, à partir de deux reviews | v2 | Repo, comparaison et commentaires par onglet ; barre de titre libérée et lisible à 800 px ; réutilise le code actuel. | 36 px de plus dès deux reviews ; dessinée en HTML ; débordement à prévoir au-delà de 6–8 onglets. |
| 3 | Liste « Reviews » en tête de la sidebar (liste de sources) | v2 | Passe à 10 reviews et plus ; comparaison, fichiers vus, commentaires ; idiome macOS (Mail, Xcode). | Raccourcit l'arbre ; invisible quand la sidebar est masquée ; loin de l'endroit où l'on lit le code. |
| 4 | Sélecteur de review : le chemin devient un bouton à menu | v2 (`<select>`), natif en v3 ou Electron | Un seul bouton, lisible à toutes les largeurs ; sert aussi de menu de débordement. | On ne voit pas ce qui est ouvert ; deux gestes pour changer (⌃Tab reste direct). |
| 5 | Une fenêtre par review, regroupées en onglets par macOS | Wails v3 (multi-fenêtres et `TabbingMode`, vérifiés) ou Electron (`tabbingIdentifier`) | Le plus natif ; glisser un onglet hors de la fenêtre, vue d'ensemble (⇧⌘\), fenêtres côte à côte ; règle aussi la fenêtre Settings séparée. | Changement de framework ; l'état d'onglets Go (`tabs.go`, vues sauvegardées) devient un état par fenêtre ; pas de compteur par onglet. |
| 6 | Rail de repos : pastilles à initiales, comme Slack | v2 | Très compact ; badges toujours visibles. | Initiales peu parlantes (deux « GL ») ; idiome de messagerie plus que macOS ; une colonne de plus. |

**Recommandation.**
- En Wails v2 : la 2, avec le sélecteur de la 4 comme menu de débordement à la place du « … » actuel. Elle corrige l'ambiguïté des reviews du même repo et ne coûte de la hauteur que quand plusieurs reviews sont ouvertes.
- Si on passe en Wails v3 ou en Electron : la 5, la plus native, à condition d'accepter de refaire le modèle d'onglets côté Go.
- À écarter : la 6 (peu lisible) et la 1 telle quelle (ambiguë).

## Barre compacte : propositions

Maquette : [desktop-titlebar-mockup.html](./desktop-titlebar-mockup.html), quatre hauteurs de barre (A à D) et trois façons de se passer de la barre d'état (E à G), du 24 octobre 2026.

## Hors périmètre

Wails v3 et ce qu'elle apporterait (fenêtre Settings séparée, menus contextuels natifs, onglets natifs macOS), filtre de fichiers, liste des repos récents sur l'écran vide, mises à jour automatiques, notarisation, Linux et Windows, refonte de la version navigateur.

## Questions ouvertes

1. Le double-clic dans la barre de titre agrandit-il la fenêtre une fois la barre native masquée ? À vérifier pendant la PR 04.
2. Faut-il écarter les thèmes syntaxiques peu contrastés (certains, comme Solarized Light, utilisent des teintes peu contrastées par conception ; non mesuré) ?
3. Quelle présentation des onglets retenir ? Voir [Onglets : propositions](#onglets--propositions).
