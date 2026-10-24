# Durcissement après la review

Statut : plan proposé le 24 octobre 2026, issu de la review complète de la codebase faite le même jour.

## Objectif

Corriger les défauts relevés par la review, en commençant par ceux que les utilisateurs rencontrent, puis alléger le code laissé par la version navigateur. Le schéma de `.git/ghl/state.json` ne change pas.

## Constat

La base est saine : refs et chemins validés (`--end-of-options`, `--literal-pathspecs`, `os.Root`, `O_NOFOLLOW`), contrôle du `Host` contre le DNS rebinding, écritures atomiques, instance unique robuste, release vérifiée de bout en bout. tsc, oxlint, oxfmt, `go vet` et `pnpm audit` passent.

Les défauts sont aux bords : la config git de l'utilisateur, les dépôts dans un état inhabituel, le lancement par LaunchServices, et l'état de vue de l'UI quand la comparaison change. Environ 1 000 lignes datent de la version navigateur ou de l'ère Node.

## Découpage en PRs

Préfixe `hardening/`. Les PRs sont indépendantes : chacune part de `main`, sans pile. Seule la 11 vient en dernier, parce qu'elle touche les mêmes fichiers que la 04 et la 06.

### 01 · `hardening/01-git-format` — Sortie git indépendante de la config utilisateur — [#184](https://github.com/vmaerten/ghl/pull/184)

- Le parseur de patch (`headerMatches`, `parseSections`) suppose les préfixes `a/` et `b/`, et une ligne de contexte vide précédée d'un espace.
- Avec `diff.mnemonicPrefix`, `diff.noprefix`, `diff.srcPrefix` ou `diff.dstPrefix`, aucun fichier n'est reconnu dans le patch. Les fichiers n'ont plus d'empreinte : Viewed ne tient pas, les commentaires renvoient 400 et le contexte ne s'ouvre pas.
- Avec `diff.suppressBlankEmpty`, les numéros de ligne se décalent après une ligne vide, et un commentaire s'ancre sur la mauvaise ligne.
- Correctif : `--src-prefix=a/ --dst-prefix=b/` sur les deux `git diff` (review et non suivis), et `diff.suppressBlankEmpty=false` imposé aux commandes git du serveur.
- Les autres réglages essayés (`color.diff=always`, `diff.renames=copies`, `core.quotePath=false`, `log.showSignature`) ne changent pas ce que lisent les parseurs.

### 02 · `hardening/02-app-lifecycle` — Lancement depuis le Finder et arrêt — [#185](https://github.com/vmaerten/ghl/pull/185)

- Un lancement depuis le Finder, Spotlight ou le Dock passe par le lanceur, sans argument et avec `/` comme dossier courant. L'app essaie d'ouvrir `/` et affiche « not a git repository ». Sans argument et depuis `/`, le binaire doit ouvrir la fenêtre sans requête. À confirmer d'abord à la main : quitter ghl, le relancer depuis Spotlight.
- Un `ghl` lancé pendant un Cmd+Q reçoit un accusé de réception, puis sa requête est perdue : le socket répond jusqu'au dernier `defer`. Fermer l'instance en premier dans `OnShutdown`.
- Retirer les branches `ctx.Done()` mortes : Wails v2 n'annule jamais son contexte.

### 03 · `hardening/03-state-lock` — Verrou et lecture de l'état — [#186](https://github.com/vmaerten/ghl/pull/186)

- Chaque lecture prend le verrou. Un `refs/worktree/ghl-state-lock.lock` laissé par un crash fait échouer tout `/diff` (500 après 10 s), indéfiniment.
- Sur un dépôt reftable, la contention n'est pas reconnue comme telle, et la transaction verrouille toute la pile de refs.
- Une simple lecture, par exemple `ghl comments`, renomme `state.json` en `.corrupt` dès qu'un commentaire est invalide.
- Correctif :
  - lire sans verrou, puisque les écritures sont des renommages atomiques ;
  - ne mettre en quarantaine que dans `Mutate` ;
  - remplacer le verrou de ref par un `flock` sur un fichier de `.git/ghl/`, que le noyau libère si le processus meurt.

### 04 · `hardening/04-view-state` — État de vue de l'UI — [#187](https://github.com/vmaerten/ghl/pull/187)

- Quand la comparaison change, le composer n'a plus de place où s'afficher mais reste ouvert, et tous les raccourcis à une lettre sont bloqués. Le fermer quand sa ligne quitte les hunks.
- Le fichier actif est un index, jamais recalculé. Après un changement de commit, `j` et `k` sautent au dernier fichier ; après un scroll au trackpad, `v` marque le mauvais fichier. Le garder par chemin et le suivre au scroll.
- Recherche ouverte : la vue re-scrolle et resélectionne à chaque Viewed ou commentaire publié.
- Un refresh qui échoue laisse l'expansion de contexte bloquée, sans erreur.
- Un tick Viewed encore en cours d'envoi est perdu au changement d'onglet. Il faut un store Viewed par onglet, comme pour les commentaires.
- Le sélecteur de cible est libellé « base », et le panneau des commentaires ne trie pas les fichiers comme l'arbre.

### 05 · `hardening/05-local-api` — API locale — [#188](https://github.com/vmaerten/ghl/pull/188)

- Le contrôle d'`Origin` accepte tous les ports de `localhost`, et un POST `text/plain` passe sans preflight.
- Une page servie sur `localhost:3000` peut donc créer ou supprimer des commentaires, changer Viewed ou réécrire `branch.*.ghlBase`.
- Correctif : exiger `Content-Type: application/json` sur les requêtes qui écrivent ; l'UI et `backend.go` l'envoient déjà.

### 06 · `hardening/06-repository-edge-cases` — Dépôts dans un état inhabituel — [#189](https://github.com/vmaerten/ghl/pull/189)

- **Opération en cours.** Pendant un merge, un rebase ou un cherry-pick, toute la review et `ghl comments` renvoient 422. Calculer le diff quand même et remplir `state.operation`, que le bandeau de l'UI attend déjà.
- **Fichiers non suivis problématiques.** Un lien symbolique, un FIFO ou un fichier de plus de 20 Mo fait échouer `ghl comments` et la review avec non suivis. Les lister comme indisponibles, comme les images.
- **Lignes non UTF-8.** Le commentaire passe stale aussitôt, car l'ancre et le code ne sont pas normalisés de la même façon.
- **Noms de fichiers.** `validPath` refuse `\`, pourtant valide dans un nom de fichier.
- **Dossier du dépôt.** `#`, `?` ou `%` dans son nom cassent l'URL des aperçus d'images.
- **Erreurs git.** `optionalText` traite l'erreur fatale 128 comme une valeur absente.

### 07 · `hardening/07-git-filters` — Filtres et textconv — [#190](https://github.com/vmaerten/ghl/pull/190)

- Avec `eol=crlf`, un filtre clean ou un `textconv`, ouvrir du contexte renvoie 409 et les commentaires hors hunk passent stale. Le serveur compare les octets bruts du fichier au blob nettoyé ou au texte converti.
- Correctif : `--no-textconv`, et vérifier les lectures du worktree avec `git hash-object --path`.
- Décision prise le 24 octobre : `--no-textconv`, un fichier que l'utilisateur fait lire par textconv s'affiche comme Git le stocke, binaire le cas échéant, comme sur GitHub.
- À vérifier ici : un aperçu d'image Git LFS montre probablement le pointeur.

### 08 · `hardening/08-release` — Release — [#191](https://github.com/vmaerten/ghl/pull/191)

- **Token du tap.** `release:tap:access` ne détecte pas un token absent : le tap est public, la lecture passe sans token, et l'échec n'arrive qu'après publication. Exiger `HOMEBREW_TAP_TOKEN` pour un tag stable.
- **Version de Go.** Avec Go 1.27.1, govulncheck trouve 12 failles de la bibliothèque standard atteignables, corrigées en 1.27.2 et 1.27.3. Passer `.mise.toml` à 1.27.3.
- **Concurrence.** Elle est réglée par ref : deux tags poussés ensemble peuvent faire reculer le cask. Passer à un groupe unique `release`, et faire refuser à `release:tap` d'écrire une version plus ancienne que celle du tap.
- **`zap` du cask.** Il oublie `~/Library/WebKit/dev.ghl.desktop`, `~/Library/Caches/dev.ghl.desktop` et `~/Library/Preferences/dev.ghl.desktop.plist`.
- **Gatekeeper.** Ajouter une ligne pour qui télécharge le zip à la main (signature ad hoc, pas de notarisation).
- **Option.** Séparer le build, sans secret et en `contents: read`, de la publication, pour qu'une dépendance de build compromise ne voie pas les tokens.

### 09 · `hardening/09-performance` — Performance — [#192](https://github.com/vmaerten/ghl/pull/192)

Mesurer avant et après sur un gros diff, sinon rien ne justifie la PR.

- Aucun `WorkerPoolContextProvider` n'est monté : Shiki colore sur le thread principal. Monter le pool après avoir vérifié que WKWebView charge le worker.
- `structuredClone(allItems)` tourne à chaque chargement, même sans recherche.
- L'appariement des en-têtes de patch avec les fichiers est quadratique : 1,76 s sur 8 000 fichiers.
- Sans base dans l'URL, chaque requête lance deux processus git par branche locale. Un PATCH de commentaire refait un `Resolve` complet.
- Ouvrir une review calcule le diff deux fois, à cause de la vérification préalable de `backend.open`.

### 10 · `hardening/10-tests` — Tests — [#193](https://github.com/vmaerten/ghl/pull/193)

- Aucun garde rapide pour la régression TMPDIR de 0.3.0 : tester `userTempDir`.
- Les suites UI contiennent environ 45 `sleep` fixes avant des assertions. Attendre plutôt la condition, avec les helpers existants.
- Le démarrage de `ghl-dev` existe en trois copies, dans `goImages.ts`, `goState.ts` et `goRevisions.ts`. Celle de `goState.ts` n'a pas de repli SIGKILL.
- Les helpers git de `test/fixture.ts`, `goState.ts` et `images.ts` lisent la config globale.
- Deux tests de `releaseTask.py` ne vérifient que le code de sortie.
- `test/images.ts` écrit une capture de debug dans `/tmp`.
- `test/goMise.ts` laisse tourner l'app précédente quand il échoue.

### 11 · `hardening/11-cleanup` — Nettoyage — [#194](https://github.com/vmaerten/ghl/pull/194)

- **Benchmark mémoire.** Il est cassé : `.repo-name` n'existe plus. Supprimer `memory.py`, `metrics.py`, `memory-probe.js`, `tab-memory.json`, `task desktop:memory` et la section correspondante du README.
- **`PLAN.md`.** Reporter la note de la décision 7 dans `useReviewDiff.tsx`, puis supprimer le fichier.
- **CSS.** Les palettes de `themes.css` sont toutes surchargées par `desktop.css` (environ 195 lignes), et `styles.css` contient des règles mortes ou surchargées (environ 115 lignes). Charger `desktop.css` comme une feuille normale.
- **Restes Node et navigateur.**
  - Types et exports : `StateRead`, `PatchResult`, `asExport`, `CommentExport`.
  - Côté UI : les props optionnelles d'`App`.
  - Côté serveur : `/api/repos` et le rejet de `includeUntracked`.
  - Outillage : `web-dist`, les scripts `go:*`, `loopbackURL`, `smoke.py --bundle` et `test:desktop-tabs`.
  - Commentaires : les mentions de « Node » et de « Go PoC ».
- **Doc.** Dans `desktop/README.md`, deux points sont faux : le refus de la CLI 0.2 par `task install`, et les renvois au benchmark absent de `main`. Indiquer aussi que les plans `desktop-release` et `desktop-redesign` sont livrés.

## Risques

- **Verrou (03).** Pendant une mise à jour, l'ancienne app peut encore tourner avec le verrou de ref pendant que la nouvelle commande utilise `flock`. Ce n'est pas un problème : avec 03, `ghl comments` ne fait que lire, sans verrou, et une seule app écrit.
- **PATH au lancement depuis le Finder.** L'app reçoit alors le PATH de launchd, sans `/opt/homebrew/bin`. Un filtre git-lfs installé par Homebrew échoue quand on ouvre un dépôt avec Cmd+O. Lancée par `ghl` depuis un terminal, l'app reçoit l'environnement de l'appelant, sauf `TMPDIR`. Hors périmètre de 02, à traiter si quelqu'un le rencontre.

## Hors périmètre

- La notarisation, et les tests sur le runner de release (décisions de la release 0.3.0).
- `log.showSignature`, qui ralentit la liste des commits (une vérification par commit) sans casser le parseur.
- La croissance de `state.json` : les Viewed sont enregistrés par plage et jamais purgés.

## Journal des écarts

| PR | Constat | Ce qu'on a fait |
| --- | --- | --- |
| 01 | Le cas `diff.suppressBlankEmpty` ne se voit que sur une ligne de contexte qui suit une ligne vide : ailleurs, `Lines` retombe sur le fichier et masque le décalage. | Le test vise la ligne 3 de `one / (vide) / three / FOUR`. |
| 02 | Le lancement depuis Spotlight, confirmé par une capture, affichait aussi la réponse JSON du runtime (`{"error":…}`) au lieu de son message. | Corrigé dans 02, avec un test sur `backend.open`. |
| 02 | Wails v2 quitte déjà sur SIGINT et SIGTERM (`signal.Start` dans `wails.Run`) : le contexte de signal de l'app faisait doublon, en plus des branches `Done()` mortes. | Gestion des signaux laissée à Wails ; `desktop:smoke`, qui quitte l'app par SIGTERM, passe. |
| 02 | Fermer l'instance dans `OnShutdown` et dans le `defer` l'appelle deux fois ; le second appel pouvait supprimer le socket de l'app suivante. | `close` passe par un `sync.Once`, gardé par `instance_test.go`. |
| 01, 02 | Chaque PR ajoute une section `### 🐛 Fixes` à Unreleased : la seconde mergée entre en conflit sur le CHANGELOG. | Rebaser la seconde après le merge de la première. |
| 03 | Sans verrou, `Snapshot` n'a plus besoin de contexte. | Signature réduite à `Snapshot()` ; les appelants et les tests suivent. |
| 03 | Un commentaire invalide rend encore tout le fichier illisible : le récupérer entrée par entrée suppose de deviner un schéma futur. | Gardé tel quel ; un schéma futur doit changer `version`, refusé sans quarantaine. Seule la lecture ne déplace plus rien. |
| 03 | Le `refs/worktree/ghl-state-lock.lock` laissé par une version antérieure reste sur disque. | Ignoré : plus rien ne lit ni ne verrouille cette ref. |
| 04 | Fermer le composer quand sa ligne quitte les hunks aurait aussi fermé un composer restauré sur du contexte déplié, avant que l'expansion soit rejouée. | Seul un composer affiché bloque les raccourcis ; il reste ouvert et revient avec sa comparaison. |
| 04 | Suivre le scroll sans garde fait boucler `j` sur un dernier fichier trop court pour monter en haut du panneau. | Le fichier actif reste tant qu'une partie est visible, puis passe à celui sous le bord haut. |
| 04 | `desktopTabs.ts` n'avait qu'un seul écouteur d'interception, propre au test des commentaires. | Écouteur commun, avec un drapeau par type de requête retenue ou en échec. |
| 04 | Libellé du sélecteur de cible et ordre du panneau de commentaires : correctifs d'une ligne. | Sans test dédié. |
| 05 | `DELETE` n'a pas de corps, mais c'est une méthode qui impose un preflight. | L'exigence porte sur `POST`, `PATCH` et `PUT` ; le contrôle d'`Origin` existant reste en place. |
| 06 | Un rebase arrêté détache HEAD : même affichée, la review perdait les commentaires, la base retenue et la pile de la branche. | La branche vient du `head-name` du rebase. Ajout hors plan, sans lequel `ghl comments` restait vide pendant un rebase. |
| 06 | Lister un fichier non suivi illisible « comme les images » ne l'aurait pas montré : sans section de patch, l'UI ne crée pas d'item. Une section binaire factice aurait menti. | Laissé hors du patch et nommé dans l'avis de la review, que `ghl comments` écrit sur stderr. |
| 06 | `strings.ToValidUTF8` remplace une suite d'octets invalides par un seul U+FFFD, JSON un par octet. | Normalisation octet par octet, comme JSON. |
| 06 | `REVERT_HEAD` n'était pas détecté. | Ajouté aux opérations, `RepoOperation` comprend `revert`. |
| 07 | `git hash-object --path` sur stdin demandait une plomberie d'entrée qu'aucun appel git du serveur n'a. | Fins de ligne : normalisation CRLF→LF en Go, retenue seulement si elle redonne l'empreinte du patch. Autres filtres : `git hash-object -- <path>`, seulement pour choisir le message d'erreur. |
| 07 | La PR part de `main` sans la 01 : les deux modifient la ligne des arguments de `git diff` dans `review.go` et `untracked.go`. | Conflit trivial à résoudre au rebase de la seconde mergée. |
| 07 | Une exécution complète des suites UI a échoué une fois sur `and c comments that selection` ; trois exécutions isolées passent. | À traiter dans la 10 : le clic de gouttière vise des coordonnées lues plus tôt, et l'`until` qui suit n'est pas vérifié. |
| 08 | Exiger `HOMEBREW_TAP_TOKEN` partout aurait cassé `task release` en local, où `gh` écrit sur le tap avec le compte du mainteneur. | Exigé seulement sous `GITHUB_ACTIONS`. |
| 08 | `brew style` refusait déjà l'ordre de la liste `zap` sur `main` (`ghl Desktop` avant `ghl`). | Ordre corrigé avec les nouveaux chemins. |
| 08 | Séparer le build, sans secret, de la publication reste une option. | Non fait : à décider, cela double les jobs et le transfert d'artefacts. |
| 08 | Aucune release n'est faite dans cette PR, à la demande de l'utilisateur. | Le contrôle du token et le groupe de concurrence ne se verront qu'au prochain tag. |
| 09 | `structuredClone` de l'instantané de recherche : 4 à 6 ms sur 8,4 Mo de patch, contre 20 ms pour le parse. | Laissé tel quel. |
| 09 | Le double calcul du diff à l'ouverture coûte environ 0,2 s sur 558 fichiers ; l'éviter demande de couper `compare` en deux. | Laissé tel quel. |
| 09 | Le PATCH d'un commentaire renvoie son code et son état stale, qui dépendent de la comparaison. | Son `Resolve` reste ; le cache de la base devinée en réduit le coût. |
| 09 | « Écrire la base résolue dans l'URL » aurait fait passer chaque base devinée pour une base imposée. | Remplacé par un cache par dépôt, indexé sur le HEAD, le trunk et les pointes de branche. |
| 09 | Avec les workers, le re-rendu d'un fichier après la fermeture d'un composer peut effacer une sélection faite juste après : deux exécutions complètes sur quatre échouaient dans `comments`. | Le test reclique jusqu'à ce que la sélection tienne. La fenêtre réelle est de quelques dizaines de millisecondes après Escape. |
| 10 | Le `sleep(600)` avant le zoom d'image masquait un vrai délai : juste après la sélection du fichier, le point visé n'appartient pas encore au bouton et le clic tombe sur le panneau. | Le test attend que `elementFromPoint` au centre du bouton tombe dans le bouton. |
| 10 | Des parcours plus rapides chargent davantage les suites parallèles : le clic de gouttière de `comments` échouait trois fois sur cinq sans le pool de workers. | Correctif de test de #192 repris à l'identique par cherry-pick. |
| 10 | La suite complète est passée de 33 s à 19 s. | Seuls les intervalles de sondage de `poll` et `waitForRows` gardent un délai fixe. |
| 10 | Les tests ne touchent pas l'utilisateur. | Pas d'entrée au CHANGELOG. |
| 10 | Le commentaire sur la longueur du socket était au-dessus de `userTempDir` depuis #178. | Remis sur `instancePaths`, dans un commit à part. |
| 11 | Élaguer propriété par propriété les règles de `styles.css` que `desktop.css` surcharge demandait de comparer des sélecteurs de spécificités différentes, pour une trentaine de lignes. | Seules les règles mortes et les palettes de `themes.css` sont retirées ; `desktop.css` reste injecté en `?inline`, qui garantit qu'il passe après `styles.css`. Captures identiques au pixel dans sept états. |
| 11 | Rendre obligatoires les props optionnelles d'`App` réécrit les lignes que #187 modifie. | Reporté après le merge de #187. |
| 11 | Le bandeau d'opération en cours et `RepoState` sont utilisés depuis #189, et `loopbackURL` a été retiré par #193. | Laissés à ces PR. |
| 11 | `smoke.py --standalone` a échoué sur « Scroll not restored » ; la référence qui passait avait été compilée avec Go 1.27.3, la branche avec 1.27.1. L'UI de la branche, CSS annulé, est identique octet pour octet à celle de `main` et échouait aussi. | Aucun commit de la PR n'est en cause à l'analyse ; trois exécutions standalone sur `main` trancheront, au moment choisi par l'utilisateur. |
| 11 | Les smoke natifs lancés à répétition ont affiché des fenêtres au premier plan pendant que l'utilisateur travaillait. | Plus de test natif sans le demander ; ils sont listés dans les PR. |
