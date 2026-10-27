---
description: Review the working tree and stage only explicitly confirmed exact paths (never git add . / -A / --all)
---

Follow this workflow exactly. Do not skip steps or shortcut with `git add .`,
`git add -A`, or `git add --all` at any point — Mona Jacinta requires explicit
path staging, and a project hook also blocks those forms mechanically.

## 1. Show current state

Run and show the output of each, unmodified:

```
git status --short
git diff --name-status
git diff --stat
git diff --check
git diff --cached --name-status
```

## 2. Identify candidates

From the output above, list every modified/untracked path as a candidate for
staging. Do not assume any file should be staged.

## 3. Flag opencode.json

If `opencode.json` appears anywhere in the working tree status, explicitly
call it out as **protected / out-of-scope** for this project and state that it
will not be staged by this command under any circumstance, even if the human
asks for it here — that requires the human to stage it themselves outside
this workflow.

## 4. Ask for exact paths

Ask the human to state the exact paths they want staged, e.g.:

> Which exact paths should be staged? (list them explicitly — I will not use
> `git add .` / `-A` / `--all`)

Do not proceed until they give an explicit list. A vague answer ("everything",
"all of it", "the usual") is not confirmation — ask again for the exact paths.

## 5. Fail closed

Before staging, refuse and stop (do not run `git add`) if any of the following
is true:

- The human has not given an explicit list of exact paths.
- `opencode.json` (or any path resolving to it) appears in the requested list.
- `git diff --check` (from step 1) reported any whitespace errors in files
  being requested for staging.
- Any requested path does not appear in the step-1 status output (nothing to
  stage there — likely a typo).

If any of these apply, explain which check failed and stop. Do not commit.

## 6. Stage exactly the confirmed paths

Only once the human has explicitly confirmed the exact path list and none of
the fail-closed conditions apply, run:

```
git add -- <exact confirmed paths>
```

Never substitute `.`, `-A`, or `--all` for the path list, even if the
confirmed list happens to be "everything currently modified" — spell out each
path.

## 7. Show the result

Run and show:

```
git diff --cached --name-status
git diff --cached --check
git status --short
```

Compare the staged file list against the exact confirmed set from step 4/6.
If they differ (something got staged that wasn't confirmed, or something
confirmed didn't get staged), say so explicitly and stop — do not proceed.

## 8. Stop

This command ends here. It never runs `git commit` or `git push`, regardless
of how clean the result looks. Report the final staged state and stop.
