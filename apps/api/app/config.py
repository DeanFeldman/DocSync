from __future__ import annotations

import os
from dataclasses import dataclass
from math import isfinite
from pathlib import Path


def _bounded_float_env(
    name: str,
    default: float,
    *,
    minimum: float,
    maximum: float,
) -> float:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number.") from exc
    if not isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}.")
    return value


def _bounded_int_env(
    name: str,
    default: int,
    *,
    minimum: int,
    maximum: int,
) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a whole number.") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}.")
    return value


@dataclass(frozen=True)
class Settings:
    api_dir: Path
    data_dir: Path
    database_url: str
    cors_origins: tuple[str, ...]
    max_file_bytes: int
    max_files_per_set: int
    web_dist_dir: Path
    render_script: Path
    session_token: str
    near_match_threshold: float
    near_match_candidate_limit: int
    render_map_confidence_threshold: float
    render_map_dpi: int
    render_map_max_pages: int


def _build_settings() -> Settings:
    api_dir = Path(__file__).resolve().parents[1]
    raw_data_dir = os.getenv("DOCUMENTSYNC_DATA_DIR", "./data")
    data_dir = Path(raw_data_dir)
    if not data_dir.is_absolute():
        data_dir = (api_dir / data_dir).resolve()

    default_database = f"sqlite:///{(data_dir / 'documentsync.db').as_posix()}"
    database_url = os.getenv("DOCUMENTSYNC_DATABASE_URL", default_database)
    raw_web_dist = os.getenv("DOCUMENTSYNC_WEB_DIST", str(api_dir.parent / "web" / "dist"))
    web_dist_dir = Path(raw_web_dist).resolve()
    raw_render_script = os.getenv(
        "DOCUMENTSYNC_RENDER_SCRIPT",
        str(api_dir / "scripts" / "render_docx_to_pdf.ps1"),
    )
    render_script = Path(raw_render_script).resolve()
    cors_origins = tuple(
        origin.strip()
        for origin in os.getenv(
            "DOCUMENTSYNC_CORS_ORIGINS",
            (
                "http://localhost:5173,http://localhost:5174,"
                "http://127.0.0.1:5173,http://127.0.0.1:5174"
            ),
        ).split(",")
        if origin.strip()
    )

    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "originals").mkdir(parents=True, exist_ok=True)
    (data_dir / "generated").mkdir(parents=True, exist_ok=True)
    (data_dir / "renders").mkdir(parents=True, exist_ok=True)

    return Settings(
        api_dir=api_dir,
        data_dir=data_dir,
        database_url=database_url,
        cors_origins=cors_origins,
        max_file_bytes=int(os.getenv("DOCUMENTSYNC_MAX_FILE_BYTES", str(10 * 1024 * 1024))),
        max_files_per_set=int(os.getenv("DOCUMENTSYNC_MAX_FILES_PER_SET", "20")),
        web_dist_dir=web_dist_dir,
        render_script=render_script,
        session_token=os.getenv("DOCUMENTSYNC_SESSION_TOKEN", ""),
        near_match_threshold=_bounded_float_env(
            "DOCUMENTSYNC_NEAR_MATCH_THRESHOLD",
            0.82,
            minimum=0.0,
            maximum=1.0,
        ),
        near_match_candidate_limit=_bounded_int_env(
            "DOCUMENTSYNC_NEAR_MATCH_CANDIDATE_LIMIT",
            25,
            minimum=1,
            maximum=500,
        ),
        render_map_confidence_threshold=_bounded_float_env(
            "DOCUMENTSYNC_RENDER_MAP_CONFIDENCE_THRESHOLD",
            0.90,
            minimum=0.5,
            maximum=1.0,
        ),
        render_map_dpi=_bounded_int_env(
            "DOCUMENTSYNC_RENDER_MAP_DPI",
            144,
            minimum=72,
            maximum=300,
        ),
        render_map_max_pages=_bounded_int_env(
            "DOCUMENTSYNC_RENDER_MAP_MAX_PAGES",
            500,
            minimum=1,
            maximum=2000,
        ),
    )


settings = _build_settings()
