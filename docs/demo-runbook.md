# Demo runbook

This is the single source for the judge-facing run. It distinguishes checks we
can automate from the two things that inherently need a phone: a carrier
answering and a human accepting a transfer.

## One-command clean start

On a fresh clone, put the team's server-only values in `backend/.env` and the
browser-safe values in `frontend/.env.local`. Use the tracked example files as
field names; never commit either local file.

Then run:

```bash
npm run demo:prepare
```

It installs both applications from their lockfiles, validates migrations and
TypeScript, exercises the routing/mandate/quote/escalation contracts, lints and
builds the dashboard, verifies the shared Supabase schema, idempotently
prepares `OP-900001`, and checks the deployed runtime health endpoint. It does
not prompt, open the dashboard, send an SMS or email, or place a phone call.

The command must finish with all harnesses passing and with `Seed completo`.
If it fails, do not start the live demo: fix the failed dependency and run the
same command again.

The seeded story is **Textiles del Plata, Terminal 4 to Gonzalez Catan, ARS
950,000 maximum**. The judge-facing dashboard URL is
`<dashboard-url>/dashboard/operations/OP-900001`; open it and authenticate
before the timer starts. Once the run starts, nobody needs to type in Tango.

## Live sequence

1. Start from the prepared operation page. Point out the mandate, quotes and
   live-update indicator.
2. Make the registered provider call in and request an allowed pickup-window
   change. Tango records a successor booking; the original remains historical.
3. From that same registered number, ask for a price above the mandate or a
   pickup window outside it. Add urgency. Tango must not create a booking or
   silently approve the change. It persists an escalation, then transfers only
   after the caller confirms the handoff.
4. Let the supervisor take the call. The dashboard shows the verified summary,
   requested action, mandate and recipient selected from Directory data.

The active transfer target comes from `handoff_recipients`, not an environment
variable or source code. Before the run, use Directory to confirm that one
active recipient is reachable. Argentine mobile outbound destinations use the
mobile `9`; inbound caller IDs stay stored exactly as received.

## Trial-by-fire register

| Judge move | Expected behaviour | Automated evidence | Live evidence |
| --- | --- | --- | --- |
| Calls from an unregistered number | SIP rejection; no conversational session and no mutation. | `inbound:routing` | Optional: call the number once before the pitch. |
| Asks for a pickup change inside the action window | A new, immutable booking succeeds and the prior booking stays in history. | `harness:tools:bookings` | Timeline refreshes on `OP-900001`. |
| Pushes price above the cap or requests a window outside authority | No commitment; a durable escalation is created with verified context. | `harness:quotes:above-budget`, `harness:escalation:triggers` | Escalation panel appears before the handoff. |
| Interrupts or changes mind during the farewell | The transfer is disarmed; Tango asks again instead of transferring accidentally. | `harness:escalation`, `harness:realtime:agents` | Say “stay with Tango” before confirming the transfer. |
| Carrier does not answer | No quote is fabricated; the durable sourcing job is retried or remains recoverable. | `harness:sourcing` | Show the pending request rather than claiming success. |
| The human does not answer | Escalation remains open; no approval is inferred. | `harness:escalation` | Show the persisted escalation and recovery line. |

## Under-seven-minute rehearsal

Use [the pitch rehearsal guide](pitch/rehearsal-guide.md) for the spoken
script. Run three timed passes: narrative (6:15), happy path (6:35), and hostile
judge (6:50). The pitch ends at 6:50 to leave ten seconds of buffer.

If a service fails, show the actual prepared record and say that it is the
fallback. Do not represent a recording, transcript or transfer as live unless
it just happened.
