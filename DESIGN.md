---
name: Tango Dispatch Ledger
description: An English-only freight-operations interface built as a calm, verified traffic book.
colors:
  ink: "#15222A"
  ink-soft: "#486A76"
  paper: "#F2EFE8"
  paper-deep: "#E5DFD3"
  copper: "#B76E31"
  line: "#C8C9BF"
  danger: "#A63E3A"
  success: "#30684B"
typography:
  display:
    fontFamily: "Source Serif 4 Variable, Georgia, serif"
    fontSize: "clamp(3.5rem, 7.3vw, 6.9rem)"
    fontWeight: 560
    lineHeight: 0.86
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Manrope Variable, sans-serif"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Manrope Variable, sans-serif"
    fontSize: "0.66rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "0.08em"
rounded:
  none: "0"
spacing:
  compact: "0.75rem"
  standard: "1.25rem"
  section: "clamp(3rem, 6vw, 5.5rem)"
components:
  action-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
    padding: "0.8rem 1rem"
  escalation-ticket:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
    padding: "clamp(1.4rem, 3vw, 2.5rem)"
  register-row-escalated:
    backgroundColor: "#EEE7DC"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "1.15rem 1rem 1.15rem 0"
---

# Design System: Tango Dispatch Ledger

## Overview

**Creative North Star: "The Dispatch Ledger"**

Tango is a working traffic book for a freight supervisor: composed, factual, and ready for interruption. The interface makes verified operational state easy to scan without visualizing logistics as decoration. It is English-only, even when the freight context or source data is local.

Its pages read as documents, not dashboards made from KPI cards. Editorial display type establishes the report; compact sans-serif labels and tabular figures carry the evidence. A live escalation is a held ticket with the strongest visual claim on the page, while open work is a ruled register and a route detail is a dossier arranged by mandate, booking, and commitments. The interface summarizes verified facts; it never substitutes a raw call transcript for the operational record.

**Key Characteristics:**

- Ivory paper and blue-black ink create a calm, archival operating surface.
- Fine rules, not rounded card chrome, establish grouping and hierarchy.
- Copper identifies durable references and timestamps; semantic status color remains purposeful and scarce.
- Large serif titles set the editorial register; Manrope keeps operational data compact and legible.
- Dense data remains calm through fixed label rhythm and tabular numerals.

## Colors

The palette behaves like a printed operational ledger: paper and ink do most of the work, while copper and semantic colors annotate only what needs attention.

### Primary

- **Blue-Black Ink:** the principal reading color for headings, decisive rules, and primary actions.
- **Copper Reference:** the verified-reference accent for operation identifiers, version markers, and timeline timecodes.

### Secondary

- **Soft Blue Annotation:** subdued supporting text for route context, explanatory copy, labels, and secondary navigation.

### Neutral

- **Ivory Paper:** the default page field and light action text, giving the system its physical paper quality.
- **Deep Paper:** a restrained tonal variant for a selected or held register row.
- **Ledger Rule:** the standard divider between records, fields, and sections.

### Named Rules

**The Copper Evidence Rule.** Copper marks references, versioning, and time evidence—not general decoration, success, or calls to action.

**The Semantic Exception Rule.** Red identifies a live escalation or follow-up requirement; green identifies a confirmed state. Neither becomes a broad page accent.

## Typography

**Display Font:** Source Serif 4 Variable (with Georgia fallback)

**Body Font:** Manrope Variable (with sans-serif fallback)

**Character:** Source Serif 4 gives the system the authority of a formal traffic record. Manrope is the operational hand: narrow, durable, and clear at the small sizes required by a register.

### Hierarchy

- **Display** (560, `clamp(3.5rem, 7.3vw, 6.9rem)`, 0.86): broad page and dossier titles only.
- **Headline** (560, `clamp(1.8rem, 2.4vw, 2.65rem)`, 0.98): live escalation subject and major section titles.
- **Title** (560, `clamp(1.7rem, 2.5vw, 2.4rem)`, normal): ledger section headings, booking summary values, and paired dossier headings.
- **Body** (400, `0.82rem`, 1.5): facts, context, and operational prose; use Soft Blue Annotation when it is supporting information.
- **Label** (800, `0.66rem`, 1.2, `0.08em`, uppercase): table headers, field labels, status treatments, and report metadata.

**The Figure Discipline Rule.** Dates, times, references, and prices use tabular figures (`font-feature-settings: "tnum" 1`) so columns and event histories remain visually dependable.

## Layout

The dashboard holds content within a broad report column (up to 88rem) and uses the page edge as an editorial margin. Header, page title, escalation, table, and dossier sections are separated by horizontal rules. Space grows by section rather than by container padding, with compact record rows (`1.15rem` vertical padding) and generous section intervals.

On desktop, the live escalation uses a three-part held-ticket layout: live state, decision context, and action. Dossier facts use paired columns, then expand into a full-width booking and commitment history. At 760px and below, titles, escalation content, booking fields, and dossier facts stack in source order; the register retains its minimum readable width and scrolls horizontally rather than collapsing its columns into ambiguous cards.

## Elevation & Depth

This is a flat paper system. There are no ambient card shadows or floating panels. Depth comes from the contrast between ivory paper and the blue-black held escalation, from selected-row paper tone, and from the cadence of rules. The live status dot may use a restrained halo solely to convey immediacy.

**The Rule-First Depth Rule.** Establish a relationship with a border or typographic interval before considering a fill; shadows are not part of the ledger language.

## Shapes

The geometry is square and documentary. Surfaces, actions, fields, rows, and sheets use zero radius. Rules are 1px; the only circular form is the small live indicator. Avoid decorative containers, pills, soft rounded controls, and dashboard-card silhouettes.

## Components

### Actions

- **Character:** terse, ink-stamped instructions.
- **Primary:** Blue-Black Ink field with Ivory Paper type and square corners; it is reserved for an immediate operational action such as reviewing an escalation.
- **Hover / Focus:** hover shifts the fill to Copper Reference; keyboard focus uses the project’s copper-adjacent visible outline without changing the documentary shape.
- **Secondary:** underlined ink or Soft Blue Annotation text actions, with a deliberate underline offset rather than a button boundary.

### Ledger Header

- **Style:** a simple ruled header with Tango wordmark at left and supervisor identity/actions at right.
- **Typography:** compact Manrope metadata; the header never competes with the editorial page title.
- **Responsive behavior:** identity aligns beneath or beside actions as space contracts, retaining clear sign-out access.

### Live Escalation Ticket

- **Style:** a full-width held record, not a dismissible alert or card.
- **Dashboard treatment:** paper field divided by a strong lower rule; red live status, copper operation reference, serif decision subject, and a single ink action.
- **Dossier treatment:** inverse Blue-Black Ink field with Ivory Paper body text, three ruled facts, and a restrained red live indicator.
- **Content rule:** explain the verified conflict, requested change, authorized constraint, and operator handoff. Do not show raw conversation transcript.

### Operations Register

- **Style:** a semantic table with uppercase labels, a firm header rule, and one ledger rule per operational row.
- **State:** the escalated row receives Deep Paper tone and a 3px inset Danger rule on its leading edge; other status colors remain text-only.
- **Data:** operation reference and destination carry stronger ink weight; status labels, timestamps, prices, and dates use tabular figures where applicable.

### Dossier Facts and Commitments

- **Facts:** definition-list rows pair a compact uppercase label with an ink value, separated by ledger rules.
- **Booking:** three summary fields form a ruled strip before relevant quote comparison.
- **Commitments:** an ordered, time-led history where Copper Reference timecodes anchor confirmed operational milestones.

## Do's and Don'ts

### Do:

- **Do** give the live escalation the first and strongest operational position, before the wider list of open operations.
- **Do** use Source Serif 4 for titles and decision subjects; use Manrope for all operational facts, labels, and controls.
- **Do** preserve English product language throughout the UI, including statuses, labels, and simulated data.
- **Do** describe verified mandate, booking, quote, and commitment facts in a clear hierarchy.
- **Do** use 1px rules and editorial whitespace to organize information before adding a fill.

### Don't:

- **Don't** turn the dashboard into KPI cards, rounded widgets, or a generic logistics control room.
- **Don't** use copper as a general-purpose brand wash or use semantic red/green outside meaningful state.
- **Don't** replace the route dossier with a raw call transcript or unstructured conversational log.
- **Don't** sacrifice data alignment: prices, dates, references, and times must use tabular figures when they appear in a series.
- **Don't** hide table structure on small screens by restyling rows as cards; retain a readable register with horizontal overflow when needed.
