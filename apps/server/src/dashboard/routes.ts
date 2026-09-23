import { Effect } from "effect";
import { guard, json, withChange } from "../capabilities/web.ts";
import { summaryOf } from "./server/index.ts";

export const dashboardRoutes = guard({
  // The facts a change's card on the overview shows — terminals from the core, the rest from
  // the extensions. One request per card, so a change whose CLIs are slow holds up only its
  // own card.
  "/api/changes/:id/summary": {
    GET: (req) => withChange(req.params.id, (c) => Effect.map(summaryOf(c), json)),
  },
});
