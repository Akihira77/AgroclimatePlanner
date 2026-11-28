# ADR-009 — Recompute Fan-Out Security Design (`OPEN-27`)

- Status: **Accepted** — design locked 2026-11-28 by project owner (**Akihira77**); implementation of the worker fan-out sweep remains deferred until the recomputation worker is enabled.
- Date: 2026-11-28
- Deciders: project owner (**Akihira77**); security design prepared by the orchestrator.
- Depends on: `ADR-003` (trusted tenant context `withTenant` and role boundary), `docs/data-model/ownership-and-rls.md` §2.

---

## 1. Context

When a weather ingestion job completes for `(provider, model, cell_key)`, the worker (`app_system`, `BYPASSRLS`) needs to discover which fields are mapped to that cell in `app.field_outlook_cells` so it can enqueue per-field `recompute.windows` jobs.

Granting `app_system` direct `SELECT` on `app.field_outlook_cells` would expose tenant-owned tables to a `BYPASSRLS` role, violating `ownership-and-rls.md` §2 rule 2.

---

## 2. Decision (Hybrid Approach)

1. **User-triggered mutations (API):**
   - Changes made by the user through the API (field geometry, agronomy profile, field observations) enqueue per-field recomputation jobs directly from the authenticated `app_api` request context (`withTenant`).
2. **Post-ingestion weather fan-out (Worker):**
   - A narrow `SECURITY DEFINER` discovery function owned by `migration_owner` performs cell-to-field lookup without granting `app_system` any table privilege on `app.field_outlook_cells` or `app.fields`:

   ```sql
   CREATE FUNCTION app.discover_fields_for_cell(
     p_provider text,
     p_model    text,
     p_cell_key text
   )
     RETURNS TABLE (field_id uuid, user_id uuid)
     LANGUAGE sql
     STABLE
     SECURITY DEFINER
     SET search_path = pg_catalog, app
   AS $$
     SELECT foc.field_id, foc.user_id
       FROM app.field_outlook_cells foc
       JOIN app.outlook_cells oc ON oc.id = foc.outlook_cell_id
       JOIN app.fields f ON f.id = foc.field_id AND f.user_id = foc.user_id
      WHERE foc.provider = p_provider
        AND foc.model = p_model
        AND oc.cell_key = p_cell_key
        AND foc.superseded_at IS NULL
        AND f.deleted_at IS NULL;
   $$;

   REVOKE ALL ON FUNCTION app.discover_fields_for_cell(text, text, text) FROM PUBLIC;
   GRANT EXECUTE ON FUNCTION app.discover_fields_for_cell(text, text, text) TO app_system;
   ```

3. **Recomputation execution:**
   - Every enqueued `recompute.windows` job executes all reads and writes of tenant artifacts (`suitability_runs`, `planting_windows`, `ai_briefings`) strictly under **`app_api` + `withTenant(user_id)`** with `FORCE` RLS active.

---

## 3. Security Properties

- `app_system` retains **zero** `SELECT`/`INSERT`/`UPDATE`/`DELETE` grants on any tenant-owned table.
- `SET search_path = pg_catalog, app` prevents search-path hijacking.
- Only `(field_id, user_id)` pairs are returned — no geometry, soil, pH, email, or observation data leaves the function.
- `REVOKE ALL FROM PUBLIC` ensures `app_api` and `app_auth` cannot execute cross-tenant discovery.
