# bumpwarden art direction

Locked 2026-08-21. Every page derives from this document. If a screen disagrees with this file,
the screen is wrong.

Two directions were drawn and rendered as working pages before this was locked: a 1960s electric
route panel in panel blue and instrument white, and the mechanical lever frame below. The panel
version was clear and competent and looked like every other operations product, so it lost. Its
best ideas were kept and are marked where they appear.

## 1. Anchor

**The mechanical signal box: a lever frame, its locking table, and the printed notice board,
read through the 1965 British Rail corporate identity.**

Not railways in general. Specifically the pre-electric box, where a signalman pulls painted steel
levers and a mechanical interlocking makes a conflicting movement physically impossible, and where
the rule that forbids it is written out in a locking table anyone can read.

That is this product's claim, not a costume. bumpwarden says the verdict is deterministic and the
machine only explains. A signal box is the oldest working example of exactly that: authority is
granted by a published rule, not by judgement, and the rule is auditable. The vocabulary already
matches. A three aspect signal shows green for clear, yellow for caution and red for danger
([Railway News](https://railwaynews.net/wiki/railway-signal-colours-aspects-meaning-explained)),
which is bumpwarden's three bands. A lever frame is colour coded by what each lever controls, red
for stop signals, yellow for distant signals, black for points, blue for facing point locks, brown
for gate locks, white for spare
([WBS frame](https://www.wbsframe.mste.co.uk/public/Lever_Colours.html)), which is colour as
published meaning rather than decoration. The 1965 identity supplies the typographic discipline:
one standardised colour and one lettering system across an entire network, set down in a four
volume manual by the Design Research Unit
([Wikipedia](https://en.wikipedia.org/wiki/British_Rail_Corporate_Identity_Manual)).

Victorian mechanism, 1965 typography. That pairing is the anchor.

## 2. Type

Three families, all free and self hosted at build time. Never Inter, Roboto, a system stack, or
Space Grotesk.

| Role                                                 | Face                                                                                                                                 | Why                                                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Display: page titles, lever plates, dependency names | **Archivo** (OFL, Omnibus Type, Héctor Gatti and team), variable `wdth 62..125`, `wght 100..900`                                     | Drawn for highlights and headlines and reminiscent of late nineteenth century American grotesques, which is the register of a cast plate. The width axis is what makes a plate read as stamped rather than typed. |
| Interface: body, tables, controls                    | **Overpass** (OFL, Delve Withrington and Dave Bailey)                                                                                | Drawn from the Highway Gothic series, so it carries transport lettering DNA with wide apertures that survive small sizes in a dense frame.                                                                        |
| Data: versions, scores, timestamps, rule ids         | **Overpass Mono** (OFL)                                                                                                              | Same skeleton as Overpass, so a version string beside prose does not break the line. Tabular by construction.                                                                                                     |
| Notices: the generated brief, quoted upstream text   | **Newsreader** (OFL, Production Type, commissioned by Google Fonts for longer-form on-screen reading), `opsz 6..72`, `wght 200..800` | The brief is somebody else's words pinned to a board, and a book serif says that before you read a word of it. The optical size axis keeps a quoted excerpt readable at 15px and a heading right at 22px.         |

Scale, root 16px, tabular numerals on everywhere numbers line up:

| Token       | Size             | Use                                    |
| ----------- | ---------------- | -------------------------------------- |
| `--t-plate` | 0.6875rem (11px) | plate captions, column heads, eyebrows |
| `--t-meta`  | 0.8125rem (13px) | table meta, versions, timestamps       |
| `--t-body`  | 0.9375rem (15px) | interface body                         |
| `--t-lead`  | 1.0625rem (17px) | lede, notice body                      |
| `--t-head`  | 1.375rem (22px)  | section heads                          |
| `--t-page`  | 2rem (32px)      | page title                             |
| `--t-board` | 3.25rem (52px)   | board title                            |
| `--t-score` | 5rem (80px)      | the score numeral on bump detail       |

Line height 1.1 on display, 1.45 on body, 1.3 in tables. Weights: Archivo 700 for plates and
titles, 800 only for the score numeral. Overpass 400 and 600, nothing lighter.

Case: uppercase with 0.14em to 0.18em tracking on plates, column heads and eyebrows only. Sentence
case everywhere else. Body text is never uppercase. Package names, versions, paths and rule ids are
reproduced exactly as their source spells them.

## 3. Palette

One dominant colour, the deep green a lever frame and a box interior are painted, with brass,
enamel bone, and the three lamp colours as sharp accents.

| Name          | Hex       | Role                                                             |
| ------------- | --------- | ---------------------------------------------------------------- |
| Frame Green   | `#14352B` | dominant. The rail, the block shelf, the score plate, buttons    |
| Night Block   | `#0C201A` | the dark theme field, the box after dark                         |
| Enamel Bone   | `#F2E9D8` | the light theme field, and all text on green                     |
| Bone Muted    | `#B9A98C` | secondary text on green                                          |
| Brass         | `#C9922E` | rules, dividers, cast number plates, focus rings, links on green |
| Brass Dim     | `#8A6A2A` | heavier rules and plate shading                                  |
| Points Black  | `#1A1A17` | text on bone, and on amber and clear fills                       |
| Lock Blue     | `#2C5C8A` | links on bone only, and the model spur in the schematic          |
| Stop Red      | `#B22B21` | red band, held                                                   |
| Distant Amber | `#E2A008` | amber band, caution                                              |
| Clear Lamp    | `#2E9E6B` | green band, clear                                                |

Measured contrast, WCAG 2.1 relative luminance, computed rather than estimated:

| Pair                          | Ratio   | Verdict      |
| ----------------------------- | ------- | ------------ |
| Enamel Bone on Frame Green    | 11.07:1 | AAA          |
| Bone Muted on Frame Green     | 5.79:1  | AA           |
| Brass on Frame Green          | 4.85:1  | AA           |
| Enamel Bone on Night Block    | 14.08:1 | AAA          |
| Points Black on Enamel Bone   | 14.47:1 | AAA          |
| Lock Blue on Enamel Bone      | 5.80:1  | AA           |
| Points Black on Distant Amber | 7.70:1  | AAA          |
| Points Black on Clear Lamp    | 5.17:1  | AA           |
| Enamel Bone on Stop Red       | 5.34:1  | AA           |
| Stop Red on Frame Green       | 2.07:1  | **unusable** |
| Lock Blue on Frame Green      | 1.91:1  | **unusable** |

Two rules fall directly out of those numbers, and they are not stylistic:

1. **A verdict colour is always a fill, never text on the green field.** Stop Red as lettering on
   Frame Green is 2.07:1. So a verdict appears as a lamp disc, a lever body, or a filled tag, and
   the lettering on that fill is Points Black on amber and clear, Enamel Bone on red.
2. **Links on the green field are Brass, not Lock Blue.** Lock Blue on green is 1.91:1. Lock Blue
   is a bone field colour only.

**Nothing is carried by colour alone.** Every score prints a keyed 0 to 100 track underneath it,
ticked at the two band thresholds, 30 and 61, so the band survives greyscale and colour vision
deficiency. Every verdict tag also spells its word. (Kept from the rejected direction.)

## 4. Structure

### The skeleton

Every page is the same instrument, seen from a different angle. There is no hero, no
three-feature row, and no card grid anywhere in this product.

**The lever rail** runs down the left on desktop, 84px wide, painted Frame Green with a brass floor
plate. One lever per watched repository, each a brass ball on a painted shaft with a cast brass
number plate, plus one white spare lever that adds a repository. The shaft colour is the worst
verdict currently open in that repository, so the rail is a status display and the navigation at
once. Hovering or focusing throws the lever seven degrees. Below 900px the rail becomes a
horizontal frame stuck to the bottom edge, scrolling sideways.

**The block shelf** runs across the top, at least 92px, Frame Green with a brass underline. It
carries the wordmark on the left and then the instruments for whatever page you are on: line state,
last run, next run, rubric version. At the right end sit the three lamps, real discs with a warm
bloom, each with its count and its word. This is what a normal site would spend on a hero.

**Home** is the illuminated diagram. Watched repositories are drawn as track sections along one
horizontal line, each with its name, its bump count, its run time and three aspect pips, followed
by a dashed spare section. Under the line is a brass sleeper rail, and under that the Register: a
ruled table of the most recent actions, with the rule id set in a brass chip.

**Project** is the lever frame itself. The queue is not a table of rows, it is a frame of levers:
one full width bar per bump, 12px of verdict colour down its left edge, a cast plate carrying its
position number, the dependency in Archivo with a one line reason under it, the version move in
Overpass Mono, the score with its keyed track, and the action taken as an enamel tag. Hovering
slides the bar six pixels right, the way a lever moves before it locks. Above the frame, the
filter is a real signal head: a black backboard with three lenses that light when their aspect is
shown.

**Bump detail** is the locking table and the notice. The score sits on a Frame Green plate at the
right with its band, its rule text and its rubric version, and the action log stacks under it and
stays with you as you scroll. (Kept from the rejected direction.) The main column is the locking
table: one row per factor, each with its evidence link and a Locks column stating what that factor
forbids, closed by a double brass rule and the total. Below it, the generated brief is a notice
pinned to the board, a bone rectangle with two brass fixing dots, set in Newsreader, carrying the
permanent label **Machine explanation, not verdict**. (Kept from the rejected direction.) Upstream
quotes are italic behind a brass bar, and every claim about this repository is a code line with its
file and line number behind a red bar.

**Audit** is the train register, ruled in brass on bone, newest first. **Policy** is the rule book:
the factor table, then the three bands as three lever bars, then the standing rule that bumpwarden
never merges. **About** is the track schematic, which is the same SVG that ships in `docs/` for the
submission. The model sits on a spur off the main line and the spur ends in a red buffer stop,
because the agent holds no GitHub tool and cannot reach the actor. (Kept from the rejected
direction.)

### The motion grammar

Mechanical, weighted, short. Nothing elastic, nothing that eases in and out like a fade.

| Movement    | Duration | Curve                              | What moves                                              |
| ----------- | -------- | ---------------------------------- | ------------------------------------------------------- |
| Lever throw | 160ms    | `cubic-bezier(0.34, 0.9, 0.28, 1)` | levers rotate, queue bars slide, buttons lift           |
| Lamp strike | 220ms    | `cubic-bezier(0.4, 0, 0.2, 1)`     | a lamp's bloom rises like a filament, never cross fades |
| Board step  | instant  | none                               | the run advances one section per completed repository   |

The running board steps discretely. It advances only when a real stage event arrives, never on a
timer and never as a smooth interpolation, so the shelf cannot report progress the run has not
made. (Kept from the rejected direction.) There are no page transitions: navigation is instant,
like throwing a lever. Nothing animates merely because it entered the viewport. There is no
parallax anywhere in this product.

Under `prefers-reduced-motion: reduce`, every transition collapses to 1ms, levers change state
without rotating, bars do not slide, and lamps change colour with no bloom animation. The running
state is then carried by the words RUNNING, the current stage and the elapsed time.

## 5. Real media

The evidence is the image. There are no photographs, no illustrated people, no abstract shapes and
no decorative gradients anywhere in this product.

1. **Real data, at full size.** The locking table, the score numerals, the version moves, the
   register. All of it read from the live store, never sample rows.
2. **Real product surfaces.** Cropped screenshots of the actual issue and pull request bumpwarden
   opened on `voyagi/bumpwarden-demo-app`, shown on Home and About as what it produced.
3. **Real upstream text.** Verbatim release note excerpts and commit subjects, typeset as notices,
   each with a link to its source. When a note cannot be read, the page says so and scores it as
   missing. It is never paraphrased into something that looks retrieved.
4. **Drawn for this product, flat vector, two colours.** The signal aspect plates, the lever and its
   cast number plate, the brass fixing dots, the sleeper rail, and the track schematic on About
   which doubles as the submission's architecture diagram.

## Why this is not the default

Handed this brief, the obvious answer is a dark control room: near black, monospace throughout, one
acid green accent, a grid of rounded metric cards and a status pill per row. That is exactly what
[oxide.computer](https://oxide.computer) already ships in its stylesheet, `#080f11` with a single
`#00d497`, and it is what the rejected direction drifted toward in a lighter key. It reads as
machine made because every operations product has converged on it.

This one puts a painted deep green and warm enamel bone at the centre, with brass and lever red, and
uses a transport grotesque rather than a monospace as its main voice. More to the point, the
skeleton has no dashboard equivalent: a lever frame whose positions and colours already mean what
the product means, a locking table that states what each factor forbids, and a printed notice for
the part a machine wrote. Swap the palette out and it is still not a template, because the objects
themselves are the argument.

## Reference DNA

Every choice traces to one of these, and each mechanic below was read out of the site's own
stylesheet on 2026-08-21 rather than remembered.

- **[The Pudding](https://pudding.cool)**. Atlas Grotesk, Tiempos Text, Gooper SemiCondensed, Atlas
  Typewriter. Saturated poster colours as whole field backgrounds. A short px type ladder,
  14/16/20/28/48. Radii 2 to 6px. Not one `cubic-bezier` in the whole stylesheet.
  **Taken:** colour is the structure and type is the hierarchy. Motion is not the differentiator.
- **[Oxide Computer](https://oxide.computer)**. Suisse Intl and GT America Mono, near black with one
  acid green, a scale of many small steps, hairline rules, drawn technical diagrams.
  **Taken:** engineering credibility comes from real technical drawing and tabular data.
  **Rejected:** its palette, which is the default this direction exists to avoid.
- **[37signals](https://37signals.com)**. One face, Lab Grotesque, weights 300 to 800. Fluid
  headline type, `calc(1em + 1vw)`. Em based radii. No card grid at all.
  **Taken:** the absence of cards is what stops a page reading as a template.
- **[Met Office UK weather warnings](https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings)**.
  FS Emeric and Open Sans, warning yellow `#ffe923`, driven by a published impact by likelihood
  matrix. **Taken:** when the verdict is the product, the colour band must be a published, keyed
  system a reader can check, never decoration. This is why the Policy page exists as a page rather
  than a paragraph in the README.

## Banned in this product

Generic hero with a gradient and centred text. Purple or blue SaaS gradients. Glassmorphism. Emoji
as icons. Stock photography. Card grids. Gradient text. The big number with a gradient. Nested
cards. Bounce easing. Cream with a high contrast serif and a terracotta accent. Near black with a
single acid accent. Hairline rules with zero radius and dense columns. Gradient orbs. Warm paper
with monospace and nothing else, which is the code editor look. Warm off white with one saturated
accent and one display face. Placeholder copy of any kind, dummy Latin included.

No em dashes or en dashes in any copy this product ships.
