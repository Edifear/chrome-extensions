# auto-pr-review

A Claude Code skill that reviews the open pull requests **you're a requested
reviewer on** when they're flagged by a trigger keyword in a comment. It looks
for **critical, merge-blocking issues only** — real bugs, security holes,
data-loss risks — and:

- **clean PR →** submits an **approving** review,
- **issues found →** posts a **non-approving comment** with the findings.

Each PR is reviewed by an **isolated per-PR subagent**, so the heavy context of
every review (diffs, file reads) stays out of the main session.

The skill runs **one pass and stops**. Continuous watching is delegated to
whatever drives it on a schedule (`/loop` or cron) — that keeps each pass on a
fresh context, which is more robust than any in-session loop.

## Requirements

- [`gh`](https://cli.github.com/) authenticated (`gh auth status`). Reviews are
  posted under that identity — and GitHub won't let you approve your **own** PRs,
  so those fall back to a comment.
- Run it from inside a local clone of the repo you want to review.

## Quick start

In Claude Code:

```
/auto-pr-review
```

That does one pass: find your flagged PRs, review the new ones one at a time,
post the verdicts, and stop.

### Arguments

| Argument | Default | Purpose |
| --- | --- | --- |
| `--keyword="..."` | `/claude-review` | Comment text that flags a PR for review |
| `--repo=owner/name` | current dir's repo | Which repo to review |
| `--from=username` | any author | Only review PRs opened by this GitHub login |

Examples:

```
/auto-pr-review --keyword="@username review pls"
/auto-pr-review --keyword="@username review pls" --repo=trymedallion/medallion
/auto-pr-review --from=octocat
```

## How to flag a PR

On any PR where you're a requested reviewer, drop a comment containing the
keyword, e.g.:

```
@username review pls
```

The next pass picks it up. The skill won't re-review the same commit twice (it
checks whether you already reviewed the current head SHA).

**Re-review after addressing comments.** Once you've reviewed a PR, it's
re-reviewed only when **both** of these are true:

1. the author has **pushed a new commit** (the head SHA changed), **and**
2. someone **posts the keyword again** after your last review.

So after the author fixes things, drop another `@username review pls` comment to
ask for the re-review — the next pass then reviews the new commit (approving with
`🔥` if it's clean now). A new push alone won't trigger it, and re-posting the
keyword without a new push won't either. (The skill stays in scope for this
because it also looks at PRs you've already reviewed, not just ones where you're
currently a requested reviewer.)

## Watching continuously

The skill itself does a single pass — to keep watching, run it on a schedule.

**In-session, with `/loop`:**

```
/loop 5m /auto-pr-review --keyword="@username review pls"
```

`/loop <interval> <command>` re-runs the command on a timer. Each tick is a
clean, independent pass — no context accumulates across passes. Good for
watching in the background while your session is open. (`/loop` is a global
Claude Code skill; install it if you don't have it.)

**Walk-away durable, with cron / launchd:**

```cron
*/5 * * * * cd ~/code/medallion && claude -p '/auto-pr-review --keyword="@username review pls"' >> ~/.cache/pr-review.log 2>&1
```

Each run is a fresh `claude` process with fresh context, and it survives your
machine sleeping/restarting in a way no in-session loop does. This is the most
durable option for an unattended watch.

> **Why no built-in loop?** An in-session `while`-loop would depend on the model
> faithfully never ending its turn, lean on `sleep`, and slowly accumulate
> per-pass state. Delegating recurrence to `/loop` or cron is simpler and starts
> every pass clean.

## What it will and won't do

- **Will:** read the diff and the code, find critical issues, approve clean PRs,
  comment findings on risky ones — one PR at a time, never two reviews at once.
- **Won't:** edit, commit, or push anything; nitpick style/naming/coverage; or
  re-review a commit it already reviewed. It deliberately ignores the project's
  other reviewer agents/skills and does a self-contained critical-only pass.

Try a manual `/auto-pr-review` and watch the first pass until you trust its
judgment, since it approves under your name.
