from __future__ import annotations

import os


# Unit/integration tests mock the COM worker boundary. Real Word lifecycle and
# timing are covered by the opt-in Windows benchmark instead of every TestClient.
os.environ.setdefault("DOCUMENTSYNC_WORD_WORKER_AUTOSTART", "0")
