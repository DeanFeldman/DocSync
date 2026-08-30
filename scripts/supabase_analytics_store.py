"""Small, dependency-free Supabase REST persistence for download analytics."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class SupabaseAnalyticsStore:
    def __init__(
        self,
        url: str,
        secret_key: str,
        request: Callable[[Request], Any] | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self.secret_key = secret_key
        self._request = request or (lambda request: urlopen(request, timeout=30))  # noqa: S310

    @classmethod
    def from_environment(cls, url: str | None, secret_key: str | None) -> "SupabaseAnalyticsStore | None":
        if not url and not secret_key:
            return None
        if not url or not secret_key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY must both be configured.")
        return cls(url, secret_key)

    def _upsert(self, table: str, conflict: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        request = Request(
            f"{self.url}/rest/v1/{table}?on_conflict={conflict}",
            data=json.dumps(rows).encode(),
            method="POST",
            headers={
                "apikey": self.secret_key,
                "Authorization": f"Bearer {self.secret_key}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
        )
        try:
            with self._request(request):
                pass
        except (HTTPError, URLError, OSError) as error:
            raise RuntimeError(f"Supabase {table} upsert failed: {error}") from error

    def upsert_releases(self, releases: list[dict[str, Any]]) -> None:
        self._upsert("releases", "github_release_id", [
            {
                "github_release_id": int(release["id"]),
                "tag": str(release["tag_name"]),
                "name": release.get("name"),
                "published_at": release.get("published_at"),
            }
            for release in releases
        ])

    def upsert_assets(self, releases: list[dict[str, Any]]) -> None:
        rows = []
        for release in releases:
            for asset in release.get("assets", []):
                name = str(asset.get("name", ""))
                rows.append({
                    "github_asset_id": int(asset["id"]),
                    "github_release_id": int(release["id"]),
                    "name": name,
                    "size_bytes": int(asset.get("size") or 0),
                    "content_type": asset.get("content_type"),
                    "is_installer": name.startswith("DocSync-Setup-") and name.lower().endswith(".exe"),
                    "is_latest_alias": name == "DocSync-Setup-latest.exe",
                })
        self._upsert("release_assets", "github_asset_id", rows)

    def upsert_snapshots(self, releases: list[dict[str, Any]], snapshot_date: str, recorded_at: str) -> None:
        self._upsert("download_snapshots", "github_asset_id,snapshot_date", [
            {
                "github_asset_id": int(asset["id"]),
                "snapshot_date": snapshot_date,
                "recorded_at": recorded_at,
                "download_count": int(asset.get("download_count") or 0),
            }
            for release in releases
            for asset in release.get("assets", [])
        ])

    def sync(self, releases: list[dict[str, Any]], snapshot_date: str, recorded_at: str) -> None:
        self.upsert_releases(releases)
        self.upsert_assets(releases)
        self.upsert_snapshots(releases, snapshot_date, recorded_at)
