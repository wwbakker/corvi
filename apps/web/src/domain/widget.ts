/** The widget vocabulary (`@corvi/contracts/api`) and the display rule that goes with it
 * (`@corvi/contracts/display`), re-exported so the browser half imports one module. */
export type {
  SummaryFactDto as SummaryFact,
  WidgetDto as Widget,
  WidgetItemDto as WidgetItem,
  WidgetStateDto as WidgetState,
} from "@corvi/contracts/api";
export { worst } from "@corvi/contracts/display";
