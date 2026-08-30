# Supabase download analytics

Supabase is the permanent store for public GitHub Release download snapshots.
The CSV, JSON, and Markdown files in `analytics/` remain a repository backup and
human-readable export. No in-app telemetry is collected.

## Setup

1. Create a Supabase project.
2. In its SQL Editor, run `analytics/supabase-schema.sql`.
3. Add `SUPABASE_URL` and `SUPABASE_SECRET_KEY` as GitHub repository secrets.
4. Set the same variables locally only when running trusted collection tools.
5. Backfill existing history once with `python scripts/backfill_supabase_download_stats.py`.
6. Trigger **Collect download statistics** manually, then verify `releases`,
   `release_assets`, `download_snapshots`, and their views contain rows.

The secret key is used only by the trusted collector and is never included in
the Electron application or frontend code. Tables use RLS and have no public
write policies.

## Useful queries

```sql
select coalesce(sum(new_downloads), 0) as total_installer_downloads
from download_daily where is_installer = true;

select coalesce(sum(new_downloads), 0) as downloads_today
from download_daily where is_installer = true and snapshot_date = current_date;

select coalesce(sum(new_downloads), 0) as downloads_7d
from download_daily where is_installer = true and snapshot_date >= current_date - 6;

select coalesce(sum(new_downloads), 0) as downloads_30d
from download_daily where is_installer = true and snapshot_date >= current_date - 29;

select * from installer_downloads_by_version order by downloads desc;
select snapshot_date, downloads from installer_daily_totals order by downloads desc limit 1;
select * from installer_daily_totals order by snapshot_date;
```
