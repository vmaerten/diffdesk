# Runtime Go de production : mesures et décision

Relevé du 4 octobre 2026 sur macOS 26.6.2 / ARM64, avec Node 24.21.0,
Go 1.27.1, Git 2.55.0 et Python 3.14.7. Le
[JSON complet](./go-runtime-benchmark.json) contient les 24 observations,
les versions, le matériel, les requêtes et leurs hashes. `complete: true`
signifie que les quatre scopes, deux runtimes et trois passages ont terminé
avec des réponses conformes.

Le binaire testé est extrait de l'archive snapshot `0.0.0-next-71b818d`,
construite au commit `71b818de824c1d2f28b61a708e7d0b21ad538e7e`.
Le harness de cette branche était en cours d'édition lors du relevé ; le JSON
le signale avec `source_dirty: true`. Le code de production Go et React est
celui de ce commit. La CI produit son propre relevé pour chaque candidat.
Les [prototypes minimaux](./runtime-benchmark.md) et le
[PoC isolé](./go-poc.md) conservent leurs résultats séparés.

## Mémoire et CPU

Médianes des trois passages. RSS en Mio, après échauffement puis après toute
la charge ; CPU du processus serveur en secondes pendant la charge.

| Scope                      | Node RSS chaud | Go RSS chaud | Node RSS chargé | Go RSS chargé | Node CPU | Go CPU |
| -------------------------- | -------------: | -----------: | --------------: | ------------: | -------: | -----: |
| 100 fichiers texte         |          169,0 |         30,7 |           267,6 |          57,3 |     2,35 |   2,23 |
| Checkout mixte + untracked |          103,9 |         22,1 |           140,8 |          24,6 |     2,19 |   2,09 |
| Cible `feature`            |          104,6 |         21,8 |           136,2 |          24,2 |     2,22 |   1,89 |
| Commit sélectionné         |          105,1 |         21,8 |           140,8 |          24,2 |     2,14 |   1,90 |

Ces mesures portent sur **le PID serveur seulement**. Les sous-processus Git,
le navigateur, le client Python et les outils de build sont exclus. Le RSS
après charge est un relevé final, pas un pic. Aucune progression du temps CPU
au repos n'a été détectée dans les fenêtres de trois secondes ; la résolution
au centième de seconde de `ps` ne démontre pas une consommation exactement
nulle. Ce protocole ne mesure pas l'énergie consommée.

## Latences

Millisecondes ; chaque cellule est la médiane des p50 / p95 des trois passages.

| Scope                      | Node diff en série | Go diff en série | Node diff, 4 clients | Go diff, 4 clients |
| -------------------------- | -----------------: | ---------------: | -------------------: | -----------------: |
| 100 fichiers texte         |      64,44 / 84,96 |    68,17 / 71,91 |      135,20 / 143,91 |    101,23 / 113,92 |
| Checkout mixte + untracked |      72,52 / 82,72 |   86,79 / 110,52 |      124,30 / 135,20 |     95,37 / 107,72 |
| Cible `feature`            |      51,41 / 54,05 |    64,94 / 67,71 |      131,77 / 144,41 |      81,70 / 89,35 |
| Commit sélectionné         |      50,38 / 54,43 |   70,94 / 111,97 |      114,74 / 134,39 |      83,13 / 91,48 |

La fixture mixte permet aussi de comparer les autres routes en série :

| Route             | Node p50 / p95 |  Go p50 / p95 |
| ----------------- | -------------: | ------------: |
| Healthcheck       |  0,247 / 0,391 | 0,203 / 0,333 |
| Asset JS commun   |  1,192 / 1,802 | 0,350 / 0,422 |
| Contexte texte    |  64,25 / 65,55 | 75,54 / 80,65 |
| Refs              |   9,97 / 11,13 | 21,88 / 23,16 |
| Commits           |  30,97 / 33,77 | 40,97 / 48,73 |
| Image du worktree |  0,266 / 0,352 | 0,213 / 0,290 |

Le JSON contient toutes les routes, débits, tailles et mesures avec quatre
clients. Les images historiques nécessitent Git : leur p50 sur les vues cible
et commit est d'environ 9–12 ms, contre moins d'une milliseconde pour l'image
du worktree. Ces cas ne sont pas regroupés dans une moyenne unique.

## Distribution et complexité

Le binaire optimisé fait **18,03 Mio, assets inclus** (18 903 922 octets).
Il contient le frontend de production ; aucune installation de Node, pnpm ou
Go n'est nécessaire à l'exécution. L'archive inclut séparément la licence MIT
et les notices tierces. Le runtime Node mesuré fait 122 129 232 octets sur
disque, mais cette taille exclut ses sources, dépendances et assets ; elle ne
représente pas un paquet Node complet.

Le module Go reste sans dépendance externe. Le backend partagé représente
15 fichiers / 3 402 lignes Go, et ses tests 10 fichiers / 1 768 lignes, blancs
et commentaires compris. Ces comptes excluent les commandes d'entrée,
React, les assets et les harness TypeScript ; ils décrivent le volume.

Les frontières principales sont la comparaison et la lecture des sources
(`Repository` / `Review`), la persistance (`Store`, verrou Git et écriture
atomique), les routes HTTP et le lifecycle CLI/daemon. Les difficultés du port
ont été les chemins Git quotés et renommés, les ancres des deux côtés, les
comparaisons devenues obsolètes, les lectures bornées d'images et le partage
de l'état entre processus Node/Go. Les contrats, les scénarios navigateur et
les remplacements de daemon sont vérifiés dans le
[contrôle de release](./go-validation.md).

## Protocole et reproduction

```bash
# Builds de production, puis comparaison locale :
mise exec -- task bench

# Mesurer le binaire extrait d'un candidat déjà construit :
pnpm build
mise exec -- task release:snapshot
mise exec -- task release:bench
```

Le mode `--go` de `scripts/bench-runtime/run.py` conserve les anciens modes.
Il utilise uniquement la bibliothèque standard Python et les exécutables
locaux. `BENCH_NODE`, `BENCH_GO`, `BENCH_GHL_GO` sélectionnent les runtimes ;
`BENCH_OUTPUT` choisit le fichier JSON. La CI écrit dans
`.task/go-runtime-benchmark.json` et conserve le rapport comme artifact,
avec un diagnostic en cas de différence de contrat. Un rapport interrompu
reste marqué incomplet.

- Dépôts temporaires avec noms canoniques : les alias macOS `/var` et
  `/private/var` ne doivent pas produire des IDs différents pour la même fixture.
- Grande fixture : 100 fichiers de 200 lignes, toutes modifiées, patch vérifié
  directement contre Git.
- Fixture mixte : 12 fichiers de 200 lignes, ajout, suppression, renommage
  Unicode, SVG/PNG, modifications commitées, staged, unstaged et untracked texte,
  image et binaire. Elle est demandée en checkout, cible et commit sélectionné.
- Go de production au premier plan avec `--no-daemon --port 0`, et serveur
  Node de production via `createGhlServer`, sur les mêmes dépôts. Le daemon
  partagé et son upgrade sont testés fonctionnellement, pas mesurés ici.
- Même chunk JS et mêmes octets servis par les deux frontends. Échauffement :
  dix healthchecks, trois assets, trois diffs, trois contextes et trois appels
  de refs/commits ; lecture d'image lorsqu'elle existe.
- Trois secondes au repos, puis 100 healthchecks, 20 assets, 20 diffs,
  10 contextes, 10 refs, 10 listes de commits et 20 images lorsqu'elles existent,
  pour chaque route en série puis avec quatre clients.
- Une connexion HTTP par requête, sans keep-alive. Statut, taille et SHA-256
  vérifiés pour chaque réponse. Les payloads de diff déclarés et les octets
  d'image doivent correspondre entre Node/Go et entre les passages ; l'ordre
  des propriétés JSON n'est pas imposé entre langages.
- Trois passages avec ordre des runtimes alterné. Le démarrage s'arrête au
  premier healthcheck ; Go valide déjà une comparaison avant son annonce,
  alors que le harness Node annonce son port avant cette lecture.
- Serveurs et fixtures supprimés à la fin. Les tests navigateur finissent
  avant les mesures locales et CI.

## Décision et limites

Sur ces fixtures, Go réduit le RSS chargé d'environ 4,7 à 5,8 fois et permet
la distribution d'un seul exécutable avec React. Les latences séquentielles
du diff, du contexte et des refs sont plus élevées dans plusieurs cas ; le
profilage de ces chemins est nécessaire avant de revendiquer un gain de
réactivité. Plusieurs routes avec quatre clients sont plus rapides en Go.
Le CPU du seul serveur reste proche, avec les processus Git exclus.

Ces résultats soutiennent la poursuite de la distribution Go lorsque le RSS
et le binaire autonome sont prioritaires. La bascule du CLI dépend aussi de
l'acceptation du candidat et du travail d'installation/documentation restant.
Aucun seuil de RAM et aucun gain garanti ne sont utilisés pour la promotion.

Les dépôts sont synthétiques, les caches chauds et les images petites. Il y a
une seule machine, trois passages et une charge courte ; le client, les coûts
Git, le navigateur, les gros dépôts réels et les sessions longues peuvent
modifier les résultats. Les débits ne décrivent pas une capacité maximale.
Les différences de résolution Git, de validation et d'I/O des implémentations
empêchent d'attribuer ces écarts au seul langage. Le support initial reste
macOS ARM64 ; les autres plateformes ont leur suivi séparé.
