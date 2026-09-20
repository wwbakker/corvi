import { expect, test } from "bun:test"

import { Change, ChangeId, DirectoryName, Repository, RepositoryId } from "@corvi/contracts/changes"
import { allowedTransition, checkoutLocationOf, isFinished, stateOf } from "../src/rules.ts"

const change = (phase: Change["phase"]): Change =>
  new Change({
    changeId: ChangeId.make("example"),
    title: "Example",
    workspaceLocation: "/workspace/example",
    branch: "example",
    phase,
    createdAt: "2026-01-01T00:00:00.000Z",
  })

const link = (checkoutMethod: Repository["checkoutMethod"]): Repository =>
  new Repository({
    changeId: ChangeId.make("example"),
    repositoryId: RepositoryId.make("repo"),
    directoryName: DirectoryName.make("repo"),
    originalLocation: "/sources/repo",
    checkoutMethod,
  })

test("only Ideation leaves for Implementation or Cancelled, and terminal phases are final", () => {
  expect(allowedTransition("Ideation", "Implementation")).toBe(true)
  expect(allowedTransition("Ideation", "Cancelled")).toBe(true)
  expect(allowedTransition("Ideation", "Completed")).toBe(false)
  expect(allowedTransition("Ideation", "Blocked")).toBe(false)
  expect(allowedTransition("Implementation", "Verification")).toBe(true)
  expect(allowedTransition("Verification", "Blocked")).toBe(true)
  expect(allowedTransition("Blocked", "Implementation")).toBe(true)
  expect(allowedTransition("Implementation", "Completed")).toBe(true)
  expect(allowedTransition("Completed", "Implementation")).toBe(false)
  expect(allowedTransition("Cancelled", "Cancelled")).toBe(false)
})

test("finished means done in either direction", () => {
  expect(isFinished(change("Completed"))).toBe(true)
  expect(isFinished(change("Cancelled"))).toBe(true)
  expect(isFinished(change("Implementation"))).toBe(false)
  expect(isFinished(change("Ideation"))).toBe(false)
})

test("the row state projects the change phase", () => {
  expect(stateOf(change("Ideation"))).toBe("Concept")
  expect(stateOf(change("Implementation"))).toBe("Active")
  expect(stateOf(change("Verification"))).toBe("Active")
  expect(stateOf(change("Blocked"))).toBe("Active")
  expect(stateOf(change("Completed"))).toBe("Archived")
  expect(stateOf(change("Cancelled"))).toBe("Archived")
})

test("the checkout location follows the method", () => {
  const example = change("Implementation")
  expect(checkoutLocationOf(example, link("UseNewLocationNewBranch"))).toBe("/workspace/example/repo")
  expect(checkoutLocationOf(example, link("UseOriginalLocationOriginalBranch"))).toBe("/sources/repo")
  expect(checkoutLocationOf(example, link("UseOriginalLocationNewBranch"))).toBe("/sources/repo")
})
