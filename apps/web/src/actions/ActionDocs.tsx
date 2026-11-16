/** The action file's field documentation, rendered beside its editor. The vocabulary is
 * `@corvi/actions/fields`'; the panel itself is the shared `FieldDocs`. */
import { type JSX } from "react";
import { actionFieldDocs } from "@corvi/actions/fields";

import { FieldDocs } from "../app-root/FieldDocs.tsx";

export function ActionDocs({ highlight }: { highlight?: string }): JSX.Element {
  return (
    <FieldDocs
      docs={actionFieldDocs}
      title="The action file"
      ariaLabel="action file documentation"
      highlight={highlight}
    />
  );
}
