"""FastAPI 后端：提供逐行审校 API 与静态前端托管。"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .engine import analyze_plan

app = FastAPI(title="编织行指令审校", version="1.0.0")


class AnalyzeRequest(BaseModel):
    start_stitches: int = Field(..., description="起始针数（非负整数）", ge=0)
    rows: list[str] = Field(..., description="逐行指令源文本")


class AnalyzeResponse(BaseModel):
    rows: list[dict]


class SizeSpec(BaseModel):
    name: str = Field(..., description="尺码名称（去空白后非空）", min_length=1, max_length=40)
    start_stitches: int = Field(..., description="该尺码的起始针数（非负整数）", ge=0)

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("尺码名称不能为空")
        return v


class AnalyzeSizesRequest(BaseModel):
    rows: list[str] = Field(..., description="逐行指令源文本（所有尺码共用）")
    sizes: list[SizeSpec] = Field(..., description="2～8 个命名尺码", min_length=2, max_length=8)

    @field_validator("sizes")
    @classmethod
    def _names_unique(cls, sizes: list[SizeSpec]) -> list[SizeSpec]:
        names = [s.name for s in sizes]
        if len(set(names)) != len(names):
            raise ValueError("尺码名称不能重复")
        return sizes


class SizeAnalysis(BaseModel):
    name: str
    start_stitches: int
    rows: list[dict]


class AnalyzeSizesResponse(BaseModel):
    sizes: list[SizeAnalysis]


@app.post("/api/analyze", response_model=AnalyzeResponse)
def api_analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    return AnalyzeResponse(rows=[r.to_dict() for r in analyze_plan(req.start_stitches, req.rows)])


@app.post("/api/analyze_sizes", response_model=AnalyzeSizesResponse)
def api_analyze_sizes(req: AnalyzeSizesRequest) -> AnalyzeSizesResponse:
    """尺码联检：同一份行指令按各尺码起始针数独立逐行审校。

    每个尺码各自执行与单方案完全相同的解析、自适应重复推导与跨行针数
    传递；某尺码的短缺 / 语法错误只阻断该尺码自己的后续行，其余尺码
    继续审校，结果互不影响。
    """
    return AnalyzeSizesResponse(sizes=[
        SizeAnalysis(
            name=s.name,
            start_stitches=s.start_stitches,
            rows=[r.to_dict() for r in analyze_plan(s.start_stitches, req.rows)],
        )
        for s in req.sizes
    ])


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


# 静态前端（目录不存在时不挂载，方便只跑引擎测试）
_static_dir = None
_static_path = None
try:
    from pathlib import Path

    _static_path = Path(__file__).resolve().parent / "static"
    if _static_path.is_dir():
        _static_dir = str(_static_path)
        app.mount("/static", StaticFiles(directory=_static_dir), name="static")
except Exception:  # pragma: no cover - 静态目录问题不应阻断 API
    pass


@app.get("/")
def index() -> FileResponse:
    if _static_dir is None:
        raise HTTPException(status_code=404, detail="前端目录不存在")
    return FileResponse(f"{_static_dir}/index.html")
