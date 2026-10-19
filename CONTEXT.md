# Local review

## Language

**Comparison**: The versions and scope of code being reviewed, such as a branch against its base, a selected commit, or changes including the working tree.

**Viewed**: A record that a file's displayed changes have been read in a particular revision range and whitespace mode. It applies to the recorded version of those changes and becomes invalid when they change.

**Comment**: A remark on source lines belonging to a repository path and a reviewed branch. Its original comparison records provenance; the comment remains available when the base or displayed commit changes on that branch. Switching branches shows that branch's comments, and returning restores the earlier branch's comments.

**Anchor**: The original text of the lines a comment refers to. It belongs to the first saved comment and survives edits and repeated submissions of the same comment.

**Stale comment**: A comment whose current lines differ from its anchor. This describes the current code rather than a saved status or a reason to delete the comment.
