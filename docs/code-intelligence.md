# Intelligence de code (LSP, bêta)

Statut : plan proposé le 25 octobre 2026. Maquettes : [`code-intelligence-mockup.html`](./code-intelligence-mockup.html), pistes A, C et F du canvas de design.

## Objectif

Pendant une review, tenir ⌘ au-dessus d'un symbole montre son type et sa documentation, et ⌘-clic mène à sa définition. Ses références s'ouvrent dans un onglet Symbol, à côté des commentaires. Les réponses viennent des serveurs de langage installés sur le Mac. La fonction est en bêta, éteinte par défaut, et se règle dans Settings.

## Constat

- `@pierre/diffs` 1.3.5 expose `onTokenEnter`, `onTokenLeave` et `onTokenClick`, avec `lineNumber`, `lineCharStart`, `lineCharEnd`, `side`, `tokenText` et `tokenElement`. Les colonnes additionnent les `content.length` des tokens Shiki de la ligne brute : ce sont des unités UTF-16, l'encodage par défaut de LSP. Déclarer ces callbacks active le transformer de tokens (`data-char` sur chaque span), dont le coût reste à mesurer sur une grosse review.
- Mesures du 25 octobre sur ce dépôt, du lancement du serveur au premier hover :

  | Serveur | Premier hover | Remarque |
  |---|---|---|
  | gopls 0.23.0 | 330 à 520 ms | racine du dépôt, sans `go.mod` à la racine |
  | `tsc --lsp --stdio`, TypeScript 7.0.2 | 100 à 130 ms | le serveur livré avec TypeScript 7 |
  | `tsrs --lsp -stdio`, tsrs 0.18.0 (TS 7.1-dev) | 60 ms | port Rust de TypeScript 7 par oxc |
  | typescript-language-server 5.3.0 | — | hover vide : il lui faut le `tsserver.js` que TS 7 ne livre plus |

  Hover, définition et références donnent les mêmes réponses avec gopls, tsc et tsrs ; les trois annoncent UTF-16. tsrs parle le protocole de TypeScript 7 et vise une version stable alignée sur TypeScript 7.1, en bêta aujourd'hui.
- Lancée depuis le Finder, l'app hérite du PATH de launchd, sans gopls ni `go`. Un `zsh -l -i -c` lancé dans le dépôt les trouve tous, installés par mise, en 0,5 s.
- Leçons de la branche `feat/lsp-navigation` (3 septembre, serveur Node) :
  - un serveur lit le disque : seul le côté droit d'une review du working tree porte les numéros de ligne des fichiers ;
  - la racine et les documents doivent s'écrire pareil (`/private/var` et `/var` sur macOS), sinon gopls ne répond rien, sans erreur ;
  - un démarrage raté doit se mémoriser, au lieu d'être relancé à chaque survol ;
  - `scrollTo` sur une ligne hors des hunks affichés ne fait rien, sans erreur.
- Les serveurs exécutent du code du dépôt : gopls lance `go list`, qui peut télécharger la toolchain demandée par un `go.mod` ; rust-analyzer lance les build scripts et les proc macros ; `node_modules/.bin/tsc` est un binaire du checkout.

## Décisions

### Seulement le côté droit d'une review du working tree

ghl répond quand `comparison.after` est nul, c'est-à-dire quand le côté droit est le disque : sur les lignes ajoutées et sur le contexte. Côté gauche, sur une révision cible, un commit choisi ou avec le working tree exclu, rien n'est souligné et la barre d'état l'indique. Si un fichier a changé depuis le chargement du diff, Go compare le token envoyé à celui du disque et répond 409 ; la carte propose alors `r`.

### ⌘ pour tout

Sans ⌘, aucune requête ne part. ⌘ tenu, l'identifiant sous le pointeur se souligne et la carte s'ouvre après 150 ms. ⌘-clic mène à la définition. La carte reste ouverte tant que le pointeur est dessus, même ⌘ relâché, et Esc la ferme. La carte affiche la signature, la documentation, l'emplacement de la définition (`not in this diff` le cas échéant) et les actions Go to definition et References.

### Aller à la définition

- Dans le diff, sur un hunk affiché : le diff défile jusqu'à la ligne, qui clignote ; ⌘[ ramène au point de départ.
- Ailleurs dans le dépôt : la carte s'agrandit avec une dizaine de lignes lues sur le disque.
- Hors du dépôt (bibliothèque standard, `node_modules`) : seulement le chemin.

### Onglet Symbol

Le panneau de droite gagne deux onglets, Comments et Symbol. Symbol montre la signature, l'emplacement, puis les références groupées par fichier dans l'ordre de l'arbre, avec un badge `in diff` et un filtre « In this diff only ». Une référence située dans un hunk affiché s'ouvre dans le diff ; les autres montrent leur ligne, sans lien, comme « Outside the current diff » pour les commentaires.

Le réglage Symbol panel, actif par défaut, retire l'onglet et le bouton References quand il est éteint : le panneau redevient celui d'aujourd'hui.

### Go parle aux serveurs

Le client LSP vit dans `go/internal/app`, avec la seule bibliothèque standard. Le serveur de review connaît déjà la racine canonique du dépôt et lit le disque, et il tourne aussi pour ghl-dev et les tests. Le front n'appelle que ces routes :

| Route | Rôle |
|---|---|
| `PUT /api/lsp` | configuration globale, venue des réglages : `{enabled, servers: {go, typescript, rust}}`. Éteindre arrête les serveurs. Sans ce `PUT`, aucun serveur ne démarre. |
| `GET /r/<id>/api/lsp` | état par langage pour ce dépôt : serveur trouvé (chemin, checkout ou PATH), `missing` avec la commande d'installation, `starting`, `indexing` avec son avancement, `ready`, `failed` avec la fin de stderr |
| `GET /r/<id>/api/lsp/symbol?path&line&character&token` | hover et définitions : chemin, ligne, et extrait si la définition est dans le dépôt |
| `GET /r/<id>/api/lsp/references?path&line&character&token` | références, avec le texte de leur ligne |

Les lectures passent en `GET` : la règle de #188 vise les écritures, et le `PUT` porte du JSON.

### Un serveur par dépôt et par langage

- Il démarre au premier survol, dans la racine du dépôt passée par `realpath`. Son environnement vient d'un shell de login interactif lancé dans le dépôt (mise, Homebrew, `~/go/bin`), avec repli sur le PATH du processus. `processId` dans `initialize` et un groupe de processus garantissent qu'un ghl tué ne laisse rien derrière lui.
- Il s'arrête après 10 minutes sans requête, à la fermeture du runtime, ou quand un réglage l'exclut.
- Un échec se mémorise 30 secondes ; Settings montre la fin de stderr.
- Le document est envoyé (`didOpen`) avec son contenu sur le disque, et renvoyé si sa taille ou sa date changent. Quand le diff est servi à nouveau, `didChangeWatchedFiles` signale ses fichiers aux serveurs déjà démarrés. Une requête HTTP annulée envoie `$/cancelRequest`.

### Serveurs connus

| Langage | Extensions | Auto | Choix |
|---|---|---|---|
| Go | `.go` | gopls | Auto, Off |
| TypeScript et JavaScript | `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` | `tsrs` du checkout puis du PATH, puis le `tsc` du checkout si TypeScript ≥ 7, puis `typescript-language-server` | Auto, TypeScript 7 (tsc), tsrs, typescript-language-server, Off |
| Python | `.py` `.pyi` | dans le checkout, `.venv/bin/basedpyright-langserver`, puis `pyright-langserver` ; sur le PATH, ces deux, puis `ty server` | Auto, basedpyright, pyright, ty, Off |
| Terraform | `.tf` `.tfvars` | terraform-ls | Auto, Off |
| Helm | `.yaml` `.yml` `.tpl` `.txt` du dossier `templates` d'un chart | helm_ls | Auto, Off |
| Rust | `.rs` | rust-analyzer | Auto, Off |

Le serveur du checkout passe en premier : c'est la version que le projet a choisie. Exception : tsrs passe avant le `tsc` du checkout, parce qu'il répond plus vite et avec moins de mémoire (79 contre 115 ms au premier survol, 99 contre 159 Mo sur ce dépôt). Python, Terraform et Helm sont venus en cours de route (`code-intel/06-languages`). Helm ne se reconnaît pas à l'extension : ghl liste les `Chart.yaml` suivis par Git, et le statut donne leurs dossiers `templates` à la fenêtre.

### Le nom sous le pointeur

Shiki fusionne souvent les tokens : ` helper(name)` en Python, `.Values.replicaCount` dans un template Helm. La fenêtre mesure les caractères du token pour trouver le nom sous le pointeur, l'envoie avec sa colonne, et dessine le soulignement par-dessus le diff, à la taille du nom.

### Opt-in global

Le réglage est global et éteint par défaut ; Settings précise que les serveurs tournent sur le code relu. La bêta ne gère pas de confiance par dépôt.

### Réglages

Settings › Code intelligence (Beta) contient Use language servers, Symbol panel, puis une ligne par langage avec le chemin du serveur, son état et son choix. Nouveaux champs du `DesktopSettings` version 1 : `codeIntelligence` (`false`), `symbolPanel` (`true`) et `languageServers` (`{go: 'auto', typescript: 'auto', rust: 'auto'}`). La fenêtre envoie `PUT /api/lsp` au chargement des réglages et à chaque changement.

### Barre d'état

Elle montre les langages du diff et l'état de leur serveur : `● gopls`, `gopls indexing 42 %`, `gopls failed`, avec le badge Beta. Hors working tree, elle affiche « Code intelligence: working tree only ».

## Découpage en PRs

Préfixe `code-intel/` (la branche `lsp` occupait le nom), en pile `gh stack` dans l'ordre ci-dessous : chaque PR a pour base la précédente, et ce plan, `docs/code-intel-plan`, ouvre la pile.

### 01 · `code-intel/01-servers` — Client et cycle de vie

- Framing JSON-RPC, client multiplexé, réponses aux requêtes du serveur (`workspace/configuration`, `window/workDoneProgress/create`, `client/registerCapability`).
- Registre, détection (checkout, PATH du shell de login), démarrage paresseux, arrêts, mémoire d'échec, avancement.
- `PUT /api/lsp` et `GET /r/<id>/api/lsp`.
- Tests : un faux serveur, le binaire de test relancé ; gopls et tsc réels quand ils sont installés.

### 02 · `code-intel/02-queries` — Hover, définitions, références

- Synchronisation des documents, conversion UTF-16 vers octets, vérification du token (409), `realpath` pour savoir si une cible est dans le dépôt, extraits bornés.
- Routes `symbol` et `references`, annulation, `didChangeWatchedFiles` quand le diff est servi.

### 03 · `code-intel/03-settings` — Réglages et état

- Champs de réglages, section Code intelligence (Beta), liste des serveurs depuis l'état, `PUT /api/lsp`.
- Barre d'état.
- Suite UI avec le faux serveur.

### 04 · `code-intel/04-hover` — Carte et ⌘-clic

- Callbacks de tokens, soulignement sous ⌘, carte, définition (saut, ⌘[, extrait dans la carte).
- Coût du transformer de tokens, mesuré sur une grosse review.
- Suite UI ; `docs/reviewing.md`, raccourcis du README, CHANGELOG.

### 05 · `code-intel/05-symbol-panel` — Onglet Symbol

- Onglets Comments et Symbol, références groupées, filtre, ouverture dans le diff, bouton References de la carte.
- Réglage Symbol panel.
- Suite UI ; doc et CHANGELOG.

### 06 · `code-intel/06-languages` — Python, Terraform et Helm

- Registre : Python (basedpyright, pyright, ty), Terraform (terraform-ls), Helm (helm_ls, par dossier de chart).
- Le nom sous le pointeur dans un token fusionné, et son soulignement.

Le panneau de commentaires change aussi dans `agent-comments/02-window` (#215) : 05 se rebasera sur celle des deux qui sera fusionnée en premier.

## Reporté

- Côté gauche et reviews de révision, avec un worktree détaché par révision.
- Problèmes introduits par le changement (D), symboles modifiés et leur impact (E), aperçu en ligne (B).
- Serveurs libres (une commande LSP sur stdio).
- Accès clavier aux symboles.
- Confiance par dépôt.
- `node_modules` le plus proche du fichier dans un monorepo.
