// Nielsen's response-time limits (Usability Engineering, 1993): within a second a person's flow of thought holds.
export const flowLimitMillis = 1_000;

// Within ten seconds a person's attention stays on the dialogue.
export const attentionLimitMillis = 10_000;

// A slow fixture answers this late, longer than the flow limit, so a frame that waits for one answer more than it needs to
// overruns its budget.
export const slowReadMillis = 2 * flowLimitMillis;
