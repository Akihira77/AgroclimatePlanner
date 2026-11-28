/**
 * Assertion logic of the privilege verifier, exercised without a database.
 *
 * The verifier itself drives four real logins and a cluster-admin re-bootstrap,
 * which is why it has no unit test. These three groups are the ones a reviewer
 * most needs to trust: the session table must be present under its exact
 * identity, every role must be provably unable to replicate, and the
 * `app.users` grant must be exactly the approved column set rather than a
 * superset. All are pure functions of an already fetched row, so they are
 * extracted and driven here through a recording `check`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkAuthUserColumnGrants,
  checkRoleAttributes,
  checkSessionTable,
  checkUsersPolicyInventory,
} from "../../scripts/lib/privilege-verification.mjs";

/** Mirrors `check(label, passed, detail)` in the verifier. */
function recorder() {
  const calls = [];
  return {
    calls,
    check(label, passed, detail) {
      calls.push({ label, passed, detail });
    },
  };
}

const INTENDED_ROLE = {
  rolsuper: false,
  rolcanlogin: true,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: false,
  rolreplication: false,
};

describe("role attribute assertions", () => {
  it("passes a role that carries exactly the intended attributes", () => {
    const log = recorder();
    checkRoleAttributes(log.check, "app_auth", INTENDED_ROLE);

    assert.equal(log.calls.length, 6);
    assert.deepEqual(
      log.calls.filter((call) => call.passed === false),
      [],
    );
    for (const call of log.calls) {
      assert.match(call.label, /^app_auth /, "every label names the role");
      assert.equal(call.detail, undefined);
    }
  });

  it("fails when a role can replicate", () => {
    const log = recorder();
    checkRoleAttributes(log.check, "app_auth", { ...INTENDED_ROLE, rolreplication: true });

    const failed = log.calls.filter((call) => call.passed === false);
    assert.deepEqual(
      failed.map((call) => call.label),
      ["app_auth cannot replicate"],
    );
  });

  it("fails each attribute independently, including a missing column", () => {
    for (const [field, wrongValue, label] of [
      ["rolsuper", true, "is not a superuser"],
      ["rolcreatedb", true, "cannot create databases"],
      ["rolcreaterole", true, "cannot create roles"],
      ["rolcanlogin", false, "can log in"],
      ["rolinherit", true, "does not inherit privileges"],
      ["rolreplication", true, "cannot replicate"],
    ]) {
      const log = recorder();
      checkRoleAttributes(log.check, "app_system", { ...INTENDED_ROLE, [field]: wrongValue });

      const failed = log.calls.filter((call) => call.passed === false);
      assert.equal(failed.length, 1, `${field} must fail exactly one assertion`);
      assert.equal(failed[0].label, `app_system ${label}`);
    }

    // A row that never selected the column yields `undefined`, which is not
    // `false`: the assertion has to fail rather than treat absence as a pass.
    const log = recorder();
    const { rolreplication: _omitted, ...withoutReplication } = INTENDED_ROLE;
    checkRoleAttributes(log.check, "app_api", withoutReplication);
    assert.deepEqual(
      log.calls.filter((call) => call.passed === false).map((call) => call.label),
      ["app_api cannot replicate"],
    );
  });
});

describe("session table assertion", () => {
  it("passes a relation that is app.sessions, a regular table", () => {
    const log = recorder();
    checkSessionTable(log.check, {
      oid: "12345",
      relname: "sessions",
      nspname: "app",
      relkind: "r",
    });

    assert.equal(log.calls.length, 4);
    assert.deepEqual(
      log.calls.filter((call) => call.passed === false),
      [],
    );
  });

  it("fails, rather than staying silent, when the relation is missing", () => {
    const log = recorder();
    checkSessionTable(log.check, null);

    assert.equal(log.calls.length, 4);
    assert.deepEqual(
      log.calls.map((call) => call.passed),
      [false, false, false, false],
    );
  });
});

describe("app.users column grant assertion", () => {
  const APPROVED = {
    select_columns: ["id", "email", "password_hash", "role", "locale", "timezone", "deleted_at"],
    insert_columns: ["email", "password_hash"],
    update_columns: [],
  };

  it("passes on exactly the approved set, in any order", () => {
    const log = recorder();
    checkAuthUserColumnGrants(log.check, {
      ...APPROVED,
      select_columns: ["timezone", "id", "role", "email", "locale", "password_hash", "deleted_at"],
    });

    assert.deepEqual(
      log.calls.map((call) => call.passed),
      [true, true, true],
    );
  });

  it("fails when an eighth column is readable, even though the seven are present", () => {
    const log = recorder();
    checkAuthUserColumnGrants(log.check, {
      ...APPROVED,
      select_columns: [...APPROVED.select_columns, "created_at"],
    });

    assert.deepEqual(
      log.calls.filter((call) => call.passed === false).map((call) => call.label),
      ["app_auth SELECTs exactly the seven approved columns of app.users"],
    );
    assert.match(log.calls[0].detail, /created_at/);
  });

  it("fails when an approved column is missing", () => {
    const log = recorder();
    checkAuthUserColumnGrants(log.check, {
      ...APPROVED,
      select_columns: APPROVED.select_columns.filter((name) => name !== "password_hash"),
    });

    assert.equal(log.calls[0].passed, false);
  });

  it("fails on a duplicate that pads the set to the right length", () => {
    const log = recorder();
    checkAuthUserColumnGrants(log.check, {
      ...APPROVED,
      insert_columns: ["email", "email"],
    });

    assert.equal(log.calls[1].passed, false);
  });

  it("fails when INSERT widens beyond email and password_hash", () => {
    const log = recorder();
    checkAuthUserColumnGrants(log.check, {
      ...APPROVED,
      insert_columns: [...APPROVED.insert_columns, "role"],
    });

    assert.deepEqual(
      log.calls.filter((call) => call.passed === false).map((call) => call.label),
      ["app_auth INSERTs exactly the two approved columns of app.users"],
    );
  });

  it("fails on any UPDATE column", () => {
    const log = recorder();
    checkAuthUserColumnGrants(log.check, { ...APPROVED, update_columns: ["locale"] });

    assert.deepEqual(
      log.calls.filter((call) => call.passed === false).map((call) => call.label),
      ["app_auth holds UPDATE on no column of app.users"],
    );
    assert.match(log.calls[2].detail, /locale/);
  });

  it("treats a missing row as a denial rather than as silence", () => {
    const log = recorder();
    checkAuthUserColumnGrants(log.check, {});

    assert.deepEqual(
      log.calls.map((call) => call.passed),
      [false, false, true],
    );
  });
});

describe("app.users policy inventory assertion", () => {
  // The shapes `pg_policies` returned on PostgreSQL 18.6 after S4, including the
  // normalised tenant predicate. `roles` stays an array here because the verifier
  // selects `roles::text[]`; the string form is covered separately.
  const TENANT_PREDICATE =
    "(id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)";

  const policies = () => [
    {
      policyname: "users_auth_lookup",
      cmd: "SELECT",
      permissive: "PERMISSIVE",
      roles: ["app_auth"],
      qual: "true",
      with_check: null,
    },
    {
      policyname: "users_auth_register",
      cmd: "INSERT",
      permissive: "PERMISSIVE",
      roles: ["app_auth"],
      qual: null,
      with_check: "true",
    },
    {
      policyname: "users_owner_full_access",
      cmd: "ALL",
      permissive: "PERMISSIVE",
      roles: ["migration_owner"],
      qual: "true",
      with_check: "true",
    },
    {
      policyname: "users_self_only",
      cmd: "ALL",
      permissive: "PERMISSIVE",
      roles: ["app_api"],
      qual: TENANT_PREDICATE,
      with_check: TENANT_PREDICATE,
    },
  ];

  const failing = (log) =>
    log.calls.filter((call) => call.passed === false).map((call) => call.label);

  it("passes on exactly the four recorded policies", () => {
    const log = recorder();
    checkUsersPolicyInventory(log.check, policies());

    assert.equal(log.calls.length, 7);
    assert.deepEqual(
      log.calls.map((call) => call.passed),
      [true, true, true, true, true, true, true],
    );
  });

  it("fails when an expected policy is missing", () => {
    const log = recorder();
    checkUsersPolicyInventory(
      log.check,
      policies().filter((policy) => policy.policyname !== "users_self_only"),
    );

    assert.deepEqual(failing(log), [
      "app.users carries exactly the four expected policies",
      "users_self_only has its recorded command, roles, USING and WITH CHECK",
    ]);
  });

  it("fails on an unexpected additional policy", () => {
    const log = recorder();
    checkUsersPolicyInventory(log.check, [
      ...policies(),
      {
        policyname: "users_everyone",
        cmd: "SELECT",
        permissive: "PERMISSIVE",
        roles: ["app_api"],
        qual: "true",
        with_check: null,
      },
    ]);

    assert.equal(log.calls[0].passed, false);
    assert.match(log.calls[0].detail, /users_everyone/);
    assert.equal(log.calls.length, 7);
  });

  it("fails when an expected policy changes command", () => {
    const log = recorder();
    const mutated = policies();
    mutated.find((policy) => policy.policyname === "users_auth_lookup").cmd = "ALL";

    checkUsersPolicyInventory(log.check, mutated);

    assert.deepEqual(failing(log), [
      "users_auth_lookup has its recorded command, roles, USING and WITH CHECK",
      "app_auth holds no FOR ALL policy on app.users",
    ]);
  });

  it("fails when an expected policy changes roles", () => {
    const log = recorder();
    const mutated = policies();
    mutated.find((policy) => policy.policyname === "users_self_only").roles = [
      "app_api",
      "app_auth",
    ];

    checkUsersPolicyInventory(log.check, mutated);

    // Adding app_auth to the tenant policy is both a changed role set and a
    // FOR ALL grant to the auth credential — two assertions, not one.
    assert.deepEqual(failing(log), [
      "users_self_only has its recorded command, roles, USING and WITH CHECK",
      "app_auth holds no FOR ALL policy on app.users",
    ]);
  });

  it("fails when the tenant predicate is widened to true", () => {
    const log = recorder();
    const mutated = policies();
    const tenant = mutated.find((policy) => policy.policyname === "users_self_only");
    tenant.qual = "true";

    checkUsersPolicyInventory(log.check, mutated);

    assert.deepEqual(failing(log), [
      "users_self_only has its recorded command, roles, USING and WITH CHECK",
    ]);
    assert.match(log.calls[4].detail, /users_self_only/);
  });

  it("fails when WITH CHECK alone is widened", () => {
    const log = recorder();
    const mutated = policies();
    const tenant = mutated.find((policy) => policy.policyname === "users_self_only");
    tenant.with_check =
      "(id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid) IS NOT NULL";

    checkUsersPolicyInventory(log.check, mutated);

    assert.deepEqual(failing(log), [
      "users_self_only has its recorded command, roles, USING and WITH CHECK",
    ]);
  });

  it("fails a multi-role policy that includes PUBLIC", () => {
    const log = recorder();
    const mutated = policies();
    mutated.find((policy) => policy.policyname === "users_auth_lookup").roles = [
      "app_auth",
      "public",
    ];

    checkUsersPolicyInventory(log.check, mutated);

    assert.deepEqual(failing(log), [
      "users_auth_lookup has its recorded command, roles, USING and WITH CHECK",
      "no policy on app.users names PUBLIC",
    ]);
  });

  it("detects PUBLIC in a policy with the other roles listed first", () => {
    const log = recorder();
    const mutated = policies();
    mutated.find((policy) => policy.policyname === "users_auth_register").roles = "public";

    checkUsersPolicyInventory(log.check, mutated);

    assert.deepEqual(failing(log), [
      "users_auth_register has its recorded command, roles, USING and WITH CHECK",
      "no policy on app.users names PUBLIC",
    ]);
  });

  it("parses the text form of roles, quoted and unquoted", () => {
    const log = recorder();
    const mutated = policies();
    for (const policy of mutated) {
      policy.roles =
        policy.roles.length === 1 ? `{${policy.roles[0]}}` : `{${policy.roles.join(",")}}`;
    }
    mutated.find((policy) => policy.policyname === "users_auth_register").roles = '{"app_auth"}';

    checkUsersPolicyInventory(log.check, mutated);

    assert.deepEqual(failing(log), []);
  });

  it("fails when the registration policy gains an unexpected USING", () => {
    const log = recorder();
    const mutated = policies();
    mutated.find((policy) => policy.policyname === "users_auth_register").qual = "true";

    checkUsersPolicyInventory(log.check, mutated);

    assert.deepEqual(failing(log), [
      "users_auth_register has its recorded command, roles, USING and WITH CHECK",
    ]);
  });

  it("fails when the lookup policy gains an unexpected WITH CHECK", () => {
    const log = recorder();
    const mutated = policies();
    mutated.find((policy) => policy.policyname === "users_auth_lookup").with_check = "true";

    checkUsersPolicyInventory(log.check, mutated);

    assert.deepEqual(failing(log), [
      "users_auth_lookup has its recorded command, roles, USING and WITH CHECK",
    ]);
  });

  it("fails a RESTRICTIVE policy, which would survive a permissive rename", () => {
    const log = recorder();
    const mutated = policies();
    mutated.find((policy) => policy.policyname === "users_owner_full_access").permissive =
      "RESTRICTIVE";

    checkUsersPolicyInventory(log.check, mutated);

    assert.deepEqual(failing(log), [
      "users_owner_full_access has its recorded command, roles, USING and WITH CHECK",
    ]);
  });
});
