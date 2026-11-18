// Set while an own mode owns feed-sync, so the auth breaker neither pauses nor resumes it.
let held = false;

export const holdFeedSyncForMode = (on: boolean): void => {
  held = on;
};

export const modeHoldsFeedSync = (): boolean => held;
