import time
import logging
from collections import defaultdict

import numpy as np
from sklearn.cluster import KMeans, DBSCAN
from sklearn.decomposition import PCA
from sklearn.preprocessing import normalize
from fastapi import HTTPException

from db import get_cursor
from ingestion import safe_col_name
from models import ClusterResponse, ClusterGroup, ClusterResult, ClusterStats

logger = logging.getLogger("lens.clustering")


def _parse_embedding(s: str) -> list[float]:
    return [float(v) for v in s.strip("[]").split(",")]


def fetch_embeddings(
    schema_name: str,
    display_columns: list[str],
    filter_column: str | None,
    filter_value: str | None,
) -> tuple[list[int], np.ndarray, list[dict]]:
    """
    Fetch all record embeddings and display-column values for the project.
    Returns (ids, float32 matrix [N, dims], list of display dicts).

    pgvector.psycopg2.register_vector is never called in this codebase so
    RealDictCursor returns the embedding column as a plain string; we cast to
    ::text and parse manually — same approach as browse_project in main.py.
    """
    safe_display = [f'col_{safe_col_name(c)}' for c in display_columns]
    select_cols = ", ".join(f'"{c}"' for c in safe_display)

    where_clause = ""
    params: list = []
    if filter_column and filter_value:
        safe_fc = f'col_{safe_col_name(filter_column)}'
        where_clause = f'WHERE "{safe_fc}" ILIKE %s'
        params = [f"%{filter_value}%"]

    with get_cursor() as (cur, _conn):
        cur.execute(
            f"""
            SELECT id, {select_cols}, embedding::text AS embedding_text
            FROM {schema_name}.records
            {where_clause}
            ORDER BY id
            """,
            params,
        )
        rows = cur.fetchall()

    if not rows:
        return [], np.empty((0, 0), dtype=np.float32), []

    ids = [r["id"] for r in rows]

    emb_list = [_parse_embedding(r["embedding_text"]) for r in rows]
    embeddings = np.array(emb_list, dtype=np.float32)

    display_rows = [
        {col: r.get(f'col_{safe_col_name(col)}') for col in display_columns}
        for r in rows
    ]

    return ids, embeddings, display_rows


def _pca_reduce(normed: np.ndarray) -> np.ndarray:
    """Reduce L2-normalised embeddings to 2D and scale axes to [-1, 1]."""
    n_components = min(2, normed.shape[0], normed.shape[1])
    coords = PCA(n_components=n_components, random_state=42).fit_transform(normed)
    # Pad to 2 columns if n_components < 2 (degenerate dataset)
    if coords.shape[1] < 2:
        coords = np.hstack([coords, np.zeros((coords.shape[0], 2 - coords.shape[1]))])

    # Min-max scale each axis independently to [-1, 1]
    for i in range(2):
        lo, hi = coords[:, i].min(), coords[:, i].max()
        if hi > lo:
            coords[:, i] = 2 * (coords[:, i] - lo) / (hi - lo) - 1
        else:
            coords[:, i] = 0.0
    return coords


def cluster(
    schema_name: str,
    display_columns: list[str],
    algorithm: str,
    k: int | None,
    filter_column: str | None,
    filter_value: str | None,
) -> ClusterResponse:
    total_start = time.perf_counter()

    if algorithm not in ("kmeans", "dbscan"):
        raise HTTPException(status_code=400, detail="algorithm must be 'kmeans' or 'dbscan'")
    if algorithm == "kmeans" and k is None:
        raise HTTPException(status_code=400, detail="k is required for K-Means")

    # ── Fetch ──────────────────────────────────────────────────────────────
    t = time.perf_counter()
    ids, embeddings, display_rows = fetch_embeddings(
        schema_name, display_columns, filter_column, filter_value
    )
    ms_fetch = round((time.perf_counter() - t) * 1000, 1)

    n = len(ids)
    logger.info(
        "cluster() schema=%s algorithm=%s k=%s filter=%s=%s records=%d fetch_ms=%.1f",
        schema_name, algorithm, k, filter_column, filter_value, n, ms_fetch,
    )

    if n == 0:
        return ClusterResponse(
            groups=[],
            stats=ClusterStats(
                algorithm=algorithm, records_loaded=0, n_clusters=0,
                ms_fetch=ms_fetch, ms_cluster=0.0,
                total_ms=round((time.perf_counter() - total_start) * 1000, 1),
            ),
        )

    if algorithm == "kmeans":
        max_k = min(50, n - 1) if n > 1 else 1
        if not (2 <= k <= max_k):
            raise HTTPException(
                status_code=400,
                detail=f"k must be between 2 and {max_k} for this dataset ({n} records)",
            )

    # ── Normalise ──────────────────────────────────────────────────────────
    # L2 normalisation makes Euclidean distance equivalent to cosine distance
    # on the unit sphere — required because sklearn KMeans is Euclidean-only
    # while the project's embeddings are indexed under cosine distance in pgvector.
    normed = normalize(embeddings, norm="l2")

    # ── Cluster ────────────────────────────────────────────────────────────
    t = time.perf_counter()
    if algorithm == "kmeans":
        labels = KMeans(n_clusters=k, random_state=42, n_init="auto").fit_predict(normed)
    else:
        # eps=0.3 on L2-normalised vectors ≈ cosine similarity threshold of ~0.955.
        # Conservative default: only groups genuinely similar records.
        labels = DBSCAN(eps=0.3, min_samples=5, metric="euclidean").fit_predict(normed)
    ms_cluster = round((time.perf_counter() - t) * 1000, 1)

    # ── PCA for scatter ────────────────────────────────────────────────────
    coords = _pca_reduce(normed)

    # ── Build groups ───────────────────────────────────────────────────────
    buckets: dict[int, list[tuple[dict, float, float]]] = defaultdict(list)
    for lbl, display_data, (px, py) in zip(labels.tolist(), display_rows, coords.tolist()):
        buckets[int(lbl)].append((display_data, px, py))

    groups: list[ClusterGroup] = []
    # Normal clusters sorted by id; DBSCAN noise (-1) always last
    for cluster_id in sorted(buckets.keys(), key=lambda x: (x == -1, x)):
        items = buckets[cluster_id]
        label = "Unassigned" if cluster_id == -1 else f"Cluster {cluster_id + 1}"
        groups.append(
            ClusterGroup(
                cluster_id=cluster_id,
                label=label,
                count=len(items),
                records=[
                    ClusterResult(display_data=d, pca_x=px, pca_y=py)
                    for d, px, py in items
                ],
            )
        )

    n_clusters = sum(1 for g in groups if g.cluster_id != -1)
    total_ms = round((time.perf_counter() - total_start) * 1000, 1)

    logger.info(
        "cluster() done n_clusters=%d records=%d fetch_ms=%.1f cluster_ms=%.1f total_ms=%.1f",
        n_clusters, n, ms_fetch, ms_cluster, total_ms,
    )

    return ClusterResponse(
        groups=groups,
        stats=ClusterStats(
            algorithm=algorithm,
            records_loaded=n,
            n_clusters=n_clusters,
            ms_fetch=ms_fetch,
            ms_cluster=ms_cluster,
            total_ms=total_ms,
        ),
    )
