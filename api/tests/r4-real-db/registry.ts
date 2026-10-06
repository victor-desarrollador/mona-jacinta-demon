// V2.3.3 R4 real-PostgreSQL proof registry (AC-204..AC-214). Pure data: the topics mirror the sealed implementation packet
// (v233-r4-implementation-20261005T210704Z/PREREGISTRATION.md rows AC-204..AC-214).

export const AC_IDS = ['AC-204', 'AC-205', 'AC-206', 'AC-207', 'AC-208', 'AC-209', 'AC-210', 'AC-211', 'AC-212', 'AC-213', 'AC-214'] as const;
export type AcId = (typeof AC_IDS)[number];

// none: no write at all. rolled-back: writes only inside a transaction that is always rolled back. canary: one synthetic
// Brand row committed and removed again (the state is re-fingerprinted afterwards). not-implemented: restore (OWNER decision).
export type MutationClass = 'none' | 'rolled-back' | 'canary' | 'not-implemented';

export type AcCase = Readonly<{
  id: AcId;
  topic: string;
  invariant: string;
  mutation: MutationClass;
  status: 'implemented' | 'OWNER_DECISION_REQUIRED';
}>;

export const AC_CASES: readonly AcCase[] = Object.freeze([
  { id: 'AC-204', topic: 'locks / writer exclusion', invariant: 'while the protected transaction holds its locks, a second session cannot write or lock-DDL a protected relation (55P03) but can still read', mutation: 'rolled-back', status: 'implemented' },
  { id: 'AC-205', topic: 'snapshot + dump equivalence', invariant: 'pg_dump --snapshot=<exporter id> sees the PRE state: a canary committed after the snapshot is absent, present without the snapshot; fPre equals the pre-canary digest', mutation: 'canary', status: 'implemented' },
  { id: 'AC-206', topic: 'live Prisma qualification', invariant: 'the real read steps succeed through Prisma under search_path = pg_catalog, pg_temp (public omitted)', mutation: 'none', status: 'implemented' },
  { id: 'AC-207', topic: 'pg_temp and $user shadowing', invariant: 'a pg_temp relation named like a protected relation is refused by the domain proof and never changes a qualified protected read', mutation: 'rolled-back', status: 'implemented' },
  { id: 'AC-208', topic: 'jsonb / timestamptz exactness', invariant: 'jsonb key order, timestamptz zone, microsecond precision, infinity, uuid, bool, int8 and NULL project to one exact text', mutation: 'rolled-back', status: 'implemented' },
  { id: 'AC-209', topic: 'synchronous_commit / fsync', invariant: 'synchronous_commit=off fails the resume settings proof; fsync cannot be changed by the unprivileged role and is on', mutation: 'rolled-back', status: 'implemented' },
  { id: 'AC-210', topic: 'in-transaction vs post-commit digest', invariant: 'the witness fPost is durable before COMMIT while the change is invisible to another session; after COMMIT the outcome verifier post digest equals fPost', mutation: 'canary', status: 'implemented' },
  { id: 'AC-211', topic: 'restore re-fingerprint', invariant: 'a restore re-fingerprints to fPre (destructive: not implemented, needs an OWNER decision)', mutation: 'not-implemented', status: 'OWNER_DECISION_REQUIRED' },
  { id: 'AC-212', topic: 'backend pid', invariant: 'pg_backend_pid is constant across every protected step and differs from every other session', mutation: 'rolled-back', status: 'implemented' },
  { id: 'AC-213', topic: 'real archive TOC', invariant: 'a real custom-format pg_dump lists exactly the protected relations (TABLE and TABLE DATA once each) and passes the repository checkToc', mutation: 'none', status: 'implemented' },
  { id: 'AC-214', topic: 'OWNER.updatedAt', invariant: 'the real Prisma user.upsert with update:{} does not write updatedAt of an existing OWNER row', mutation: 'rolled-back', status: 'implemented' },
] satisfies readonly AcCase[]);
