"""Safe project snapshots for handoff and archival."""

from __future__ import annotations

import hashlib
import io
import json
import os
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .rendering import _atomic_publish
from .security import ValidationError, ensure_safe_project, excluded_dir_names


def bundle_project(project: Path, output: Path, force: bool = False) -> None:
    project = project.absolute()
    output = output.absolute()
    files = ensure_safe_project(project, output)
    name = project.name or "project"
    records = []
    for path in files:
        digest = hashlib.sha256()
        size = 0
        try:
            with path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
                    size += len(chunk)
        except OSError as exc:
            raise ValidationError(f"cannot hash project file {path}: {exc}") from exc
        records.append({
            "path": path.relative_to(project).as_posix(),
            "size": size,
            "sha256": digest.hexdigest(),
        })
    manifest = {
        "schema": 1,
        "project": name,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceAuthority": "The files under the project directory are authoritative; generated previews are not sources.",
        "excludedDirectories": list(excluded_dir_names()),
        "files": records,
    }
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".tmp", dir=output.parent)
    os.close(fd)
    temp = Path(temp_name)
    try:
        with tarfile.open(temp, mode="w:gz") as archive:
            info = tarfile.TarInfo("manifest.json")
            info.size = len(manifest_bytes)
            info.mode = 0o644
            info.mtime = 0
            archive.addfile(info, io.BytesIO(manifest_bytes))
            for path, record in zip(files, records):
                arcname = f"{name}/{record['path']}"
                stat = path.stat()
                info = tarfile.TarInfo(arcname)
                info.size = stat.st_size
                info.mode = stat.st_mode & 0o777
                info.mtime = int(stat.st_mtime)
                with path.open("rb") as stream:
                    archive.addfile(info, stream)
        _atomic_publish(temp, output, force)
    finally:
        temp.unlink(missing_ok=True)
