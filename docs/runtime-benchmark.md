# Node, Go et Rust : première mesure locale

> Rapport historique : le runtime Node et le comparateur ont été retirés.
> Les résultats décrivent les révisions mesurées ; leurs sources restent dans
> [la révision précédente](https://github.com/vmaerten/ghl/tree/5e301b1e4c2f670da211effb9cc8168d3fbfa2be/scripts/bench-runtime).
> `task bench` et `task release:bench` mesurent désormais Go seul.

Mesuré le 30 septembre 2026 sur macOS 26.6.2 / ARM64, avec Node 24.21.0,
Go 1.27.1 et Rust 1.98.0. Sources et runner dans
[scripts/bench-runtime](../scripts/bench-runtime/), données brutes dans
[runtime-benchmark.json](./runtime-benchmark.json).

## Résultats

Médiane de trois exécutions par serveur. La RAM est le RSS du processus serveur,
en Mio (MiB). « Au repos » signifie après échauffement ; « après charge » est
un relevé immédiatement après les requêtes, pas le pic mémoire ni la taille des
objets encore utilisés.

| Serveur minimal | RAM au repos | RAM après charge | Démarrage prêt à répondre | Healthcheck p50 | Fichier React p50 | Git diff p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Node | 69,9 Mio | 136,6 Mio | 38,2 ms | 0,262 ms | 0,539 ms | 20,18 ms |
| Go | 19,5 Mio | 33,8 Mio | 6,2 ms | 0,230 ms | 0,398 ms | 20,10 ms |
| Rust | 4,1 Mio | 17,7 Mio | 3,9 ms | 0,214 ms | 0,342 ms | 20,05 ms |

Le serveur **ghl Node actuel**, mesuré séparément sur la même fixture, utilise
157,4 Mio après échauffement et 261,4 Mio après charge. Sa route complète
`api/diff` prend 67,13 ms en p50 ; elle fait davantage de travail que les
prototypes, donc ces chiffres ne mesurent pas le seul effet du langage.

CPU au repos : aucune progression détectée pour les quatre serveurs pendant
les fenêtres de trois secondes. `ps` arrondit le temps CPU au centième de
seconde : cela ne démontre pas une consommation exactement nulle.

Temps CPU du serveur pendant toute la charge : Node minimal 0,19 s, Go 0,18 s,
Rust 0,12 s et ghl actuel 1,41 s. Ces relevés **excluent les sous-processus Git**
et ne constituent pas une mesure énergétique ni un benchmark CPU soutenu.

Les exécutables optimisés des prototypes font 5,31 Mio pour Go et 0,41 Mio
pour Rust. Ils lisent les assets sur disque : ces tailles **n'incluent pas le
frontend**. Le build web présent fait 10,77 Mio de contenu. Le script Node
nécessite également son runtime, dont la taille n'est pas incluse ici.

## Protocole

- Trois petits serveurs avec les mêmes réponses : JSON fixe, même fichier JS
  React de 1 143 576 octets, et même commande Git produisant le diff brut.
- Dépôt temporaire : 100 fichiers de 200 lignes, toutes les lignes modifiées ;
  patch de 1 208 500 octets. Aucun dépôt utilisateur n'est modifié.
- Commande commune : `git -C <fixture> diff --no-ext-diff --no-color HEAD`.
- Échauffement : dix healthchecks, trois lectures d'asset et trois diffs.
- Trois secondes au repos, puis 100 healthchecks, 20 lectures d'asset et 20
  diffs, chacun en série puis avec quatre clients simultanés. Une connexion
  HTTP par requête, sans keep-alive.
- Vérification du statut et du SHA-256 de **chaque réponse** des prototypes.
  Le serveur actuel est vérifié avec son propre JSON, et le champ `patch` est
  également comparé au diff brut lors de l'échauffement.
- Ordre des serveurs tournant entre les trois passages. Builds optimisés Go
  (`CGO_ENABLED=0`, `-s -w`) et Rust (`opt-level=3`, strip système macOS).
- Ports éphémères sur 127.0.0.1. Compilation et fixture dans un répertoire
  temporaire supprimé à la fin ; tous les serveurs sont arrêtés.

Pour reproduire avec les compilateurs disponibles dans le PATH :

```bash
python3 scripts/bench-runtime/run.py
```

Le build `web-dist/` doit être présent ; sinon, exécuter `pnpm build` une fois.
Les variables `BENCH_NODE`, `BENCH_GO` et `BENCH_RUSTC` permettent de sélectionner
explicitement les exécutables. Le runner utilise uniquement la bibliothèque
standard Python et ne télécharge aucune dépendance. Le relevé de RAM/CPU via
`ps` et les connexions localhost nécessitent les permissions correspondantes.

## Ce que cela permet de décider

Le coût mémoire de base est nettement plus faible dans les deux prototypes
natifs. Go utilise environ quatre fois moins de RSS que Node après la charge ;
Rust environ huit fois moins. Les temps de `git diff` sont quasiment identiques :
pour cette opération, passer en natif n'apporte pas de gain visible de latence.

Cette première mesure favorise Rust pour la RAM et Go pour un compromis entre
RAM et simplicité d'un serveur construit avec la bibliothèque standard.
Elle ne prédit pas la consommation d'un port complet : la résolution des bases,
les commentaires, les images, les stacks, le daemon et la persistance ne sont
pas implémentés dans les prototypes. Le HTTP Rust est un parseur GET minimal
avec un thread par connexion, alors que Node et Go utilisent leurs serveurs HTTP
standards ; un framework Rust de production changerait aussi ce coût de base.

Le navigateur, le rendu React et les processus Git ne sont pas comptés dans le
RSS des serveurs. La courte charge, les caches chauds, le client Python et une
seule machine limitent la portée des mesures ; les chiffres de débit bruts ne
doivent pas être lus comme une capacité maximale de production.
