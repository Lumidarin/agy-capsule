"""Build only the IDE extension; no sidecar SDK or updater in the VSIX."""
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

RELATIVE_SPEC_RE = re.compile(
    r"""(?:(?:import|export)\s+(?:[^'"]*?\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)['"](\.\.?/[^'"]+)['"]"""
)

STATIC_FILES = [
    ("ide/package.json", "package.json"),
    ("ide/README.md", "README.md"),
    ("LICENSE", "LICENSE"),
    ("ide/capsule.svg", "ide/capsule.svg"),
    ("ide/logo.png", "ide/logo.png"),
]


def collect_module_closure(root: Path, entries: list[str]) -> list[Path]:
    root = root.resolve()
    seen: set[Path] = set()
    queue: list[Path] = []
    for entry in entries:
        p = (root / entry).resolve()
        if not p.is_file():
            raise FileNotFoundError(f"Missing entry module: {entry}")
        if p not in seen:
            seen.add(p)
            queue.append(p)
    while queue:
        current = queue.pop(0)
        text = current.read_text(encoding="utf-8")
        for match in RELATIVE_SPEC_RE.finditer(text):
            spec = match.group(1)
            candidate = (current.parent / spec).resolve()
            if not candidate.is_file() and candidate.suffix == "":
                for ext in (".cjs", ".mjs", ".js"):
                    alt = candidate.with_suffix(ext)
                    if alt.is_file():
                        candidate = alt
                        break
            if not candidate.is_file():
                rel_cur = current.relative_to(root).as_posix()
                raise FileNotFoundError(f"Unresolved relative import '{spec}' in {rel_cur}")
            candidate.relative_to(root)
            if candidate not in seen:
                seen.add(candidate)
                queue.append(candidate)
    return sorted(p.relative_to(root) for p in seen)


def collect_package_files(root: Path) -> list[tuple[str, str]]:
    files = list(STATIC_FILES)
    for rel in collect_module_closure(root, ["ide/extension.cjs"]):
        posix = rel.as_posix()
        files.append((posix, posix))
    return files


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    files = collect_package_files(root)
    if "--list" in sys.argv[1:]:
        for src, dst in files:
            print(f"{src} -> {dst}")
        return
    version = json.loads((root / "ide/package.json").read_text(encoding="utf-8"))["version"]
    output = root / "dist" / f"agy-capsule-ide-{version}.vsix"
    output.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as staging:
        stage = Path(staging)
        for src, dst in files:
            target = stage / dst
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / src, target)
        subprocess.run([shutil.which("pnpm") or "pnpm", "dlx", "@vscode/vsce@4.1.1", "package",
                        "--no-dependencies", "--out", str(output)], cwd=stage, check=True)


if __name__ == "__main__":
    main()
