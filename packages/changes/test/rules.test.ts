import { expect, test } from "bun:test"

import { Change, ChangeId, DirectoryName, Repository, RepositoryId } from "@corvi/contracts/changes"
import { effectiveBranchOf } from "@corvi/contracts/changes"
import { checkoutSpecProblem, targetOf } from "../src/record.ts"
import {
  allowedTransition,
  checkoutLocationOf,
  isFinished,
  repositoryFromSpec,
  specFromRepository,
  stateOf,
} from "../src/rules.ts"

const change = (phase: Change["phase"]): Change =>
  new Change({
    changeId: ChangeId.make("example"),
    title: "Example",
    workspaceLocation: "/workspace/example",
    branch: "example",
    phase,
    createdAt: "2026-01-01T00:00:00.000Z",
  })

const link = (
  location: Repository["location"] = "new",
  branch: Repository["branch"] = { kind: "change" },
): Repository =>
  new Repository({
    changeId: ChangeId.make("example"),
    repositoryId: RepositoryId.make("repo"),
    directoryName: DirectoryName.make("repo"),
    originalLocation: "/sources/repo",
    location,
    branch,
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

test("the checkout location follows the location facet", () => {
  const example = change("Implementation")
  expect(checkoutLocationOf(example, link("new"))).toBe("/workspace/example/repo")
  expect(checkoutLocationOf(example, link("original"))).toBe("/sources/repo")
  expect(checkoutLocationOf(example, link("original", { kind: "current" }))).toBe("/sources/repo")
})

test("the effective branch follows the branch facet", () => {
  expect(effectiveBranchOf("example", { kind: "change" })).toEqual({ _tag: "Recorded", name: "example" })
  expect(effectiveBranchOf("example", { kind: "existing", name: "feature" })).toEqual({
    _tag: "Recorded",
    name: "feature",
  })
  expect(effectiveBranchOf("example", { kind: "current" })).toEqual({ _tag: "Observed" })
})

test("a spec derives the same link every time, and back", () => {
  const spec = {
    path: "/sources/repo",
    location: "original" as const,
    branch: { kind: "existing" as const, name: "feature" },
    base: "main",
    target: "main",
  }
  const derived = repositoryFromSpec(ChangeId.make("example"), spec)
  expect(derived.repositoryId).toBe(RepositoryId.make("example:repo"))
  expect(derived.directoryName).toBe(DirectoryName.make("repo"))
  expect(specFromRepository(derived)).toEqual(spec)
})

test("the combination that cannot exist is refused with a sentence", () => {
  expect(checkoutSpecProblem({ location: "new", branch: { kind: "current" } })).toBe(
    "a new worktree cannot use the branch a source checkout has checked out",
  )
  expect(checkoutSpecProblem({ location: "new", branch: { kind: "existing", name: "  " } })).toBe(
    "an existing branch must be named",
  )
  expect(checkoutSpecProblem({ location: "original", branch: { kind: "current" } })).toBeUndefined()
  expect(checkoutSpecProblem({ location: "new", branch: { kind: "change" } })).toBeUndefined()
})

test("a pull request merges into target, then into base, and both mean one thing when split", () => {
  expect(
    targetOf({ path: "/s", location: "new", branch: { kind: "change" }, base: "b", target: "t" }),
  ).toBe("t")
  // One field served both roles before they were split, so a spec without `target` still means
  // what it always meant.
  expect(targetOf({ path: "/s", location: "new", branch: { kind: "change" }, base: "b" })).toBe("b")
  expect(targetOf({ path: "/s", location: "original", branch: { kind: "current" } })).toBeUndefined()
})
