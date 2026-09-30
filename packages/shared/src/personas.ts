/**
 * §8's persona layer as a setting, and the one rule A9 states as prose that has
 * to be code.
 *
 * §8: "personas (names/avatars) exist for the office view; **personas are
 * display-only by default** — persona flavor text is injected into prompts only
 * if the operator enables `personaFlavorInPrompts`, and personas can be **fully
 * disabled** (neutral role labels). Quality must never compete with theater."
 *
 * That sentence names three states, and the arrangement here is `./gates.ts`'s:
 * a catalogue in `@vorschicht/shared` rather than beside the component that
 * uses it, because three parties need it and only one of them may touch a
 * database. The settings page (§17.9) renders the switch, the API validates a
 * change against it, and the orchestrator decides from it whether a prompt
 * carries flavour. A catalogue in `@vorschicht/core` would drag Postgres into
 * the dashboard's import graph for three labels.
 *
 * Browser-safe by construction: this module imports only `zod`. It is reachable
 * through the `@vorschicht/shared/personas` subpath for the reason `./gates`,
 * `./dokumente` and `./quellen` are — the barrel re-exports `worktree.js` and
 * `containment.js`, which pull `node:path` (A75.5).
 *
 * **English identifiers, German values**, this house's rule.
 *
 * Four decisions are not transcription of §8.
 *
 *   1. **One enum with three values, not two booleans.** The obvious build is
 *      `personaFlavorInPrompts` beside `personasVisible`, because §8 names the
 *      first by that identifier. It makes an incoherent state representable:
 *      personas "fully disabled" while `You are Rita` is still being prepended
 *      to a system prompt. That combination contradicts §8's own word *fully*,
 *      and it is the combination A9 exists to forbid — flavour in a prompt is
 *      the only place personas can cost anything, so it is the last thing that
 *      may survive switching them off. Three values in a total order make the
 *      state unreachable rather than merely discouraged, which is the same call
 *      0021 made for a source's state and 0016 for an answered escalation: do
 *      not store a fact a second component can contradict.
 *
 *      What it costs, stated rather than discovered: The operator cannot have neutral
 *      labels on screen *and* flavour in prompts. That is not a configuration
 *      this project would honour if asked — it is theatre with the audience
 *      removed, paying the only price personas can charge and collecting none
 *      of the benefit §8 wants them for.
 *
 *   2. **The neutral label is the desk, and no new field was added for it.**
 *      `Persona.desk` is already documented as "German desk label for the
 *      office view" and every value in the profile table is a role name —
 *      Planung, Review, Datenbank, Sicherheit. A parallel `neutralLabel` field
 *      would be a second German string per profile, kept in step with the first
 *      by nobody, in a table that already has seventeen rows. `personaLabel` is
 *      the one place the choice is made.
 *
 *   3. **`aus` is not the default and `prompt` is not either.** A9 fixes the
 *      middle value: display-only by default, flavour opt-in. The default lives
 *      here rather than in the migration for the reason 0022 gives — a seeded
 *      row makes "never touched" and "set back to the default" the same fact.
 *
 *   4. **The wire lives here too** (`./inbox.ts`'s reason, A81): two
 *      independent declarations of one JSON document is the defect that let the
 *      routes answer `{ posteingang: … }` while the pages read `koerper.items`,
 *      with each side green about its own half. The producer in `apps/server`
 *      is type-checked *from* these schemas and the dashboard **parses** rather
 *      than casts. German envelope keys, English fields — a JSON key is read by
 *      a program; every string a person reads is German (§2).
 */
import { z } from 'zod';

/**
 * §8's three states, in the order they switch more of the layer on.
 *
 * The order is meaningful and is asserted: `aus` < `anzeige` < `prompt`, each
 * a superset of the one before. That is what makes a single enum honest rather
 * than merely compact — if the three were not a ladder, collapsing two booleans
 * into them would be hiding a combination instead of ruling one out.
 */
export const PERSONA_MODES = ['aus', 'anzeige', 'prompt'] as const;
export type PersonaMode = (typeof PERSONA_MODES)[number];

/** A9: display-only by default. Prompts untouched until the operator says otherwise. */
export const PERSONA_MODE_DEFAULT: PersonaMode = 'anzeige';

/** The key `config` stores it under (§5). */
export const PERSONA_MODE_KEY = 'personas.mode';

/** What the switch says on the settings page (§2, §17.9). */
export const PERSONA_MODE_LABELS: Record<PersonaMode, string> = {
  aus: 'Aus — neutrale Rollenbezeichnungen',
  anzeige: 'Anzeige — Namen in der Oberfläche',
  prompt: 'Anzeige und Prompt — Namen und Charakter',
};

/**
 * Why the operator would pick each one, in his own language.
 *
 * The third says what it costs, because it is the only one that can cost
 * anything and a switch whose price is invisible is a switch nobody weighs.
 */
export const PERSONA_MODE_DESCRIPTIONS: Record<PersonaMode, string> = {
  aus:
    'Die Oberfläche zeigt Rollen statt Namen — „Review" statt „Rita". ' + 'Prompts sind unberührt.',
  anzeige:
    'Voreinstellung. Namen und Schreibtische im Büro, die Prompts bleiben ' +
    'Wort für Wort dieselben wie bei „Aus".',
  prompt:
    'Zusätzlich bekommt jede Sitzung einen Satz über ihren Charakter vorangestellt. ' +
    'Das ist die einzige Stufe, die überhaupt etwas kosten kann — der Auftrag ' +
    'selbst bleibt unverändert.',
};

/**
 * Does a session's system prompt carry persona flavour (A9)?
 *
 * The single reader of this answer is `renderSystemPrompt`, and the assertion
 * that matters is on the other side of it: at `false` the rendered prompt is
 * **byte-identical** to the profile's own, for every profile. That is A9's
 * "quality must never compete with theater" made mechanical — a claim about
 * cost that can be checked rather than believed.
 */
export function personaFlavorEnabled(mode: PersonaMode): boolean {
  return mode === 'prompt';
}

/** Does the interface show persona names at all (§8's "fully disabled")? */
export function personaNamesShown(mode: PersonaMode): boolean {
  return mode !== 'aus';
}

/** The two fields any renderer needs. Structural, so callers may pass a profile's persona. */
export interface PersonaIdentity {
  readonly name: string;
  readonly desk: string;
  readonly alternates?: readonly string[];
}

/**
 * What one desk is called, under this mode (§8's "neutral role labels").
 *
 * One function, so that the office view (§17.2), the settings roster and
 * anything Phase 7 adds cannot each answer it differently. The alternative —
 * every renderer writing `mode === 'aus' ? desk : name` — is the shape A81.3
 * records: one rule written in two packages, and every deep link in every
 * notification landing on the wrong page.
 */
export function personaLabel(mode: PersonaMode, persona: PersonaIdentity): string {
  return personaNamesShown(mode) ? persona.name : persona.desk;
}

/**
 * The further names for the same profile at another desk (§8's two coders).
 *
 * Empty under `aus`, because an alternate is a *name* and §8's third state has
 * none. Returned as a list rather than folded into `personaLabel`'s string so
 * that a renderer can decide how to show it — the office view seats them at two
 * desks, the settings page names them in one line.
 */
export function personaAlternates(mode: PersonaMode, persona: PersonaIdentity): readonly string[] {
  return personaNamesShown(mode) ? (persona.alternates ?? []) : [];
}

// ---------------------------------------------------------------------------
// The wire (§17.9)
// ---------------------------------------------------------------------------

export const personaModeSchema = z.enum(PERSONA_MODES);

/**
 * One desk as the API reports it.
 *
 * Deliberately the raw identity plus the mode, never a pre-rendered label: the
 * page applies `personaLabel` itself, so switching the mode re-renders without
 * a round trip and there is exactly one implementation of §8's rule. A server
 * that sent the finished string would be a second one.
 */
export const personaRosterEntry = z.object({
  id: z.string(),
  department: z.string(),
  name: z.string(),
  desk: z.string(),
  alternates: z.array(z.string()),
});
export type PersonaRosterEntry = z.infer<typeof personaRosterEntry>;

export const personaSettingsView = z.object({
  mode: personaModeSchema,
  roster: z.array(personaRosterEntry),
});
export type PersonaSettingsView = z.infer<typeof personaSettingsView>;

export const einstellungenResponse = z.object({ personas: personaSettingsView });
export type EinstellungenBody = z.infer<typeof einstellungenResponse>;

export const personaModeSubmission = z.object({ mode: personaModeSchema });
export type PersonaModeSubmission = z.infer<typeof personaModeSubmission>;

export const einstellungenRejectedResponse = z.object({ errors: z.array(z.string()) });

/**
 * Every path exactly once (A81.3).
 *
 * `seite` liefert §17.9s ganze Seite (`@vorschicht/shared/einstellungen`) und
 * `personas` bleibt der Ausschnitt, den der Schalter schreibt und
 * zurückbekommt. Beide stehen hier, obwohl die eine Form dort deklariert ist:
 * §17.9s Pfade an zwei Stellen zu führen ist genau das, woran §15s Deep-Link
 * schon einmal zerbrochen ist (`/inbox` gegen `/posteingang`, A81.3).
 */
export const EINSTELLUNGEN_API = {
  seite: '/api/einstellungen',
  personas: '/api/einstellungen/personas',
} as const;

/** Where the dashboard puts the page (§17.9). */
export const EINSTELLUNGEN_PFAD = '/einstellungen';

/**
 * zod's messages are English and this is a boundary a person sees (§2).
 *
 * The same treatment `germanQuellenIssues` gives the registry: a rejected
 * submission answers in the language the rest of the page is written in.
 */
export function germanPersonaIssues(issues: ReadonlyArray<{ message: string }>): string[] {
  const known = PERSONA_MODES.join('", "');
  return issues.map((issue) =>
    /invalid|expected|option/i.test(issue.message)
      ? `Unbekannte Persona-Stufe. Erlaubt sind "${known}".`
      : issue.message,
  );
}

/** Parse a submitted mode change, refusing rather than throwing. */
export function parsePersonaModeSubmission(
  body: unknown,
): { ok: true; value: PersonaModeSubmission } | { ok: false; errors: string[] } {
  const parsed = personaModeSubmission.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: germanPersonaIssues(parsed.error.issues) };
}
