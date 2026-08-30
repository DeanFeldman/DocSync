"""Backfill the durable CSV history into Supabase once credentials are configured."""

from __future__ import annotations

import os
from pathlib import Path

from collect_download_stats import fetch_releases, read_history
from supabase_analytics_store import SupabaseAnalyticsStore


def backfill(store: SupabaseAnalyticsStore, history: list[dict[str, str]], releases: list[dict]) -> None:
    store.upsert_releases(releases)
    store.upsert_assets(releases)
    assets = {
        (str(release["tag_name"]), str(asset["name"])): int(asset["id"])
        for release in releases
        for asset in release.get("assets", [])
    }
    missing = {(row["tag"], row["asset_name"]) for row in history} - assets.keys()
    if missing:
        raise RuntimeError(f"GitHub no longer exposes assets needed for backfill: {sorted(missing)}")
    for row in history:
        store._upsert("download_snapshots", "github_asset_id,snapshot_date", [{
            "github_asset_id": assets[(row["tag"], row["asset_name"])],
            "snapshot_date": row["date"],
            "recorded_at": f"{row['date']}T00:00:00Z",
            "download_count": int(row["total_downloads"]),
        }])


def main() -> None:
    store = SupabaseAnalyticsStore.from_environment(
        os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SECRET_KEY"),
    )
    if store is None:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY are required for backfill.")
    backfill(
        store,
        read_history(Path("analytics/download-history.csv")),
        fetch_releases("DeanFeldman/DocSync", os.getenv("GITHUB_TOKEN")),
    )


if __name__ == "__main__":
    main()
