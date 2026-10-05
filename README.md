# Homework — Refund Desk

A skincare brand's customer-support team handles refunds all day. You are building the service behind that work, and the one screen they do it on.

**The deadline is in your email. Pace yourself however you like.**

## Read these first

| File | What it is |
|---|---|
| `README.md` | This file. What to build and what to deliver |
| `POLICY.md` | The refund rules. Treat them as the law |
| `CONTRACT.md` | Exact endpoints, event format, and the ledger JSON you must return |
| `events.ndjson` | The exact deliveries (about 420) we will send to your service |
| `selfcheck.mjs` | A small smoke test you can run against your own service |
| `DECISIONS.md` | A template you fill in. We read it before we read your code |

## What to build

A web service with a single screen on top of it.

Order and support events arrive as webhooks — orders, deliveries, cancellations, customer messages, refund requests. The service takes them in, decides every refund it can decide on its own, uses Claude to triage the customer messages, and puts what is left on the screen for a human to rule on.

### Must have

- **A webhook endpoint**, `POST /webhooks`, that takes one event per request and verifies its signature
- **Refund decisions** — every refund request ends up auto-approved, queued for a human, or rejected, exactly as `POLICY.md` says, carrying the reason code that explains why
- **Claude triage on every customer message** — a category, a sentiment and a one-line draft reply, with the reply sent immediately by `POST`ing it to your own `/outbound` endpoint and recording it
- **An approval queue screen** — one page showing every refund a human has to rule on: which refund, which order, how much, why the policy could not decide it, and how much of that order is still refundable. Approve and Reject on each, both behind `APPROVER_TOKEN`
- **A state endpoint**, `GET /ledger`, returning every order, refund and message in the exact shape in `CONTRACT.md`. This is the first thing we look at
- **A live deploy URL** on your own free-tier account — Railway, Render, Fly, Vercel, your choice
- **`DECISIONS.md`** filled in, in the repo root. We read it before we read your code

`POLICY.md` is the law: where it and any other file disagree, it wins. `CONTRACT.md` has the exact paths, headers, status codes, event payloads and ledger shape.

## Rules that apply throughout

- **A refund is never paid twice.** Not by a duplicate delivery, not by two people approving at the same moment, not by the same person clicking twice.
- **Production sees about 50,000 events a day.** Do what you think is right about that.

## What you deliver

Reply to the homework email with:

1. **Live URL**
2. **[Loom](https://www.loom.com/), 5 minutes max**: what you built, what you cut, what the AI got wrong and how you caught it, and roughly how long it took you

Everything else we read in the repo, so push your commits as you go rather than as one drop at the end.

## How we grade

| What | How we look at it |
|---|---|
| Is the ledger correct? | Replay, then compare with the reference ledger |
| Does it survive bad input? | Duplicates, disorder, bad signatures, broken JSON, timeouts |
| Is it safe? | Auth on approval, untrusted message text |
| Did you make decisions, and can you explain them? | `DECISIONS.md`, questions you asked, the Loom |
| How you worked, and what you verified | The walkthrough |

Stack is your choice. We use TypeScript, React and Node.

## Questions

If something is unclear, or two documents disagree, reply to the homework email. Any time. Asking never counts against you.
