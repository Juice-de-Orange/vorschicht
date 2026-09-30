/**
 * §12s Release-Historie gegen das Repository prüfen (§22, Phase-5-Gate G8).
 *
 * Der Gate-Satz lautet „release history complete and consistent with git", und
 * das sind **drei** Fragen, nicht eine — jede kann für sich falsch sein, und
 * eine gemeinsame Antwort würde die anderen beiden verdecken:
 *
 *   1. **Existiert der Commit?** `deployments.sha` ist die einzige Angabe, die
 *      sagt, *was* ausgeliefert wurde. Ein Wert, den `git rev-parse` nicht
 *      auflöst, macht den Datensatz unbrauchbar und einen Rollback
 *      unauffindbar — und genau das war der Zustand vor A88, als jeder Rollout
 *      als `HEAD` oder als Branchname aufgezeichnet wurde.
 *   2. **Gehört er zum Integrationszweig?** §12 rollt aus, was ein grüner Merge
 *      erzeugt hat. Ein Release, dessen Commit kein Vorfahr des Zielzweigs ist,
 *      beschreibt Code, der nie zusammengeführt wurde — ausgeliefert wäre dann
 *      etwas, das im Repository nicht als Stand existiert.
 *   3. **Ist die Aufzeichnung vollständig?** Ein Deployment ohne terminales
 *      Ereignis (`outcome IS NULL`) ist entweder gerade unterwegs oder es ist
 *      abgestürzt, ohne etwas zu hinterlassen. Das erste ist normal, das zweite
 *      ist eine Lücke — unterschieden wird über das Alter, weil es kein anderes
 *      Signal gibt, und die Schwelle ist großzügig gewählt: eine falsch
 *      gemeldete Lücke kostet einen Blick, eine übersehene kostet den Nachweis.
 *
 * **Diese Datei entscheidet nichts und schreibt nichts.** Sie liest die Sicht
 * und das Repository und sagt, wo beide auseinandergehen — dieselbe Trennung,
 * die `DeployRecords` schon zieht (A48.2): wer die Wahrheit ändern kann, darf
 * nicht auch beurteilen, ob sie stimmt. Der Aufrufer ist heute ein Test und
 * beim Phasenabschluss der Prüfbericht; ein Ops-Kommando kann später denselben
 * Weg nehmen.
 *
 * **Fail closed, wie überall an dieser Naht.** Ein Repository, das nicht gelesen
 * werden kann, ist ein `unreadable_repo`-Befund und kein grünes Ergebnis —
 * „wir konnten nicht nachsehen" und „es stimmt" sind derselbe Satz nur für ein
 * System, das sich entschieden hat, nicht hinzusehen (A83.6, A87.6).
 */
import { isAncestor, isGitRepository, resolveCommit } from '../git.js';
import type { DeploymentRecord } from './records.js';

/** Wie lange ein Deployment ohne Abschluss als „unterwegs" gilt. */
export const UNFINISHED_GRACE_MS = 60 * 60_000;

export type HistoryProblemKind =
  /** Der Commit ist im Repository nicht auffindbar. */
  | 'unknown_commit'
  /** Er existiert, gehört aber nicht zur Historie des Integrationszweigs. */
  | 'not_on_branch'
  /** Kein terminales Ereignis, und zu alt, um noch unterwegs zu sein. */
  | 'unfinished'
  /** Das Repository selbst war nicht lesbar — nichts wurde geprüft. */
  | 'unreadable_repo';

export interface HistoryProblem {
  kind: HistoryProblemKind;
  /** Null bei `unreadable_repo`: der Befund betrifft dann kein einzelnes Release. */
  deploymentId: string | null;
  sha: string | null;
  /** Deutsch (§2) — dieser Satz landet im Prüfbericht. */
  detail: string;
}

export interface HistoryAuditResult {
  projectId: string;
  /** Wie viele Datensätze angesehen wurden. Null ist ein gültiges Ergebnis. */
  checked: number;
  problems: HistoryProblem[];
  ok: boolean;
}

export interface HistoryAuditDeps {
  /** Absoluter Pfad zum Checkout des Projekts. */
  repo: string;
  /** Der Zweig, auf den §12 ausrollt — `projects.default_branch`. */
  branch: string;
  releases: readonly DeploymentRecord[];
  now?: () => number;
}

export async function auditReleaseHistory(
  projectId: string,
  deps: HistoryAuditDeps,
): Promise<HistoryAuditResult> {
  const now = deps.now?.() ?? Date.now();
  const problems: HistoryProblem[] = [];

  if (!(await isGitRepository(deps.repo))) {
    return {
      projectId,
      checked: 0,
      ok: false,
      problems: [
        {
          kind: 'unreadable_repo',
          deploymentId: null,
          sha: null,
          detail: `„${deps.repo}" ist kein lesbares git-Repository — die Historie konnte nicht gegen den Baum geprüft werden.`,
        },
      ],
    };
  }

  // Der Zweig einmal auflösen: existiert er nicht, ist jede weitere Aussage
  // über „gehört zur Historie" gegenstandslos, und das ist eine Eigenschaft des
  // Projekts und nicht eines einzelnen Releases.
  let branchSha: string | null = null;
  try {
    branchSha = await resolveCommit(deps.repo, deps.branch);
  } catch {
    problems.push({
      kind: 'unreadable_repo',
      deploymentId: null,
      sha: null,
      detail: `Der Integrationszweig „${deps.branch}" existiert in „${deps.repo}" nicht — ohne ihn ist nicht entscheidbar, ob ein Release zum Stand gehört.`,
    });
  }

  for (const release of deps.releases) {
    if (release.outcome === null) {
      const alter = now - release.startedAt.getTime();
      if (alter > UNFINISHED_GRACE_MS) {
        problems.push({
          kind: 'unfinished',
          deploymentId: release.id,
          sha: release.sha,
          detail: `Deployment ${release.id} hat seit ${Math.round(alter / 60_000)} Minuten kein Ergebnis — zuletzt „${release.lastStep ?? 'nichts protokolliert'}".`,
        });
      }
      // Ein laufendes Deployment wird nicht gegen git geprüft: sein Commit ist
      // schon zugesagt, aber der Datensatz ist noch nicht das, worüber dieses
      // Gate eine Aussage macht.
      continue;
    }

    let aufgeloest: string | null = null;
    try {
      aufgeloest = await resolveCommit(deps.repo, release.sha);
    } catch {
      problems.push({
        kind: 'unknown_commit',
        deploymentId: release.id,
        sha: release.sha,
        detail: `Deployment ${release.id} nennt „${release.sha}", und git kennt diesen Commit nicht.`,
      });
      continue;
    }

    if (branchSha === null) continue;
    if (!(await isAncestor(deps.repo, aufgeloest, branchSha))) {
      problems.push({
        kind: 'not_on_branch',
        deploymentId: release.id,
        sha: release.sha,
        detail: `Deployment ${release.id} rollte ${release.sha.slice(0, 10)} aus, das nicht in der Historie von „${deps.branch}" liegt — ausgeliefert wurde Code, der dort nie zusammengeführt wurde.`,
      });
    }
  }

  return { projectId, checked: deps.releases.length, problems, ok: problems.length === 0 };
}
