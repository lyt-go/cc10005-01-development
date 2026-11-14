"""代理可用性预检与接入准入库。

设计取舍（有效性边界）：
- 每次预检以**采样时刻**为准入有效性边界：目标域允许关系、代理状态、最近存活时间、
  分配权重与当时已存在的有效准入占用，都取采样时刻的内存快照，一次性给出结论。
- 准入结果只追加不覆盖：同一连接器再次通过预检时，旧有效记录置为「已失效-被新预检替代」，
  历史行原样保留；预检失败只追加拒绝记录，连接器状态与原分配不回退。
- 代理被回收或连接器被置为离线后，相关有效记录置为「已失效」并记录失效原因与失效时刻，
  历史接入结论本身不被改写。
- 全部预检在同一把进程锁内串行完成评估+占位，保证多个采集入口争用最后一个代理时只有一份通过。
"""
from __future__ import annotations

import threading
from datetime import datetime
from typing import Any

from app.store import store

MODULE = "admission"

# 准入结论（同时作为记录状态，便于概览/看板直接按状态聚合）
PASS = "准入通过"
REJECT = "准入拒绝"
INVALID = "已失效"

# 预检排序优先级：拒绝（需复核）排在最前，通过其次，已失效沉底
_CONCLUSION_ORDER = {REJECT: 0, PASS: 1, INVALID: 2}

# 存活新鲜度窗口：采样时刻与最近存活检测时间差超过该值即判定存活过期
STALE_SECONDS = 30 * 60
# 负载率达到该阈值即判定过载
LOAD_LIMIT = 0.85

_LOCK = threading.Lock()


def _now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def parse_alive_time(value: Any) -> datetime | None:
    text = str(value or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def domain_allowed(allowed_field: Any, target_domain: str) -> bool:
    """目标域匹配：支持精确域名与 ``*.example.com`` 形式的通配后缀。"""
    target = target_domain.strip().lower()
    if not target:
        return False
    for item in str(allowed_field or "").split(","):
        rule = item.strip().lower()
        if not rule:
            continue
        if rule.startswith("*."):
            suffix = rule[1:]  # 保留前导点：".example.com"
            if target == rule[2:] or target.endswith(suffix):
                return True
        elif rule == target:
            return True
    return False


class AdmissionService:
    """代理可用性预检、准入留痕与占用释放。"""

    # ---- 读取侧 -----------------------------------------------------------------

    def list_entries(
        self,
        *,
        keyword: str | None = None,
        conclusion: str | None = None,
        page: int = 1,
        size: int = 20,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = store.rows(MODULE)
        if keyword:
            rows = [
                row
                for row in rows
                if keyword in str(row.get("连接器编号", ""))
                or keyword in str(row.get("实例编号", ""))
            ]
        if conclusion:
            rows = [row for row in rows if row.get("接入准入结论") == conclusion]
        rows = sorted(
            rows,
            key=lambda row: (
                _CONCLUSION_ORDER.get(str(row.get("接入准入结论")), 9),
                -int(row.get("id", 0)),
            ),
        )
        total = len(rows)
        start = max(page - 1, 0) * size
        return rows[start:start + size], total

    def get_entry(self, entry_id: int) -> dict[str, Any] | None:
        return store.find(MODULE, entry_id)

    def active_rows(self) -> list[dict[str, Any]]:
        return [row for row in store.rows(MODULE) if row.get("接入准入结论") == PASS]

    def is_proxy_occupied(self, proxy_id: int) -> bool:
        return any(int(row.get("代理实例ID", 0)) == proxy_id for row in self.active_rows())

    def occupied_connector_ids(self) -> set[int]:
        return {int(row.get("连接器ID", 0)) for row in self.active_rows()}

    # ---- 预检主流程 -------------------------------------------------------------

    def precheck(self, connector_id: int, proxy_id: int | None = None) -> tuple[dict[str, Any] | None, str]:
        """对一个数据连接器执行代理可用性预检并完成准入占位。

        采样时刻在加锁后取一次，整次评估复用同一时刻，避免评估中途状态漂移。
        返回 (准入记录, 提示语)；连接器本身不存在时记录为 None。
        """
        with _LOCK:
            sampled_at = _now_text()
            connector = store.find("connector", connector_id)
            if connector is None:
                return None, f"数据连接器 {connector_id} 不存在或已归档，无法发起代理可用性预检"

            target_domain = str(connector.get("目标域") or "").strip()
            if not target_domain:
                return self._reject(
                    connector, None, sampled_at,
                    reason="连接器未登记目标域，无法核对代理允许的目标域",
                ), "预检失败：连接器缺少目标域，原连接器状态已保留"

            if connector.get("status") == "已离线":
                return self._reject(
                    connector, proxy_id and store.find("proxypool", proxy_id), sampled_at,
                    reason="连接器已离线，采样时刻不具备接入准入条件",
                ), "预检失败：连接器已离线，原连接器状态已保留"

            proxy, reason = self._select_proxy(connector, target_domain, proxy_id, sampled_at)
            if proxy is None:
                return self._reject(
                    connector,
                    store.find("proxypool", proxy_id) if proxy_id else None,
                    sampled_at,
                    reason=reason,
                ), f"预检失败：{reason}；原连接器状态已保留"

            # 评估通过：同一连接器旧的有效准入让位（历史行保留，不覆盖）
            for row in self.active_rows():
                if int(row.get("连接器ID", 0)) == connector_id:
                    row["接入准入结论"] = INVALID
                    row["准入状态"] = INVALID
                    row["失效时刻"] = sampled_at
                    row["失效原因"] = f"被 {sampled_at} 的新一轮预检替代"

            record = self._build_record(connector, proxy, sampled_at)
            store.rows(MODULE).append(record)
            self._writeback(connector, record)
            return record, (
                f"预检通过：{connector.get('连接器编号')} 准入代理 "
                f"{proxy.get('实例编号')}（{proxy.get('代理地址')}），分配结果已回写连接器详情"
            )

    # ---- 候选评估 ---------------------------------------------------------------

    def _select_proxy(
        self,
        connector: dict[str, Any],
        target_domain: str,
        proxy_id: int | None,
        sampled_at: str,
    ) -> tuple[dict[str, Any] | None, str]:
        proxies = store.rows("proxypool")

        # 指定代理：只评估该实例，并把不可分配的具体原因返回给排班人员复核
        if proxy_id is not None:
            target = next((row for row in proxies if int(row.get("id", 0)) == proxy_id), None)
            if target is None:
                return None, f"代理实例 {proxy_id} 不存在或已归档"
            reason = self._evaluate_one(target, target_domain, sampled_at)
            if reason:
                return None, reason
            return target, ""

        # 未指定：在全部满足硬性条件的代理里按权重高、负载低、编号稳定排序选优
        candidates: list[tuple[dict[str, Any], float, int]] = []
        for proxy in proxies:
            if self._evaluate_one(proxy, target_domain, sampled_at):
                continue
            load = self._load_rate(proxy)
            candidates.append((proxy, load, int(proxy.get("id", 0))))
        if not candidates:
            return None, "目标域允许且采样时刻存活、未过载、未被占用的代理实例为 0，无可分配代理"
        candidates.sort(key=lambda item: (-_as_float(item[0].get("分配权重")), item[1], item[2]))
        return candidates[0][0], ""

    def _evaluate_one(self, proxy: dict[str, Any], target_domain: str, sampled_at: str) -> str:
        """返回空串表示通过；否则返回可复核的不可分配原因。"""
        label = f"{proxy.get('实例编号')}（{proxy.get('代理地址')}）"
        if proxy.get("status") != "可用":
            return f"代理 {label} 采样时刻状态为「{proxy.get('status')}」，不在可用状态"
        if not domain_allowed(proxy.get("允许目标域"), target_domain):
            return (
                f"代理 {label} 允许目标域为「{proxy.get('允许目标域') or '未登记'}」，"
                f"不覆盖目标域 {target_domain}"
            )
        alive_at = parse_alive_time(proxy.get("存活检测时间"))
        if alive_at is None:
            return f"代理 {label} 缺少可解析的最近存活时间，无法确认存活新鲜度"
        age_seconds = (datetime.strptime(sampled_at, "%Y-%m-%d %H:%M:%S") - alive_at).total_seconds()
        if age_seconds > STALE_SECONDS:
            return (
                f"代理 {label} 最近存活时间 {proxy.get('存活检测时间')} 距采样时刻已 "
                f"{int(age_seconds // 60)} 分钟，超过 {STALE_SECONDS // 60} 分钟存活窗口"
            )
        load = self._load_rate(proxy)
        if load >= LOAD_LIMIT:
            return (
                f"代理 {label} 采样时刻负载率 {load:.0%}（当前连接数 "
                f"{proxy.get('当前连接数')}/{proxy.get('容量上限')}）达到 {LOAD_LIMIT:.0%} 过载线"
            )
        if self.is_proxy_occupied(int(proxy.get("id", 0))):
            return (
                f"代理 {label} 已被其他采集入口的有效准入占用（容量上限 "
                f"{proxy.get('容量上限')}），无剩余分配名额"
            )
        return ""

    @staticmethod
    def _load_rate(proxy: dict[str, Any]) -> float:
        capacity = _as_int(proxy.get("容量上限"), 0)
        if capacity <= 0:
            return 1.0
        return min(1.0, _as_int(proxy.get("当前连接数")) / capacity)

    # ---- 记录与回写 -------------------------------------------------------------

    def _build_record(
        self,
        connector: dict[str, Any],
        proxy: dict[str, Any],
        sampled_at: str,
    ) -> dict[str, Any]:
        rows = store.rows(MODULE)
        load_rate = self._load_rate(proxy)
        alive_age = ""
        alive_at = parse_alive_time(proxy.get("存活检测时间"))
        if alive_at is not None:
            age = (datetime.strptime(sampled_at, "%Y-%m-%d %H:%M:%S") - alive_at).total_seconds()
            alive_age = f"{int(age // 60)}分{int(age % 60)}秒"
        return {
            "id": max((int(row.get("id", 0)) for row in rows), default=0) + 1,
            "status": PASS,
            "pending": False,
            "abnormal": False,
            "准入编号": f"ADM-{max((int(row.get('id', 0)) for row in rows), default=0) + 1:04d}",
            "连接器ID": connector.get("id"),
            "连接器编号": connector.get("连接器编号"),
            "代理实例ID": proxy.get("id"),
            "实例编号": proxy.get("实例编号"),
            "代理地址": proxy.get("代理地址"),
            "代理端口": proxy.get("代理端口"),
            "目标域": connector.get("目标域"),
            "接入准入结论": PASS,
            "准入状态": PASS,
            "不可分配原因": "",
            "采样时刻": sampled_at,
            "采样时刻代理状态": proxy.get("status"),
            "最近存活时间": proxy.get("存活检测时间"),
            "存活时差": alive_age,
            "负载采样时刻": sampled_at,
            "当前连接数": proxy.get("当前连接数"),
            "容量上限": proxy.get("容量上限"),
            "负载率": f"{load_rate:.0%}",
            "分配权重": proxy.get("分配权重"),
            "权重来源": f"代理池档案「分配权重」字段（实例 {proxy.get('实例编号')}，采样时刻快照）",
            "准入时刻": sampled_at,
            "失效时刻": "",
            "失效原因": "",
        }

    def _reject(
        self,
        connector: dict[str, Any],
        proxy: dict[str, Any] | None,
        sampled_at: str,
        *,
        reason: str,
    ) -> dict[str, Any]:
        rows = store.rows(MODULE)
        next_id = max((int(row.get("id", 0)) for row in rows), default=0) + 1
        load_rate = self._load_rate(proxy) if proxy else 0.0
        record = {
            "id": next_id,
            "status": REJECT,
            "pending": True,
            "abnormal": True,
            "准入编号": f"ADM-{next_id:04d}",
            "连接器ID": connector.get("id"),
            "连接器编号": connector.get("连接器编号"),
            "代理实例ID": proxy.get("id") if proxy else None,
            "实例编号": proxy.get("实例编号") if proxy else "—",
            "代理地址": proxy.get("代理地址") if proxy else "—",
            "代理端口": proxy.get("代理端口") if proxy else "—",
            "目标域": connector.get("目标域"),
            "接入准入结论": REJECT,
            "准入状态": REJECT,
            "不可分配原因": reason,
            "采样时刻": sampled_at,
            "采样时刻代理状态": proxy.get("status") if proxy else "—",
            "最近存活时间": proxy.get("存活检测时间") if proxy else "—",
            "存活时差": "—",
            "负载采样时刻": sampled_at,
            "当前连接数": proxy.get("当前连接数") if proxy else "—",
            "容量上限": proxy.get("容量上限") if proxy else "—",
            "负载率": f"{load_rate:.0%}" if proxy else "—",
            "分配权重": proxy.get("分配权重") if proxy else "—",
            "权重来源": (
                f"代理池档案「分配权重」字段（实例 {proxy.get('实例编号')}，采样时刻快照）"
                if proxy else "未命中代理实例，无权重来源"
            ),
            "准入时刻": "",
            "失效时刻": "",
            "失效原因": "",
        }
        rows.append(record)
        # 预检失败：保留原连接器状态，只留痕最近一次拒绝原因，分配字段一律不动
        connector["最近预检时刻"] = sampled_at
        connector["最近预检结论"] = REJECT
        connector["最近不可分配原因"] = reason
        return record

    @staticmethod
    def _writeback(connector: dict[str, Any], record: dict[str, Any]) -> None:
        """预检通过才回写连接器详情；历史接入结果在准入表中保留，不在连接器上覆盖删除。"""
        connector["准入结论"] = record["接入准入结论"]
        connector["准入状态"] = record["准入状态"]
        connector["分配代理实例"] = record["实例编号"]
        connector["分配代理地址"] = record["代理地址"]
        connector["准入编号"] = record["准入编号"]
        connector["准入时刻"] = record["准入时刻"]
        connector["负载采样时刻"] = record["负载采样时刻"]
        connector["负载率"] = record["负载率"]
        connector["最近预检时刻"] = record["采样时刻"]
        connector["最近预检结论"] = PASS
        connector["最近不可分配原因"] = ""

    # ---- 失效回收 ---------------------------------------------------------------

    def release_proxy(self, proxy_id: int, reason: str) -> int:
        """代理回收时释放其名下有效准入；历史行保留并标记失效原因。返回受影响行数。"""
        return self._release(proxy_id=proxy_id, connector_id=None, reason=reason)

    def release_connector(self, connector_id: int, reason: str) -> int:
        """连接器离线时释放其有效准入。返回受影响行数。"""
        return self._release(proxy_id=None, connector_id=connector_id, reason=reason)

    def _release(self, *, proxy_id: int | None, connector_id: int | None, reason: str) -> int:
        affected = 0
        moment = _now_text()
        connector = store.find("connector", connector_id) if connector_id is not None else None
        with _LOCK:
            for row in self.active_rows():
                if proxy_id is not None and int(row.get("代理实例ID", 0)) != proxy_id:
                    continue
                if connector_id is not None and int(row.get("连接器ID", 0)) != connector_id:
                    continue
                row["接入准入结论"] = INVALID
                row["准入状态"] = INVALID
                row["status"] = INVALID
                row["pending"] = True
                row["失效时刻"] = moment
                row["失效原因"] = reason
                affected += 1
                if connector is not None:
                    # 连接器侧同步标记当前分配已失效，但保留分配快照便于事后核对
                    connector["准入状态"] = INVALID
                    connector["准入结论失效时刻"] = moment
                    connector["准入结论失效原因"] = reason
        return affected

    # ---- 看板汇总 ---------------------------------------------------------------

    def summary(self) -> dict[str, Any]:
        rows = store.rows(MODULE)
        passed = sum(1 for row in rows if row.get("接入准入结论") == PASS)
        rejected = sum(1 for row in rows if row.get("接入准入结论") == REJECT)
        invalid = sum(1 for row in rows if row.get("接入准入结论") == INVALID)
        return {
            "total": len(rows),
            "passed": passed,
            "rejected": rejected,
            "invalid": invalid,
            "occupied_proxies": len({int(row.get("代理实例ID", 0)) for row in self.active_rows()}),
        }


admission_service = AdmissionService()
