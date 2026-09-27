"""Flask 服务：REST API + 静态单页前端。

启动：python -m app.server  （容器内由 waitress 在 8000 端口提供服务）
"""
from __future__ import annotations

import json
import os

from flask import Flask, jsonify, request, send_from_directory

from . import scheduler
from .db import DB
from .seed import seed_if_empty

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('HUMIDITY_DB', os.path.join(BASE, 'data', 'humidity.db'))

app = Flask(__name__, static_folder=os.path.join(BASE, 'static'),
            static_url_path='/static')
db = DB(DB_PATH)
seed_if_empty(db)


# --------------------------------------------------------------------------- #
def _sample_payload(d: dict) -> dict:
    return {
        'id': d['id'], 'code': d['code'], 'rh_min': d['rh_min'],
        'rh_max': d['rh_max'], 'eq_rh': d['eq_rh'],
        'eq_duration': d['eq_duration'],
        'steps': [{'target': s['target'], 'dwell': s['dwell'],
                   'rate': s['rate']} for s in d['steps']],
        'excludes': d['excludes'],
    }


def _all_samples() -> list[dict]:
    return [_sample_payload(d) for d in db.list_samples()]


def _all_occ() -> list[dict]:
    return db.list_occ()


# --------------------------------------------------------------------------- #
# 页面
# --------------------------------------------------------------------------- #
@app.get('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


# --------------------------------------------------------------------------- #
# 样本
# --------------------------------------------------------------------------- #
@app.get('/api/samples')
def list_samples():
    return jsonify(_all_samples())


@app.post('/api/samples')
def save_sample():
    data = request.get_json(force=True, silent=True) or {}
    try:
        # 先经引擎归一化校验
        norm = scheduler.normalize_sample(data)
        payload = {
            'id': data.get('id'), 'code': norm.code, 'rh_min': norm.rh_min,
            'rh_max': norm.rh_max, 'eq_rh': norm.eq_rh,
            'eq_duration': norm.eq_duration,
            'steps': norm.steps,
            'excludes': sorted(int(x) for x in (data.get('excludes') or [])),
        }
        sid = db.upsert_sample(payload)
    except scheduler.SchedulingError as e:
        return jsonify({'error': str(e)}), 400
    return jsonify(_sample_payload(db.get_sample(sid))), 200


@app.delete('/api/samples/<int:sid>')
def remove_sample(sid: int):
    db.delete_sample(sid)
    return jsonify({'ok': True})


# --------------------------------------------------------------------------- #
# 占用与设置
# --------------------------------------------------------------------------- #
@app.get('/api/occupancies')
def list_occ():
    return jsonify(_all_occ())


@app.post('/api/occupancies')
def add_occ():
    data = request.get_json(force=True, silent=True) or {}
    try:
        norm = scheduler.normalize_occ(data)
        oid = db.add_occ({'start': norm.start, 'end': norm.end, 'rh': norm.rh,
                          'slots': norm.slots, 'note': norm.note})
    except scheduler.SchedulingError as e:
        return jsonify({'error': str(e)}), 400
    created = next(o for o in db.list_occ() if o['id'] == oid)
    return jsonify(created), 201


@app.delete('/api/occupancies/<int:oid>')
def remove_occ(oid: int):
    db.delete_occ(oid)
    return jsonify({'ok': True})


@app.get('/api/settings')
def get_settings():
    return jsonify({'capacity': db.get_capacity(),
                    'max_shift_delta': db.get_max_shift_delta()})


@app.post('/api/settings')
def set_settings():
    data = request.get_json(force=True, silent=True) or {}
    out = {}
    if 'capacity' in data:
        try:
            cap = int(float(data.get('capacity')))
            if cap < 1:
                raise ValueError
        except (TypeError, ValueError):
            return jsonify({'error': '容量必须为 ≥1 的整数'}), 400
        db.set_capacity(cap)
        out['capacity'] = cap
    # max_shift_delta：缺省 → 保持原值；null/空串 → 清除（不限制，兼容旧数据）
    if 'max_shift_delta' in data:
        raw = data.get('max_shift_delta')
        try:
            shift_limit = scheduler.normalize_max_shift_delta(
                None if raw in ('', ) else raw)
        except scheduler.SchedulingError as e:
            return jsonify({'error': str(e)}), 400
        db.set_max_shift_delta(shift_limit)
        out['max_shift_delta'] = shift_limit
    if not out:
        out = {'capacity': db.get_capacity(),
               'max_shift_delta': db.get_max_shift_delta()}
    else:
        out.setdefault('capacity', db.get_capacity())
        out.setdefault('max_shift_delta', db.get_max_shift_delta())
    return jsonify(out)


# --------------------------------------------------------------------------- #
# 排程与校验
# --------------------------------------------------------------------------- #
@app.post('/api/schedule')
def run_schedule():
    body = request.get_json(force=True, silent=True) or {}
    samples = body.get('samples') or _all_samples()
    occs = body.get('occupancies')
    if occs is None:
        occs = _all_occ()
    capacity = body['capacity'] if 'capacity' in body else db.get_capacity()
    shift_limit = (body['max_shift_delta'] if 'max_shift_delta' in body
                   else db.get_max_shift_delta())
    try:
        res = scheduler.schedule(samples, occs, capacity,
                                 max_shift_delta=shift_limit)
    except scheduler.SchedulingError as e:
        return jsonify({'error': str(e)}), 400
    db.save_schedule(res)
    return jsonify(res)


@app.post('/api/validate')
def validate():
    """拖拽后校验：body = {board_times: {sample_id: minute}, ...可选完整数据}"""
    body = request.get_json(force=True, silent=True) or {}
    samples = body.get('samples') or _all_samples()
    occs = body.get('occupancies')
    if occs is None:
        occs = _all_occ()
    capacity = body['capacity'] if 'capacity' in body else db.get_capacity()
    shift_limit = (body['max_shift_delta'] if 'max_shift_delta' in body
                   else db.get_max_shift_delta())
    board_times = body.get('board_times') or {}
    try:
        res = scheduler.validate_board_times(
            samples, occs, capacity, board_times,
            max_shift_delta=shift_limit)
    except scheduler.SchedulingError as e:
        return jsonify({'error': str(e)}), 400
    return jsonify(res)


@app.get('/api/schedule/latest')
def latest():
    s = db.latest_schedule()
    if s is None:
        return jsonify({})
    return jsonify(s)


@app.errorhandler(500)
def _err(e):
    return jsonify({'error': f'服务器错误：{e}'}), 500


if __name__ == '__main__':
    import waitress
    port = int(os.environ.get('PORT', 8000))
    print(f'古籍修复湿度阶梯试验编排台 → http://0.0.0.0:{port}')
    waitress.serve(app, host='0.0.0.0', port=port, threads=4)
