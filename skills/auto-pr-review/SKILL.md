---
name: auto-pr-review
description: Do one pass over the open pull requests you are a requested reviewer on (or have already reviewed) and auto-review the ones whose comments contain a trigger keyword — surfacing only critical, merge-blocking issues, then approving the clean ones or commenting findings on the rest. Re-reviews a PR only when the author has pushed a new commit AND the keyword is posted again. Each PR is reviewed by an isolated per-PR subagent. Runs a single pass per invocation; drive it with /loop or cron to watch continuously. Use when the user asks to review / watch / track / auto-review the PRs assigned to them, or invokes /auto-pr-review.
---

Do one pass over the pull requests the user is a requested reviewer on,
auto-reviewing the ones flagged by a trigger keyword. This is a
**critical-issues-only** safety net — not a thorough line-by-line review. Clean
PRs get an auto-approval; risky ones get a comment with the findings.

Each PR is reviewed by a **dedicated subagent** (see "Review a PR via a
subagent"), keeping the heavy context of each review out of this session.

This skill runs **one pass and stops**. To watch continuously, drive it from an
external loop — see the README (`/loop` or cron + `claude -p`). That way each
pass starts with a fresh context, which is more robust than any in-session loop.

Requires the `gh` CLI authenticated as the user. Reviews are submitted under
that identity.

## Parameters

Read these from the user's invocation; otherwise use the defaults.

- **`--keyword`** — the text a PR comment must contain to flag that PR for
  review. Default `/claude-review`. Example:
  `--keyword="@username review pls"`. Match it as a plain substring of the
  comment body.
- **`--repo`** — `owner/name` to review. Default: the repo of the current
  directory (`gh repo view --json nameWithOwner -q .nameWithOwner`).
- **`--from`** — restrict the pass to PRs opened by a single author (their GitHub
  login). Default: unset (review PRs from any author). Example:
  `--from=octocat`. Match it case-insensitively against each PR's `author.login`.

## Setup

1. Confirm `gh` is authenticated (`gh auth status`); if not, stop and tell the user.
2. Record your own login: `gh api user -q .login` → call it `ME`.
3. Resolve `--repo` as above.

## The review pass

1. **Find candidate PRs** — open PRs where you're a requested reviewer **or which
   you've already reviewed**. Run both searches and union them by PR number
   (submitting a review removes you from the requested-reviewers list, so the
   second search is what keeps an already-reviewed PR in scope for a re-review):

   ```
   gh pr list --repo <repo> --search "review-requested:@me" --state open \
     --json number,title,author,url,headRefOid --limit 100
   gh pr list --repo <repo> --search "reviewed-by:@me"      --state open \
     --json number,title,author,url,headRefOid --limit 100
   ```

   If `--from` is set, drop any candidate whose `author.login` does not match it
   (case-insensitive) before moving on. You can also append `author:<from>` to
   each `--search` to filter server-side.

2. **Decide whether to (re-)review** — for each candidate, gather three facts
   from GitHub (no local state is kept; this is recomputed every pass):

   - **Head SHA** — `headRefOid` from step 1.
   - **Latest keyword comment time** — from
     `gh pr view <number> --repo <repo> --json comments`, the newest `createdAt`
     among comments whose body contains `<keyword>`. If there is none, the PR was
     never flagged → skip it.
   - **Your reviews** — the commits you've reviewed and when:

     ```
     gh api repos/<repo>/pulls/<number>/reviews \
       --jq '[.[] | select(.user.login=="<ME>") | {commit_id, submitted_at}]'
     ```

     → the set of `commit_id`s you've reviewed, and your latest `submitted_at`
     (none if you've never reviewed this PR).

   Review the PR only if **BOTH** gates pass; otherwise skip:

   - **Gate A — new commit:** the head SHA is NOT among your reviewed
     `commit_id`s. (If you already reviewed this exact commit, skip.)
   - **Gate B — keyword (re)posted since your last review:** you have no prior
     review of this PR, OR the latest keyword comment's time is newer than your
     latest review's time.

   So re-reviewing an already-reviewed PR needs **both** a newly pushed commit
   **and** a fresh `<keyword>` comment posted after your last review — either one
   alone is not enough. (Both timestamps are ISO-8601 UTC, so a plain string
   comparison orders them correctly.)

3. **Review the remaining PRs ONE AT A TIME** — strictly sequential. For each
   PR: spawn one review subagent (below), wait for it to finish, submit the
   verdict, then move to the next PR. Never run two review subagents at once.

4. **Finish** — when all flagged PRs are handled, briefly report what you did
   (e.g. "approved #123, commented #456, 2 skipped") and stop. If nothing was
   flagged, say so and stop.

## Review a PR via a subagent

For each PR to review, launch a **single subagent** with the `Agent` tool using
`subagent_type: "general-purpose"`. Do **not** use `medallion-python-reviewer`,
`medallion-frontend-reviewer`, or any other specialized agent, and do **not**
invoke any other skill — this review is self-contained and uses only the
criteria below. The subagent only analyzes and reports back; **you** submit the
GitHub review, which keeps serialization and identity handling in one place.

Give the subagent a prompt along these lines (fill in `<repo>`, `<number>`):

> You are doing a fast, critical-only review of pull request #`<number>` in
> `<repo>`. This is NOT a thorough line-by-line review — find only critical,
> merge-blocking problems, or confirm there are none.
>
> Do not invoke any skills or other agents. Work read-only: never edit, commit,
> push, or submit a GitHub review.
>
> Steps:
> 1. Get the change: `gh pr diff <number> --repo <repo>`.
> 2. For context, inspect files at the PR's exact version without touching the
>    working tree: run `git fetch origin pull/<number>/head` once, then read any
>    file with `git show FETCH_HEAD:<path>`. Grep the local checkout to find
>    callers/definitions of touched symbols.
> 3. Verify every suspicion against the real code before reporting it — do not
>    speculate.
>
> Report ONLY these as critical: real bugs (logic errors, off-by-one,
> wrong/missing conditionals, inverted operators, swapped args, unhandled
> None/null, broken control flow); data loss/corruption (unsafe migrations,
> unscoped deletes/updates, unsafe bulk ops); security (missing authz/authn,
> injection, leaked secrets/PII, broken tenant isolation, unsafe deserialization,
> SSRF); correctness hazards (race conditions, non-idempotent retries,
> transaction misuse, on_commit pitfalls); migration-safety violations (a
> migration that breaks currently-running old code — see
> `.agents/docs/migrations.md`); anything that will clearly crash, hang, or break
> a code path at runtime.
>
> IGNORE: style, naming, formatting, lint nits, test-coverage gaps, missing
> docstrings, minor refactors, subjective preferences, and any pre-existing issue
> in code this PR does not touch. Be conservative: if you are not confident an
> issue is real and critical, do not report it and lean toward approval.
>
> Respond in EXACTLY this format and nothing else:
>
> ```
> VERDICT: APPROVE | REQUEST_CHANGES
> SUMMARY: <1-3 sentences on what the PR does>
> ISSUES:
> - `path/to/file:line` — <the problem> — <why it is critical>
> - ...
> ```
>
> Use APPROVE with `ISSUES: none` when there are no critical issues. Use
> REQUEST_CHANGES only when you list one or more critical issues.

Parse the subagent's `VERDICT`, `SUMMARY`, and `ISSUES` from its reply, then
submit per below.

## Submitting the verdict

Keep the review body short — no preamble, no boilerplate.

**APPROVE** — approve with the body `🔥`, unless it's your own PR (GitHub forbids
self-approval), in which case post `🔥` as a comment instead:

```
gh pr review <number> --repo <repo> --approve --body "🔥"
```

**REQUEST_CHANGES** — never approve; post a short comment listing only the
issues:

```
gh pr review <number> --repo <repo> --comment --body "<body>"
```

Body — just the issues, nothing else:

```
⚠️ Potential critical issues:
<the ISSUES list>
```

## Guardrails

- Read-only on the codebase: the only writes are GitHub reviews via
  `gh pr review`. The review subagents are read-only too.
- One review per PR per head SHA (the dedup in step 2 enforces this).
- Only act on PRs where you're a requested reviewer. If the user wants to also
  restrict *who* may post the keyword comment, honor that; otherwise any
  commenter's keyword is valid.
- If a single PR errors, note it, skip it, and continue the pass — don't let one
  PR stop the rest.
- Review exactly one PR at a time: one subagent, wait, submit, next.
