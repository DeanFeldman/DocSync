from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files


api_dir = Path(SPECPATH)

a = Analysis(
    [str(api_dir / "desktop_backend.py")],
    pathex=[str(api_dir)],
    binaries=[],
    datas=collect_data_files("docx"),
    hiddenimports=[
        "pymupdf",
        "sqlalchemy.dialects.sqlite",
        "uvicorn.lifespan.on",
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "IPython",
        "PIL",
        "_tkinter",
        "dateutil",
        "httpx",
        "ipykernel",
        "jedi",
        "jupyter_client",
        "matplotlib",
        "numpy",
        "parso",
        "psutil",
        "pytest",
        "tkinter",
        "tornado",
        "watchfiles",
        "websockets",
        "werkzeug",
        "yaml",
        "zmq",
    ],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="docsync-api",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="docsync-api",
)
