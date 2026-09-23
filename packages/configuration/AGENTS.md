# @corvi/configuration

## Owns

The configuration vocabulary and the settings precedence chain.

- `./config`: what a workspace is, the settings shape both scopes hold (`SettingsOverrides`),
  what the resolved config holds (`Config`, `EffectiveSettings`), the config file's write
  shape, and the fallbacks (`DEFAULT_WORKSPACE`, `DEFAULT_IDEATION_PROMPT`). Pure.
- `./settings`: `resolveSetting` (environment variable > workspace > global > fallback),
  `settingsFor` (what applies in one scope), the bag readers (`bagString`, `bagList`), and the
  override readers the settings page locks fields with. Environment variable *names* are the
  app's (`ENV_OVERRIDES`); this reads the names it is handed. The one exception to the chain is
  a `secret` setting: its variable is a fallback, not an override.
- `./workspaces`: which workspace a change belongs to, and the one enablement rule
  (`extensionsFor`, `extensionEnabled`: the workspace's `extensions` list over the global one,
  no list meaning all of them).

## Does not own

Reading and writing the config file, path defaults, migrations, the runtime snapshot, or
integration execution. The app's workspace server does the file I/O, builds `ENV_OVERRIDES`
from the product's identity, injects the workspace migrator, and refills the one snapshot the
runtime holds.

## Public entrypoints

- `@corvi/configuration/config`: `Workspace`, `SettingsOverrides`, `EffectiveSettings`, `Config`,
  `ConfigFile`, `DEFAULT_WORKSPACE`, `DEFAULT_IDEATION_PROMPT`
- `@corvi/configuration/settings`: `SettingBag`, `resolveSetting`, `settingsFor`, `bagString`,
  `bagList`, `envOverride`, `overriddenSettings`, `overriddenExtensionSettings`,
  `SettingDeclaration`, `SettingsHolder`
- `@corvi/configuration/workspaces`: `workspaceById`, `workspaceOf`, `extensionsFor`,
  `extensionEnabled`

## Dependencies

`@corvi/contracts` (the default workspace value and the shared schema it is typed against).
`resolveSetting` reads `process.env` by name; no Node imports and nothing browser-unsafe.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
