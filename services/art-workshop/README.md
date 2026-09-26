# Art workshop (optional)

This is a small, offline, one-shot CLI for private SVG studies. It is deliberately
not connected to Monika, Pi, agentd, the forum, or a job queue. Keep real projects
outside this repository (the example deployment uses `/workspace/art-workshop-projects`).
The source SVG is the authority: previews and OpenRaster exports are derived files,
and manual SVG edits should be made in the source before rerunning a command.
Existing outputs are never replaced unless `--force` is explicit, so a hand-edited
preview is not silently regenerated.

## Local use

Use a Python 3.12 virtual environment and install the pinned dependencies:

```sh
cd services/art-workshop
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
PYTHONPATH=. .venv/bin/python -m art_workshop --help
PYTHONPATH=. .venv/bin/python -m art_workshop render \
  /workspace/art-workshop-projects/river-01/source.svg \
  /workspace/art-workshop-projects/river-01/preview.png \
  --width 1600 --height 1200
PYTHONPATH=. .venv/bin/python -m art_workshop sheet \
  /workspace/art-workshop-projects/river-01/contact.png \
  /workspace/art-workshop-projects/river-01/*.png --crop
PYTHONPATH=. .venv/bin/python -m art_workshop export-ora \
  /workspace/art-workshop-projects/river-01/source.svg \
  /workspace/art-workshop-projects/river-01/layers.ora
PYTHONPATH=. .venv/bin/python -m art_workshop bundle \
  /workspace/art-workshop-projects/river-01 \
  /workspace/art-workshop-projects/river-01-snapshot.tar.gz
```

`render` runs CairoSVG in a child process with a bounded timeout and dimensions
(maximum 4096 pixels per dimension). `sheet` accepts local raster files and adds
filenames as labels. `export-ora` requires direct child groups tagged with
`inkscape:groupmode="layer"`; their `inkscape:label` (or `id`) becomes the ORA
layer name. Visible top-level SVG graphics outside those layers are rejected
rather than silently dropped. Global `defs` and top-level styles are retained;
hidden top-level nodes are allowed and remain hidden. The ORA stack records the
SVG layers topmost-first and includes image dimensions, so a reader composites
its children in reverse order (bottom-to-top). `bundle` writes a gzip tar archive
containing source files and a
`manifest.json` with SHA-256 hashes. Version-control directories, common caches,
symlinks, special files, and paths outside the project are rejected/excluded.

## Container use

Build from this directory and mount only the private project directory:

```sh
docker build -f Containerfile -t monika-art-workshop:local .
docker run --rm --network none --cap-drop ALL --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  -v /workspace/art-workshop-projects:/work:rw \
  monika-art-workshop:local render /work/river-01/source.svg /work/river-01/preview.png
```

`compose.yaml.example` provides the same optional setup with no network, dropped
capabilities, a non-root user, read-only image filesystem, and resource limits.
There is no Docker socket, host-shell execution, or live runtime configuration.

## Safety and limitations

SVG input is parsed before rendering. Scripts, `foreignObject`, XML
DOCTYPE/ENTITY declarations, CSS imports/fonts, external URLs/files, and unsafe
references are rejected. Local fragment references (`#id`) and base64 embedded
PNG/JPEG/GIF/WebP images are allowed. The renderer also uses CairoSVG's safe mode
and CairoSVG safe mode; validation ensures no network/file URL reaches the renderer.

This is not a general-purpose SVG editor: filters and unusual CairoSVG constructs
may render differently, and only explicitly tagged top-level Inkscape layers are
exported to ORA. Nested groups inside a tagged layer are retained, but nested
Inkscape layers are not separately promoted to ORA layers. Font availability, CairoSVG/Pillow versions, operating system,
and platform rasterization can affect pixels; the bundle preserves source and
hashes but does not promise byte-identical rendered previews. ORA exports contain
derived PNGs and do not replace the source SVG. No River artwork or private
project files belong in this repository.
