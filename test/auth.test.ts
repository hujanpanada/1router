import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/auth.js";

test("password hashing: verifies correct password only, salted (hashes differ)", () => {
  const a = hashPassword("hunter2");
  const b = hashPassword("hunter2");
  assert.notEqual(a, b);
  assert.ok(!a.includes("hunter2"));
  assert.equal(verifyPassword("hunter2", a), true);
  assert.equal(verifyPassword("wrong", a), false);
  assert.equal(verifyPassword("hunter2", "garbage"), false);
});

