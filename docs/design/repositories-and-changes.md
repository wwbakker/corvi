# Repository capabilities and change workflows

Status: proposed step-1 design. No workspace packages or production APIs
are implemented. This is the contract specification for the first slice, not another migration
plan; execution remains in the [architecture refactor plan](../plans/architecture-refactor.md).

High-level outline for changes and repositories.

# Change
## Fields
- changeId
- title
- phase = 'Ideation' | 'Implementation' | 'Verification' | 'Blocked' | 'Completed' | 'Cancelled'
## Interface ChangeService
- listChanges(filter: 'Active' | 'Archived')
- createChange(changeId, title)
- transitionTo(changeId)
- onPhaseTransition(changeId, oldPhase, newPhase)


# Repository (depends on Change)
## Fields
- changeId
- directoryName
- originalLocation
- checkoutMethod: 'UseOriginalLocationOriginalBranch' | 'UseOriginalLocationNewBranch' | 'UseNewLocationNewBranch'
- checkoutLocation # derived
- state: 'Concept' | 'Active' | 'Archived' # derived from change

## Interface RepositoryService
- listRepositories(changeId)
- addRepository(changeId, directoryName, originalLocation, checkoutMethod)
- removeRepository(changeId)

