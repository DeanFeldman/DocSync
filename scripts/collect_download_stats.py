"""Collect durable daily GitHub Release installer-download snapshots."""

from __future__ import annotations

import argparse
import csv
import json
import os
from collections import defaultdict
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

from supabase_analytics_store import SupabaseAnalyticsStore


FIELDNAMES = [
    "date", "tag", "release_name", "published_at", "asset_name", "asset_size",
    "total_downloads", "new_downloads", "anomaly",
]


def installer_assets(releases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the raw installer assets; checksums and source archives are excluded."""
    snapshots = []
    for release in releases:
        for asset in release.get("assets", []):
            name = str(asset.get("name", ""))
            if not (name.startswith("DocSync-Setup-") and name.lower().endswith(".exe")):
                continue
            snapshots.append({
                "tag": str(release.get("tag_name", "")),
                "release_name": str(release.get("name") or release.get("tag_name", "")),
                "published_at": str(release.get("published_at") or ""),
                "asset_name": name,
                "asset_size": int(asset.get("size") or 0),
                "total_downloads": int(asset.get("download_count") or 0),
            })
    return snapshots


def read_history(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as file:
        return list(csv.DictReader(file))


def update_history(
    history: list[dict[str, str]], snapshots: list[dict[str, Any]], snapshot_date: str,
) -> list[dict[str, str]]:
    """Replace same-day keys and calculate deltas from the prior daily snapshot."""
    today_keys = {(snapshot_date, item["tag"], item["asset_name"]) for item in snapshots}
    retained = [
        row for row in history
        if (row["date"], row["tag"], row["asset_name"]) not in today_keys
    ]
    previous: dict[tuple[str, str], dict[str, str]] = {}
    for row in retained:
        key = (row["tag"], row["asset_name"])
        if row["date"] < snapshot_date and (
            key not in previous or row["date"] > previous[key]["date"]
        ):
            previous[key] = row
    for item in snapshots:
        old = previous.get((item["tag"], item["asset_name"]))
        delta = item["total_downloads"] if old is None else item["total_downloads"] - int(old["total_downloads"])
        retained.append({
            "date": snapshot_date,
            "tag": item["tag"],
            "release_name": item["release_name"],
            "published_at": item["published_at"],
            "asset_name": item["asset_name"],
            "asset_size": str(item["asset_size"]),
            "total_downloads": str(item["total_downloads"]),
            "new_downloads": str(delta) if delta >= 0 else "",
            "anomaly": "counter_decreased" if delta < 0 else "",
        })
    return sorted(retained, key=lambda row: (row["date"], row["tag"], row["asset_name"]))


def summary_for(history: list[dict[str, str]], updated_at: str) -> dict[str, Any]:
    latest: dict[tuple[str, str], dict[str, str]] = {}
    by_day: dict[str, int] = defaultdict(int)
    for row in history:
        key = (row["tag"], row["asset_name"])
        if key not in latest or row["date"] > latest[key]["date"]:
            latest[key] = row
        if row["new_downloads"]:
            by_day[row["date"]] += int(row["new_downloads"])
    dates = sorted(by_day)
    today = updated_at[:10]
    recent = lambda days: sum(by_day[day] for day in dates if (date.fromisoformat(today) - date.fromisoformat(day)).days < days)
    by_release: dict[str, int] = defaultdict(int)
    for row in latest.values():
        by_release[row["tag"]] += int(row["total_downloads"])
    best_date = max(by_day, key=by_day.get) if by_day else None
    return {
        "last_updated": updated_at,
        "total_installer_downloads": sum(int(row["total_downloads"]) for row in latest.values()),
        "downloads_today": by_day.get(today, 0),
        "downloads_7d": recent(7),
        "downloads_30d": recent(30),
        "downloads_by_release": dict(sorted(by_release.items())),
        "best_day": {"date": best_date, "downloads": by_day[best_date]} if best_date else None,
    }


def write_outputs(history: list[dict[str, str]], history_path: Path, summary_path: Path, report_path: Path, updated_at: str) -> None:
    history_path.parent.mkdir(parents=True, exist_ok=True)
    with history_path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(history)
    summary = summary_for(history, updated_at)
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    release_rows = "\n".join(f"| {tag} | {count} |" for tag, count in summary["downloads_by_release"].items()) or "| — | 0 |"
    daily = defaultdict(int)
    for row in history:
        if row["new_downloads"]:
            daily[row["date"]] += int(row["new_downloads"])
    daily_rows = "\n".join(f"| {day} | {count} |" for day, count in sorted(daily.items(), reverse=True)[:14]) or "| — | 0 |"
    report_path.write_text(
        "# DocSync Download Statistics\n\n"
        f"Last updated: {summary['last_updated']}\n\n"
        f"Total installer downloads: {summary['total_installer_downloads']}\n\n"
        f"Last 7 days: {summary['downloads_7d']}\nLast 30 days: {summary['downloads_30d']}\n\n"
        "## By Version\n\n| Version | Downloads |\n| --- | ---: |\n" + release_rows +
        "\n\n## Recent Daily Downloads\n\n| Date | Downloads |\n| --- | ---: |\n" + daily_rows + "\n",
        encoding="utf-8",
    )


def fetch_releases(repo: str, token: str | None) -> list[dict[str, Any]]:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "DocSync-download-stats"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    releases: list[dict[str, Any]] = []
    for page in range(1, 101):
        request = Request(
            f"https://api.github.com/repos/{repo}/releases?per_page=100&page={page}",
            headers=headers,
        )
        with urlopen(request, timeout=30) as response:  # noqa: S310 - fixed GitHub API URL
            current = json.load(response)
        releases.extend(current)
        if len(current) < 100:
            break
    return releases


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="DeanFeldman/DocSync")
    parser.add_argument("--history", type=Path, default=Path("analytics/download-history.csv"))
    parser.add_argument("--summary", type=Path, default=Path("analytics/summary.json"))
    parser.add_argument("--report", type=Path, default=Path("analytics/README.md"))
    parser.add_argument("--date", dest="snapshot_date")
    args = parser.parse_args()
    updated_at = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    snapshot_date = args.snapshot_date or updated_at[:10]
    releases = fetch_releases(args.repo, os.getenv("GITHUB_TOKEN"))
    history = update_history(read_history(args.history), installer_assets(releases), snapshot_date)
    write_outputs(history, args.history, args.summary, args.report, updated_at)
    store = SupabaseAnalyticsStore.from_environment(
        os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SECRET_KEY"),
    )
    if store is not None:
        store.sync(releases, snapshot_date, updated_at)


if __name__ == "__main__":
    main()
