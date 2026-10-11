# Go + React : PoC de review local

Le PoC fournit un exécutable séparé, `ghl-go-poc`, avec l'interface React
embarquée. Il sert à évaluer le coût d'un backend complet sur le périmètre de
review retenu. Il ne remplace pas `ghl` et ne publie aucun paquet.

## Construire et lancer

Depuis le checkout, avec les dépendances pnpm installées, Go ≥ 1.24 et
[Task v3](https://taskfile.dev/installation/) :

```bash
task poc:build
./poc/go/dist/ghl-go-poc --repo /chemin/du/depot --base main
```

Le build Vite `go-poc` écrit dans `go/cmd/ghl-go-poc/assets/`, puis Go embarque tout ce
répertoire. Le binaire est construit avec `CGO_ENABLED=0`, `-trimpath` et
`-ldflags='-s -w'`. Les assets et le binaire générés sont ignorés par Git.
`pnpm build` continue à produire le build Node habituel dans `web-dist/`.

Le dépôt par défaut est le répertoire courant, la base `HEAD`, et le port est
éphémère. Le serveur écoute exclusivement sur `127.0.0.1`, reste au premier
plan et s'arrête avec Ctrl-C. Sur macOS, il ouvre le navigateur ; `--no-open`
évite ce lancement. `--port 7778` impose un port sans fallback.

```bash
./poc/go/dist/ghl-go-poc --repo /chemin/du/depot --base main --no-open --json
```

Cette commande annonce une ligne JSON `{port, repoId, url}` sur stdout. Les
erreurs vont sur stderr. L'URL inclut la base configurée. Git et un navigateur
sont les seuls prérequis utilisateur ; Node, pnpm, Go et Task servent au build.
La validation de cette livraison cible macOS ARM64, sans promesse de support
Windows : la lecture des fichiers utilise les options Unix de non-suivi des
symlinks et de lecture non bloquante.

## Périmètre et état

La comparaison part du merge-base entre la base explicite et HEAD. Elle couvre
les changements commités, staged et unstaged. **Working tree** permet de
s'arrêter à HEAD. Les fichiers texte ajoutés, modifiés, supprimés et renommés
gardent leurs statistiques, l'arborescence, les vues unified/split, la recherche
et l'expansion du contexte. Les binaires restent signalés sans preview.

Les commentaires conservent le texte de leurs ancres sur le côté choisi,
signalent les lignes changées et restent dans le panneau quand leur fichier
sort du diff. PATCH change uniquement leur prose ; un nouvel envoi du même ID
ne duplique pas l'entrée et conserve son timestamp. Viewed est associé au hash
de la section du patch et devient invisible quand ce hash change. Thèmes,
copie Markdown et raccourcis de navigation/commentaire restent côté React.

Les fichiers untracked, les previews d'images, les stacks, les sélecteurs de
base/cible/commit et le daemon partagé sont exclus. Le build PoC retire leurs
contrôles et les raccourcis `b`, `t`, `l`. Les API refusent explicitement les
paramètres `target`, `commit`, `untracked` et `includeUntracked`, même vides.
`base` et la présence de `committed` restent acceptés.

L'état version 1 est dans `.git/ghl-go-poc/state.json` ; pour un worktree lié,
il est dans son git-dir propre. Aucun état de `.git/ghl/state.json` n'est
importé. Chaque lecture et mutation prend le mutex du store. Une écriture
passe par un fichier temporaire voisin, flushé puis renommé. Un état illisible
ou invalide est préservé dans un fichier horodaté `.corrupt`, avec une notice
dans le payload de diff. Cette notice reste disponible pendant le processus.
Le mutex protège un processus : lancer deux instances sur le même dépôt
n'apporte pas de verrouillage inter-processus.

## Modules et difficultés

Un seul module Go, sans dépendance externe, contient trois modules logiques
et leurs contrats JSON. Aucun framework HTTP, moteur Git ou couche ORM.

| Fichier | Responsabilité et interface |
| --- | --- |
| `go/internal/app/review.go` | `Repository.Compare`, puis `Review.Context`, `Lines`, `Comments` ; capture des révisions, Git, patch, comptes, hashes et versions de fichiers |
| `go/internal/app/state.go` | `Store.Snapshot` et `Mutate` ; mutex, validation du schéma, récupération et écriture atomique |
| `go/internal/app/server.go` | Routes HTTP, validation des entrées, contrôles Host/Origin et fichiers embarqués |
| `go/internal/app/types.go` | Formes JSON du périmètre conservé, alignées sur `src/types.ts` |
| `go/internal/app/command.go` | Flags, validation initiale, loopback, annonce, ouverture macOS et arrêt |
| `go/cmd/ghl-go-poc/main.go` | Entrée du PoC et assets embarqués ; le runtime `go/cmd/ghl` partage le backend |

Le backend initial mesuré représentait 1 131 lignes Go et ses tests 597 lignes, blancs et
commentaires inclus. Ce relevé décrit uniquement le volume de sources ; le
harness TypeScript et les adaptations React sont comptés séparément.

Chaque requête possède sa comparaison et son cache de sources. Patch,
numstat et name-status sont lus en parallèle avec les mêmes révisions ; les
processus Git sont liés au contexte annulable de la requête. Le PoC force la
détection des renommages et désactive les diff externes. Un dépôt sans commit,
une base invalide ou sans merge-base et une opération merge/rebase/cherry-pick
en cours produisent une erreur explicite.

La difficulté principale est le protocole Git : les comptes et statuts
utilisent des records NUL, alors que le patch peut citer ses chemins avec des
échappements octaux. Les noms avec espaces, Unicode, tabulations et retours à
la ligne sont testés. Le parseur associe les headers aux paires de chemins
connues, plutôt que de couper un nom sur ses espaces.

L'expansion est le deuxième point délicat : elle doit lire les anciennes
versions des renommages, traiter les côtés absents et détecter un checkout
modifié après capture. Elle compare les identifiants de blobs SHA-1/SHA-256
et les lignes des hunks, en plus du fingerprint demandé par React. Elle
refuse les symlinks, fichiers spéciaux, binaires, texte non UTF-8 et fichiers
de plus de 20 Mio. `os.Root` borne les lectures au dépôt, même si un chemin
est remplacé pendant la lecture. HTTP 409 demande un refresh pour une
comparaison obsolète ; HTTP 422 signale une source non extensible.

Le troisième point est la persistance : une lecture-modification-écriture
doit être sérialisée, y compris les lectures qui récupèrent un état corrompu.
Les timestamps et ancres appartiennent à l'entrée persistée ; la réponse
optimiste React reçoit ensuite la version enregistrée et son code courant.

## Vérification

```bash
task poc:test
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
task vet
```

Validation de la livraison initiale : 12 tests Go avec `-race`, harness PoC et 597
vérifications de la suite Node habituelle passent. TypeScript, lint, formatage
et `go vet` passent également.

`task poc:test` (également accessible via `pnpm poc:go:test`) construit les
assets et le binaire, lance les tests Go avec `-race`, puis le harness de parité
et de navigateur. Les tests Go utilisent
des dépôts temporaires et des handlers HTTP sans socket. Ils couvrent les
statistiques, merge-base, noms quotés, renommages purs et édités, les deux
côtés des ancres, le contexte caché, les hashes obsolètes, les commentaires
stale/hors diff, Viewed, la corruption et les écritures concurrentes. Ils
vérifient aussi l'annulation d'un processus Git déjà lancé, les opérations
hors périmètre, les limites de lecture et les contrôles Host/Origin.

`test/goPoc.ts` compare Node et Go sur le même checkout : patch, comptes,
hashes, clés de cache, versions, ancres et résultats des mutations. Il compare
les champs de `DiffFiles` déclarés par le contrat ; Node expose aussi un
champ interne `sha1`. La fixture commune désactive le quoting Unicode de Git,
que le parseur Node actuel ne sait pas associer aux hashes. Les cas quotés
sont testés séparément en Go et dans le navigateur du PoC.

Le harness copie le binaire hors du checkout et le lance avec un PATH
contenant seulement Git, sans Node, pnpm ni Go. Il vérifie HTML/JS/CSS
embarqués, puis utilise Chrome pour vérifier les contrôles exclus, Working
tree, les thèmes, l'expansion, commentaire/édition/suppression, copie,
Viewed, recherche, split, refresh et redémarrage. Un commentaire dont le
fichier quitte le diff reste accessible dans le panneau. Le transport clipboard est simulé pour vérifier le Markdown et le retour UI.
Chrome et le toolchain C requis par `-race` sont des prérequis de test supplémentaires.

## Mesures

```bash
pnpm poc:go:bench
```

Le benchmark complet écrit [go-poc-benchmark.json](./go-poc-benchmark.json).
Les [mesures minimales précédentes](./runtime-benchmark.md) et leur JSON
restent séparés. Le mode `--go-poc` du runner compare uniquement le serveur
Node actuel et le PoC complet, sans dépendance Rust.

Trois passages avec ordre alterné utilisent 100 fichiers de 200 lignes, tous
modifiés, soit un patch de 1 208 500 octets. Les deux serveurs reçoivent les
mêmes routes de healthcheck, diff et contexte. Ils servent aussi le même JS
de 790 000 octets, choisi parmi les chunks identiques des deux builds ; leurs
entry bundles diffèrent à cause des contrôles exclus. Chaque réponse est
vérifiée par son hash et sa taille ; le patch est comparé au diff Git pendant
l'échauffement. Les réponses JSON propres à chaque serveur sont vérifiées
contre leur référence, sans imposer l'ordre des propriétés entre langages.

Après dix healthchecks, trois assets, trois diffs et trois contextes, le
runner observe trois secondes de repos, puis 100 healthchecks, 20 assets,
20 diffs et 10 contextes, en série puis avec quatre clients simultanés.
Le RSS est relevé après échauffement et après toute la charge, pas au pic.
Le CPU serveur mesuré par `ps` exclut les sous-processus Git et le navigateur.
Le benchmark est relancé après la fin des tests navigateur.

Mesuré le 30 septembre 2026 sur macOS 26.6.2 / ARM64, Node 24.21.0 et
Go 1.27.1. Médianes des trois passages :

| Serveur | RSS après échauffement | RSS après charge | CPU serveur pendant la charge | Démarrage prêt au healthcheck |
| --- | ---: | ---: | ---: | ---: |
| Node actuel | 189,0 Mio | 257,9 Mio | 1,82 s | 59,6 ms |
| Go PoC | 28,2 Mio | 53,4 Mio | 1,31 s | 59,0 ms |

Latences en série, en millisecondes ; médianes des p50 et p95 de chaque passage :

| Route | Node p50 | Node p95 | Go p50 | Go p95 |
| --- | ---: | ---: | ---: | ---: |
| Healthcheck | 0,272 | 0,459 | 0,257 | 0,391 |
| Asset JS commun | 0,761 | 2,057 | 0,296 | 0,349 |
| API diff | 59,20 | 67,23 | 44,47 | 48,94 |
| API contexte | 66,37 | 67,42 | 51,26 | 54,40 |

Avec quatre clients, le diff p50 médian est de 129,16 ms pour Node et
73,49 ms pour Go ; le contexte de 123,28 et 84,49 ms. Le JSON contient les
relevés par passage, leurs p95 et débits.

Aucune progression du CPU au repos n'est détectée pendant les trois secondes.
La résolution au centième de seconde de `ps` ne prouve pas un CPU exactement
nul. Le démarrage Go valide déjà une comparaison complète ; le harness Node
annonce le port avant cette lecture. Les chemins d'initialisation diffèrent.

Le binaire optimisé mesure **17,32 Mio, assets inclus** (18 158 786 octets).
Le frontend PoC représente 10,76 Mio de contenu ; il est embarqué dans cette
taille, sans fichier annexe à distribuer. Pour Node, les sources serveur et
le runtime s'ajoutent au frontend de 10,77 Mio. La taille d'un paquet Node
complet n'est pas mesurée ici.

Sur cette fixture, le RSS après charge de Go est environ 4,8 fois plus faible
et le diff p50 environ 25 % plus court. Le serveur Node exécute aussi la
résolution du trunk/stack et les contrôles d'images/untracked absents du PoC :
ces écarts décrivent les deux implémentations livrées, et ne permettent pas
d'isoler le coût du langage.

## Décision à prendre

Pour les priorités RAM et distribution, ce résultat justifie d'engager un
port progressif du backend Go. Le remplacement complet dépend de la parité
des fonctions restantes et de mesures sur des dépôts représentatifs.

Le PoC permet d'évaluer une migration en gardant React et Git système, avec
un fichier distribué et aucune dépendance Go externe. Les principaux coûts
de code sont la lecture fiable des comparaisons et la persistance, déjà
implémentées et testées ici. Les assets de coloration syntaxique restent une
part significative de la distribution ; changer le backend ne réduit pas le
coût du navigateur.

Une migration complète doit encore porter et vérifier la résolution
automatique des bases, les stacks, les cibles et commits arbitraires, les
images, les untracked, le daemon partagé et le CLI d'export/installation.
La consommation mesurée de ce périmètre ne prédit pas celle de ces fonctions.
Une seule machine, des caches chauds et une courte charge limitent la portée
des chiffres. Aucun seuil RAM ni gain garanti n'est fixé. Les résultats
doivent servir à décider si le coût du port restant est justifié, avant toute
publication mise ou Homebrew.
