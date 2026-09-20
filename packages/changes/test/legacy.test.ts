import { expect, test } from "bun:test"

import { ChangeId, DirectoryName, RepositoryId } from "@corvi/contracts/changes"
import { mapLegacyPhase, projectLegacyChange, projectLegacyRepositories } from "../src/legacy.ts"

test("legacy phases map onto the new vocabulary", () => {
  expect(mapLegacyPhase("Ideation")).toBe("Ideation")
  expect(mapLegacyPhase("In Progress")).toBe("Implementation")
  expect(mapLegacyPhase("Awaiting Review")).toBe("Verification")
  expect(mapLegacyPhase("Blocked")).toBe("Blocked")
  expect(mapLegacyPhase("Completed")).toBe("Completed")
  expect(mapLegacyPhase("Cancelled")).toBe("Cancelled")
  expect(mapLegacyPhase(undefined)).toBe("Implementation")
})

test("legacy repositories project to links with deterministic ids", () => {
  const links = projectLegacyRepositories({
    id: "demo",
    repos: ["/sources/one", "/sources/two"],
    direct: ["/sources/two"],
  })
  expect(links.map((link) => link.repositoryId)).toEqual([
    RepositoryId.make("demo:one"),
    RepositoryId.make("demo:two"),
  ])
  expect(links.map((link) => link.directoryName)).toEqual([
    DirectoryName.make("one"),
    DirectoryName.make("two"),
  ])
  expect(links[0]?.checkoutMethod).toBe("UseNewLocationNewBranch")
  expect(links[1]?.checkoutMethod).toBe("UseOriginalLocationNewBranch")
})

test("legacy change projections default the branch and keep the workspace location", () => {
  const change = projectLegacyChange({ id: "demo", createdAt: "2026-01-01T00:00:00.000Z" }, "/changes/demo")
  expect(change.changeId).toBe(ChangeId.make("demo"))
  expect(change.title).toBe("demo")
  expect(change.branch).toBe("demo")
  expect(change.phase).toBe("Implementation")
  expect(change.workspaceLocation).toBe("/changes/demo")
})
