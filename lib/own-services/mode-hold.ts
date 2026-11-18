// Set while an own mode has feed-sync paused, so the auth breaker's recovery does not resume it.
let held = false;

export const holdFeedSyncForMode = (on: boolean): void => {
  held = on;
};

export const modeHoldsFeedSync = (): boolean => held;
