from __future__ import annotations

import json
import os
from typing import Any

import psycopg

STATE_KEY = "scanner.latest_1h"


def _database_url() -> str | None:
    value = os.getenv("DATABASE_URL", "").strip()
    return value or None


def ensure_state_schema() -> bool:
    url = _database_url()
    if not url:
        return False
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS app_state (
                    key TEXT PRIMARY KEY,
                    payload JSONB NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
        conn.commit()
    return True


def save_scanner_result(result: dict[str, Any]) -> bool:
    url = _database_url()
    if not url:
        return False
    payload = json.dumps(result)
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO app_state (key, payload, updated_at)
                VALUES (%s, %s::jsonb, NOW())
                ON CONFLICT (key)
                DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
                """,
                (STATE_KEY, payload),
            )
        conn.commit()
    return True


def load_scanner_result() -> dict[str, Any] | None:
    url = _database_url()
    if not url:
        return None
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT payload FROM app_state WHERE key = %s", (STATE_KEY,))
            row = cur.fetchone()
    if not row:
        return None
    payload = row[0]
    if isinstance(payload, dict):
        return payload
    return json.loads(payload)
