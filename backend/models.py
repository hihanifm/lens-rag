from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from datetime import datetime


class ProjectCreate(BaseModel):
    name: str
    stored_columns: List[str]
    content_column: str = ''
    context_columns: List[str]
    id_column: Optional[str] = None
    display_columns: List[str]
    default_k: int = 10
    pin: Optional[str] = None
    source_filename: Optional[str] = None


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
    created_at: datetime


class ColumnInfo(BaseModel):
    columns: List[str]
    sheet_names: List[str]
    row_count: int


class SearchRequest(BaseModel):
    query: str
    mode: str          # "id" or "topic"
    k: Optional[int] = None
    # topic pipeline toggles (per-request; defaults preserve current behavior)
    use_vector: Optional[bool] = True
    use_bm25: Optional[bool] = True
    use_rrf: Optional[bool] = True
    use_rerank: Optional[bool] = True


class SearchResult(BaseModel):
    display_data: Dict[str, Any]
    score: Optional[float] = None


class SearchStats(BaseModel):
    mode: str
    total_ms: float
    candidates_retrieved: Optional[int] = None
    results_returned: int
    # applied topic pipeline toggles (echoed back for transparency/history)
    use_vector: Optional[bool] = None
    use_bm25: Optional[bool] = None
    use_rrf: Optional[bool] = None
    use_rerank: Optional[bool] = None
    # topic mode timings
    embedding_ms: Optional[float] = None
    vector_search_ms: Optional[float] = None
    bm25_search_ms: Optional[float] = None
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


class EvalCase(BaseModel):
    question: str
    ground_truth: str


class EvalRequest(BaseModel):
    test_cases: List[EvalCase]
    k: int = 10
    # same pipeline toggles as topic search (defaults preserve current behavior)
    use_vector: Optional[bool] = True
    use_bm25: Optional[bool] = True
    use_rrf: Optional[bool] = True
    use_rerank: Optional[bool] = True
