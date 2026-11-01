# Walkthrough

Statut : plan validé le 29 octobre 2026, variante A retenue. Maquettes : [`walkthrough-mockup.html`](./walkthrough-mockup.html), variantes A à D, plus la génération et l'état périmé.

## Objectif

Une review commence souvent par la question « par où je prends ce changement ? ». Un walkthrough y répond : un parcours en quelques arrêts, chacun avec un titre, une phrase et les hunks qui le portent, dans l'ordre qui aide le plus la review plutôt que dans celui des fichiers. Diffdesk l'affiche sur la vraie diff ; un agent l'écrit, soit celui qui a fait le changement, soit un CLI que Diffdesk lance à la demande.

## Constat

### codiff

- `codiff -w` lance un CLI d'agent local (Codex, Claude Code, OpenCode ou Pi, détectés dans cet ordre) avec la connexion de l'utilisateur ; codiff ne garde aucune clé. Le résultat est mis en cache par modèle et effort de raisonnement.
- L'agent écrit un JSON « narratif » : un titre, un `focus`, 1 à 6 chapitres (« UI », « Tests »…), chacun fait d'arrêts. Un arrêt est une idée de review, avec un titre sémantique, un résumé d'une phrase, une prose courte et une liste ordonnée de `hunkIds`, éventuellement dans plusieurs fichiers. Les lockfiles, le code généré et les modifications mécaniques vont dans `support`, hors du parcours.
- L'agent ne fournit ni chemins, ni statistiques, ni code : codiff les recalcule depuis la diff. Un id inconnu fait échouer la commande, qui liste les vrais ids.
- Un id vaut `<chemin>:<scope>:h<n>`, `n` étant le rang du hunk dans le patch du fichier, et `scope` le diff d'origine : `staged`, `unstaged`, `pull-request:<n>` ou le SHA complet de la tête.
- `--walkthrough-file` laisse un agent extérieur écrire le JSON. Le guide qu'il lit (`walkthrough-guide.md`) fixe des plafonds : 2 arrêts pour un petit changement, 14 au plus, jamais un arrêt par fichier, pas de risques ni de tests inventés.
- L'interface réordonne la diff par arrêt : la sidebar montre les chapitres, le centre ne montre que les hunks de l'arrêt avec sa prose.

### Diffdesk

- Une review compare une base à une cible, et peut inclure le working tree et les fichiers non suivis, avec ou sans `-w`. La même branche donne donc plusieurs diffs : un `scope` à la codiff ne suffit pas à dire laquelle.
- Le patch est découpé côté web par `parsePatchFiles` de `@pierre/diffs` ; côté Go, `describe` connaît les lignes de chaque fichier mais pas encore ses hunks. La CLI devra les compter de la même façon que la page.
- `CodeView` virtualise des fichiers entiers. L'hydratation au dépliage du contexte réécrit les hunks d'un item en place (vu avec le rendu Markdown, #302). Afficher un sous-ensemble de hunks par arrêt demande donc des items à part, pas un filtre sur l'item existant.
- La boucle avec l'agent existe déjà : `diffdesk comments` imprime un texte compact pour un agent, l'état vit dans `.git/ghl/state.json`, et les commentaires appartiennent à la branche revue.
- Le code intelligence trouve déjà les outils par le shell de login (`lsp_env.go`), ce qui couvre un CLI d'agent installé par mise ou Homebrew quand l'app est lancée depuis le Finder.
- `n` et `p` sont libres parmi les touches de la review.

## Décisions

### Format

Un document JSON, version 1, inspiré de celui de codiff mais réduit à ce que Diffdesk affiche :

```json
{
  "version": 1,
  "title": "Comments on a whole file or review",
  "focus": "A comment without lines now covers its file, or the review without a path.",
  "chapters": [
    {
      "title": "Model",
      "stops": [
        {
          "title": "A comment without lines",
          "summary": "start and end at 0 mean the whole file; no path means the review.",
          "prose": "`validTarget` is shared by creation and by reading the state file, so both accept the same comments.",
          "hunks": ["go/internal/app/review.go#2", "go/internal/app/state.go#1"]
        }
      ]
    }
  ],
  "support": [{ "note": "Docs and changelog", "hunks": ["CHANGELOG.md#1"] }]
}
```

- Un id de hunk vaut `<chemin>#<n>` : le rang du hunk dans le patch du fichier, à partir de 1, dans la comparaison affichée. Le scope n'est pas dans l'id ; il vit une fois dans le document stocké (voir Stockage).
- Pas d'icône, de notes par hunk, de message de commit ni de partage : Diffdesk relit, il ne commite pas.
- Plafonds repris de codiff : 1 à 6 chapitres, 14 arrêts au plus, 14 hunks par arrêt. Un hunk apparaît une fois au plus ; ceux qu'aucun arrêt ne cite vont d'office dans `support`.
- La prose accepte le code en ligne entre backticks, rien d'autre.

### Deux façons de l'écrire

1. **Par l'agent du changement.** Celui qui a écrit le code connaît l'intention, et le walkthrough ne coûte rien de plus que ses propres tokens. `diffdesk walkthrough hunks` lui donne les ids, `diffdesk walkthrough guide` les règles, `diffdesk walkthrough set` valide et enregistre.
2. **Par un CLI que Diffdesk lance**, en bêta, éteint par défaut comme le code intelligence : Settings › Walkthrough choisit Claude Code ou Codex. **Generate Walkthrough** envoie au CLI le guide, la liste des hunks et la diff, attend le JSON, le valide comme `set` et l'enregistre.

Les deux passent par la même validation et le même stockage ; l'interface ne sait pas qui a écrit le document, sauf pour l'afficher.

### CLI

- `diffdesk walkthrough hunks [revision]` : une ligne par hunk, `id  +a −d  en-tête @@`, sous-ensemble de la diff au besoin avec `--code` ; `--json` pour un agent qui préfère parser. Mêmes options de comparaison que `diffdesk comments` (`--base`, `--repo`).
- `diffdesk walkthrough guide` : les règles d'écriture, pour qu'un skill d'agent n'ait qu'une ligne à dire.
- `diffdesk walkthrough set <fichier|->` : valide le document contre la comparaison. Un id inconnu ou en double, un plafond dépassé ou un champ manquant fait échouer la commande, qui imprime les erreurs et les vrais ids. Sinon il enregistre et la fenêtre ouverte sur cette review l'affiche.
- `diffdesk walkthrough show` : le parcours en texte ; `clear` le supprime.

### Stockage

- Un walkthrough par branche revue, comme les commentaires, dans `.git/ghl/walkthroughs/<branche>.json`. `set` remplace le précédent.
- Le document stocké garde sa provenance : la plage, les options de comparaison (working tree, non suivis, `-w`), l'auteur (`agent` ou le CLI et son modèle) et la date.
- Chaque id résolu est stocké avec l'empreinte du contenu de son hunk. À l'affichage, un hunk se retrouve par son empreinte d'abord, ce qui survit à un hunk ajouté plus haut dans le fichier, puis par son rang.
- Un hunk introuvable rend son arrêt **périmé** : l'arrêt reste lisible, marqué, sans surlignage. Si la moitié des hunks sont introuvables, le walkthrough entier est marqué périmé et propose de le régénérer.

### Génération dans l'app

- Go cherche `claude` ou `codex` par le shell de login, comme les serveurs de langage, et les lance sans terminal : `claude -p --output-format json` ou `codex exec`, avec le guide et la liste des hunks en prompt et la diff en entrée. Le CLI ne reçoit aucun outil d'écriture.
- La feuille de génération dit ce qui part et où : nombre de fichiers et de lignes, CLI, modèle, et que la diff est envoyée au fournisseur de ce CLI avec la connexion de l'utilisateur.
- Annuler arrête le processus. Une erreur garde la sortie du CLI, avec **Try Again**, comme l'installation d'un serveur de langage.
- Pas de cache par modèle : régénérer remplace le document, et le précédent reste dans `walkthroughs/<branche>.previous.json` le temps d'une session.

### Interface

Quatre variantes dans la maquette ; **A** est retenue pour la première version.

- **A · Onglet du panneau.** Walkthrough rejoint Comments et Symbol dans le panneau de droite. Les chapitres et arrêts s'y lisent, l'arrêt courant déplie sa prose. Choisir un arrêt fait défiler la diff normale jusqu'à son premier hunk et marque ses hunks d'une barre d'accent. `n` / `p` passent d'arrêt en arrêt. La diff ne change pas : c'est la variante la moins risquée.
- **B · Sidebar.** La sidebar bascule entre Files et Walkthrough. L'arrêt courant s'affiche en bandeau collant au-dessus de la diff, qui défile comme en A. Le panneau de droite reste aux commentaires.
- **C · Vue narrative.** Comme codiff : le centre ne montre que l'arrêt courant, sa prose puis ses hunks, chacun avec l'en-tête de son fichier. `support` se lit à la fin, replié. Demande des items `CodeView` par hunk et une seconde façon de rendre la review.
- **D · Notes dans la diff.** La prose de chaque arrêt s'insère comme une carte au-dessus de son premier hunk, d'une couleur distincte des commentaires, et la barre d'état porte `Arrêt 3/7 ‹ ›`. Rien ne s'ouvre, mais un arrêt multi-fichier n'a qu'une carte, au-dessus de son premier hunk.

A livre l'essentiel sans toucher au rendu de la diff. **C** pourra suivre si le walkthrough sert, comme vue à part (`View › Walkthrough`).

Dans toutes les variantes :

- Un arrêt lu se coche ; la progression vit avec le walkthrough, pas avec Viewed.
- Commenter fonctionne comme ailleurs : le walkthrough ne remplace pas la diff.
- La palette gagne Next Stop (`n`), Previous Stop (`p`), Show Walkthrough et, en bêta, Generate Walkthrough….

## Découpage en PRs

Préfixe `walkthrough/`, en pile `gh stack` dans l'ordre ci-dessous ; ce plan ouvre la pile.

### 01 · `walkthrough/01-plan` — Plan et maquettes

- Ce plan et `walkthrough-mockup.html`.

### 02 · `walkthrough/02-cli` — Format, validation, CLI

- Hunks côté Go, comptés comme `parsePatchFiles` ; ids et empreintes.
- Validation, stockage par branche, `diffdesk walkthrough hunks|guide|set|show|clear`.
- Tests Go : ids identiques à ceux de la page sur les fixtures existantes (renommage, suppression, non suivi, `-w`), document invalide, hunk retrouvé après un ajout plus haut, périmé.

### 03 · `walkthrough/03-panel` — Interface (variante A)

- Lecture par l'API de la review, affichage, navigation `n` / `p`, surlignage, arrêts lus, palette.
- Suite UI ; guide ; CHANGELOG.

### 04 · `walkthrough/04-generate` — Génération (bêta)

- Settings › Walkthrough, détection des CLIs, feuille de génération, annulation, erreurs.
- Test avec un faux CLI, comme les faux serveurs de langage.

## Reporté

- La vue narrative C.
- Le partage d'un walkthrough et sa publication dans une PR GitHub (voir #235).
- Les notes par hunk et le message de commit de codiff.
- Les autres CLIs (OpenCode, Pi) et le choix du modèle au-delà de celui du CLI.
- Un walkthrough par commit d'une pile.

## Décisions du 29 octobre

- Variante **A**, l'onglet du panneau.
- L'agent du changement d'abord (02 et 03) ; la génération dans l'app suit en 04, sans bloquer les deux premières.
- Un walkthrough par branche, comme les commentaires. Quand la comparaison affichée diffère de celle du document (autre base, working tree ou `-w`), le panneau le dit et les hunks se retrouvent par empreinte ; un walkthrough par commit d'une pile reste reporté.
