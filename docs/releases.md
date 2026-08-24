# Container Release Lifecycle

Monika and Forum are published as one coordinated release even though their
`main` images are built independently. A stable release must always contain both
images from the same repository commit.

## Continuous images

The path-filtered image workflows publish development images after relevant
changes reach `main`:

- `Image / Monika` publishes `ghcr.io/irrigationreal/monika:main` and `sha-*`.
- `Image / Forum` publishes `ghcr.io/irrigationreal/monika-forum:main` and
  `sha-*`.

Those workflows intentionally do not run when their component is unchanged.
Consequently, matching `sha-*` tags are not guaranteed to exist for both images
at every repository commit. Stable releases do not use these tags.

## Nightly candidates

`Release / Nightly` runs daily and can also be dispatched manually. When the
current commit differs from the `nightly` release tag, it:

1. builds Monika and Forum from the same full commit SHA;
2. publishes multi-architecture manifests for both as
   `candidate-<full-sha>`;
3. updates both rolling `:nightly` images; and
4. recreates the `nightly` prerelease at that commit.

The immutable candidate tags are the source artifacts for stable promotion. The
nightly release includes a `candidate-manifests.json` asset binding its publication
time to the exact Monika and Forum manifest digests. A scheduled run that finds
no source change exits successfully without rebuilding or resetting the
candidate's publication time. Failed or incomplete builds do not replace the
`nightly` release, so they cannot become stable candidates.

Nightly and Stable share a concurrency group. Candidate publication and stable
promotion therefore cannot mutate release tags concurrently.

## Automatic stable promotion

`Release / Stable` runs daily. It promotes nothing unless all of these conditions
hold:

- the `nightly` release tag resolves to the current `main` commit;
- that coordinated candidate has been published for at least 168 hours;
- both immutable candidate manifests exist; and
- no existing stable release already targets the candidate commit.

A newer nightly candidate resets the soak period. Daily no-change Nightly runs
do not. Stable verifies that the candidate tags still have the digests recorded
at nightly publication, then rechecks `main` and the nightly tag immediately
before promotion. A commit visible by that final pre-promotion check stops the
release rather than promoting stale artifacts.

Eligible releases promote the exact candidate manifest digests to a
`YYYY.MM.DD` tag derived from the coordinated candidate publication date in UTC,
as well as `latest`, then create a GitHub release at the candidate commit. Beginning
with the next stable release after this contract ships, the release also attaches
`stable-manifests.json`. There is intentionally no backfill or fallback for older
releases: stable autodeploy becomes usable when the first release carrying this
asset is published.

The asset is the machine-readable coordinated deployment authority. Schema version
1 and deployment contract version 1 bind the stable tag and full source commit to
the canonical repositories `ghcr.io/irrigationreal/monika` and
`ghcr.io/irrigationreal/monika-forum` and the exact `sha256` manifest digests already
verified and promoted by the workflow. Consumers deploy those immutable digest
references; rolling `latest` remains a convenience tag, not a coordinated channel
or artifact authority.

The GitHub release publication time separately records when stable promotion
occurred. The first automated stable release says `Initial stable release` rather
than manufacturing a historical changelog. Later releases use GitHub's generated
release notes to list changes since the previous stable tag.

The workflow does not rebuild images during promotion. OCI registries cannot
atomically update tags across two packages, so the workflow publishes and
verifies both date tags before moving either `latest` tag. Every operation is
idempotent: a registry or GitHub failure can be rerun safely. The workflow creates
or resumes a commit-matched draft release, uploads and downloads the stable manifest
to verify it byte-for-byte, and publishes only after both versioned and rolling tags
verify against the recorded candidate digests. A failed asset upload therefore leaves
a repairable draft rather than a published release that stable consumers cannot use.

## Stable autodeploy consumer contract

`scripts/deploy-if-safe` keeps `main` as its default and opts into this contract only
with `MONIKA_RELEASE_CHANNEL=stable`. It resolves GitHub's latest non-draft,
non-prerelease release rather than consulting Git refs, strictly validates the
asset, pulls both digest references, and checks each image's OCI revision label
against the release commit. Missing or malformed metadata defers before runtime
quiescence. See [`autodeploy.md`](autodeploy.md) for scheduler configuration,
credential boundaries, explicit rollback overrides, and the one-shot migration
guard.

## Manual operation

A manual Stable dispatch may provide a custom tag instead of the candidate
publication date. By default it enforces the same eligibility rules as the schedule. The `force` input bypasses only the
seven-day timer for the current coordinated candidate; it does not allow an old
candidate, mismatched `main`, or missing images to be released.

Use the override for an intentional urgent release, not to repair Nightly. If no
candidate matches `main`, dispatch Nightly and let its coordinated build finish
first.
