# Pixel office — the design system of the dashboard

The operator's brief, in short: everything should have a pixelated office look —
cosy and easy to read.

Before this there were **zero CSS files**: the dashboard was unstyled HTML with
browser default styles. The first pass creates the system and applies it to the
shell and the overview; the **second** extends it to the remaining nine pages
(see "Second pass" further down).

| | |
|---|---|
| Foundation (tokens, base elements) | `apps/web/src/styles/basis.css` |
| Components (card, metric, bubble, strip, button) | `apps/web/src/styles/bausteine.css` |
| Entry point | `apps/web/src/styles/index.css` |
| Font + licence | `apps/web/src/styles/schriften/` |

The detailed rationale for every decision is in the header of the two CSS files,
where it is read when something is changed. Here only the outcome.

It was applied to `App.tsx` (shell), `Overview.tsx` (overview) and additionally
to `Build.tsx` and `Fehlergrenze.tsx` — both appear **on** the overview, and a
raw box in the middle of a designed page would have devalued the example this
pass is supposed to deliver.

Stated precisely, because "only styling" would otherwise claim more than is
true: **not one string of display text and not one `data-testid` was changed**,
and no line makes a decision the page had not already made before. Two places go
beyond pure `className` and `data-` attributes. `App.tsx` was structured into
`header` / `main` — which is at the same time the landmark structure that was
missing before — and the tabs now carry `aria-current="page"`. `Overview.tsx`
gained `windowTon()`, a pure function that maps a percentage and the two
thresholds onto a colour name; both numbers stand as text beside it anyway.

## Screenshots

See the screenshots in `docs/media/`. They show:

* the overview at **390 × 844, unscrolled** — the promise from §17.1: the
  guardian's verdict in words and the decision counter sit above the fold,
  without a single swipe;
* the same page in full at 390 px, and at 1440 px;
* the component sheet, every component in every state;
* the focus ring on a tab in the first and in the wrapped second row of the
  navigation.

All of them are captured from the **built** bundle (`apps/web/dist`), i.e. from
exactly the artefact nginx delivers — not from a development server and not from
a rebuilt component. Only the API responses and the event stream are staged;
CSS, font and markup are real.

[`design-components.html`](design-components.html) is the component sheet
itself. It loads the real style files over a relative path and therefore cannot
drift from them — opened in a browser it always shows the delivered state,
without a database and without signing in.

## What was measured

| Check | Result |
|---|---|
| `pnpm gate`, ten steps | green, `GATE_EXIT=0` |
| Browser suite (Playwright) | **65 of 65 green**, unchanged |
| axe-core 4.10.2, WCAG 2.0/2.1 A + AA + best-practice | **0 violations** at 390 px and 1440 px, 57 nodes pass `color-contrast` |
| Contrast computed | lowest value 4.89:1, body text 15.21:1 |

The axe run deliberately went over the **noisy** state — wrap-up mode, one
window above the stop threshold, one unreadable, pending decisions, parked tasks.
A scan over the quiet page does not check half of the colours.

And because "zero violations" only means something if the run can also come out
differently, it was broken once: `--tinte-leise` set from `#5f5040` to
`#bfb3a1`, rebuilt, run again → **9 nodes red**, with the four backgrounds
named individually (1.71:1 on the groove, 1.83:1 on amber, 1.76:1 on rust,
1.94:1 on paper). Then restored from a file copy and back at zero.

## The font, and why there are two

**Silkscreen**, Jason Kottke, [SIL Open Font License 1.1](../apps/web/src/styles/schriften/OFL.txt)
— self-hosted, no CDN. `silkscreen-400.woff2` 8 404 bytes,
`silkscreen-700.woff2` 7 524 bytes, together **15 928 bytes**; both cuts are in
use (400 for navigation and labels, 700 for headings). The CSS comes to
10.2 KB, gzip 2.65 KB.

What is delivered is the Latin-subsetted set from Google Fonts — the OFL
explicitly allows that, and the licence file sits beside it, as the licence
requires. The name may stay: the copyright line reads *"Copyright 2001 The
Silkscreen Project Authors"* **without** the suffix `with Reserved Font Name`, so
there is no protected name here that a subsetted version would have to drop.

The brief contains a conflict of goals: pixel fonts are cosy and poor at
digits. Both candidates were therefore rasterised against each other character
by character in a real browser (Chromium, canvas, `getImageData`). Given is the
share of differing pixels — **0.000 means: the same glyph**:

| Pair | Silkscreen 10/12/14/16/20 px | Pixelify Sans 10/12/14/16/20 px |
|---|---|---|
| `0`/`O` | 0.000 0.000 0.000 0.000 0.000 | 0.000 0.000 0.000 0.000 0.000 |
| `8`/`B` | 0.114 0.333 0.259 0.333 0.322 | 0.000 0.000 0.031 0.000 0.020 |
| `5`/`S` | 0.100 0.150 0.160 0.167 0.156 | 0.122 0.120 0.145 0.211 0.184 |
| `2`/`Z` | 0.323 0.275 0.286 0.333 0.292 | 0.050 0.061 0.065 0.085 0.079 |
| `6`/`G` | 0.206 0.286 0.170 0.250 0.273 | 0.049 0.041 0.092 0.091 0.085 |
| `l`/`I` | 0.222 0.273 0.182 0.286 0.278 | 0.571 0.675 0.578 0.677 0.658 |

`0` and `O` are pixel-identical in **both** fonts at **every** size, in Pixelify
additionally `8` and `B`. A run id or a percentage in the pixel font would
therefore be not merely ugly but ambiguous. From that follows the rule every
later page has to obey:

> The display font carries **only static labels** — headings, navigation,
> button captions. As soon as an element carries data, the text font applies
> (system stack, `tabular-nums`).

The pixel character therefore lives in surfaces, borders, colour and bars, not
in body text. Umlauts and ß were checked as well: across `ÄÖÜäöüß` and the
entire ASCII range Silkscreen is missing **not a single glyph**.

## Light, not dark

"Office" means paper, folders and wood, and paper is light; the same palette
thought dark reads as a games console. On top of that: dark ink on warm paper
reaches 15:1 instead of the required 4.5:1, and the thin strokes of a pixel font
bloom on a dark background. A dark version would be a swap of the variables and
is deliberately **not** part of this pass — every value would have to be
re-measured individually.

## Contrast

Computed (WCAG 2.1) over every pair that actually occurs, lowest value
**4.89:1**, body text **15.21:1**. The amber was `#8a5d0a` at first and failed on
the desk tone at 4.17:1; it has therefore been darkened to `#7d5308`. Colour is
nowhere the only cue: every state carries its name as text and additionally a
shape — block mark, border weight, font weight.

## Two things that are not decoration

**No `position: sticky`.** Playwright scrolls an element into view before a
click; under a sticky header it ends up covered and the click fails with
"intercepts pointer events". 65 browser cases hang on that, and a more
convenient header is not worth it.

**The budget bar draws only on a real measurement.** It has no markup of its
own (`data-balken` switches it on, `--fuellung` says how far), and a window
without a measurement does not get one. An empty bar would be a reassuring
statement about a number that does not exist — exactly what §17.1 rejects in
words right beside it. An unreadable window therefore also looks different:
dashed edge instead of a bar, so that "unreadable" does not look like "fine" at
a glance.

## What remains open

**The navigation needs four rows at 390 px.** Ten sections with thumb-sized
targets (44 px) do not fit in fewer, and that costs roughly half of the first
screen. The promise from §17.1 holds anyway — the verdict below it is still
above the fold, see the unscrolled phone screenshot in `docs/media/` — but it
is tight. Whoever touches all pages in the second pass should check whether ten
equal-ranking tabs are the right form on a phone at all.

**There is no dark version.** Reasoned above; it would be a swap of the
variables plus a re-measurement of every contrast pair.

**What is checked is the overview, not the whole dashboard.** The eight
remaining pages inherit the base elements (headings, tables, input fields,
links) and already look considerably better because of it, but they are neither
designed nor checked with axe. Phase 7's a11y gate demands **all** pages.

---

# Design — screenshots

Pictures, not reports: what a test cannot say about a view is here.

## Office (§17.2)

The screenshots in `docs/media/` show:

| View | What is on it |
|---|---|
| Empty office | The after-hours office — the state in which the operator opens the page as long as the guardian's latch is set. The same furniture, the lights down, the window on evening, empty chairs pushed in. |
| Three desks | Three occupied desks: idle · working · reviewing. |
| Five states | All five bubbles side by side. Round bubble (idle/working/reviewing), **square** (blocked), **triangle** (asking) — the silhouette carries first, the pictogram separates the three round ones, the word beside it is the exact one. Colour is the fourth channel and never the only one. |
| Phone, 390 px | 390 px width: one column, coarser grid, clock and plant gone. No horizontal scrolling. |

## Regenerating

```
node infra/scripts/buero-bildschirmfotos.mjs
```

Builds the bundle if necessary, starts a small server with contract-conforming
responses and shoots the four pictures. The script checks two things along the
way that are visible on no picture: that the page does not scroll horizontally
and that the room cuts nothing off (`.px-buero` carries `overflow: hidden`; a
desk that is too wide would otherwise vanish silently).

Exit codes per A25/A50: **2** means "nothing checked" (no browser, no bundle),
**1** means "a picture could not be taken".

What this proves: how the real components draw a contract-conforming payload.
What it does not prove: that the server builds that payload this way — that is
`apps/server/src/buero.itest.ts` and `e2e/buero.spec.ts`.


---

# Second pass — the remaining nine pages

`Auth` · `Controlling` · `Dokumente` · `Einstellungen` · `Entscheidungen` ·
`Posteingang` · `Projekte` · `Quellen` · `Spuren`.

The same promise as in the first pass: **no `data-testid` renamed, no
behaviour changed**, and the 65 browser cases are unchanged green. What goes
beyond `className` and `data-` attributes is four pure presentation functions
(`fensterTon`, `dringlichkeitTon`, `zustandsTon`, and `Rahmen`'s `daten` switch
in `Spuren.tsx`) — each maps values that stand as text on the page anyway onto a
tone; and a header cell that was empty before and now carries a caption visible
only to screen readers.

## What was added to the system, and why

| Component | What it was needed for |
|---|---|
| Checkbox & radio button (`basis.css`) | The rule for text fields turned a tick into an empty box. §11's gate list, A26's pause and §8's persona level consist almost entirely of these. |
| `fieldset` / `legend`, `dl`, `details`, `pre`, `small` | Base elements that did not exist yet. `pre` is the most important: it gets **its own scroll area**, otherwise a single long log line stretches the page. |
| `.stapel` | Lists whose entries are cards. Without an intermediate element, because browser cases count `> li` directly. |
| `.feld`, `.werkzeugleiste` | Label above the field instead of beside it; filters in a groove above their list. |
| `.wahl` | One setting with its explanation. The selected one is recognisable by paper tone, edge width **and** a filled button — not by colour. |
| `.optionen` / `.empfehlung` | §15's card. The recommendation has to be seen without reading. |
| `.plakette` | State as a badge. **Text font**, because it carries digits. §17.8's four confidence levels additionally differ in stroke style (A64/A73). |
| `.lesbarkeit` | §13's three states of a stored file — without inserted text, because browser cases read this line as contiguous. |
| `.tabellenfeld` | Six columns scroll in their own area. |
| `.zeitstrahl`, `.transkript` | §17.4. The jumped-to line is recognisable by three cues. |
| `.tafel`, `.leerstand`, `.knopfreihe`, `.ablegezone`, `.nur-vorleser` | Chart on paper, empty state as an answer rather than a breakdown, button row, drop zone, invisible header-cell caption. |
| `[data-inhalt="daten"]` | **The most important addition.** See below. |

## The finding: the display font draws `4` and `9` the same

The header of `basis.css` measures six character pairs and derives from them the
rule that the display font must never carry data. `4`/`9` was not in the list —
and is the worst case of it: the jump mark "line 4" read as "line 9", an entry
number "#42" as "#92".

The rule was broken in a good dozen places, and **none of them was new**: a card
heading since Phase 4, a document title since Phase 6, "page 1 of 3" since
Phase 7. It was found by no test and no reading, but by the first screenshot.

`[data-inhalt="daten"]` switches an element back to the text font — deliberately
**without an element list**, because any element can carry data.

## Screenshots

Per page one at desktop width (1280 px) and one at phone width (390 px), in
`docs/media/`. Sixteen views, because several pages have more than one state
that has to be shown:

| View | What is on it |
|---|---|
| Sign-in | What an invited person sees. Friendly card, blue hint strip, green primary button — no error dialog. |
| Projects, project settings | §11's gate list as choice rows; the locked six remain **operable** (A62). §12's releases in a scroll area. |
| Inbox | §15's cards. The recommendation sits on warm paper with a double-width edge. |
| Decisions | The log as cases with question and answer. |
| Documents, search hits, document, unread document | §13's three states side by side: not in the vault (dashed empty state), searchable (green edge), stored and unread (dashed amber edge on warm paper). |
| Sources, source | §14's register with state badge, and the history as the evidence behind the level. |
| Controlling | All four confidence levels side by side — measured filled, estimated dashed. |
| Settings | §8's levels as choice rows, the current one visible. |
| Tasks, task, session transcript | §17.4. In the transcript: foreign text as **text**, every line with its own scroll area, the jumped-to line highlighted. |

### Regenerating

```
node infra/scripts/seiten-bildschirmfotos.mjs
```

Builds the bundle if necessary, starts a small server with contract-conforming
responses and shoots 32 pictures. It checks two things along the way that are
visible on no picture: that **no** page overflows horizontally (and names the
offending elements on an overflow), and that every page has reached its
*successful* state — it always waits for a marker of the content, never for the
page frame, otherwise the script would photograph an error message.

Both paid off: the first run refused three pages (the ids in the fixture were
not uuids, so the pages quite correctly reported "broken link"), and the
overflow check found a 1 px, invisible element that turned 390 px of page width
into 571.

Exit codes per A25/A50: **2** means "nothing checked", **1** means "a picture
could not be taken or a page overflows".

What this proves: how the real components draw a contract-conforming payload.
What it does not prove: that the server builds that payload this way — that is
the browser suite and the `*.itest.ts` files.

### What a metric does not catch

Twice the overflow check was green and the page was still unreadable: the
release history showed six columns of two centimetres each at 390 px, and after
the first scroll area the header cells broke mid-word ("AUSGA / NG"). Both are
visible only on the picture. "Easy to read" is the second half of the
operator's brief, and the one for which there is no test.
