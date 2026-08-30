# Pitch deliverables

| Deliverable | File |
| --- | --- |
| Seven-minute presentation, editable with speaker notes | [tango-pitch.pptx](tango-pitch.pptx) |
| Shareable presentation PDF | [tango-pitch.pdf](tango-pitch.pdf) |
| Architecture and flow-map pack, editable | [tango-architecture-and-flows.pptx](tango-architecture-and-flows.pptx) |
| Architecture and flow-map pack, six-page PDF | [tango-architecture-and-flows.pdf](tango-architecture-and-flows.pdf) |
| Standalone technology architecture, PDF | [assets/tango-technology-architecture.pdf](assets/tango-technology-architecture.pdf) |
| Standalone technology architecture, PNG | [assets/tango-technology-architecture.png](assets/tango-technology-architecture.png) |
| Interactive architecture atlas | [index.html](index.html) |
| Responsibility and authority map, PDF | [assets/tango-architecture.pdf](assets/tango-architecture.pdf) |
| Responsibility and authority map, PNG | [assets/tango-architecture.png](assets/tango-architecture.png) |
| Spoken script, timings, judge questions and recovery plan | [rehearsal-guide.md](rehearsal-guide.md) |
| Project trade-offs | [../decision-log.md](../decision-log.md) |

## Which diagram to use

- **Technology architecture:** the technical pre-flight deliverable. It shows the actual deployment boundary: Twilio, OpenAI Realtime, Render backend/worker, Render dashboard and Supabase.
- **Responsibility and authority map:** useful in the pitch when explaining that the server, not the model, is the decision-maker.
- **Flow-map pack:** appendix/reference material for rehearsals and judge questions. It separates outbound sourcing, an inbound carrier change, a mandate change, cancellation and live escalation.

## Public, no-login link

The preferred browser view is the static **Architecture Atlas**. The repository deploys `docs/pitch/` to GitHub Pages with [the Pages workflow](../../.github/workflows/deploy-pitch-atlas.yml), so it will be available without a login at:

<https://mperezdegracia.github.io/ctrl-alt-ship/pitch/>

It includes the technology architecture, all five flow maps, direct PDF downloads and the explicit trial-by-fire cases. Check that URL once in a private browser window after publishing.

After these files are merged to the public `main` branch, share this direct PDF URL and verify it once in a private browser window:

<https://raw.githubusercontent.com/mperezdegracia/ctrl-alt-ship/main/docs/pitch/tango-pitch.pdf>

The supplementary architecture pack is also shareable after merge:

<https://raw.githubusercontent.com/mperezdegracia/ctrl-alt-ship/main/docs/pitch/tango-architecture-and-flows.pdf>

This is intentionally a direct file link: it does not require a Google account, a GitHub sign-in, or a presentation-app permission. The editable PPTX remains the presenter version because it contains the speaker notes.

## Before the final rehearsal

The deck uses an intentionally generic shipment story. The challenge brief uses a Mexico/MXN example, while the repository seed currently uses an Argentina/ARS fixture. Pick one version and align the spoken script, seed data and dashboard before the event; see the rehearsal guide for the exact check.
