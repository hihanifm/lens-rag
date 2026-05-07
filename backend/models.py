from pydantic import BaseModel, Field, field_serializer
from typing import List, Optional, Dict, Any, Literal
from datetime import datetime, timezone


def _dt_utc_z(dt: datetime) -> str:
    """Postgres TIMESTAMP columns are naive; store uses UTC (typical Docker PG). Emit Z so JS Date parses as UTC, not local."""
    u = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    return u.isoformat().replace("+00:00", "Z")


def _iso_utc_z(dt: datetime | None) -> str | None:
    return None if dt is None else _dt_utc_z(dt)


class ProjectCreate(BaseModel):
    name: str
    stored_columns: List[str]
    content_column: str = ''
    context_columns: List[str]
    id_column: Optional[str] = None
    display_columns: List[str]
    default_k: int = 5
    pin: Optional[str] = None
    source_filename: Optional[str] = None
    embed_url: Optional[str] = None
    embed_api_key: Optional[str] = None
    embed_model: Optional[str] = None
    embed_dims: Optional[int] = None
    rerank_model: Optional[str] = None
    rerank_enabled: bool = True


class ProjectResponse(BaseModel):
    id: int
    name: str
    schema_name: str
    stored_columns: List[str]
    content_column: str
    context_columns: List[str]
    id_column: Optional[str]
    display_columns: List[str]
    has_id_column: bool
    default_k: int
    status: str
    row_count: Optional[int]
    total_rows: Optional[int]
    ingestion_started_at: Optional[datetime]
    created_at: datetime
    embed_url: Optional[str] = None
    embed_model: Optional[str] = None
    embed_dims: Optional[int] = None
    rerank_model: Optional[str] = None
    rerank_enabled: Optional[bool] = None  # None = legacy row, treat as true in clients


class ModelListRequest(BaseModel):
    url: str
    api_key: Optional[str] = None


class EmbeddingVerifyRequest(BaseModel):
    """One-shot embed probe for the Connection wizard (same kwargs as project ingest)."""

    url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None


class RerankVerifyRequest(BaseModel):
    """One-shot rerank probe for the Create → Rerank wizard."""

    model: Optional[str] = None


class SystemConfigResponse(BaseModel):
    """Read-only server retrieval configuration (for transparency UI)."""
    embedding_provider: str
    embedding_url: str
    embedding_model: str
    embedding_dims: int
    reranker_enabled: bool
    reranker_model: str
    reranker_strategy: Optional[str] = None  # "native" | "embedding" — detected at runtime, cached in API process
    top_k_retrieval: int
    top_k_default: int
    top_k_max: int
    pgvector_version: Optional[str] = None
    vector_index: str
    keyword_search: str
    topic_pipeline: str
    hnsw_m_default: int = 16
    hnsw_ef_construction_default: int = 64
    hnsw_ef_search: Optional[str] = None
    hnsw_defaults_note: str
    compare_embed_query_prefix: str = ""
    compare_embed_doc_prefix:   str = ""


class ColumnInfo(BaseModel):
    columns: List[str]
    sheet_names: List[str]
    row_count: int


class SearchRequest(BaseModel):
    query: str
    mode: str          # "id" | "topic" | "legacy"
    legacy_method: Optional[str] = None  # "bm25" | "ilike" (only used when mode="legacy")
    k: Optional[int] = None
    # topic pipeline toggles (per-request; defaults preserve current behavior)
    use_vector: Optional[bool] = True
    use_bm25: Optional[bool] = True
    use_rrf: Optional[bool] = True
    use_rerank: Optional[bool] = True


class SearchResult(BaseModel):
    display_data: Dict[str, Any]
    score: Optional[float] = None
    # Optional per-stage diagnostics (topic mode only; best-effort).
    cosine_score: Optional[float] = None        # vector similarity (1 - cosine distance)
    bm25_rank: Optional[int] = None             # 1-based rank in BM25 retrieval list
    rerank_score: Optional[float] = None        # cross-encoder reranker score (if enabled)


class SearchStats(BaseModel):
    mode: str
    legacy_method: Optional[str] = None
    total_ms: float
    candidates_retrieved: Optional[int] = None
    results_returned: int
    # applied topic pipeline toggles (echoed back for transparency/history)
    use_vector: Optional[bool] = None
    use_bm25: Optional[bool] = None
    use_rrf: Optional[bool] = None
    use_rerank: Optional[bool] = None
    reranker_available: Optional[bool] = None  # False when RERANKER_ENABLED=false server-side
    # topic mode timings + per-stage candidate counts
    embedding_ms: Optional[float] = None
    vector_search_ms: Optional[float] = None
    vector_candidates: Optional[int] = None
    bm25_search_ms: Optional[float] = None
    bm25_candidates: Optional[int] = None
    rrf_merge_ms: Optional[float] = None
    reranker_ms: Optional[float] = None
    # id mode timings
    sql_lookup_ms: Optional[float] = None


class SearchResponse(BaseModel):
    results: List[SearchResult]
    stats: SearchStats


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    display_columns: Optional[List[str]] = None
    default_k: Optional[int] = None
    rerank_model: Optional[str] = None
    rerank_enabled: Optional[bool] = None


class ClusterFilterItem(BaseModel):
    """One column: one or more substring predicates OR’d together (ILIKE)."""
    column: str
    value: Optional[str] = None              # legacy single-value
    values: Optional[List[str]] = None        # preferred; OR within column


class ClusterRequest(BaseModel):
    algorithm: str                              # "kmeans" | "dbscan"
    k: Optional[int] = None                     # required for kmeans; ignored for dbscan
    filter_column: Optional[str] = None          # legacy: single predicate
    filter_value: Optional[str] = None
    filters: List[ClusterFilterItem] = Field(default_factory=list)  # combined with legacy; dup columns: last wins

class ClusterResult(BaseModel):
    display_data: Dict[str, Any]
    contextual_content: Optional[str] = None
    pca_x: float
    pca_y: float


class ClusterGroup(BaseModel):
    cluster_id: int   # -1 = Unassigned (DBSCAN noise)
    label: str        # "Cluster 1", "Cluster 2", "Unassigned"
    count: int
    records: List[ClusterResult]


class ClusterStats(BaseModel):
    algorithm: str
    records_loaded: int
    n_clusters: int
    ms_fetch: float
    ms_cluster: float
    total_ms: float


class ClusterResponse(BaseModel):
    groups: List[ClusterGroup]
    stats: ClusterStats


class EvalCase(BaseModel):
    question: str
    ground_truth: str


class EvalRequest(BaseModel):
    test_cases: List[EvalCase]
    k: int = 5
    # same pipeline toggles as topic search (defaults preserve current behavior)
    use_vector: Optional[bool] = True
    use_bm25: Optional[bool] = True
    use_rrf: Optional[bool] = True
    use_rerank: Optional[bool] = True


# ── Compare models ─────────────────────────────────────────────────────────

class CompareRowFilter(BaseModel):
    """Plain-text row filter applied after loading the sheet (AND-combined)."""

    column: str
    op: Literal[
        "contains",
        "not_contains",
        "equals",
        "not_equals",
        "empty",
        "not_empty",
        "regex",
    ] = "contains"
    value: Optional[str] = None


class CompareJobCreate(BaseModel):
    name: str
    label_left: str
    label_right: str
    tmp_path_left: str
    tmp_path_right: str
    sheet_name_left: Optional[str] = None
    sheet_name_right: Optional[str] = None
    row_filters_left: List[CompareRowFilter] = Field(default_factory=list)
    row_filters_right: List[CompareRowFilter] = Field(default_factory=list)
    source_filename_left: Optional[str] = None
    source_filename_right: Optional[str] = None
    context_columns_left: List[str]
    content_column_left: str
    display_column_left: Optional[str] = None
    context_columns_right: List[str]
    content_column_right: str
    display_column_right: Optional[str] = None
    embed_url: Optional[str] = None
    embed_api_key: Optional[str] = None
    embed_model: Optional[str] = None
    embed_query_prefix: Optional[str] = None
    embed_doc_prefix:   Optional[str] = None
    all_columns_left:  List[str] = Field(default_factory=list)
    all_columns_right: List[str] = Field(default_factory=list)


class CompareJobResponse(BaseModel):
    id: int
    name: str
    notes: Optional[str] = None
    label_left: str
    label_right: str
    sheet_name_left: Optional[str] = None
    sheet_name_right: Optional[str] = None
    row_filters_left: List[CompareRowFilter] = Field(default_factory=list)
    row_filters_right: List[CompareRowFilter] = Field(default_factory=list)
    schema_name: str
    status: str
    status_message: Optional[str] = None
    row_count_left: Optional[int] = None
    row_count_right: Optional[int] = None
    embed_url: Optional[str] = None
    embed_model: Optional[str] = None
    embed_dims: Optional[int] = None
    embed_query_prefix: Optional[str] = None
    embed_doc_prefix:   Optional[str] = None
    all_columns_left:  List[str] = Field(default_factory=list)
    all_columns_right: List[str] = Field(default_factory=list)
    context_columns_left: List[str] = Field(default_factory=list)
    content_column_left: Optional[str] = None
    context_columns_right: List[str] = Field(default_factory=list)
    content_column_right: Optional[str] = None
    created_at: datetime

    @field_serializer("created_at")
    def _ser_job_created_at(self, v: datetime) -> str:
        return _dt_utc_z(v)


class CompareRunCreate(BaseModel):
    name: Optional[str] = None
    top_k: int = 3
    vector_enabled: bool = True
    # When vector_enabled is false (LLM compares vs many right rows): max rights loaded per left; null uses server default.
    llm_compare_max_rights: Optional[int] = Field(default=None, ge=1, le=500)
    reranker_enabled: bool = False
    reranker_model: Optional[str] = None
    reranker_url: Optional[str] = None
    llm_judge_enabled: bool = False
    llm_judge_url: Optional[str] = None
    llm_judge_model: Optional[str] = None
    llm_judge_prompt: Optional[str] = None
    # Audit-only label when run used a named preset unchanged, e.g. "MyPreset-v3"
    llm_judge_prompt_preset_tag: Optional[str] = Field(default=None, max_length=240)
    # None = use server env LLM_JUDGE_MAX_REQUESTS_PER_MINUTE; 0 = unlimited; N > 0 = max N calls/min
    llm_judge_max_requests_per_minute: Optional[int] = Field(default=None, ge=0, le=360)
    notes: Optional[str] = None
    llm_judge_left_columns:  Optional[List[str]] = None
    llm_judge_right_columns: Optional[List[str]] = None


class CompareRunUpdate(BaseModel):
    """Name and optional notes — pipeline fields are immutable after create."""

    name: Optional[str] = None
    notes: Optional[str] = None


class CompareRunResponse(BaseModel):
    id: int
    job_id: int
    name: Optional[str] = None
    notes: Optional[str] = None
    status: str
    status_message: Optional[str] = None
    top_k: int
    vector_enabled: bool
    llm_compare_max_rights: Optional[int] = None
    reranker_enabled: bool
    reranker_model: Optional[str] = None
    reranker_url: Optional[str] = None
    llm_judge_enabled: bool
    llm_judge_url: Optional[str] = None
    llm_judge_model: Optional[str] = None
    llm_judge_prompt: Optional[str] = None
    llm_judge_prompt_preset_tag: Optional[str] = None
    llm_judge_max_requests_per_minute: Optional[int] = None
    llm_judge_left_columns:  Optional[List[str]] = None
    llm_judge_right_columns: Optional[List[str]] = None
    row_count_left: Optional[int] = None
    created_at: datetime
    completed_at: Optional[datetime] = None

    @field_serializer("created_at")
    def _ser_run_created_at(self, v: datetime) -> str:
        return _dt_utc_z(v)

    @field_serializer("completed_at")
    def _ser_run_completed_at(self, v: Optional[datetime]) -> Optional[str]:
        return _iso_utc_z(v)


class CompareJobUpdate(BaseModel):
    name: Optional[str] = None
    notes: Optional[str] = None


class CompareContextPreviewRequest(BaseModel):
    """Preview the merged text used for embeddings in Compare (pre-ingest)."""

    tmp_path: str
    match_columns: List[str]
    n: int = 3
    sheet_name: Optional[str] = None
    row_filters: List[CompareRowFilter] = Field(default_factory=list)


class CompareContextPreviewResponse(BaseModel):
    content_column: str
    context_columns: List[str]
    samples: List[str]


class ComparePreviewRowStatsRequest(BaseModel):
    tmp_path: str
    sheet_name: Optional[str] = None
    row_filters: List[CompareRowFilter] = Field(default_factory=list)


class ComparePreviewRowStatsResponse(BaseModel):
    row_count_unfiltered: int
    row_count_filtered: int


class ComparePreviewColumnValuesRequest(BaseModel):
    """Distinct cell values for one column (Excel compare upload), optional sibling row filters."""

    tmp_path: str
    column: str
    sheet_name: Optional[str] = None
    row_filters: List[CompareRowFilter] = Field(default_factory=list)


class ComparePreviewColumnValuesResponse(BaseModel):
    column: str
    values: List[str]
    truncated: bool


class ComparePreviewColumnSamplesRequest(BaseModel):
    """First-row samples per column for compare column-picker UI."""

    tmp_path: str
    sheet_name: Optional[str] = None
    row_filters: List[CompareRowFilter] = Field(default_factory=list)
    columns: List[str] = Field(default_factory=list)
    n: int = 1


class ComparePreviewColumnSamplesResponse(BaseModel):
    samples_by_column: Dict[str, List[str]]


class CompareLlmJudgeDefaultsResponse(BaseModel):
    """Built-in LLM judge settings for Compare runs (UI display + parity with pipeline)."""

    default_system_prompt: str
    fixed_suffix: str = Field(
        ...,
        description=(
            "Tail section embedded in default_system_prompt when llm_judge_prompt is empty; "
            "not appended when the run supplies a custom judge prompt."
        ),
    )
    max_tokens: int
    temperature: float
    default_max_requests_per_minute: int
    default_llm_judge_url: str = ""
    default_llm_judge_model: str = ""


class ComparePromptTemplateSummary(BaseModel):
    """List row — id + name + version (body fetched on demand)."""

    id: int
    name: str
    version: int


class ComparePromptTemplateResponse(BaseModel):
    """Full preset including domain overlay body."""

    id: int
    name: str
    body: str
    version: int
    created_at: datetime
    updated_at: datetime


class ComparePromptTemplateCreate(BaseModel):
    name: str
    body: str


class ComparePromptTemplateUpdate(BaseModel):
    name: Optional[str] = None
    body: Optional[str] = None


class CandidateItem(BaseModel):
    right_id: int
    contextual_content: str
    display_value: Optional[str] = None
    cosine_score: float
    rerank_score: Optional[float] = None
    llm_score: Optional[float] = None
    llm_judge_meta: Optional[Dict[str, Any]] = None
    final_score: Optional[float] = None
    rank: int


ReviewOutcome = Optional[Literal["no_match", "partial", "fail", "system_fail"]]


class ReviewItem(BaseModel):
    left_id: int
    contextual_content: str
    display_value: Optional[str] = None
    candidates: List[CandidateItem]
    matched_right_ids: List[int] = Field(default_factory=list)
    is_decided: bool
    review_comment: str = ""
    review_outcome: ReviewOutcome = None   # optional: semantic (no_match/partial/fail) or judge/pipeline (system_fail)


class CompareDecision(BaseModel):
    matched_right_id: Optional[int] = None   # legacy single-id submit; ignored when matched_right_ids is set
    matched_right_ids: Optional[List[int]] = None  # authoritative multi-select when present (including [])
    review_comment: str = ""
    review_outcome: ReviewOutcome = None
