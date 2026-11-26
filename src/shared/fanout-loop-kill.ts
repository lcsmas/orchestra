// A process death as the tests' seam (decision 12): never swallowed by a guard, a trap or a `catch` of a port call. Lives here so the step modules can rethrow it without importing the loop.
export class LoopKilled extends Error {}
