// On-device article chat (D27, D31): one intent per turn, mapped by the app to
// the executors the cloud chat calls (proposeTrack, proposeChanges,
// applyProposal, cancelProposal). Fact checks and web searches stay cloud-only.
// RN-free, so the harness builds the same prompt.
export * from './schema';
export * from './prompt';
export * from './parse';
