# UI copy

The words in ADE's interface. Terms come from [CONTEXT.md](../../CONTEXT.md): a workspace is never
a "project" or a "worktree" in the UI, a conversation is never a "chat".

## Rules

- **Sentence case** everywhere: buttons, menus, titles, tabs, tooltips. "Review changes", not
  "Review Changes". Proper nouns keep their capitals ("Open in VS Code").
- **Buttons say what happens.** "Delete branch", "Close tab", "Commit". Never "OK", "Yes", "No",
  "Submit" or "Done"; a confirm dialog's buttons repeat its verb.
- **An ellipsis means more input follows** before the action happens: "Commit…" opens a message
  field, "Commit" commits. Use the single character `…`, not three dots.
- **Tooltips and icon-button labels** are the action in a few words ("Split right"), no full stop.
- **Titles are nouns or questions**: "Settings", "Delete the branch?".
- **Numbers are digits**: "3 changes", "2 running", including one ("1 change").
- **Errors say what happened and what to do**: "Push failed. Pull first, then push again." Never
  "Something went wrong" without a next step, and never blame the person.
- **No filler**: no "please", "successfully", "simply", exclamation marks or emoji.
- **Shortcuts** are shown with `<Shortcut>`, never typed into copy.

## Enforced

`ade/button-copy` refuses title-case labels and "OK/Yes/No/Submit/Done" on `Button`,
`AlertDialogAction`, `AlertDialogCancel` and `IconButton` labels. The rest is checked in review.
