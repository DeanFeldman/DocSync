from __future__ import annotations

import importlib.util
from pathlib import Path
import sys


SCRIPT = Path(__file__).parents[1] / "collect_download_stats.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("collect_download_stats", SCRIPT)
collector = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(collector)


def release(tag: str, asset: str, downloads: int, size: int = 10) -> dict:
    return {
        "tag_name": tag,
        "name": f"DocSync {tag}",
        "published_at": "2026-08-30T00:00:00Z",
        "assets": [{"name": asset, "size": size, "download_count": downloads}],
    }


def test_filters_only_versioned_and_latest_installers():
    releases = [
        release("v1.14.0", "DocSync-Setup-1.14.0.exe", 17),
        release("v1.14.0", "SHA256SUMS.txt", 99),
        release("v1.13.0", "source.zip", 99),
        release("v1.14.0", "DocSync-Setup-latest.exe", 4),
    ]
    assert [item["asset_name"] for item in collector.installer_assets(releases)] == [
        "DocSync-Setup-1.14.0.exe", "DocSync-Setup-latest.exe",
    ]


def test_history_uses_cumulative_counts_and_replaces_same_day_snapshot():
    first = collector.update_history([], collector.installer_assets([
        release("v1.14.0", "DocSync-Setup-1.14.0.exe", 17),
    ]), "2026-08-30")
    second = collector.update_history(first, collector.installer_assets([
        release("v1.14.0", "DocSync-Setup-1.14.0.exe", 31),
    ]), "2026-08-31")
    repeated = collector.update_history(second, collector.installer_assets([
        release("v1.14.0", "DocSync-Setup-1.14.0.exe", 33),
    ]), "2026-08-31")
    assert [(row["date"], row["total_downloads"], row["new_downloads"]) for row in repeated] == [
        ("2026-08-30", "17", "17"),
        ("2026-08-31", "33", "16"),
    ]


def test_summary_aggregates_multiple_versions_and_preserves_counter_resets():
    day_one = collector.update_history([], collector.installer_assets([
        release("v1.13.0", "DocSync-Setup-1.13.0.exe", 10),
        release("v1.14.0", "DocSync-Setup-1.14.0.exe", 20),
    ]), "2026-08-30")
    history = collector.update_history(day_one, collector.installer_assets([
        release("v1.13.0", "DocSync-Setup-1.13.0.exe", 15),
        release("v1.14.0", "DocSync-Setup-1.14.0.exe", 12),
        release("v1.14.0", "DocSync-Setup-latest.exe", 4),
    ]), "2026-08-31")
    reset = next(row for row in history if row["tag"] == "v1.14.0" and row["asset_name"] == "DocSync-Setup-1.14.0.exe" and row["date"] == "2026-08-31")
    assert reset["new_downloads"] == ""
    assert reset["anomaly"] == "counter_decreased"
    summary = collector.summary_for(history, "2026-08-31T12:00:00Z")
    assert summary["total_installer_downloads"] == 31
    assert summary["downloads_today"] == 9
    assert summary["downloads_7d"] == 39
    assert summary["downloads_30d"] == 39
    assert summary["downloads_by_release"] == {"v1.13.0": 15, "v1.14.0": 16}
    assert summary["best_day"] == {"date": "2026-08-30", "downloads": 30}
