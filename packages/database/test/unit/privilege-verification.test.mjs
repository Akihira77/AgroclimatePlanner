/**
 * Assertion logic of the privilege verifier, exercised without a database.
 *
 * The verifier itself drives four real logins and a cluster-admin re-bootstrap,
 * which is why it has no unit test. These three groups are the ones a reviewer
 * most needs to trust: the session table must be provably absent, every role must
 * be provably unable to replicate, and the `app.users` grant must be exactly the
 * approved column set rather than a superset. All are pure functions of an
 * already fetched row, so they are extracted and driven here through a recording
 * `check`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkAuthUserColumnGrants,
  checkRoleAttributes,
  checkSessionAbsence,
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

describe("session absence assertion", () => {
  it("passes when the relation is missing", () => {
    const log = recorder();
    checkSessionAbsence(log.check, null);

    assert.equal(log.calls.length, 1);
    assert.deepEqual(log.calls[0], {
      label: "app.sessions is absent before S5",
      passed: true,
      detail: undefined,
    });
  });

  it("fails, rather than staying silent, when the relation exists", () => {
    const log = recorder();
    checkSessionAbsence(log.check, "app.sessions");

    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].passed, false);
    assert.match(log.calls[0].detail, /app\.sessions already exists/);
    assert.equal(log.calls[0].detail.includes("password"), false);
  });
});

describe("app.users column grant assertion", () => {
  const APPROVED = {
    select_columns: ["id", "email", "password_hash", "role", "locale", "timezone"],
    insert_columns: ["email", "password_hash"],
    update_columns: [],
  };

  it("passes on exactly the approved set, in any order", () => {
    const log = recorder();
    checkAuthUserColumnGrants(log.check, {
      ...APPROVED,
      select_columns: ["timezone", "id", "role", "email", "locale", "password_hash"],
    });

    assert.deepEqual(
      log.calls.map((call) => call.passed),
      [true, true, true],
    );
  });

  it("fails when a seventh column is readable, even though the six are present", () => {
    const log = recorder();
    checkAuthUserColumnGrants(log.check, {
      ...APPROVED,
      select_columns: [...APPROVED.select_columns, "created_at"],
    });

    assert.deepEqual(
      log.calls.filter((call) => call.passed === false).map((call) => call.label),
      ["app_auth SELECTs exactly the six approved columns of app.users"],
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
