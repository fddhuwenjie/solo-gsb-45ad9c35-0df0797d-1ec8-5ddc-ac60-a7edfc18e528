"""实测湿度复核引擎单元测试：
python3 -m unittest app.tests.test_review -v
"""
import unittest

from app.review import (ReviewError, Reading, analyze_piece, normalize_params,
                       parse_readings, plan_curve, review_schedule)


def hold(s, e, v):
    return {'start': s, 'end': e, 'kind': 'hold',
            'start_rh': v, 'end_rh': v}


def ramp(s, e, v0, v1):
    return {'start': s, 'end': e, 'kind': 'ramp',
            'start_rh': v0 + (v1 - v0) / max(e - s, 1),
            'end_rh': v1, 'from_rh': v0}


# 计划：50 保持 0..10；50→60 换档 10..20；60 保持 20..40；60→50 换档 40..50；
#       50 保持 50..70。样本窗口 [0,70)。
SEGMENTS = [hold(0, 10, 50), ramp(10, 20, 50, 60), hold(20, 40, 60),
            ramp(40, 50, 60, 50), hold(50, 70, 50)]
LANE = {'sample_id': 1, 'code': 'T', 'board': 0, 'unboard': 70,
        'pieces': [{'start': 0, 'end': 10, 'kind': 'hold', 'step': -1},
                   {'start': 10, 'end': 20, 'kind': 'ramp', 'step': 0},
                   {'start': 20, 'end': 40, 'kind': 'hold', 'step': 0},
                   {'start': 40, 'end': 50, 'kind': 'ramp', 'step': 0},
                   {'start': 50, 'end': 70, 'kind': 'cooldown', 'step': 1}]}
SCHEDULE = {'feasible': True, 'segments': SEGMENTS, 'lanes': [LANE],
            'end_minute': 70, 'board_times': {1: 0}}


def plan_value(t):
    if t < 10:
        return 50.0
    if t < 20:
        return 50.0 + (t - 10)
    if t < 40:
        return 60.0
    if t < 50:
        return 60.0 - (t - 40)
    return 50.0


def exact_readings():
    return [Reading(t, plan_value(t)) for t in range(71)]


class TestParsing(unittest.TestCase):
    def test_bare_values_use_start(self):
        rs = parse_readings("50\n50.5\n51", start_minute=100)
        self.assertEqual([(r.minute, r.rh) for r in rs],
                         [(100, 50), (101, 50.5), (102, 51)])

    def test_explicit_minutes_mixed(self):
        rs = parse_readings("10,50\n50.5\n12 51")
        self.assertEqual([r.minute for r in rs], [10, 11, 12])

    def test_comments_and_blanks_ignored(self):
        rs = parse_readings("# header\n\n50\n  # note\n51\n")
        self.assertEqual(len(rs), 2)

    def test_non_increasing_rejected(self):
        with self.assertRaises(ReviewError):
            parse_readings("5,50\n4,51")

    def test_rh_range(self):
        with self.assertRaises(ReviewError):
            parse_readings("0,120")

    def test_empty(self):
        with self.assertRaises(ReviewError):
            parse_readings("")

    def test_non_integer_minute(self):
        with self.assertRaises(ReviewError):
            parse_readings("1.5, 50")

    def test_normalize_params(self):
        tol, limit, gap, start = normalize_params('2', '60', '1', 0)
        self.assertEqual((tol, limit, gap, start), (2.0, 60.0, 1, 0))
        with self.assertRaises(ReviewError):
            normalize_params(0, 60, 1, 0)
        with self.assertRaises(ReviewError):
            normalize_params(2, -1, 1, 0)
        with self.assertRaises(ReviewError):
            normalize_params(2, 60, 1.5, 0)


class TestPlanCurve(unittest.TestCase):
    def test_continuous_knots(self):
        knots = plan_curve(SEGMENTS)
        self.assertEqual(knots[0], (0.0, 50.0))
        self.assertEqual(knots[-1], (70.0, 50.0))
        # ramp 从 hold 角点出发：无重复断裂顶点
        for (t1, v1), (t2, v2) in zip(knots, knots[1:]):
            self.assertLess(t1, t2)
        d = dict(knots)
        self.assertAlmostEqual(d[10.0], 50.0)
        self.assertAlmostEqual(d[20.0], 60.0)
        self.assertAlmostEqual(d[40.0], 60.0)
        self.assertAlmostEqual(d[50.0], 50.0)


class TestReview(unittest.TestCase):
    def test_exact_follow_pass_zero_dose(self):
        res = review_schedule(SCHEDULE, exact_readings(), 2, 60, 1)
        self.assertEqual(res['overall'], 'pass')
        s = res['samples'][0]
        self.assertEqual(s['conclusion'], 'pass')
        self.assertAlmostEqual(s['dose'], 0.0)
        self.assertEqual(s['uncovered'], [])

    def test_constant_offset_exact_area(self):
        # 实测恒为 53，tol=2；手工分段解析积分 = 156
        rs = [Reading(t, 53) for t in range(71)]
        res = review_schedule(SCHEDULE, rs, 2, 1000, 1)
        s = res['samples'][0]
        self.assertAlmostEqual(s['dose'], 156.0, places=6)

    def test_dose_over_limit_is_review(self):
        res = review_schedule(SCHEDULE, [Reading(t, 53) for t in range(71)],
                              2, 10, 1)
        self.assertEqual(res['samples'][0]['conclusion'], 'review')
        self.assertEqual(res['overall'], 'review')

    def test_dose_equal_limit_passes(self):
        # 计划恒定 50 × 20 分钟，实测恒 52，tol=1 → 剂量 20，上限 20 → 通过
        flat = {'feasible': True,
                'segments': [hold(0, 20, 50)],
                'lanes': [{'sample_id': 9, 'code': 'F', 'board': 0,
                           'unboard': 20,
                           'pieces': [{'start': 0, 'end': 20, 'kind': 'hold',
                                       'step': 0}]}],
                'end_minute': 20, 'board_times': {9: 0}}
        res = review_schedule(flat, [Reading(t, 52) for t in range(21)],
                              1, 20.0, 1)
        self.assertEqual(res['samples'][0]['conclusion'], 'pass')
        self.assertAlmostEqual(res['samples'][0]['dose'], 20.0)

    def test_oversize_gap_not_interpolated(self):
        # 缺口 10→15（5 分钟 > max_gap=2）：即便端点为 90 也不积分缺口面积
        flat = {'feasible': True, 'segments': [hold(0, 20, 50)],
                'lanes': [{'sample_id': 9, 'code': 'F', 'board': 0,
                           'unboard': 20,
                           'pieces': [{'start': 0, 'end': 20, 'kind': 'hold',
                                       'step': 0}]}],
                'end_minute': 20, 'board_times': {9: 0}}
        rs = [Reading(0, 50), Reading(10, 50), Reading(15, 90),
              Reading(20, 50)]
        res = review_schedule(flat, rs, 1, 1000, max_gap=2)
        s = res['samples'][0]
        self.assertEqual(s['conclusion'], 'insufficient')
        self.assertAlmostEqual(s['dose'], 0.0)
        gap_spans = [(g['start'], g['end']) for g in s['uncovered']]
        self.assertIn((10.0, 15.0), gap_spans)

        # 放开该缺口（读数改为每分钟，max_gap=5）后尖峰参与插值：
        # 50→90→50，超带量 |d|−1，穿带点距峰 39/8 分钟，
        # 剂量 = 2 × 0.5 × (39/8) × 39 = 190.125，结论变为复核
        rs_open = [Reading(t, 50 + 8 * (t - 10) if 10 <= t <= 15
                           else 50 + 8 * (20 - t) if 15 < t <= 20
                           else 50) for t in range(21)]
        res2 = review_schedule(flat, rs_open, 1, 100, max_gap=5)
        self.assertAlmostEqual(res2['samples'][0]['dose'], 190.125, places=4)
        self.assertEqual(res2['samples'][0]['conclusion'], 'review')

        # 间隔正好等于 max_gap 也允许插值（"超过上限"才禁止）：
        # 每分钟读数场景 0→10 间隔=10，max_gap=10 时应完整、无缺口
        per_min = [Reading(t, 50 if t != 5 else 52) for t in range(21)]
        res3 = review_schedule(flat, per_min, 1, 1000, max_gap=10)
        self.assertEqual(res3['samples'][0]['conclusion'], 'pass')

    def test_edge_gaps_no_extrapolation(self):
        flat = {'feasible': True, 'segments': [hold(0, 20, 50)],
                'lanes': [{'sample_id': 9, 'code': 'F', 'board': 0,
                           'unboard': 20,
                           'pieces': [{'start': 0, 'end': 20, 'kind': 'hold',
                                       'step': 0}]}],
                'end_minute': 20, 'board_times': {9: 0}}
        res = review_schedule(flat, [Reading(5, 50), Reading(15, 50)],
                              1, 1, max_gap=10)
        s = res['samples'][0]
        self.assertEqual(s['conclusion'], 'insufficient')
        self.assertEqual([(g['start'], g['end']) for g in s['uncovered']],
                         [(0.0, 5.0), (15.0, 20.0)])
        self.assertAlmostEqual(s['covered_minutes'], 10.0)

    def test_exceedances_listed_with_phases(self):
        rs = [Reading(t, 53) for t in range(71)]
        res = review_schedule(SCHEDULE, rs, 2, 1000, 1)
        exc = res['samples'][0]['exceedances']
        self.assertTrue(exc)
        # 首段是「保持」阶段（step -1 → 无档位编号），末段为冷却
        self.assertEqual(exc[0]['phase'], '保持')
        # 每个超带区间都带剂量，合计应等于样本总剂量
        self.assertAlmostEqual(sum(e['dose'] for e in exc),
                               res['samples'][0]['dose'], places=3)

    def test_piecewise_exact_integration(self):
        # 计划 50→60 线性 10 分钟；实测 54→64 线性（恒高 4），tol=2：
        # 超带量恒为 2，剂量 = 2*10 = 20
        knots = [(10.0, 50.0), (20.0, 60.0)]
        rs = [Reading(10, 54), Reading(20, 64)]
        p = analyze_piece({'start': 10, 'end': 20, 'kind': 'ramp', 'step': 0},
                          knots, rs, 10, tol=2)
        self.assertAlmostEqual(p['dose'], 20.0, places=6)
        self.assertEqual(len(p['exceedances']), 1)
        self.assertAlmostEqual(p['exceedances'][0]['minutes'], 10.0)

    def test_crossing_band_triangle(self):
        # 计划恒 50；实测 50→56 线性 6 分钟，tol=2：
        # e 从 0（t=2 穿带）线性增到 4，三角形面积 = 0.5*4*4 = 8
        knots = [(0.0, 50.0), (6.0, 50.0)]
        rs = [Reading(0, 50), Reading(6, 56)]
        p = analyze_piece({'start': 0, 'end': 6, 'kind': 'hold', 'step': 0},
                          knots, rs, 6, tol=2)
        self.assertAlmostEqual(p['dose'], 8.0, places=6)
        self.assertAlmostEqual(p['exceedances'][0]['start'], 2.0, places=3)
        self.assertAlmostEqual(p['exceedances'][0]['end'], 6.0, places=3)

    def test_infeasible_schedule_rejected(self):
        with self.assertRaises(ReviewError):
            review_schedule({**SCHEDULE, 'feasible': False},
                            exact_readings(), 2, 60, 1)


if __name__ == '__main__':
    unittest.main()
