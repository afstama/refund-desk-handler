# Decisions

Short entries. Bullets are fine. We read this before we read your code. A good one fits on one screen.

## 1. What did you find in `events.ndjson` or the docs that you had to handle?

List each thing you noticed and what you did about it.

- 4 bad signatures, 5 duplicates, 1 unknown event type - these were handled exactly as the POLICY and CONTRACT say.
- 12 signed but invalid events (```null```, ```"not-a-date```, etc.) - returned 200 with ```{"status": "dead_lettered"}``` and a reason for each
- Dirty values: ```" 18.40"```, ```11.4```, ```"13,40"``` are accepted, trimmed, and converted. ```" O-1112 "```, and ```"R-0081\n"``` are trimed, and only the refund reason is lowercased.
- The signature is over the raw bytes: bodies come in 3 formats (compact, compact plus a newline, pretty-printed) and one is 125 KB, so the exact bytes are verified and a very long message is cut before the model.
- Two prompt-injection messages are flagged and never answered.

## 2. Where were the documents unclear, or where did they disagree? What did you decide?

If you asked us, say what you asked and what we answered.

Questions I asked (answered by email):
- Currency conversion: Some orders are in USD or GBP, while the policy limit is in EUR. The answer was to convert at fixed rates. Another currency, or a refund in a currency different from its order’s, goes to a human.
- Malformed events (```null```, a list, ```type: 42```, missing fields) and dirty values: The question was where such events gfo, 400 or 2xx, and whther they count as unknown types. The answer was to never answer 500, to refuse with 400 or acknowledge with 2xx. They do not count as unknown types. The decision was to return 200 with ```{"status":"dead_lettered"}```. For dirty values, the anwser was to normalize oonly what is unambiguous. The decision was to trim whitespace, lowercase the refund reason, accept numbers after strict conversion to string, and refuse the decimal comma.
- Messages that fit into more than one category: The answer was that anything related to refunds is marked as ```refund_related```.

These are the decisions made without asking:
- The README says every refund ends up auto-approved, queued or rejected, and POLICY adds parked. POLICY wins.
- When there is a crrency mismatch between the order and the refund, the reason code is chosen as ```OVER_THRESHOLD``` , with the note ```currency_mismatch```. This decision is made to not disturb the accepted ledger values. The order goes to a human in any case.
- The policy only says an approval checks the balance again. If the order was cancelled while the refund was on screen, the approval gets 409 ```order_cancelled```.
- ```POST/outbound```. The contract lists only 200. It needs our signature and answers 401 without it, so a stranger cannot fake a sent reply.

## 3. What did you cut or simplify, and why?

- Fixed exchange rates, as per the email answer.
- Holding more messages than required: the decision was that it is better to be safe and hold more messages than send out any answers about a refund.
- One shared approver token, no lockout, a stateless 8-hour session: the simplest login that is safe.
- Plain HTML and a small script, no framework: for the sake of time.

## 4. What did one full replay cost in Claude API requests and dollars? How do you know?

- There were 83 requests to the model (one per valid ```message.received``` event, no retries) and the cost is their sum. The model costs were computed through the _usage_ field of the Anthropic API, which was multiplied with the official pricing.
- The cost of the full run was *$0.0145* (about $0.000175 per message) with *Haiku 5.5* as the selected model; 116,847 input tokens (about 1,408 per request) and 5,529 output tokens (about 67 per request). It took 76 seconds, limited by 45 requests per minute.
- Sonnet 5.5 was also tried as an option, and it cost $0.2877 (20x more than Haiku).
- Scaling to 50,000 events a day (assuming about 20% of them are messages) would cost about *$1.70* a day with Haiku and about *$34* a day with Sonnet.

## 5. What would you build next with another day?

- A queue in front of the database, in case of database outage.
- Held drafts on the screen, separate approver users and logins.
- Flood protection: a flood of unsigned requests grows dead_letter and the public ledger.

## 6. How did you use AI on this, and where did it get something wrong that you caught?

- Claude Code was used as an assistant accross all phases. It read the documents and the data, helped in brainstorming and creating the plan of implementation, wrote the code and tests, and prepared the deploy files. It never made any decision, it only presented options. It never commited or pushed and it never called the real Anthropic AI key.
- The AI sometimes parsed wrongly and created tests with wrong arithmetic. It caught its own mistakes through its own tests.
- It didn't check whether the header id matched the body id, and it decided parked refunds againts the order's final state, not the state at the time. This was corrected through workflow and code inspection.
- It made some design mistakes for the UI showing the refunds to humans. This was noticed during review and usage and corrected.
- The prompt the assistant wrote for the Claude triage was also corrected a couple of times to strenghten guardrails and safety.

## 7. Hours

Honest total, roughly split.

- 3h for analysis and planning
- 5h for implementation
- 1h for deploying and writing the report.
