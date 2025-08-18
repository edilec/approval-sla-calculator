# Approval SLA Calculator

`TOOL_ID=approval-sla-calculator`. Offline, read-only Node 22+ CLI with no dependencies. It calculates elapsed and business-minute approval SLAs from local versioned exports. It does not contact providers or write files.

```sh
node bin/approval-sla-calculator.mjs --root examples/pass --approvals approvals.json --policy policy.json
node bin/approval-sla-calculator.mjs --root examples/fail --approvals approvals.json --policy policy.json
```

The first command exits `0`; the second exits `1` because 90 business minutes exceed its 89-minute policy. `--help` describes the command. Standard output is one deterministic JSON report; bad usage writes only to standard error. Both input paths are relative to `--root`. Real paths must remain within the real root.

The export is `{ "schemaVersion":"1", "approvals":[...] }`. Each approval has `id`, `queue`, `owner`, `priority`, `requestedAt`, optional `completedAt`, and `pauses` as an array of `{start,end}` UTC or offset timestamps. Timestamps must include seconds and fall on whole minutes. Intervals are half-open. An open approval has no `completedAt`; the policy's explicit `asOf` ends its *accrued* time only. Pauses cannot extend outside the measured interval; overlapping pauses are unioned.

The policy contains `schemaVersion`, IANA `timeZone`, `weekdays` (Sunday=0 through Saturday=6), `businessHours` as local `HH:MM` start/end on one day, local `holidays` (`YYYY-MM-DD`), explicit `asOf`, and `slaMinutes` keyed by source priority. A minute is a business minute when its local calendar fields meet all three calendar conditions and it is not paused. Iterating real UTC minutes handles daylight-saving gaps and repeated hours. Elapsed minutes are raw clock duration; active elapsed minutes subtract unioned pauses. An SLA breach uses business minutes after pauses. Records and groups by queue, owner, and priority are emitted using ordinal source labels. Names and IDs are never printed; `sourceOrdinal` and `/approvals/N` point to the zero-based record in the exact input file.

| Rule | Severity | Meaning |
| --- | --- | --- |
| `input-unavailable`, `input-invalid`, `approval-limit`, `empty-export` | warning/incomplete | Source cannot be evaluated |
| `invalid-approval`, `duplicate-approval`, `span-limit`, `timeout` | warning/incomplete | Record or bound prevents reliable evaluation |
| `open-approval` | warning/incomplete | Completion outcome is still unknown at `asOf` |
| `sla-breach` | error/fail | Completed approval exceeds its priority's business-minute limit |

Exit `0` means `pass`, `1` means `fail`, and `2` means `incomplete` or invalid usage. Invalid usage has empty stdout; input read and parse failures yield an `incomplete` report. Findings use logical `@approvals` and `@policy` source roles and zero-based JSON pointers; no raw identifiers, paths, payloads, or parser messages are emitted.

Limits: 1 MiB per input file, 100 approvals, JSON depth 16, 31 days per approval, five seconds evaluation time. Exactly the bound is legal; N+1 is incomplete. The tool does not authenticate the export, infer missing pause ends, apply labor-law calendars, account for leap seconds, or claim a live service guarantee.
