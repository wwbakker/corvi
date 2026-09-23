import { expect, test } from "bun:test"

import { mapLegacyState, migrateRecord } from "../src/legacy.ts"

test("legacy states map onto the current vocabulary", () => {
  expect(mapLegacyState("Ideation")).toBe("Ideation")
  expect(mapLegacyState("In Progress")).toBe("Implementation")
  expect(mapLegacyState("Awaiting Review")).toBe("Verification")
  expect(mapLegacyState("Blocked")).toBe("Blocked")
  expect(mapLegacyState("Completed")).toBe("Completed")
  expect(mapLegacyState("Cancelled")).toBe("Cancelled")
  expect(mapLegacyState(undefined)).toBe("Implementation")
})

test("a legacy record migrates to checkouts with the legacy cell meanings", () => {
  const migrated = migrateRecord({
    id: "demo",
    repos: ["/sources/one", "/sources/two"],
    direct: ["/sources/two"],
    base: { "/sources/two": "feature" },
    state: "In Progress",
    createdAt: "2026-01-01T00:00:00.000Z",
  })
  expect(migrated.formatVersion).toBe(2)
  expect(migrated.state).toBe("Implementation")
  // `direct` is the one original-location kind v1 knew, every v1 row's branch is the change's
  // own, and a `base` entry becomes both base and target: one field served both roles before
  // the split, so the migration preserves what a pull request targeted.
  expect(migrated.checkouts).toEqual([
    { path: "/sources/one", location: "new", branch: { kind: "change" } },
    {
      path: "/sources/two",
      location: "original",
      branch: { kind: "change" },
      base: "feature",
      target: "feature",
    },
  ])
})

test("migration drops the v1 fields and keeps everything it does not know", () => {
  const migrated = migrateRecord({
    id: "demo",
    repos: ["/sources/one"],
    direct: [],
    base: {},
    repositories: [{ anything: true }],
    title: "Demo",
    branch: "demo",
    state: "Awaiting Review",
    extensions: { jira: { key: "X-1" } },
    somethingANewerVersionAdded: "kept",
  })
  expect(migrated.state).toBe("Verification")
  expect(migrated.title).toBe("Demo")
  expect(migrated.branch).toBe("demo")
  expect(migrated.extensions).toEqual({ jira: { key: "X-1" } })
  expect(migrated.somethingANewerVersionAdded).toBe("kept")
  expect("repos" in migrated).toBe(false)
  expect("direct" in migrated).toBe(false)
  expect("base" in migrated).toBe(false)
  expect("repositories" in migrated).toBe(false)
})
