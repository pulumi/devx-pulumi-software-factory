# Triage evaluation (live Jev + live Factory)

Date 2026-10-09. Real calls: Jev (`api.typesafe.ai`, `jev-latest`) and the deployed Factory (`my-org/factory/dev`), project `triage-eval`, brief = `factory-prompt.md` ("Build a simple web instant messenger application in Vite and Node.JS ... websockets"). Harness: `scripts/triage-eval.sh [--apply]`.

## The five issues and what Jev said (dry-run, 3 repeat runs after the final context design)
| Issue | Intended | Jev decision (confidence across runs) | Policy action |
|---|---|---|---|
| Add a typing indicator that shows when another user in the session is typing | clear feature | accept 0.73 / 0.77 / 0.77 (0.61 before widening the accept criterion) | needs-human at threshold 0.8; **advance** at 0.7 |
| Messages sent while the websocket is reconnecting are silently lost; queue and resend them | clear bug | accept 0.95-0.97 | advance |
| Show a 'user is typing...' hint when someone else in the chat is typing | duplicate of #1 | reject 0.70 / 0.73 / 0.76 while #1 was still in *intake*; **reject 0.85, reason `duplicate`** once #1 was in `planning` | needs-human at 0.8 while #1 was in intake; **reject (duplicate)** after |
| Migrate the company payroll system to SAP | out of scope | reject 1.00, reason `out_of_scope` | reject |
| Make it better | vague | needs_info 0.94-0.95 | needs-human |

## Final applied run (`--apply`, thresholds accept 0.7 / reject 0.8)
Resulting Factory stages: feature -> `planning`, bug -> `planning`, duplicate -> `canceled` (metadata reason `duplicate`), payroll -> `canceled` (`out_of_scope`), vague -> stays in `intake` with `metadata.triage.needsHuman=true`. No errors, and a repeat pass touched only the 3 items that were still in intake.

## Measured latency
Jev call latency over ~25 live calls: 74-307 ms (median roughly 100 ms). This is our own measurement from a laptop through the internet to `api.typesafe.ai`, not the vendor figure.

## What changed because of this evidence
1. Context now includes titles of OTHER open issues (Jev cannot see duplicates otherwise).
2. Duplicates are judged only against EARLIER work (created before the issue, or already past intake). Without this, two copies each flagged the other as a duplicate and neither was accepted.
3. The `accept` criterion text was widened (clear specific change to the app: 0.61 -> ~0.75).
4. `buildState` clips body/brief separately so the project-status section is never truncated (unit test found this).
5. Thresholds set asymmetrically: **accept 0.7, reject 0.8** (closing an issue is the destructive action).
6. Reject = patch `metadata.triage` then transition to `canceled` using the revision returned by the PATCH (a PATCH bumps `revision`; a stale transition returns HTTP 409, now handled as a normal retryable outcome).

## Honest limits
- n = 5 issues, hand-written by us, and the criteria wording and thresholds were tuned on this same set. Do not read these as accuracy numbers; they show the mechanism works and how Jev's confidence behaves, nothing more.
- Jev confidence is a spread-of-probabilities measure, not a calibrated accuracy.
- A duplicate is only caught reliably (0.85) once the original is already in the pipeline; two near-simultaneous duplicates in intake land in `needs-human`.
- Human approval and merge stay with the team: triage only advances to `planning`, cancels, or flags.
