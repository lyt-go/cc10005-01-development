"""代理可用性预检与接入准入接口。

独立视图：列出数据连接器、代理实例、代理地址与采样时刻的负载/权重依据，
默认按接入准入结论（拒绝优先、通过其次、已失效沉底）排列，方便排班复核。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.schemas import ActionResult, PageResult
from app.services.admission import REJECT, AdmissionService, admission_service

router = APIRouter(prefix="/api/admission", tags=["代理准入预检"])

service = admission_service

LIST_FIELDS = [
    "准入编号", "连接器编号", "实例编号", "代理地址", "代理端口", "目标域",
    "接入准入结论", "不可分配原因", "采样时刻", "最近存活时间", "负载率",
    "负载采样时刻", "分配权重", "权重来源", "准入时刻", "失效时刻", "失效原因",
]
CONCLUSIONS = ["准入通过", "准入拒绝", "已失效"]


class PrecheckPayload(BaseModel):
    """预检入参：连接器必选；代理实例留空时由系统按权重/负载自动选优。"""

    connector_id: int
    proxy_id: int | None = None
    remark: str | None = None


@router.get("", response_model=PageResult[dict])
def list_entries(
    keyword: str | None = Query(default=None, description="按连接器编号或实例编号检索"),
    conclusion: str | None = Query(default=None, description="准入通过、准入拒绝、已失效"),
    page: int = 1,
    size: int = 20,
) -> PageResult[dict]:
    """准入记录列表；默认已按接入准入结论排列，拒绝记录优先展示供复核。"""
    if size > 200:
        raise HTTPException(status_code=400, detail="每页最多 200 条，请缩小分页范围")
    items, total = service.list_entries(keyword=keyword, conclusion=conclusion, page=page, size=size)
    return PageResult(items=items, total=total, page=page, size=size)


@router.get("/summary")
def summary() -> dict[str, Any]:
    """看板汇总：通过/拒绝/失效数量与当前被占用的代理数。"""
    return service.summary()


@router.post("/precheck", response_model=ActionResult)
def precheck(payload: PrecheckPayload) -> ActionResult:
    """发起一次代理可用性预检；无论通过与否都会留下一条不可覆盖的准入记录。"""
    record, message = service.precheck(payload.connector_id, payload.proxy_id)
    if record is None:
        return ActionResult(ok=False, message=message)
    return ActionResult(ok=record.get("接入准入结论") != REJECT, message=message, entry=record)


@router.get("/{entry_id}", response_model=dict)
def get_entry(entry_id: int) -> dict:
    """读取单条准入记录，含采样时刻、负载率与权重来源等复核字段。"""
    entry = service.get_entry(entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"准入记录 {entry_id} 不存在")
    return entry


@router.get("/export")
def export_entries() -> dict[str, Any]:
    """导出代理准入清单全量数据（含历史拒绝与失效记录）。"""
    items, total = service.list_entries(page=1, size=10000)
    return {"module": "admission", "total": total, "items": items}
