"""Build only the IDE extension; no sidecar SDK or updater in the VSIX."""
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "ide/package.json").read_text(encoding="utf-8"))["version"]
output = root / "dist" / f"agy-capsule-ide-{version}.vsix"
output.parent.mkdir(exist_ok=True)
shared = Path("agy-capsule/sidecars/agy_capsule")
with tempfile.TemporaryDirectory() as staging:
    stage = Path(staging)
    for src, dst in [
        ("ide/package.json", "package.json"), ("ide/README.md", "README.md"), ("LICENSE", "LICENSE"),
        ("ide/sidebar.mjs", "ide/sidebar.mjs"), ("ide/capsule.svg", "ide/capsule.svg"),
        ("ide/logo.png", "ide/logo.png"),
        *((f"ide/{name}", f"ide/{name}") for name in (
            "billing.mjs", "cloud.mjs", "data_roots.mjs", "maintenance.cjs", "cli_quota.cjs")),
        ("ide/composer.mjs", "ide/composer.mjs"), ("ide/extension.cjs", "ide/extension.cjs"), ("ide/host.mjs", "ide/host.mjs"),
        *((shared / (name + ".mjs"), shared / (name + ".mjs")) for name in (
            "conversation_db", "metrics", "errors", "turn_metrics", "sqlite_cache",
            "usage_history", "ui", "turn_ui", "usage_ui", "deck_injector", "settings",
            "sidebar_ui", "version_ui", "model_picker", "motion_themes", "effort_bar", "effort_upstream", "cloud_telemetry")),
    ]:
        target = stage / dst
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / src, target)
    subprocess.run([shutil.which("pnpm") or "pnpm", "dlx", "@vscode/vsce@4.1.1", "package",
                    "--no-dependencies", "--out", str(output)], cwd=stage, check=True)
