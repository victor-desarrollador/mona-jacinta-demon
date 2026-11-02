// USER-MGMT-01 U1 — credentials epoch.
//
// `User.credentialsChangedAt` (TIMESTAMPTZ(3)) is the VERSION of a user's credentials. The access token carries that version as the
// `cc` claim (the epoch in integer milliseconds; ABSENT while the user has never changed credentials) and a request is valid only
// when the claim EQUALS the stored epoch. Equality on exact milliseconds avoids the trap of comparing `iat` (1 s granularity)
// against a millisecond timestamp: a change and the token issued right after it can share a second, and an old token issued in
// that same second could not be told apart. `iat` is never used for this.
//
// Timestamps are not money: plain Number is correct here (a safe integer of milliseconds).

// The epoch that a credentials change writes: strictly greater than the previous one, whatever the clock does.
// Callers take `now` from the APPLICATION clock inside the transaction, after locking the user row.
export function nextCredentialsEpoch(previous: Date | null, now: Date): Date {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError('now must be a valid Date');
  if (previous === null) return new Date(nowMs);
  const previousMs = previous.getTime();
  if (!Number.isFinite(previousMs)) throw new RangeError('previous must be a valid Date');
  return new Date(Math.max(nowMs, previousMs + 1));
}

// The `cc` claim value for a stored epoch (null = no claim).
export function credentialsEpochClaim(epoch: Date | null): number | null {
  return epoch === null ? null : epoch.getTime();
}

// True only when the token's `cc` claim names exactly the stored epoch. A token without the claim (legacy, or issued while the
// user had never changed credentials) is current only while the stored epoch is NULL. Any malformed claim is never current.
export function isCredentialsEpochCurrent(claim: unknown, epoch: Date | null): boolean {
  if (claim === undefined || claim === null) return epoch === null;
  if (typeof claim !== 'number' || !Number.isSafeInteger(claim)) return false;
  return epoch !== null && epoch.getTime() === claim;
}
