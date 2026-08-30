from __future__ import annotations

import json
import importlib.util
import sys
from pathlib import Path
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).parents[1]))
from supabase_analytics_store import SupabaseAnalyticsStore

BACKFILL_SPEC = importlib.util.spec_from_file_location(
    "backfill_supabase_download_stats", Path(__file__).parents[1] / "backfill_supabase_download_stats.py",
)
backfill_module = importlib.util.module_from_spec(BACKFILL_SPEC)
assert BACKFILL_SPEC.loader is not None
BACKFILL_SPEC.loader.exec_module(backfill_module)


class Response:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def release() -> dict:
    return {
        "id": 101,
        "tag_name": "v1.15.0",
        "name": "DocSync v1.15.0",
        "published_at": "2026-08-30T00:00:00Z",
        "assets": [
            {"id": 201, "name": "DocSync-Setup-1.15.0.exe", "size": 10, "content_type": "application/octet-stream", "download_count": 7},
            {"id": 202, "name": "DocSync-Setup-latest.exe", "size": 10, "content_type": "application/octet-stream", "download_count": 3},
            {"id": 203, "name": "SHA256SUMS.txt", "size": 2, "content_type": "text/plain", "download_count": 9},
        ],
    }


def test_sync_upserts_release_assets_and_same_date_snapshots():
    requests = []
    store = SupabaseAnalyticsStore("https://project.supabase.co", "secret", lambda request: requests.append(request) or Response())
    store.sync([release()], "2026-08-30", "2026-08-30T10:00:00Z")
    store.sync([release()], "2026-08-30", "2026-08-30T11:00:00Z")
    assert len(requests) == 6
    release_payload = json.loads(requests[0].data)
    asset_payload = json.loads(requests[1].data)
    snapshots = json.loads(requests[2].data)
    assert release_payload == [{"github_release_id": 101, "tag": "v1.15.0", "name": "DocSync v1.15.0", "published_at": "2026-08-30T00:00:00Z"}]
    assert asset_payload[0]["is_installer"] is True
    assert asset_payload[1]["is_latest_alias"] is True
    assert asset_payload[2]["is_installer"] is False
    assert len(snapshots) == 3
    assert "on_conflict=github_asset_id,snapshot_date" in requests[2].full_url


def test_missing_or_failed_database_configuration_is_explicit():
    assert SupabaseAnalyticsStore.from_environment(None, None) is None
    try:
        SupabaseAnalyticsStore.from_environment("https://project.supabase.co", None)
    except RuntimeError as error:
        assert "must both be configured" in str(error)
    else:
        raise AssertionError("partial configuration must fail")
    store = SupabaseAnalyticsStore("https://project.supabase.co", "secret", lambda _request: (_ for _ in ()).throw(URLError("offline")))
    try:
        store.upsert_releases([release()])
    except RuntimeError as error:
        assert "Supabase releases upsert failed" in str(error)
    else:
        raise AssertionError("failed persistence must be visible")


def test_backfill_maps_existing_csv_history_to_live_github_asset_ids_idempotently():
    requests = []
    store = SupabaseAnalyticsStore("https://project.supabase.co", "secret", lambda request: requests.append(request) or Response())
    history = [{"date": "2026-08-30", "tag": "v1.15.0", "asset_name": "DocSync-Setup-1.15.0.exe", "total_downloads": "7"}]
    backfill_module.backfill(store, history, [release()])
    backfill_module.backfill(store, history, [release()])
    snapshots = [request for request in requests if "/download_snapshots?" in request.full_url]
    assert len(snapshots) == 2
    assert json.loads(snapshots[0].data) == [{
        "github_asset_id": 201,
        "snapshot_date": "2026-08-30",
        "recorded_at": "2026-08-30T00:00:00Z",
        "download_count": 7,
    }]
