/**
 * Projects (§5) — the one genuinely mutable table in this system.
 *
 * Everything else worth remembering is an event stream; a project is
 * configuration, and §5 says so explicitly. The consequence is that every write
 * here goes to `audit_log` as §19 requires, and that readers must not cache: a
 * gate set or a `read_only` flag that changed since the process started is the
 * *current* truth, not a stale copy.
 *
 * `read_only` is why this service exists now rather than at onboarding time
 * (Phase 3). A41 makes the pilot project analysis-only, and the component that could
 * violate that — the worktree manager — is built alongside this file.
 */
import {
  GateConfigError,
  type ProjectGateConfig,
  readProjectGateConfig,
  validateProjectGateConfig,
} from '@vorschicht/shared';
import type postgres from 'postgres';

export interface ProjectRecord {
  id: string;
  slug: string;
  name: string;
  /** Absolute path of the repository, inside the orchestrator container. */
  rootPath: string;
  repoUrl: string | null;
  /** Reference into the secret regime — never the token itself (§19, A20). */
  gitAccessRef: string | null;
  gateConfig: Record<string, unknown>;
  deployConfig: Record<string, unknown>;
  claimGranularity: string;
  /** Vorschicht itself; self-deploy always needs the operator's approval (§12, A12). */
  selfManaged: boolean;
  /** A41: may be analysed, never written to. */
  readOnly: boolean;
  /** §10: what task branches are cut from. */
  defaultBranch: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectSpec {
  slug: string;
  name: string;
  rootPath: string;
  repoUrl?: string;
  gitAccessRef?: string;
  gateConfig?: Record<string, unknown>;
  deployConfig?: Record<string, unknown>;
  claimGranularity?: string;
  selfManaged?: boolean;
  readOnly?: boolean;
  defaultBranch?: string;
  id?: string;
}

export class ProjectService {
  constructor(private readonly sql: postgres.Sql) {}

  async get(id: string): Promise<ProjectRecord | null> {
    const rows = await this.sql`SELECT * FROM projects WHERE id = ${id}`;
    return this.map(rows)[0] ?? null;
  }

  async require(id: string): Promise<ProjectRecord> {
    const project = await this.get(id);
    if (!project) throw new Error(`Projekt ${id} existiert nicht`);
    return project;
  }

  async getBySlug(slug: string): Promise<ProjectRecord | null> {
    const rows = await this.sql`SELECT * FROM projects WHERE slug = ${slug}`;
    return this.map(rows)[0] ?? null;
  }

  async listActive(): Promise<ProjectRecord[]> {
    const rows = await this.sql`SELECT * FROM projects WHERE active ORDER BY slug`;
    return this.map(rows);
  }

  /** Onboarding (§20). Audit-logged, because §19 asks for every config change. */
  async create(spec: CreateProjectSpec, actor = 'system'): Promise<ProjectRecord> {
    const rows = await this.sql`
      INSERT INTO projects (
        ${spec.id ? this.sql`id,` : this.sql``}
        slug, name, root_path, repo_url, git_access_ref,
        gate_config, deploy_config, claim_granularity,
        self_managed, read_only, default_branch
      ) VALUES (
        ${spec.id ? this.sql`${spec.id},` : this.sql``}
        ${spec.slug}, ${spec.name}, ${spec.rootPath}, ${spec.repoUrl ?? null},
        ${spec.gitAccessRef ?? null},
        ${this.sql.json((spec.gateConfig ?? {}) as postgres.JSONValue)},
        ${this.sql.json((spec.deployConfig ?? { method: 'none' }) as postgres.JSONValue)},
        ${spec.claimGranularity ?? 'file'},
        ${spec.selfManaged ?? false}, ${spec.readOnly ?? false},
        ${spec.defaultBranch ?? 'main'}
      )
      RETURNING *
    `;
    const project = this.map(rows)[0];
    if (!project) throw new Error('Projekt konnte nicht angelegt werden');
    await this.audit(actor, 'project.created', project.slug, null, project);
    return project;
  }

  /**
   * Flip the A41 boundary, in either direction.
   *
   * Deliberately its own method rather than a generic `update`: turning
   * `read_only` off is the moment an analysed repository becomes one this
   * system may write to, and that deserves a call site a reader can grep for
   * and an audit row that names it.
   */
  async setReadOnly(id: string, readOnly: boolean, actor = 'system'): Promise<ProjectRecord> {
    const before = await this.require(id);
    if (before.readOnly === readOnly) return before;
    const rows = await this.sql`
      UPDATE projects SET read_only = ${readOnly}, updated_at = now()
      WHERE id = ${id} RETURNING *
    `;
    const after = this.map(rows)[0];
    if (!after) throw new Error(`Projekt ${id} existiert nicht`);
    await this.audit(actor, 'project.read_only_changed', after.slug, before, after);
    return after;
  }

  /**
   * This project's gate configuration (§11), read leniently.
   *
   * `readProjectGateConfig` rather than the strict parse, for the reason it
   * documents: a row that reached the column some other way must not stop the
   * studio from merging, and the locked six are added by `resolveGates`
   * regardless of what the document says.
   */
  gateConfigOf(project: ProjectRecord): ProjectGateConfig {
    return readProjectGateConfig(project.gateConfig);
  }

  /**
   * Change a project's gate configuration (§11), or refuse it — audit-logged
   * either way.
   *
   * The refusal is the Phase 3 exit gate "baseline gates verified non-removable
   * via UI and API (attempt is refused + audit-logged)", and both halves are
   * load-bearing. Refusing without recording would leave an attempt to disable
   * the test gate looking exactly like no attempt at all — which is the one
   * thing an audit trail exists to distinguish (§19, §8.2 domain 7).
   *
   * `validateProjectGateConfig` is the whole of the rule; this method adds
   * persistence and the audit rows, and deliberately no second opinion about
   * what is allowed. A second copy of the rule is a second place for it to be
   * wrong.
   */
  async setGateConfig(id: string, input: unknown, actor = 'system'): Promise<ProjectRecord> {
    const before = await this.require(id);
    const result = validateProjectGateConfig(input);
    if (!result.ok || !result.config) {
      await this.audit(actor, 'project.gate_config_rejected', before.slug, before, {
        ...before,
        gateConfig: { attempted: input, errors: result.errors },
      } as ProjectRecord);
      throw new GateConfigError(result.errors);
    }
    const rows = await this.sql`
      UPDATE projects
      SET gate_config = ${this.sql.json(result.config as unknown as postgres.JSONValue)},
          updated_at = now()
      WHERE id = ${id} RETURNING *
    `;
    const after = this.map(rows)[0];
    if (!after) throw new Error(`Projekt ${id} existiert nicht`);
    await this.audit(actor, 'project.gate_config_changed', after.slug, before, after);
    return after;
  }

  /**
   * Has anybody ever deliberately changed this project's `read_only` flag?
   *
   * The question exists because a stored `read_only = false` means two entirely
   * different things and the column cannot tell them apart: *"nobody has
   * decided"* — the value a row keeps from before A85 was written — and *"the operator
   * decided"*, which A85 names as one audit-logged `setReadOnly` call. Anything
   * that re-asserts A85's decision has to honour the second while correcting the
   * first, and this is the only durable evidence that separates them. §19 keeps
   * the trail for exactly this kind of question.
   *
   * Reads the trail rather than the column, so a flag flipped by hand in SQL
   * counts as "never decided" — which is the safe direction: A44.3's read-only
   * is the restrictive setting, and the documented way to leave it leaves a row.
   */
  async readOnlyEverDecided(id: string): Promise<boolean> {
    const [row] = await this.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE action = 'project.read_only_changed' AND subject = (
        SELECT slug FROM projects WHERE id = ${id}
      )
    `;
    return (row?.n ?? 0) > 0;
  }

  private async audit(
    actor: string,
    action: string,
    subject: string,
    before: ProjectRecord | null,
    after: ProjectRecord | null,
  ): Promise<void> {
    await this.sql`
      INSERT INTO audit_log (actor, action, subject, before, after)
      VALUES (
        ${actor}, ${action}, ${subject},
        ${before ? this.sql.json(before as unknown as postgres.JSONValue) : null},
        ${after ? this.sql.json(after as unknown as postgres.JSONValue) : null}
      )
    `;
  }

  // biome-ignore lint/suspicious/noExplicitAny: postgres.js row shape is dynamic
  private map(rows: any[]): ProjectRecord[] {
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      rootPath: row.root_path,
      repoUrl: row.repo_url,
      gitAccessRef: row.git_access_ref,
      gateConfig: row.gate_config ?? {},
      deployConfig: row.deploy_config ?? {},
      claimGranularity: row.claim_granularity,
      selfManaged: row.self_managed,
      readOnly: row.read_only,
      defaultBranch: row.default_branch,
      active: row.active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
