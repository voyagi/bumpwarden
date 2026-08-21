# bumpwarden art direction

Locked 2026-08-21, second attempt. The first is kept at `ART-DIRECTION-retired.md` with the reason
it failed. Every page derives from this document. If a screen disagrees with this file, the screen
is wrong.

## 0. Who this is for, and what they already use

This direction is derived from the audience rather than from a period or a mood. The evidence was
pulled from the real, live stylesheets of three products this audience opens every week, on
2026-08-21.

| Product                                       | What it actually uses                                                                                                     | What it tells us                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Linear                                        | InterVariable, near-black `#08090a`, radii 5 to 8px, a token ladder of micro, mini, small, regular plus eight title steps | The quality bar this audience names out loud is quiet, dense and fast               |
| Sentry                                        | Rubik in four weights, a display face reserved for the brand layer, three separate monospace stacks                       | Personality is allowed, and it lives in the brand layer, not in the working surface |
| Aikido Security, the nearest category product | New Grotesk in five weights                                                                                               | The category reads as contemporary. Nothing retro, nothing decorative               |

**The finding that decided everything below:** in this category the working surface stays quiet,
dense and fast, and the personality belongs to the brand layer. A developer scanning a queue of
pending upgrades wants to finish, not to admire the furniture. The retired direction inverted this
by dressing the table people read every day in a costume, which is why it read as both dated and
interchangeable with the two products before it.

## 1. Anchor

**Measurement, published and checkable. The instrument is the argument.**

Not a place and not a period. The anchor is a discipline: the way a trustworthy measurement is
presented, where the scale, the thresholds and the method are shown next to the reading so the
reader can check the work rather than take it on faith.

Why it belongs to this product specifically. bumpwarden's one sharp claim is that the verdict is
arithmetic from a published rubric and the machine only explains. Every competitor hides its
number. Renovate's Merge Confidence algorithm is private. Dependabot's compatibility score is a
percentage with no method attached. So the product's differentiator and its visual system are the
same thing: show the scale, mark the thresholds, place the reading on it, and let anyone audit the
sum. That cannot be lifted onto another product, which is the test that the retired direction
failed.

## 2. The colour law

**Colour means risk. Nothing else in this product is coloured.**

The wordmark, the navigation, the type, the rules, the chrome and the buttons are monochrome. The
only saturated pixels on any screen belong to a score, a band, or a factor's contribution to a
score. Follow this and the eye is pulled only toward something that earned it, which is exactly
what a triage tool is for.

This is also the reason there is no brand accent colour. A brand blue sitting next to a risk red
would teach the eye that colour is decoration. It is not.

| Name   | Hex       | Role                                       |
| ------ | --------- | ------------------------------------------ |
| Ground | `#FAFAF9` | Page background                            |
| Panel  | `#FFFFFF` | Reading surfaces                           |
| Ink    | `#14181B` | Primary text, the wordmark, the total rule |
| Ink 2  | `#5A6469` | Secondary text                             |
| Ink 3  | `#8B959A` | Labels, axis annotations, spent factors    |
| Rule   | `#E6E8E7` | Borders                                    |
| Rule 2 | `#F0F2F1` | Row separators                             |
| Risk 0 | `#0F766E` | Clear, the low end of the ramp             |
| Risk 1 | `#4D7C3F` | Ramp step                                  |
| Risk 2 | `#B7791F` | Caution                                    |
| Risk 3 | `#C2410C` | Caution wording, factor bars               |
| Risk 4 | `#B91C1C` | Held, the high end of the ramp             |

The five risk values are a continuous ramp, not five badges. A score sits somewhere along it, and
the band words Clear, Caution and Held name where. Contrast is measured, not asserted, before this
ships: every risk value must reach at least 4.5 to 1 against Panel at text size, and any value used
only as a bar or a pin must still reach 3 to 1.

## 3. Type

Three families, all free, self hosted at build time. Never Inter, Roboto, a system stack, or Space
Grotesk. None of these were used in the retired direction.

| Role                                                  | Face                                      | Why                                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Display: headlines, the wordmark, card titles, totals | **Funnel Display** (OFL), `wght 300..800` | Carries the whole brand layer on its own. Distinctive without being costume, and tight enough at large sizes to hold a real headline |
| Interface: body, rows, labels                         | **Figtree** (OFL), `wght 300..900`        | Quiet, wide aperture, reads cleanly at 13 to 15px in a dense table                                                                   |
| Data: versions, scores, timestamps, rule ids          | **JetBrains Mono** (OFL), `wght 100..800` | Version strings and scores must align in a column, and it is the face this audience already reads all day                            |

Scale, in px because this is an interface and not a document: 10.5 label, 12 mono meta, 13.5 dense
body, 15 body, 16.5 lede, 19 total, 24 card title, clamp(29, 4vw, 46) headline. Tracking tightens
as size grows: -0.035em on the headline, -0.025em on the wordmark, 0 on body, +0.1em on uppercase
labels. Uppercase is for labels only and never for body text.

## 4. Structure

**Home and Project.** A short headline states the run in words, because the first thing a person
wants is the count. Then the one element nothing else in this category has: **the spread**, every
pending bump in the run placed as a pin on a single 0 to 100 axis, with the two band thresholds
marked at 30 and 61. The shape of the run is legible before a single row is read. Pins alternate
between two lanes so labels never collide, and the axis scrolls sideways inside its own panel on
narrow screens rather than being dropped, because it keeps its meaning at any width.

Below it the queue is a plain dense list, one row per bump: dependency, the move in mono, one line
of why, then the score as a numeral plus a track carrying the same two threshold ticks as the
spread. The same measurement appears twice at two scales, which is what makes the system feel like
one instrument rather than a page of widgets. No cards in the queue. No status pills.

**Bump detail.** Two surfaces. On the left the explanation, under a permanent label reading
"Machine explanation, not verdict", where each claim is a code line followed by the quoted source
that justifies it and a link to it. On the right the arithmetic: every factor, its points, a bar
proportional to its contribution, spent factors greyed at zero rather than hidden, and a total ruled
off in Ink. A reader can add the column up.

**Rubric.** The same factor table, published, versioned, read only. **Audit.** The same dense row
rhythm as the queue, newest first. **About.** The architecture diagram, where the model branch
visibly stops at the explanation and only the policy-controlled actor reaches GitHub.

### Motion

Restrained and quick, because this is a tool. Rows and links change state in 120ms on
`cubic-bezier(0.2, 0, 0, 1)`. The spread's pins and every score track animate from zero to their
value once on first paint over 420ms, staggered by 18ms, because a measurement arriving is worth
seeing once. Nothing else moves. Nothing animates because it scrolled into view. A run in progress
advances only when a real stage event arrives, never on a timer.

Under `prefers-reduced-motion: reduce` every duration collapses to 1ms, pins and tracks paint at
their final value, and run state is carried by the words plus the elapsed time.

## 5. Real media

There is no photography, no illustration of people and no abstract decoration, but for a reason
that is now the opposite of the retired direction's: the data is genuinely the most interesting
thing on the screen, so it gets the space.

1. **The spread and the score tracks**, drawn from live values. These are the product's images.
2. **The factor waterfall**, the arithmetic shown as proportional bars.
3. **Real upstream text**, verbatim release note excerpts quoted next to the claim they support,
   each with a link to its source, and marked as unreadable when it could not be fetched.
4. **Real product surfaces**, cropped screenshots of the actual issue and pull request bumpwarden
   opened on the demo repository.
5. **One drawn diagram**, the architecture schematic on About, which is also the submission's
   architecture image.

## Why this is not the default, and not the house style

The default answer for a dependency tool is a table of rows with a coloured status pill per row.
Every competitor ships it. This replaces the pill with a position on a published scale, at two
different scales on the same screen, and spends its only colour on that.

The harder check, which the retired direction failed: **would this have suited the previous two
products?** No. The spread only means something when many items share one scored scale, which is
true here and is not true of an investigation timeline or a call queue. The colour law only works
when a product has exactly one thing worth colouring. That is what makes this derived rather than
borrowed.

## Banned in this product

Status pills. Card grids. A brand accent colour competing with risk colour. Gradients as
decoration, the ramp is the only gradient and it encodes a scale. Glassmorphism. Emoji as icons.
Stock photography. Gradient text. Nested cards. Bounce easing. Anything animating on scroll.
Placeholder copy of any kind, dummy Latin included. And the whole retired recipe: a mid-century
operations setting, a dark ground with a warm cream reading surface, and an interface pretending to
be a physical panel.

No em dashes or en dashes in any copy this product ships.
