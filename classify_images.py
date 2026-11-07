#!/usr/bin/env python3
"""Classify bookmark images and write results into the downloader SQLite DB."""

from __future__ import annotations

import argparse
import os
import sqlite3
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse


def local_timestamp(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.astimezone().strftime("%Y%m%d-%H%M%S")


def media_filename(tweet: sqlite3.Row, media: sqlite3.Row, count: int) -> str:
    extension = Path(urlparse(media["url"] or "").path).suffix.lower()
    base = f"twitter-@{tweet['screen_name']}-{local_timestamp(tweet['created_at'])}-{tweet['id']}"
    position = media["position"] if "position" in media.keys() and media["position"] is not None else media["index"]
    return f"{base}-{position}{extension}" if count > 1 else f"{base}{extension}"


def category_for(label: str) -> str:
    normalized = label.lower()
    if any(token in normalized for token in ("porn", "hentai", "nsfw")):
        return "NSFW"
    if "sexy" in normalized or "suggestive" in normalized:
        return "Sensitive"
    return "Safe"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="Path to bookmarks.db")
    parser.add_argument("--media-dir", type=Path, help="Media directory (default: database directory/media)")
    parser.add_argument("--device", default="auto", choices=("auto", "cuda", "cpu"), help="Inference device")
    parser.add_argument("--batch-size", type=int, default=8, help="Images per inference batch")
    parser.add_argument("--model", default="Falconsai/nsfw_image_detection", help="Hugging Face image classifier")
    parser.add_argument("--overwrite", action="store_true", help="Reclassify images already in the database")
    args = parser.parse_args()

    try:
        import torch
        from PIL import Image
        from transformers import pipeline
    except ImportError as error:
        raise SystemExit(
            "Missing dependency. Install with: python -m pip install -r requirements-classifier.txt"
        ) from error

    database = args.database.expanduser().resolve()
    media_dir = (args.media_dir or database.parent / "media").expanduser().resolve()
    if not database.is_file():
        raise SystemExit(f"Database not found: {database}")
    if not media_dir.is_dir():
        raise SystemExit(f"Media directory not found: {media_dir}")
    if args.batch_size < 1:
        raise SystemExit("--batch-size must be positive")

    device = 0 if args.device == "cuda" or (args.device == "auto" and torch.cuda.is_available()) else -1
    device_name = "cuda" if device == 0 else "cpu"
    print(f"Using {device_name}; torch reports CUDA/ROCm={torch.cuda.is_available()}")

    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS image_classifications (
            filename TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            source_label TEXT NOT NULL,
            score REAL NOT NULL,
            model TEXT NOT NULL,
            classified_at TEXT NOT NULL
        )
        """
    )
    tweet_columns = {row["name"] for row in connection.execute("PRAGMA table_info(tweets)")}
    media_columns = {row["name"] for row in connection.execute("PRAGMA table_info(media)")}
    required_tweet = {"id", "screen_name", "created_at"}
    required_media = {"id", "tweet_id", "url", "type"}
    if not required_tweet <= tweet_columns or not required_media <= media_columns:
        raise SystemExit("Unsupported database schema: expected tweets and media columns are missing")

    position_column = "position" if "position" in media_columns else "index"
    quoted_position_column = f'"{position_column}"'
    rows = connection.execute(
        f"""
        SELECT t.id AS tweet_id, t.screen_name, t.created_at,
               m.id, m.tweet_id, m.url, m.type,                m.{quoted_position_column} AS position
        FROM media m JOIN tweets t ON t.id = m.tweet_id
        WHERE lower(m.type) IN ('photo', 'image')
        ORDER BY t.created_at DESC, m.{quoted_position_column}
        """
    ).fetchall()
    counts = {}
    for row in rows:
        counts[row["tweet_id"]] = counts.get(row["tweet_id"], 0) + 1

    existing = {
        row["filename"]
        for row in connection.execute("SELECT filename FROM image_classifications")
    }
    work = []
    for row in rows:
        filename = media_filename(row, row, counts[row["tweet_id"]])
        if args.overwrite or filename not in existing:
            path = media_dir / filename
            if path.is_file() and path.stat().st_size:
                work.append((filename, path))
    print(f"Found {len(work)} images to classify.")
    if not work:
        connection.commit()
        return

    classifier = pipeline("image-classification", model=args.model, device=device)
    now = datetime.now().astimezone().isoformat()
    for start in range(0, len(work), args.batch_size):
        batch = work[start : start + args.batch_size]
        images = [Image.open(path).convert("RGB") for _, path in batch]
        predictions = classifier(images, top_k=5, batch_size=args.batch_size)
        if predictions and isinstance(predictions[0], dict):
            predictions = [predictions]
        for (filename, _), candidates in zip(batch, predictions):
            top = max(candidates, key=lambda item: item["score"])
            label = str(top["label"])
            connection.execute(
                """
                INSERT OR REPLACE INTO image_classifications
                (filename, category, source_label, score, model, classified_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (filename, category_for(label), label, float(top["score"]), args.model, now),
            )
        connection.commit()
        print(f"Classified {min(start + len(batch), len(work))}/{len(work)}")

    connection.close()


if __name__ == "__main__":
    main()
