# Art workshop cold-start brief

This brief is the starting context for a private, offline art practice. It describes
what the repository can help with without making the repository a home for artwork.
Keep projects, source SVGs, previews, notes, and exports under a private workspace
(for example `/workspace/art-workshop-projects`), not in this checkout.

## Architecture and authority

The workshop is a small, one-shot Python CLI and a dependency-free semantic SVG
builder. A project is intentionally boring:

```text
/workspace/art-workshop-projects/
  river-01/
    source.svg          # working authority
    preview.png         # derived raster preview
    contact.png         # derived comparison sheet
    layers.ora          # optional derived export
    notes.md             # private process notes and provenance
    references/          # private, licensed/reference material
```

The SVG is the working source and authority. PNG previews, contact sheets, and
OpenRaster files are outputs that can be regenerated; an edited output must not be
mistaken for a source revision. `bundle` makes a hashed snapshot of a private
project, but it does not make private work suitable for version control. The CLI is
offline and one-shot: it is not connected to Pi, agentd, Monika, the forum, a job
queue, or a model provider.

The helper in `services/art-workshop/art_workshop/svg.py` creates reviewable SVG
strings (canvas, named layers, groups, simple shapes, paths, lines, circles,
definitions, and gradients). It escapes XML values and keeps output deterministic;
it is not an editor or a general XML library. The renderer validates SVG before
running CairoSVG in a bounded child process. Use the existing README for command
and container details.

## River: a frozen case study, not canon

“River” is a frozen case study for learning the workflow, not a canonical character,
reference design, style guide, or claim about the person behind the work. Do not
copy River artwork into this repository. Private River files may remain in the
private workspace with their source and provenance notes. Any later study may
contradict, retire, or replace this case study without changing the tooling contract.

The first attempts were useful because they exposed process problems rather than
because they were finished art. The private project notes and revisions under
`/workspace/art-workshop-projects/river-01/README.md` record that September 2026
experiment. The public repository intentionally contains neither those images nor
those private notes; this is a durable summary, not a replacement provenance record.

1. **First attempt (v1) — head:** a silhouette and simple placement study made
   the canvas, scale, and focal point testable, but attractive local details could
   not rescue an uncertain overall read.
2. **Second attempt (v2) — features:** adding the eyes, hair, and other facial
   features showed that feature detail amplifies proportion errors. Features need a
   stable head and deliberate spacing, not early accumulation.
3. **Third attempt (v3) — integration:** layering light, color, clothing, and background
   made the image legible as a whole, while also showing that expression and
   gesture are integration problems rather than isolated decorations.

Those attempts are observations about this learning sequence, not rules that every
artist or every River version must follow. Preserve the failed or superseded source
privately when it teaches something; label it as a revision rather than silently
rewriting history.

## What is known, inferred, and invented

Every note or visual decision should be marked as one of three kinds:

- **Observed:** directly visible in an approved reference or directly recorded in
  the current source/preview (include the reference and date or revision).
- **Inferred:** a cautious interpretation that connects observations (write the
  reasoning and confidence; do not present it as fact).
- **Invented:** an intentional creative choice where evidence is absent or the
  work needs room to breathe (record it as invention, not discovery).

This distinction protects both the subject and the work. It prevents a convenient
visual guess from becoming a false biographical fact, and it makes review possible:
a reviewer can challenge an inference without treating an invention as an error.

## Qualitative curriculum

Work in this order unless a deliberate exercise says otherwise:

1. **Head** — silhouette, tilt, planes, proportion, and crop.
2. **Features** — spacing and relationships, with detail held to what the head can
   support.
3. **Integration** — light, value, color, clothing, hair, and environment as one
   readable image.
4. **Expressions** — small changes in eyes, mouth, brows, and tension; compare the
   whole face rather than isolated features.
5. **Turns** — repeat the structure at useful head angles and rotations; check what
   remains stable and what should change.
6. **One original subject** — apply the process to one new subject without turning
   the exercise into a template or a model-training corpus.
7. **River** — return to the frozen case study only after the preceding studies can
   be reviewed on their own.

A qualitative review asks whether the image reads, whether relationships are
coherent, whether the invented choices are intentional, and whether the result
still respects the observed/inferred/invented labels. It is not a score disguised
as criticism.

## Review and revert loop

Keep revisions small enough to explain. Before changing the source, make a private
copy or commit outside this repository; render a fresh preview and compare it with
the prior preview or contact sheet. Review structure first (head and turn), then
features, integration, and expression. Record one or two concrete observations and
whether each is observed, inferred, or invented. If a change makes the read worse,
revert the source revision rather than repairing a derived PNG by hand. If a manual
preview edit is useful as a note, keep it clearly marked and never treat it as the
working authority. Bundle only when a private snapshot and its hashes are useful.

## References, licensing, and provenance

Use references only when their source, permission, and intended use are clear. Keep
a private provenance note alongside the project containing:

- creator/source URL or publication details;
- what was actually consulted (and when);
- license or permission, including attribution and share-alike obligations;
- whether the reference is for observation, transformation, or presentation; and
- which visible decisions it informed.

Do not scrape, redistribute, or imply endorsement. Do not place third-party images,
private subject material, or copied River studies in this repository. When license
status is unclear, use it only as a prompt for general study or choose another
reference; uncertainty is not permission. Keep generated work distinguishable from
reference material and preserve attribution in any private export that requires it.

## Current tooling

- `art_workshop` renders a validated self-contained SVG to PNG, creates raster
  contact sheets, exports explicitly named top-level SVG layers to OpenRaster, and
  bundles a private project with SHA-256 manifest entries.
- `art_workshop.svg` supplies deterministic semantic string helpers for simple
  source construction and XML escaping.
- `viewer.html` is a local, static comparison aid. It accepts only files selected
  through its file inputs, displays local PNG previews side by side, and shows SVG
  selections as source text. It does not upload files. SVG is deliberately not
  executed by the viewer; use the sanitized renderer output for an image preview.

## Explicit non-goals

This cold-start tooling does **not** add Krita integration, formal benchmarks,
artwork or reference extraction, diffusion or GPU support, or forum UI/integration.
It is not a generic SVG editor, model-specific code, a training-data pipeline, a
host execution bridge, or a canonical store for private artwork. A future semantic
helper/viewer may make layer and comparison review more expressive, but that is a
small local direction—not permission to widen this service into an editor or
publishing system.
