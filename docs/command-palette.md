# Palette de commandes

Statut : plan proposé le 25 octobre 2026. Maquettes : [`palette-mockup.html`](./palette-mockup.html), variante A avec les coches de B.

## Objectif

⌘K ouvre au centre de la fenêtre une palette qui cherche parmi les commandes des menus et les fichiers de la review ; ⌘P l'ouvre sur les fichiers. Entrée lance la commande ou ouvre le fichier, comme le menu ou un clic dans l'arbre.

## Constat

- Chaque action a déjà un nom, `ReviewCommand` ou `WindowCommand` dans `web/src/commands.ts`. Les menus de `desktop/main.go` envoient l'évènement `desktop:command`, qu'écoutent `App` pour la review et `DesktopApp` pour la fenêtre. Si la palette envoie le même évènement, une commande se comporte pareil depuis le menu, la touche ou la palette.
- Les libellés n'existent que dans les menus Go et dans `KeyboardShortcuts.tsx`. Côté web, rien ne dit si une commande s'applique : `runCommand` ignore sans rien dire une commande de pile hors pile ou Copy All Comments sans commentaire.
- `cmdk` 1.1.1 sert déjà `RefSelector` et `CommitSelector` : filtrage flou, navigation au clavier, groupes, `keywords` par entrée. Il ne donne pas les caractères trouvés.
- Le `keydown` d'`App` se tait quand un `dialog:modal` est ouvert : une palette en `<dialog>` garde le clavier pour elle sans nouvelle garde.
- Settings… et Open Repository… se passent dans Go. `OpenRepository` est une binding ; ouvrir Settings n'en a pas.

## Décisions

### Ouverture

- Deux entrées de menu, pour que les raccourcis s'y lisent comme les autres : View › Command Palette… (⌘K) envoie `palette`, Go › Go to File… (⌘P) envoie `go-to-file`. ghl n'imprime rien, ⌘P est libre.
- Palette ouverte, ⌘K et ⌘P changent d'onglet. Esc ou un clic à côté la ferment, et le focus revient où il était.
- Comme ⌘W, les deux raccourcis ne font rien quand Settings est au premier plan.

### Commandes

- Toutes les commandes des menus, avec le libellé du menu, le nom du menu (File, View, Go, Review, Help) et le raccourci : la lettre de la review (`c`, `l`…) ou celui du menu (⌥⌘0…). S'y ajoutent Open Repository… et Settings…, ainsi que Refresh (`r`), qui n'a pas d'entrée de menu ; pas la palette elle-même.
- Une commande sans effet est masquée : celles de la pile hors pile, Layer Below ou Above au bout de la pile, Include Working Tree et Include Untracked Files quand ils ne basculent rien, Copy All Comments sans commentaire, les commandes de fichier sans fichier actif.
- Une coche à gauche marque l'état, comme dans les menus macOS : Unified ou Split, Include Working Tree, Include Untracked Files, Ignore Whitespace, Comments, et Mark as Viewed quand le fichier actif est vu.
- Lancer une commande ferme la palette, puis envoie `desktop:command` ; Open Repository… et Settings… appellent leur binding. Settings en gagne une, `OpenSettings`.

### Fichiers

- Les fichiers de la review, dans l'ordre de l'arbre : le nom, puis le dossier en gris, les lignes ajoutées et retirées, la lettre de statut, et Viewed pour un fichier vu. Entrée l'ouvre comme un clic dans l'arbre (`selectFile`).
- Sur All et sans recherche, seules les commandes s'affichent : une review peut compter des milliers de fichiers. Ils arrivent dès la première lettre. L'onglet Files les montre tous.

### Recherche

Le filtre de `cmdk`, avec le menu en `keywords`. Les caractères trouvés passent en couleur d'accent : la sous-chaîne si la recherche en est une, sinon la première suite de caractères dans l'ordre. Une entrée que `cmdk` garde autrement reste sans surlignage.

### Un registre côté web

`commands.ts` gagne `COMMANDS` : nom, libellé, menu et raccourci de chaque commande, dans l'ordre des menus. Les libellés recopient ceux de `desktop/main.go`, et un commentaire de chaque côté renvoie à l'autre. `App` calcule pour chaque commande si elle s'applique et si elle est cochée, et rend la palette : il tient déjà les fichiers, l'état et `runCommand`. La palette est un `<dialog>` modal qui contient un `<Command>`.

## Découpage en PRs

Préfixe `palette/`, en pile `gh stack` dans l'ordre ci-dessous ; ce plan ouvre la pile.

### 01 · `palette/01-plan` — Plan et maquettes

- Ce plan et `palette-mockup.html`.

### 02 · `palette/02-commands` — Commandes

- Registre, palette sur les commandes, coches, commandes masquées, surlignage.
- View › Command Palette… (⌘K), binding `OpenSettings`.
- Suite `test/suites/palette.ts` ; raccourcis du README, du guide et de Keyboard Shortcuts ; CHANGELOG.

### 03 · `palette/03-files` — Fichiers

- Groupe Files, onglets All, Files et Commands, Go › Go to File… (⌘P).
- Suite étendue ; raccourcis ; CHANGELOG.

## Reporté

- L'aperçu du diff de la variante C.
- Les refs (base, cible) : les pickers `b`, `t` et `l` les cherchent déjà.
- Les fichiers récents et un classement par usage.
- Les commentaires dans la palette.
