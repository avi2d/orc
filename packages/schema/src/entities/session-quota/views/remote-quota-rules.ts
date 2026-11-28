export const staleAfterMillis = 5 * 60_000;

// quota-axi reads the vendor's reset instant on each machine, so one cycle of one account agrees to well inside a minute.
export const sameCycleMillis = 60_000;
