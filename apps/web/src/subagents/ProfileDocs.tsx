/** The profile file's field documentation, rendered beside its editor. The vocabulary is
 * `@corvi/agents/fields`'; the panel itself is the shared `FieldDocs`. */
import { type JSX } from "react";
import { profileFieldDocs } from "@corvi/agents/fields";

import { FieldDocs } from "../app-root/FieldDocs.tsx";

export function ProfileDocs({ highlight }: { highlight?: string }): JSX.Element {
  return (
    <FieldDocs
      docs={profileFieldDocs}
      title="The profile file"
      ariaLabel="profile file documentation"
      highlight={highlight}
    />
  );
}
