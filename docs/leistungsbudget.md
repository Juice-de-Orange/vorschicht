# Performance budget of the dashboard

§22 Phase 7 demands "Lighthouse: PWA installable pass; **performance budget met
(budget documented in repo)**". The budget is therefore part of the evidence,
not its result: it has to be fixed and written down **before** the measurement,
otherwise "met" is a statement about a number somebody picked after measuring.

This document is the rationale. The numbers themselves live in
`infra/leistungsbudget.json`, because an auditor has to be able to read them.
`infra/scripts/check-leistungsbudget.mjs` compares the two files and **fails
when one was changed without the other** — the same bargain A43.1 makes for the
§9 transition table. Without it the path of least resistance would be to raise
the limit in the file and leave the document standing, and the next reader
would believe the document.

**A note on notation:** every figure in this document uses German number
formatting — `.` as the thousands separator, `,` as the decimal separator
(`1.956 ms`, `0,061`) — and the position names in the tables are quoted
verbatim as they appear in `infra/leistungsbudget.json`. The drift check
compares both literally, character by character, so neither the numbers nor
the position names may be reformatted here.

As of: **12.8.2026**, fixed at commit `aa9b943`.

---

## 1. What is measured, and in which two halves

The budget has two parts that must not be mixed, because they have different
owners.

**The artefact** — what `vite build` produces. Deterministic: same tree, same
number, no browser, no network. That is what a commit controls, and therefore
the part that tolerates a hard limit.

**The delivery** — what the server sends over the wire from it. The same bundle
weighs a third behind a server with compression of what it weighs without. That
is not a property of the commit but of the nginx configuration, and it is
therefore **not a budget item** but a measurement with its own report in
`check-kaltstart.mjs`. A budget that carried both in one number would give a
new dependency and a changed server line the same vote — and would net an
improvement in one place against a regression in the other.

**Source maps (`*.map`) do not count.** A browser fetches them only when the
developer tools are open; today they would be 2.069.265 B, five times the whole
of the rest of the bundle. Counting them would turn the budget into a statement
about a file no visitor ever requests. The omission is stated here and in the
header of `leistungsbudget.mjs`, because a silent omission is one nobody finds
later.

---

## 2. The limits of the artefact

| Position (as the checker greps it) | Meaning | Limit | Measured 12.8.2026 | Headroom |
|---|---|---:|---:|---:|
| JavaScript, übertragen (gzip) | JavaScript, transferred (gzip) | 135.000 B | 121.825 B | 11 % |
| JavaScript, roh (Parsen und Übersetzen) | JavaScript, raw (parse and compile) | 450.000 B | 402.715 B | 12 % |
| CSS, übertragen (gzip) | CSS, transferred (gzip) | 8.000 B | 3.298 B | 142 % |
| Schriften, übertragen | Fonts, transferred | 32.000 B | 15.928 B | 101 % |
| Symbole der PWA, übertragen | PWA icons, transferred | 12.000 B | — (position added 18.8.2026) | — |
| Übertragung gesamt | Total transfer | 170.000 B | 141.529 B | 20 % |

The dash in the icons row is not an oversight. The position was created
**before** the first icon byte existed — exactly in the order §1 of this
document demands — and the "Measured" column carries only numbers from a run. It
is filled at the phase close, together with the tick it supports.

### Why these numbers

**JavaScript, transferred: 135.000 B.** Eleven percent above the current
figure, and that is the whole intent: roughly 13 kB compressed corresponds to
**one medium-sized dependency**. A new date formatter, a charting library, a
state manager — each of these bumps against it, and then somebody has to decide
instead of doing it in passing. That is what a budget is for; a budget with
twice the headroom is a number you only notice when it is too late.

**JavaScript, raw: 450.000 B.** The same headroom, a different size. Transfer
costs bandwidth, raw size costs **CPU time**: Chrome has to tokenise and compile
the text, and on the throttled mobile profile that happens with a CPU slowed
down fourfold. A dependency that compresses well but is a lot of code would be
invisible under a pure gzip limit.

**CSS: 8.000 B** and **fonts: 32.000 B.** Both have more headroom than the
JavaScript, and that is reasoned rather than generous: the design pass is still
under way, CSS compresses roughly 4:1 (8 kB gzip is about 32 kB of source, which
is a lot for ten pages), and the font limit allows exactly **two more cuts**
beside today's two. A third cut or a second family is thereby a decision and not
a side effect.

**PWA icons, transferred: 12.000 B.** §17 demands an installable PWA, and
Chrome demands icons at 192 and 512 pixels for that; on top comes a `maskable`
variant so that Android does not crop into the content. Three files, then, and
the number is reasoned from the *procedure* rather than from a measurement: the
icons are pixel art on the grid of the design system — flat colours, hard edges,
a handful of values — and that is the case PNG's filters and deflate handle best.
**What the limit is meant to keep out is the export from a graphics program:** a
512 px icon with gradients and anti-aliasing weighs 80 to 300 kB, i.e. six to
twenty-five times as much. **What it is meant to allow is a fourth file** — an
Apple touch icon, a favicon — without anybody having to touch the budget for it.
For comparison, because a number without a scale says nothing: the two complete
font cuts together weigh 15.928 B.

A word on what does **not** count here: the service worker. It sits as `sw.js`
in the root of the bundle and therefore falls under `.js`, so it counts against
**JavaScript** and not against the icons — even though a browser fetches it only
after `load` and never on first paint. That over-counts the critical path and is
the safe direction; the reasoning sits next to `KATEGORIEN` in
`infra/scripts/leistungsbudget.mjs`, where it is read when it is changed.

**Total transfer: 170.000 B — and deliberately less than the sum of the
parts.** The four transfer items add up to 187 kB (135 + 8 + 32 + 12); the total
limit therefore binds first. That is intended: the parts must not all be
exhausted at the same time, and the total limit is at the same time the only
thing that catches a **new category** — an image, a second font family — for
which no item exists yet. `js-roh` is deliberately not in this sum: it measures
the same bytes again, in a different unit.

**The total limit was not raised for the icons, and that is arithmetic, not
posture.** On 18.8.2026 the bundle weighs 143.899 B; with 12.000 B of icons and
the service worker it stays below 170.000 B. Raising it "because something is
being added now" would be precisely the path of least resistance that §5 is
meant to make uncomfortable.

---

## 3. The limits of the measurement (Lighthouse)

Measured against the built bundle from `vite preview`, in the throttled mobile
profile, **three runs, the median counts**.

| Position (as the checker greps it) | Meaning | Limit | Median 12.8.2026 | Origin of the limit |
|---|---|---:|---:|---|
| Leistungswert | Performance score | 90 Punkte | 97 | Lighthouse's own boundary between green and orange |
| Grösste inhaltliche Anzeige (LCP) | Largest Contentful Paint | 2.500 ms | 1.960 ms | Core Web Vitals, "good" threshold |
| Gesamte Blockierzeit (TBT) | Total Blocking Time | 300 ms | 86 ms | Lighthouse, "good" threshold |
| Verschiebung des Layouts (CLS) | Cumulative Layout Shift | 0,1 | 0,061 | Core Web Vitals, "good" threshold |

**None of these four numbers is invented here.** They are the published
thresholds from which the respective metric counts as "good". What was chosen is
not the number but the decision to adopt it — and that is the strongest
justification a budget can have, because it does not depend on who wrote it
down.

**Why the median and not a single run.** Three consecutive runs on this machine
gave a total blocking time of **66, 86 and 358 ms** and performance scores of
**97, 97 and 89**, while LCP stayed almost still at 1.954–1.961 ms. The reason
is not a property of the page: TBT measures CPU time, and whoever else happens
to be computing on the machine has a say. A budget on a single run would be a
gate that goes red depending on its neighbours — and a gate whose red nobody
believes is worse than none. The best value would be cherry-picking, the worst
would reflect the neighbourhood rather than the tree. All three runs are
printed.

---

## 4. The cold load against the VPS

§22 itself names a number here: "Cold load of the overview **< 2s** over a
throttled mobile profile against the VPS". It is copied into
`infra/leistungsbudget.json` and is **not a decision of this document** —
changing it would be a change to `CLAUDE.md`.

| Position (as the checker greps it) | Meaning | Limit | Worst of three runs | Origin of the limit |
|---|---|---:|---:|---|
| Kaltstart der Übersicht gegen den VPS | Cold load of the overview against the VPS | 2.000 ms | **1.856 ms** (18.8.2026) | §22 Phase 7, verbatim |

What counts is the **worst** of six runs of the day — 1.444 · 1.472 · 1.484 ·
1.516 · 1.740 · 1.856 ms. For a while this line said 1.740, because that was
the number of the run this line was first written from; it was not wrong, but it
was not the one the gate means. Found by the drift check in
`leistungsbudget.mjs`, which since 18.8. also compares the **measured value**
and not only the limit — retrofitted after a suspicion raised by internal audit
49c549b4, which found three different CLS values in the tree for the same day.

**The limit is met.** On 12.8.2026 this line said **2.928 ms**, with the
diagnosis below it that this was due to missing compression. The number stays in
this document, because a budget document that names only the numbers that fit
describes a result, not a budget — and because the diagnosis was wrong; see the
corrected paragraph below.

Measured with `infra/scripts/check-kaltstart.mjs` against
`https://vorschicht.example.com/`, in the same mobile profile (1,6 Mbit/s,
150 ms round trip, CPU 4×), three runs, **the worst counts**. LCP is used: FCP
would be too early, `load` too late and too arbitrary.

**What the number does not contain.** The page is passkey-protected (§19) and
this run has no passkey. What is measured is what a visitor without a session
sees: the delivered shell with the sign-in hint. Included are connection setup,
TLS, HTML, all of the JavaScript, the CSS and the fonts — for a single-page
application by far the largest part. Not included are the data fetches after
sign-in and the work their responses trigger.

**The diagnosis of 12.8.2026 was wrong, and it stands here corrected rather
than deleted.** It read: the host delivers JavaScript and CSS **uncompressed**,
the browser reports factor 1,00 for both, and roughly 900 ms hang on one line
of server configuration.

The run of 18.8.2026 shows the opposite, in the same table the script itself
prints:

```
  Ausgeliefert (was der Host wirklich geschickt hat)
    /assets/index-w_iCSzUs.js         127.988 B von  428.031 B  (Faktor 0.30)
    /assets/index-B-HAuoCO.css          4.635 B von   21.523 B  (Faktor 0.22)
    /assets/silkscreen-400.woff2        8.404 B von    8.404 B  (Faktor 1.00)
    /                                     610 B von    1.039 B  (Faktor 0.59)
```

(The table lists what the host actually delivered: bytes on the wire against
raw bytes, with the compression factor.)

The host compresses, and has done all along — only the **fonts** stand at 1,00,
and that is correct: `woff2` is already compressed, a second pass gains nothing.
The old diagnosis had evidently generalised their factor to every position.

**What it really was, as far as can be established today:** unknown, and that
is said here rather than replaced. Between the two measurements lie a rollout
and six days; which of those had an effect can no longer be separated in
hindsight. What is established: the number is **1.856 ms**, it was measured with
the same script and the same profile against the same host, and the explanation
the old number rested on does not hold. Replacing a wrong cause with an invented
one would be worse than the gap.

Two measures that followed from the old diagnosis are therefore **not** needed
and deliberately not built: setting compression explicitly in the vhost (it is
there) and splitting the artefact (the limit holds without it). Code splitting
remains the next measure should a later page push the number back over 2.000 ms
— the pages are natural cut points.

**Why this is not measured with Lighthouse**, although the neighbouring check
uses it: with the Chromium available here, Lighthouse crashes the renderer of
**every** HTTPS page of this size (`Inspector.targetCrashed`), github.com
included; the local preview of the same application over HTTP runs through. The
full narrowing-down, including the refuted hypotheses, is in the header of
`infra/scripts/kaltstart-messung.mjs`. The measurement is therefore taken
directly in the browser, with **applied** rather than simulated throttling — the
same profile numbers, and for an upper bound the safer direction, because
applied throttling tends to come out more pessimistic.

---

## 5. How the budget is changed

Raising a limit is allowed and is meant to be uncomfortable. The way:

1. Change the number in `infra/leistungsbudget.json`.
2. Change the number **and its rationale** in this document. Without that,
   `check-leistungsbudget.mjs` fails, with the line that says which position
   has drifted apart.
3. The rationale must say **what was gained for it**. "Does not fit otherwise"
   is not one.

What must **not** be changed without changing `CLAUDE.md`: the 2.000 ms of the
cold load. Those are in §22.
