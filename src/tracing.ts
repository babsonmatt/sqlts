import { channel } from "node:diagnostics_channel";
import { subscribeQueries } from "./query-events.ts";
/** Enable Node/Bun diagnostics_channel events; unsubscribe to remove all instrumentation. */
export function enableQueryTracing(): () => void {
  const events = channel("sqlts:query");
  return subscribeQueries((event) => {
    if (events.hasSubscribers) events.publish(event);
  });
}
