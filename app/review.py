"""实测湿度复核引擎（纯标准库，无 Flask 依赖，便于单测）。

模型
====
* 计划曲线 P(t) 与实测曲线 M(t) 均视为**分段线性连续曲线**：
    - 计划曲线由最近排程快照的 chamber segments 重建：hold 段水平，
      ramp 段从 (start, from_rh) 线性到 (end, end_rh)，段间首尾相接；
    - 实测曲线穿过按分钟递增的传感器采样点线性插值。
* 复核在每个样本的在箱窗口 [board, unboard] 内进行，并按该样本泳道的
  计划阶段（入箱 / 换档 / 保持 / 冷却）切分。
* 允许带 = P(t) ± tolerance；超带量 E(t) = max(0, |M(t)-P(t)| - tolerance)，
  累计偏差剂量 = E(t) 在覆盖区间上的**精确解析积分**（两条折线之差仍为折线，
  收集全部折点与 ±tolerance 穿带点后梯形积分，单位 %RH·分钟）。
* 最大采样间隔 max_gap：相邻采样点间隔 **超过** 它的区间不得插值（数据缺口）；
  窗口两端也不做外推。窗口内只要存在任意长度的未覆盖段，该样本结论即
  「数据不足」。
* 结论：数据完整且剂量 ≤ 剂量上限 → 通过；数据完整但剂量超限 → 复核；
  存在未覆盖段 → 数据不足。
"""
from __future__ import annotations

import math
import re
from bisect import bisect_right
from dataclasses import dataclass
from typing import Any, Optional

EPS = 1e-9
_NUM_RE = re.compile(r'[-+]?(?:\d+\.\d*|\.\d+|\d+)')


class ReviewError(Exception):
    """复核输入或排程快照错误。"""


@dataclass
class Reading:
    minute: int
    rh: float


# --------------------------------------------------------------------------- #
# 输入解析 / 归一化
# --------------------------------------------------------------------------- #
def _num(v: Any, name: str, lo: Optional[float] = None,
         hi: Optional[float] = None) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ReviewError(f"{name} 必须是数字")
    if not math.isfinite(x):
        raise ReviewError(f"{name} 必须是有限数字")
    if lo is not None and x < lo - EPS:
        raise ReviewError(f"{name} 不能小于 {lo:g}")
    if hi is not None and x > hi + EPS:
        raise ReviewError(f"{name} 不能大于 {hi:g}")
    return x


def normalize_params(tolerance: Any, dose_limit: Any, max_gap: Any,
                     start_minute: Any = 0) -> tuple[float, float, int, int]:
    tol = _num(tolerance, "允许偏差", lo=0.01, hi=50)
    limit = _num(dose_limit, "累计偏差剂量上限", lo=0)
    gap = _num(max_gap, "最大采样间隔", lo=1)
    if abs(gap - round(gap)) > EPS:
        raise ReviewError("最大采样间隔必须是整数分钟")
    start = _num(start_minute, "读数起始分钟", lo=0)
    if abs(start - round(start)) > EPS:
        raise ReviewError("读数起始分钟必须是整数")
    return round(tol, 4), round(limit, 4), int(round(gap)), int(round(start))


def parse_readings(text: str, start_minute: int = 0) -> list[Reading]:
    """解析粘贴的传感器读数。

    每行一个采样点，支持两种写法，可混用（裸值按分钟顺延，显式分钟跳到该分钟）：
      * 单数字 ``50.2``         → 相对起始分钟顺延 1 分钟的实测湿度；
      * 两个数字 ``12, 50.2``   → 第 12 分钟实测 50.2%RH（分钟必须是递增整数）。
    空白、逗号、分号、冒号、Tab 均可作分隔；``#`` 开头的行视为注释。
    """
    if start_minute < 0:
        raise ReviewError("读数起始分钟不能为负")
    out: list[Reading] = []
    cursor = start_minute - 1
    last_minute: Optional[int] = None
    for lineno, raw in enumerate(str(text or '').splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        toks = _NUM_RE.findall(line)
        if not toks:
            continue
        try:
            nums = [float(t) for t in toks]
        except ValueError:
            raise ReviewError(f"第 {lineno} 行读数无法识别：{line}")
        if len(nums) == 1:
            minute = cursor + 1
            rh = nums[0]
        elif len(nums) == 2:
            minute_f, rh = nums
            if abs(minute_f - round(minute_f)) > EPS or minute_f < 0:
                raise ReviewError(
                    f"第 {lineno} 行的采样分钟必须是非负整数：{line}")
            minute = int(round(minute_f))
        else:
            raise ReviewError(
                f"第 {lineno} 行最多包含「分钟, 湿度」两个数字：{line}")
        if not (0 - EPS <= rh <= 100 + EPS):
            raise ReviewError(
                f"第 {lineno} 行湿度 {rh:g}% 超出 0–100%RH 范围")
        if last_minute is not None and minute <= last_minute:
            raise ReviewError(
                f"第 {lineno} 行采样分钟 {minute} 不严格递增"
                f"（上一采样点在第 {last_minute} 分钟）")
        out.append(Reading(minute=minute, rh=rh))
        cursor = minute
        last_minute = minute
    if not out:
        raise ReviewError("未解析到任何传感器读数（每行一个湿度值，或「分钟, 湿度」）")
    return out


# --------------------------------------------------------------------------- #
# 分段线性曲线
# --------------------------------------------------------------------------- #
def plan_curve(segments: list[dict]) -> list[tuple[float, float]]:
    """把排程快照的 chamber segments 重建为连续折线顶点 [(minute, rh), ...]。

    * hold[s,e)：值恒为 start_rh（=end_rh）；
    * ramp[s,e)：几何上从 (s, from_rh) 线性到 (e, end_rh)，
      与前段 hold 在 (s, from_rh) 处相接。
    """
    segs = sorted(segments, key=lambda g: (g['start'], g['end']))
    if not segs:
        return []
    first = segs[0]
    v0 = first.get('from_rh', first['start_rh']) \
        if first['kind'] == 'ramp' else first['start_rh']
    knots: list[tuple[float, float]] = [(float(first['start']), float(v0))]
    for g in segs:
        if g['kind'] == 'ramp':
            start_v = float(g.get('from_rh', g['start_rh']))
            prev_t, prev_v = knots[-1]
            if abs(prev_t - g['start']) <= EPS and \
                    abs(prev_v - start_v) > 1e-6:
                # 快照异常（折线断开）时以 ramp 自带的 from_rh 为准补顶点
                knots.append((float(g['start']), start_v))
        knots.append((float(g['end']), float(g['end_rh'])))
    return knots


def pl_at(knots: list[tuple[float, float]], t: float,
          times: list[float] | None = None) -> Optional[float]:
    """折线上 t 处的值；落在顶点范围外返回 None。"""
    if not knots:
        return None
    if t <= knots[0][0] + EPS:
        return knots[0][1]
    if t >= knots[-1][0] - EPS:
        return knots[-1][1]
    ts = times if times is not None else [k[0] for k in knots]
    i = bisect_right(ts, t) - 1
    t1, v1 = knots[i]
    t2, v2 = knots[i + 1]
    if t2 - t1 <= EPS:
        return v2
    f = (t - t1) / (t2 - t1)
    return v1 + f * (v2 - v1)


def _measured_at(readings: list[Reading], t: float, max_gap: int,
                 mins: list[float] | None = None) -> Optional[float]:
    """实测折线在 t 处的值；落在超采样间隔的缺口内或范围外返回 None（不插值/外推）。"""
    ts = mins if mins is not None else [r.minute for r in readings]
    i = bisect_right(ts, t) - 1
    if i < 0:
        return None
    if i == len(ts) - 1:
        return readings[i].rh if abs(t - ts[i]) <= EPS else None
    t1, t2 = ts[i], ts[i + 1]
    if t < t1 - EPS or t > t2 + EPS:
        return None
    if abs(t - t1) <= EPS:
        return readings[i].rh
    if abs(t - t2) <= EPS:
        return readings[i + 1].rh
    if t2 - t1 > max_gap:
        return None  # 超间隔缺口：不插值
    f = (t - t1) / (t2 - t1)
    return readings[i].rh + f * (readings[i + 1].rh - readings[i].rh)


# --------------------------------------------------------------------------- #
# 覆盖分析
# --------------------------------------------------------------------------- #
def covered_intervals(readings: list[Reading], max_gap: int,
                      a: float, b: float) -> list[tuple[float, float]]:
    """窗口 [a,b] 内允许使用实测折线的区间（相邻采样间隔 ≤ max_gap 才插值）。"""
    iv: list[tuple[float, float]] = []
    for r1, r2 in zip(readings, readings[1:]):
        if r2.minute - r1.minute > max_gap:
            continue
        u, v = max(a, float(r1.minute)), min(b, float(r2.minute))
        if v - u > EPS:
            iv.append((u, v))
    return iv


def uncovered_gaps(readings: list[Reading], max_gap: int, a: float,
                   b: float, covered=None) -> list[dict]:
    """窗口内未被实测覆盖的区间：窗口两端缺读段 + 每个超采样间隔的缺口（逐条列出）。"""
    gaps: list[dict] = []
    first, last = float(readings[0].minute), float(readings[-1].minute)
    if first > a + EPS:
        v = min(b, first)
        gaps.append({'start': round(a, 3), 'end': round(v, 3),
                     'minutes': round(v - a, 3),
                     'reason': '入箱时刻早于首个传感器读数，入箱起点段无实测数据'
                               '（不做外推）'})
    for r1, r2 in zip(readings, readings[1:]):
        if r2.minute - r1.minute <= max_gap:
            continue
        u, v = max(a, float(r1.minute)), min(b, float(r2.minute))
        if v - u > EPS:
            gaps.append({'start': round(u, 3), 'end': round(v, 3),
                         'minutes': round(v - u, 3),
                         'reason': f"第 {r1.minute}–{r2.minute} 分钟采样间隔 "
                                   f"{r2.minute - r1.minute} 分钟，超过最大采样间隔 "
                                   f"{max_gap} 分钟，按规则不得插值"})
    if last < b - EPS:
        u = max(a, last)
        gaps.append({'start': round(u, 3), 'end': round(b, 3),
                     'minutes': round(b - u, 3),
                     'reason': '出箱时刻晚于末个传感器读数，出箱终点段无实测数据'
                               '（不做外推）'})
    return gaps


# --------------------------------------------------------------------------- #
# 精确积分
# --------------------------------------------------------------------------- #
PHASE_NAMES = {
    'board': '入箱平衡', 'ramp': '换档', 'hold': '保持',
    'cooldown': '冷却保持', 'cooldown-ramp': '冷却换档', 'wait': '等待/偏离',
}


def _phase(piece: dict) -> tuple[str, Optional[int]]:
    name = PHASE_NAMES.get(piece.get('kind', ''), piece.get('kind', ''))
    step = piece.get('step', -1)
    return name, (int(step) + 1 if isinstance(step, int) and step >= 0 else None)


def analyze_piece(piece: dict, knots: list[tuple[float, float]],
                  readings: list[Reading], max_gap: int,
                  tol: float, knots_t: list[float] | None = None,
                  mins: list[float] | None = None) -> dict:
    """对单个计划阶段 [start,end] 精确积分超带面积，并收集超带区间。

    两条折线之差在每个「计划折点 ∪ 采样点 ∩ 缺口端点」格子内是线性的；
    再补入 diff=±tol 的穿带点，使超带量 E=max(0,|diff|-tol) 在每段端点
    取零或线性，直接梯形积分即解析精确值。缺口内的格子一律跳过。
    """
    knots_t = knots_t if knots_t is not None else [k[0] for k in knots]
    mins = mins if mins is not None else [r.minute for r in readings]
    p_start, p_end = float(piece['start']), float(piece['end'])
    base = {p_start, p_end}
    for t in knots_t:
        if p_start + EPS < t < p_end - EPS:
            base.add(float(t))
    for t in mins:
        if p_start - EPS <= t <= p_end + EPS:
            base.add(float(t))
    # 超采样间隔的缺口：把缺口端点作为分界，缺口内格子不积分
    for r1, r2 in zip(readings, readings[1:]):
        if r2.minute - r1.minute <= max_gap:
            continue
        t1, t2 = float(r1.minute), float(r2.minute)
        if t2 <= p_start + EPS or t1 >= p_end - EPS:
            continue
        if t1 > p_start + EPS:
            base.add(t1)
        if t2 < p_end - EPS:
            base.add(t2)

    times = sorted(base)
    # 逐格判定覆盖并补 ±tol 穿带点
    enriched: list[float] = []
    for u, v in zip(times, times[1:]):
        if not enriched or abs(u - enriched[-1]) > EPS:
            enriched.append(u)
        mid = (u + v) / 2
        if _measured_at(readings, mid, max_gap, mins) is None:
            enriched.append(v)  # 缺口/范围外格子：保留端点，积分时跳过
            continue
        du = _measured_at(readings, u, max_gap, mins)
        dv = _measured_at(readings, v, max_gap, mins)
        if du is not None and dv is not None:
            d1 = du - pl_at(knots, u, knots_t)
            d2 = dv - pl_at(knots, v, knots_t)
            for target in (tol, -tol):
                if (d1 - target) * (d2 - target) < -EPS:
                    c = u + (target - d1) * (v - u) / (d2 - d1)
                    if u + EPS < c < v - EPS:
                        enriched.append(c)
        enriched.append(v)
    enriched = sorted(set(round(t, 9) for t in enriched))

    phase_name, step = _phase(piece)
    dose = 0.0
    max_dev = 0.0
    exceed_minutes = 0.0
    runs: list[list[float]] = []
    cur_run: Optional[list[float]] = None
    for u, v in zip(enriched, enriched[1:]):
        if v - u <= EPS:
            continue
        mid = (u + v) / 2
        mu = _measured_at(readings, u, max_gap, mins)
        mv = _measured_at(readings, v, max_gap, mins)
        mm = _measured_at(readings, mid, max_gap, mins)
        if mu is None or mv is None or mm is None:
            cur_run = None  # 缺口：不插值，超带区间在此断开
            continue
        du = mu - pl_at(knots, u, knots_t)
        dv = mv - pl_at(knots, v, knots_t)
        eu = max(0.0, abs(du) - tol)
        ev = max(0.0, abs(dv) - tol)
        area = (eu + ev) / 2 * (v - u)
        dose += area
        if eu > EPS or ev > EPS:
            exceed_minutes += v - u
            max_dev = max(max_dev, abs(du), abs(dv))
            if cur_run is None or abs(u - cur_run[-1]) > 1e-6:
                cur_run = [u, v]
                runs.append(cur_run)
            else:
                cur_run[1] = v
        else:
            cur_run = None

    exceedances = []
    for u, v in runs:
        mu = _measured_at(readings, u, max_gap, mins)
        mv = _measured_at(readings, v, max_gap, mins)
        exceedances.append({
            'start': round(u, 3), 'end': round(v, 3),
            'minutes': round(v - u, 3),
            'phase': phase_name, 'step': step,
            'max_dev': round(max(
                abs(mu - pl_at(knots, u, knots_t)),
                abs(mv - pl_at(knots, v, knots_t))), 3),
            'meas_start': round(mu, 3), 'meas_end': round(mv, 3),
            'plan_start': round(pl_at(knots, u, knots_t), 3),
            'plan_end': round(pl_at(knots, v, knots_t), 3),
            'dose': _dose_of_run(u, v, knots, readings, max_gap, tol,
                                 knots_t, mins),
        })
    return {'start': int(p_start), 'end': int(p_end),
            'phase': phase_name, 'step': step,
            'dose': round(dose, 4), 'max_dev': round(max_dev, 3),
            'exceed_minutes': round(exceed_minutes, 3),
            'exceedances': exceedances}


def _dose_of_run(u: float, v: float, knots: list[tuple[float, float]],
                 readings: list[Reading], max_gap: int, tol: float,
                 knots_t: list[float] | None = None,
                 mins: list[float] | None = None) -> float:
    """单个超带区间 [u,v] 上的剂量（该区间内 E 线性分段，梯形积分）。"""
    pts = [u, v]
    for t in (mins if mins is not None else [r.minute for r in readings]):
        if u + EPS < t < v - EPS:
            pts.append(float(t))
    for t in (knots_t if knots_t is not None else [k[0] for k in knots]):
        if u + EPS < t < v - EPS:
            pts.append(float(t))
    pts.sort()
    total = 0.0
    for a, b in zip(pts, pts[1:]):
        da = abs(_measured_at(readings, a, max_gap, mins)
                 - pl_at(knots, a, knots_t)) - tol
        db = abs(_measured_at(readings, b, max_gap, mins)
                 - pl_at(knots, b, knots_t)) - tol
        total += (max(0.0, da) + max(0.0, db)) / 2 * (b - a)
    return round(total, 4)


# --------------------------------------------------------------------------- #
# 复核入口
# --------------------------------------------------------------------------- #
def review_schedule(schedule: dict, readings_raw: list[Reading] | str,
                    tolerance: Any, dose_limit: Any, max_gap: Any,
                    start_minute: Any = 0, note: str = '') -> dict:
    """对最近排程快照执行一次实测湿度复核。

    ``readings_raw`` 可以是已解析的 Reading 列表（测试用），也可以是粘贴文本。
    """
    segments = schedule.get('segments') or []
    lanes = schedule.get('lanes') or []
    if not schedule.get('feasible') or not segments or not lanes:
        raise ReviewError("最近一次排程不可用或不可行，请先生成可行排程后再载入复核")
    tol, limit, gap, start = normalize_params(
        tolerance, dose_limit, max_gap, start_minute)
    if isinstance(readings_raw, str):
        readings = parse_readings(readings_raw, start)
    else:
        readings = list(readings_raw)
        if not readings:
            raise ReviewError("缺少传感器读数")

    knots = plan_curve(segments)
    knots_t = [k[0] for k in knots]
    mins = [r.minute for r in readings]
    end_minute = int(schedule.get('end_minute') or knots[-1][0])

    samples_out = []
    for lane in lanes:
        a = lane.get('board')
        b = lane.get('unboard')
        base = {
            'sample_id': lane.get('sample_id'), 'code': lane.get('code'),
            'board': a, 'unboard': b,
        }
        if a is None or b is None:
            samples_out.append({**base, 'window_minutes': 0,
                                'covered_minutes': 0, 'conclusion': 'insufficient',
                                'dose': None, 'uncovered': [{
                                    'start': a, 'end': b, 'minutes': None,
                                    'reason': '该样本缺少完整的入箱/出箱时间'}],
                                'phases': [], 'exceedances': []})
            continue
        a, b = float(a), float(b)
        gaps = uncovered_gaps(readings, gap, a, b)
        covered_min = (b - a) - sum(g['minutes'] or 0 for g in gaps)
        phases = [analyze_piece(p, knots, readings, gap, tol, knots_t, mins)
                  for p in lane.get('pieces', [])
                  if p.get('end', 0) > a - EPS and p.get('start', 0) < b + EPS]
        dose = round(sum(p['dose'] for p in phases), 4)
        exceedances = [e for p in phases for e in p['exceedances']]
        complete = not gaps
        if not complete:
            conclusion = 'insufficient'
        elif dose > limit + 1e-7:
            conclusion = 'review'
        else:
            conclusion = 'pass'
        samples_out.append({
            **base, 'board': int(a), 'unboard': int(b),
            'window_minutes': round(b - a, 3),
            'covered_minutes': round(max(0.0, covered_min), 3),
            'conclusion': conclusion, 'dose': dose,
            'dose_limit': limit, 'tolerance': tol,
            'uncovered': gaps, 'phases': phases,
            'exceedances': exceedances,
        })

    order = {'pass': 0, 'review': 1, 'insufficient': 2}
    if samples_out:
        overall = max((s['conclusion'] for s in samples_out),
                      key=lambda c: order[c])
    else:
        overall = 'insufficient'
    summary = {'total': len(samples_out),
               'pass': sum(s['conclusion'] == 'pass' for s in samples_out),
               'review': sum(s['conclusion'] == 'review' for s in samples_out),
               'insufficient': sum(
                   s['conclusion'] == 'insufficient' for s in samples_out),
               'total_dose': round(
                   sum(s['dose'] or 0 for s in samples_out), 4)}

    holes = [{'start': r1.minute, 'end': r2.minute,
              'gap': r2.minute - r1.minute}
             for r1, r2 in zip(readings, readings[1:])
             if r2.minute - r1.minute > gap]
    return {
        'kind': 'humidity-review',
        'note': str(note or ''),
        'params': {'tolerance': tol, 'dose_limit': limit,
                   'max_gap': gap, 'start_minute': start},
        'end_minute': end_minute,
        'readings_count': len(readings),
        'first_minute': readings[0].minute,
        'last_minute': readings[-1].minute,
        'holes': holes,
        'plan_curve': [{'minute': round(t, 3), 'rh': round(v, 4)}
                       for t, v in knots],
        'measured_points': [{'minute': r.minute, 'rh': round(r.rh, 4)}
                            for r in readings],
        'windows': [{'sample_id': l.get('sample_id'), 'code': l.get('code'),
                     'board': l.get('board'), 'unboard': l.get('unboard')}
                    for l in lanes],
        'samples': samples_out,
        'overall': overall,
        'summary': summary,
        'board_times': schedule.get('board_times') or {},
        'conclusion_text': {'pass': '通过', 'review': '复核',
                            'insufficient': '数据不足'},
    }
