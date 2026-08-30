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

The same Pages deployment also exposes a browser-controlled slide deck at:

<https://mperezdegracia.github.io/ctrl-alt-ship/pitch/presentation.html>

Use the direct PDF below as the universal fallback: it is stable, printable and
does not depend on a presentation-app login.

After these files are merged to the public `main` branch, share this direct PDF URL and verify it once in a private browser window:

<https://raw.githubusercontent.com/mperezdegracia/ctrl-alt-ship/main/docs/pitch/tango-pitch.pdf>

The supplementary architecture pack is also shareable after merge:

<https://raw.githubusercontent.com/mperezdegracia/ctrl-alt-ship/main/docs/pitch/tango-architecture-and-flows.pdf>

This is intentionally a direct file link: it does not require a Google account, a GitHub sign-in, or a presentation-app permission. The editable PPTX remains the presenter version because it contains the speaker notes.

## Before the final rehearsal

The repository's demo story is **Textiles del Plata / Terminal 4 → González
Catán / ARS 950,000**. Keep the spoken script and dashboard on that story. If a
judge references the challenge's Mexico/MXN illustration, describe it as an
alternative scenario; do not mix its amounts with the live record.
