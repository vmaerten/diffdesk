---
name: ghl-comments
description: Review comments left in ghl on the current branch. Use when asked to address, fix or answer review comments, or when `ghl comments check` lists open ones.
---

# ghl review comments

An open comment is your turn; `reply` hands the turn back to the reviewer.

1. Run `ghl comments check` in the repository. It lists each open comment with its ID and `path:lines`.
2. For each one, read those lines, make the change, then run `ghl comments reply <id> "<what you did>"`. When you disagree or the request is unclear, reply with your reason or question instead. Chain replies with `&&` to send them in one command.
3. Done when a reply prints `ok, 0 open left`, or `ghl comments check` exits 0.

In the list:

- `reviewer:` is the reviewer's answer to your last reply; they reopened the comment.
- `was:` holds the lines the comment was written on, which have changed since. Changed lines alone do not answer it.
- `code:` holds the removed lines a comment on deleted code is about.

Your one write is `reply`: resolving and reopening belong to the reviewer.
