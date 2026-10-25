# Commentaires pour les agents

Statut : plan proposé le 25 octobre 2026, pour [#204](https://github.com/vmaerten/ghl/issues/204) et [#74](https://github.com/vmaerten/ghl/issues/74).

## Objectif

Un agent traite les commentaires d'une review depuis le terminal : il les lit, corrige, répond, et s'arrête quand plus rien ne l'attend. Le reviewer lit les réponses dans son terminal, puis résout ou relance. La fenêtre les affiche en lecture seule. La boucle coûte peu de tokens à l'agent.

## Constat

- `ghl comments [--json]` exporte les commentaires de la comparaison avec leur code. L'agent les lit, mais rien n'enregistre ce qu'il a traité ni ne lui permet de répondre.
- Un commentaire n'a pas d'état : la carte propose Edit et Delete, et supprimer efface l'historique (#74).
- Un commentaire n'a qu'un `body`, sans réponse ni auteur.
- Le Markdown de `ghl comments` et celui du bouton de copie sont le même contrat, tenu par des goldens partagés (`go/internal/app/testdata/comment-export.json`).
- Écrire `.git/ghl/state.json` depuis un autre processus est sûr : `flock` sur les écritures et renommage atomique (#186).
- Un ghl plus ancien qui écrit l'état réécrit chaque `Comment` avec les seuls champs qu'il connaît : il effacerait les nouveaux champs sans erreur.

## Décisions

### Un tour de parole par commentaire

L'état dit qui doit agir.

| État | Au tour de | Devient |
|---|---|---|
| `open` | l'auteur du code, l'agent | `answered` quand il répond |
| `answered` | le reviewer | `resolved`, ou `open` s'il relance |
| `resolved` | personne | `open` si le reviewer le relance |

- L'agent n'a qu'un verbe, `reply`. Corrigé, refusé avec une raison ou question : la réponse rend la main au reviewer. Un agent en désaccord n'est jamais bloqué dans la boucle.
- Le reviewer a `resolve` et `reopen`, dans le terminal. Le skill interdit à l'agent de s'en servir ; ce n'est qu'une consigne, comme le reste de `state.json`.
- `Lines changed` (`stale`) reste un signal à part : des lignes modifiées ne veulent pas dire que la demande est faite.

### Un fil de réponses

`replies: [{author: "agent" | "reviewer", body, createdAt}]`. `reply` écrit comme `agent`, `reopen` comme `reviewer`. `ghl comments` montre le fil ; l'agent ne reçoit que la dernière réponse du reviewer.

### Version 2 de l'état

`status` et `replies` s'ajoutent à `Comment` ; un état absent vaut `open`. ghl lit les versions 1 et 2 et écrit la 2. Un ghl plus ancien, par exemple l'app encore ouverte après un `brew upgrade`, refuse alors le fichier (`unsupportedStateVersion`) au lieu d'effacer les réponses.

### CLI et skill, pas de MCP

Un CLI marche avec tous les agents. Les schémas d'outils d'un serveur MCP resteraient dans le contexte en permanence, même sans commentaire.

## Sobriété en tokens

Sur 5 commentaires d'exemple : 2 174 caractères avec le `--json` actuel, 1 164 en texte compact avec le code, 500 sans.

- `check` sort en texte compact ; `--json` reste pour les scripts.
- Pas de code par défaut : l'agent lit le fichier avant de le modifier. Restent les lignes que le fichier n'a pas : les anciennes lignes d'un commentaire périmé (`was`) et les lignes supprimées d'un commentaire côté gauche. `--code` remet le code.
- ID de 8 caractères, le premier groupe de l'UUID ; le CLI accepte tout préfixe unique d'au moins 4 caractères, comme git.
- `reply` répond une ligne, `ok, 2 open left` : pas besoin de relancer `check`, et plusieurs `reply` s'enchaînent avec `&&` dans un seul appel.
- `check` ne liste que les `open`. Un commentaire relancé montre son texte et la dernière réponse du reviewer, pas tout le fil.
- La dernière ligne de `check` dit quoi faire, ce qui garde le `SKILL.md` court et sa description, chargée à chaque session, à une phrase.
- Un hook `Stop` est muet quand rien n'est ouvert ; quand il bloque, sa sortie est la liste à traiter.

```
2 open on main..feature/login

0455572a web/src/App.tsx:228-230
Ce remove supprime l'historique, passe plutôt par un resolve.

1c02e40b go/internal/app/export.go:41
Nom pas clair, renomme en entries.
reviewer: Toujours trop vague.
was:
  list := make([]exportedComment, 0, len(ordered))

Reply to each when done: ghl comments reply <id> "<what you did>"
```

## Surface du CLI

```
ghl comments [target] [--json] [--all]          export, avec état et fil ; les résolus seulement avec --all
ghl comments check [target] [--json] [--code]   commentaires open, en texte compact
ghl comments reply <id> <message>               l'agent répond et rend la main au reviewer
ghl comments resolve <id>                       le reviewer clôt
ghl comments reopen <id> [message]              le reviewer relance, avec sa réponse
```

- `check` résout la comparaison comme `ghl comments` (`target`, `--repo`, `--base`) et couvre tous les commentaires de la branche, même sur un fichier sorti du diff : un commentaire ne disparaît pas parce que le fichier a été remis en l'état.
- `check` sort comme `diff` : 0 si rien n'est ouvert, 1 s'il en reste, 2 sur une erreur.
- `reply`, `resolve` et `reopen` n'ont besoin que du dépôt : l'ID est unique dans `state.json`. `reply` refuse un commentaire résolu et un message vide.
- Une branche nommée `check`, `reply`, `resolve` ou `reopen` s'écrit `refs/heads/<nom>`, comme `comments` aujourd'hui.
- Hook `Stop` de Claude Code : `ghl comments check >&2; [ $? -ne 1 ] || exit 2`. Une erreur, ou un dossier sans dépôt, ne bloque pas l'agent.

## Découpage en PRs

Préfixe `agent-comments/`, en pile `gh stack` dans l'ordre ci-dessous : chaque PR a pour base la précédente.

### 01 · `agent-comments/01-cli` — État, réponses et commandes

- `Comment` gagne `status` et `replies` ; état en version 2, migration à la lecture, validation des valeurs.
- Transitions dans `repositoryComments`, sous le verrou de l'état.
- `check`, `reply`, `resolve` et `reopen` ; `--all` sur l'export.
- Export : `status` et `replies` en JSON, l'état et le fil en Markdown, côté Go et côté bouton de copie (`src/export.ts`), avec les goldens partagés.
- Aide de `ghl`, `docs/reviewing.md`, `desktop/README.md` et CHANGELOG.

### 02 · `agent-comments/02-window` — Affichage en lecture seule

- Carte : badge `Answered` et fil de réponses, sans champ de saisie.
- Les commentaires résolus sont masqués, dans le diff comme dans le panneau. R recharge après un changement fait dans le terminal.

### 03 · `agent-comments/03-skill` — Skill et doc

- `SKILL.md` embarqué dans le binaire ; `ghl skill` l'affiche, à la version du CLI.
- Installation pour Claude Code et les autres agents, et l'exemple de hook `Stop`.

## Reporté

À faire seulement si le terminal ne suffit pas :

- répondre, résoudre et relancer depuis la fenêtre ;
- rafraîchir la fenêtre quand `state.json` change, par une sonde d'un `os.Stat` par seconde ;
- filtrer le panneau par état ;
- un auteur nommé, `--as <nom>`, pour distinguer plusieurs agents.
