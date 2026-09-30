/**
 * The registry's two jobs: refuse a configuration §11 forbids, and resolve the
 * rest into the list the runner iterates.
 *
 * The load-bearing assertions are the refusals, because every one of them is a
 * rule that would otherwise live only in prose. The Phase 3 exit gate
 * "baseline gates verified non-removable via UI and API" is the first `describe`
 * block; the API half of it is in `project-service.itest.ts`, where the refusal
 * also has to reach `audit_log`.
 */
import { describe, expect, it } from 'vitest';
import {
  assertCatalogueConsistent,
  BASELINE_GATE_IDS,
  EMPTY_GATE_CONFIG,
  GATE_CATALOGUE,
  GATE_IDS,
  GateConfigError,
  type GateDefinition,
  type GateId,
  gateDefinition,
  gateUnavailableReason,
  isGateId,
  OPTIONAL_GATE_IDS,
  type ProjectGateConfig,
  parseProjectGateConfig,
  readProjectGateConfig,
  resolveGates,
  validateProjectGateConfig,
} from './gates.js';

function config(partial: Partial<ProjectGateConfig>): ProjectGateConfig {
  return { ...EMPTY_GATE_CONFIG, ...partial };
}

/** The gate borrowed below, and deliberately not `legal`. */
const BORROWED: GateId = 'lighthouse';

/**
 * Run `body` with one catalogue entry marked "the runner does not exist yet".
 *
 * Both branches of `availableFrom` — the validator's refusal and
 * `resolveGates`'s drop — are reachable only through a catalogue entry that
 * carries the field, and since Lena landed there is none (`legal` was the last,
 * `migration-review` the one before it, A62.3). They are not dead: the next
 * optional gate that reaches the catalogue before its runner needs them, and
 * A62.5 already names one. Deleting the cases would leave the mechanism
 * unproven for exactly the arrival it exists for — §8.2's sixth domain, in the
 * guard against §8.2's sixth domain.
 *
 * A *synthetic* entry does not work: `validateProjectGateConfig` refuses an id
 * `isGateId` does not know, and that index is module-private. So a real entry is
 * borrowed for the duration and restored in `finally` — `lighthouse` rather than
 * `legal`, so the case states the rule ("whichever gate carries this is refused
 * and dropped") instead of re-coupling to the gate that has just stopped
 * carrying it. Vitest isolates per file, so no other suite sees the borrow.
 */
function withUnavailableGate(body: () => void): void {
  const gate = gateDefinition(BORROWED);
  const previous = gate.availableFrom;
  gate.availableFrom = 'Nur für diesen Testfall: der Prüflauf existiert noch nicht.';
  try {
    body();
  } finally {
    gate.availableFrom = previous;
  }
}

describe('der Katalog', () => {
  it('ist in sich stimmig', () => {
    expect(() => assertCatalogueConsistent()).not.toThrow();
  });

  it('deckt genau §11s gesperrte sechs als gesperrt aus', () => {
    const locked = GATE_CATALOGUE.filter((gate) => gate.locked).map((gate) => gate.id);
    expect(locked).toEqual([...BASELINE_GATE_IDS]);
  });

  it('führt jede Kennung genau einmal', () => {
    expect(new Set(GATE_IDS).size).toBe(GATE_IDS.length);
    expect(GATE_IDS.length).toBe(BASELINE_GATE_IDS.length + OPTIONAL_GATE_IDS.length);
  });

  it('beschreibt jedes Gate auf Deutsch (§2)', () => {
    for (const gate of GATE_CATALOGUE) {
      expect(gate.label.length).toBeGreaterThan(3);
      expect(gate.description.trim().endsWith('.')).toBe(true);
    }
  });

  it('verlangt einen Befehl genau bei den Befehls-Gates', () => {
    for (const gate of GATE_CATALOGUE) {
      expect(gate.needsCommand).toBe(gate.kind === 'command');
    }
  });

  it('führt heute kein Gate ohne Prüflauf', () => {
    // A62.3 gab genau zwei Einträgen ein `availableFrom`: `migration-review`
    // (A63, Phase 3, Schritt 2) und `legal` (§8 Zeile 5, Phase 6, Schritt 1).
    // Beide haben inzwischen einen Prüflauf, also ist das Feld überall leer.
    //
    // Das ist eine Aussage über **heute** und nicht über den Mechanismus: der
    // bleibt, weil der nächste Gate, der vor seinem Prüflauf in den Katalog
    // gerät, ihn wieder braucht — A62.5 nennt die urteilende Hälfte des
    // Doku-Gates bereits als solchen Fall. Bewiesen wird er weiter unten an
    // einem geliehenen Eintrag, weil er sonst ab jetzt ungeprüft wäre.
    const waiting = GATE_CATALOGUE.filter((gate) => gate.availableFrom !== null);
    expect(waiting.map((gate) => gate.id)).toEqual([]);
  });

  it('führt Lenas Gate als eigene Prüfung ohne Projektbefehl', () => {
    // §11 zählt die Rechtsprüfung unter den optionalen Gates auf, und sie ist
    // `internal`: Vorschicht führt sie selbst aus (eine Sitzung, §8 Zeile 5),
    // statt ein Projektkommando zu starten. Ein hinterlegter Befehl würde nie
    // ausgeführt — deshalb weist der Validator ihn eine Ebene tiefer ab.
    expect(gateDefinition('legal').kind).toBe('internal');
    expect(gateDefinition('legal').needsCommand).toBe(false);
    expect(gateDefinition('legal').locked).toBe(false);
  });

  it('erkennt fremde Kennungen nicht als Gate', () => {
    expect(isGateId('test')).toBe(true);
    expect(isGateId('kein-gate')).toBe(false);
  });
});

describe('§11: das gesperrte Grundgerüst ist nicht abwählbar', () => {
  it.each([...BASELINE_GATE_IDS])('lehnt das Abwählen von "%s" ab', (id) => {
    const result = validateProjectGateConfig({ gates: { [id]: false } });
    expect(result.ok).toBe(false);
    expect(result.config).toBeNull();
    expect(result.errors.join(' ')).toContain(gateDefinition(id).label);
    expect(result.errors.join(' ')).toContain('§11');
  });

  it('nennt jedes abgewählte Gate einzeln statt nur das erste', () => {
    const result = validateProjectGateConfig({ gates: { test: false, build: false } });
    expect(result.errors).toHaveLength(2);
  });

  it('nimmt ein ausdrückliches „an" für ein gesperrtes Gate an', () => {
    const result = validateProjectGateConfig({ gates: { test: true } });
    expect(result.ok).toBe(true);
  });

  it('läuft auch dann, wenn das Dokument gar nichts über sie sagt', () => {
    expect(resolveGates(EMPTY_GATE_CONFIG).map((gate) => gate.id)).toEqual([...BASELINE_GATE_IDS]);
  });

  it('läuft selbst dann, wenn ein Dokument sie an der Prüfung vorbei abwählt', () => {
    // The structural half: `resolveGates` adds the locked six from the
    // catalogue, so a row edited by hand cannot subtract from them either.
    const smuggled = {
      gates: { test: false, secrets: false },
      commands: {},
      tools: [],
      migrationPaths: [],
    };
    expect(resolveGates(smuggled as ProjectGateConfig).map((gate) => gate.id)).toEqual([
      ...BASELINE_GATE_IDS,
    ]);
  });

  it('wirft in der werfenden Variante mit allen Gründen', () => {
    expect(() => parseProjectGateConfig({ gates: { test: false } })).toThrow(GateConfigError);
    try {
      parseProjectGateConfig({ gates: { test: false } });
    } catch (error) {
      expect((error as GateConfigError).errors).toHaveLength(1);
    }
  });
});

describe('optionale Gates', () => {
  it('nimmt ein Gate mit Befehl an und stellt es in die Reihenfolge des Katalogs', () => {
    const result = validateProjectGateConfig({
      gates: { e2e: true },
      commands: { e2e: 'npm run e2e' },
    });
    expect(result.ok).toBe(true);
    const ids = resolveGates(result.config as ProjectGateConfig).map((gate) => gate.id);
    expect(ids).toContain('e2e');
    // Catalogue order, not insertion order: the locked six come first.
    expect(ids.slice(0, BASELINE_GATE_IDS.length)).toEqual([...BASELINE_GATE_IDS]);
  });

  it('lehnt ein angehaktes Gate ohne Befehl ab', () => {
    const result = validateProjectGateConfig({ gates: { e2e: true } });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('kein Befehl hinterlegt');
  });

  it('lehnt ein Gate ab, dessen Prüflauf es noch nicht gibt', () => {
    withUnavailableGate(() => {
      const result = validateProjectGateConfig({
        gates: { lighthouse: true },
        commands: { lighthouse: 'npm run lighthouse' },
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toContain('noch nicht verfügbar');
    });
  });

  it('führt ein noch nicht verfügbares Gate auch dann nicht aus, wenn es im Dokument steht', () => {
    const smuggled = {
      gates: { lighthouse: true },
      commands: { lighthouse: 'npm run lighthouse' },
      tools: [],
      migrationPaths: [],
    } as ProjectGateConfig;
    // Die Gegenprobe zuerst: mit Prüflauf steht das Gate in der Liste. Ohne sie
    // bewiese der Fall unten nur, dass irgendetwas an diesem Dokument nicht
    // greift — und nicht, dass `availableFrom` der Grund ist.
    expect(resolveGates(smuggled).map((gate) => gate.id)).toContain('lighthouse');
    withUnavailableGate(() => {
      expect(resolveGates(smuggled).map((gate) => gate.id)).not.toContain('lighthouse');
    });
  });

  it('lässt ein nicht angehaktes Gate weg', () => {
    expect(resolveGates(config({ gates: { e2e: false } })).map((gate) => gate.id)).not.toContain(
      'e2e',
    );
  });

  it('führt die eigenen Prüfungen ohne Befehl aus', () => {
    const result = validateProjectGateConfig({ gates: { changelog: true, docs: true } });
    expect(result.ok).toBe(true);
    expect(resolveGates(result.config as ProjectGateConfig).map((gate) => gate.id)).toEqual([
      ...BASELINE_GATE_IDS,
      'changelog',
      'docs',
    ]);
  });
});

describe('Befehle', () => {
  it.each([
    ['npm test && rm -rf /', '&'],
    ['npm test; echo ok', ';'],
    ['sh -c "npm test"', '"'],
    ['npm run $TARGET', '$'],
  ])('lehnt „%s" wegen „%s" ab', (spec, character) => {
    const result = validateProjectGateConfig({ commands: { test: spec } });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain(character);
    expect(result.errors.join(' ')).toContain('§19');
  });

  it('lehnt einen Befehl für ein Gate ab, das Vorschicht selbst ausführt', () => {
    const result = validateProjectGateConfig({ commands: { secrets: 'gitleaks detect' } });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('nie ausgeführt');
  });

  it('lehnt einen leeren Befehl ab', () => {
    const result = validateProjectGateConfig({ commands: { test: '   ' } });
    expect(result.ok).toBe(false);
  });

  it('nimmt einen gewöhnlichen Befehl an', () => {
    const result = validateProjectGateConfig({
      commands: { test: 'pnpm test', build: 'pnpm build' },
      tools: ['Bash(pnpm test:*)'],
    });
    expect(result.ok).toBe(true);
    expect(result.config?.commands.test).toBe('pnpm test');
    expect(result.config?.tools).toEqual(['Bash(pnpm test:*)']);
  });

  it('lehnt eine unbekannte Gate-Kennung ab, statt sie stillschweigend zu verwerfen', () => {
    const result = validateProjectGateConfig({ commands: { erfunden: 'npm test' } });
    expect(result.ok).toBe(false);
  });
});

describe('readProjectGateConfig — die nachsichtige Lesart einer gespeicherten Zeile', () => {
  it('gibt ein gültiges Dokument unverändert zurück', () => {
    const stored = {
      gates: { e2e: true },
      commands: { e2e: 'npm run e2e' },
      tools: [],
      migrationPaths: ['db/migrate/**'],
    };
    expect(readProjectGateConfig(stored)).toEqual(stored);
  });

  it('verwirft Unbrauchbares, statt den Betrieb anzuhalten', () => {
    const stored = {
      gates: { e2e: true, erfunden: true, test: 'ja' },
      commands: { test: 'pnpm test', erfunden: 'x' },
      tools: ['Bash(pnpm test:*)', 42],
    };
    const read = readProjectGateConfig(stored);
    expect(read.gates).toEqual({ e2e: true });
    expect(read.commands).toEqual({ test: 'pnpm test' });
    expect(read.tools).toEqual(['Bash(pnpm test:*)']);
  });

  it('überliest ein abgewähltes gesperrtes Gate — es läuft trotzdem', () => {
    const read = readProjectGateConfig({ gates: { test: false } });
    expect(resolveGates(read).map((gate) => gate.id)).toContain('test');
  });

  it('verträgt null, undefined und Unsinn', () => {
    for (const input of [null, undefined, 42, 'nein', []]) {
      expect(readProjectGateConfig(input)).toEqual(EMPTY_GATE_CONFIG);
    }
  });
});

describe('gateUnavailableReason — die Wache ohne einen Gegenstand', () => {
  /*
   * Bis A115 trug `legal` dieses Feld, und zwei Tests benutzten es als
   * Beispiel. Mit Lena ist kein Katalogeintrag mehr unverfügbar — der
   * Mechanismus wäre also ab sofort ungeprüft, obwohl er weiterlebt und beim
   * nächsten noch nicht gebauten Gate wieder trägt. Eine synthetische
   * Definition hält ihn fest, ohne dass ein echtes Gate dafür kaputt sein muss.
   */
  const spec = (availableFrom: string | null): GateDefinition => ({
    id: 'legal',
    label: 'Beispiel-Gate',
    description: 'Nur für diesen Test.',
    locked: false,
    kind: 'internal',
    needsCommand: false,
    availableFrom,
  });

  it('nennt den Grund, solange das Gate wartet', () => {
    expect(gateUnavailableReason(spec('Die Abteilung entsteht in Phase 9.'))).toBe(
      'Die Abteilung entsteht in Phase 9.',
    );
  });

  it('antwortet null, sobald es gebaut ist', () => {
    expect(gateUnavailableReason(spec(null))).toBeNull();
  });

  it('hat heute keinen Gegenstand im Katalog — und das ist eine Aussage, keine Lücke', () => {
    // Wird das je wieder falsch, ist ein Gate katalogisiert, aber unbaubar —
    // dann muss jemand die beiden Wege oben wieder gegen *dieses* Gate prüfen.
    expect(GATE_CATALOGUE.filter((gate) => gateUnavailableReason(gate) !== null)).toEqual([]);
  });
});
