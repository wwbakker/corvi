import { events, watchState } from "../events.ts";
import { runRoute } from "../effect/run.ts";
import { guard } from "../origin.ts";
import { json } from "./helpers.ts";

export const eventsRoutes = guard({
  // One connection that says when something changed, so no page has to keep asking. What is
  // pushed is the news, never the data: a page that hears "changes" asks for them.
  "/api/events": {
    GET: (req) => runRoute(events(req)),
  },

  // Whether the server is watching, and for how many pages. For the tests: nothing in the UI
  // asks, and nothing should.
  "/api/events/listeners": {
    GET: () => json(watchState()),
  },
});
