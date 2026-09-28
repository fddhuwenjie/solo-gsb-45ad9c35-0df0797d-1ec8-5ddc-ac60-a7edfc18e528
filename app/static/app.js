/* 古籍修复湿度阶梯试验编排台 —— 原生 JS，无任何框架/依赖 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
};

const state = {
  samples: [],
  occs: [],
  capacity: 3,
  maxShiftDelta: null,   // 独立换档上限（%RH）；null = 不限制（兼容旧数据）
  result: null,        // 最近一次 schedule/validate 返回
  boardTimes: {},      // 当前泳道使用的入箱分钟（拖拽会改变）
  editingId: null,
  pxPerMin: 2,
  dragging: null,
};

const fmtMin = (m) => {
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), x = m % 60;
  return (d ? d + 'd' : '') + (h ? h + 'h' : '') + ((x || (!d && !h)) ? x + 'm' : '');
};

// --------------------------------------------------------------------------- //
// 数据加载
// --------------------------------------------------------------------------- //
async function loadAll() {
  const [samples, occs, settings] = await Promise.all([
    api('/api/samples'), api('/api/occupancies'), api('/api/settings'),
  ]);
  state.samples = samples;
  state.occs = occs;
  state.capacity = settings.capacity;
  state.maxShiftDelta = settings.max_shift_delta ?? null;
  $('#capacity').value = state.capacity;
  $('#maxShiftDelta').value = state.maxShiftDelta ?? '';
  renderSamples();
  renderOccs();
  const latest = await api('/api/schedule/latest').catch(() => ({}));
  if (latest && latest.segments) {
    state.result = latest;
    state.boardTimes = { ...(latest.board_times || {}) };
    renderTimeline();
    setStatus('已载入上次保存的排程，可直接拖拽调整。', 'ok');
  }
}

// --------------------------------------------------------------------------- //
// 样本卡片 / 弹层
// --------------------------------------------------------------------------- //
function renderSamples() {
  const box = $('#sampleList');
  box.innerHTML = '';
  if (!state.samples.length) {
    box.innerHTML = '<div style="color:#998f7d;font-size:12.5px;margin-top:8px">尚无样本，点击右上角新增。</div>';
    return;
  }
  for (const s of state.samples) {
    const card = document.createElement('div');
    card.className = 'sample-card';
    const steps = s.steps.map((st, i) =>
      `${i + 1}. ${num(st.target)}% × ${st.dwell}m @ ${num(st.rate)}%/m`).join('　');
    const excl = (s.excludes || []).map(id => state.samples.find(x => x.id === id))
      .filter(Boolean).map(x => x.code).join('、');
    card.innerHTML = `
      <div class="sc-head"><span>${esc(s.code)}</span>
        <span style="font-size:11px;color:#998f7d">#${s.id}</span></div>
      <div class="sc-meta">耐受 ${num(s.rh_min)}–${num(s.rh_max)}%RH ｜ 平衡 ${
        num(s.eq_rh)}% ｜ 冷却 ${s.eq_duration}m</div>
      <div class="sc-steps">${esc(steps)}</div>
      ${excl ? `<div class="sc-ex">⛓ 不可相邻：${esc(excl)}</div>` : ''}`;
    card.onclick = () => openSampleModal(s.id);
    box.appendChild(card);
  }
}

function openSampleModal(id = null) {
  state.editingId = id;
  const s = id ? state.samples.find(x => x.id === id) : null;
  $('#modalTitle').textContent = s ? `编辑样本 ${s.code}` : '新样本';
  $('#f_code').value = s?.code || '';
  $('#f_min').value = s?.rh_min ?? '';
  $('#f_max').value = s?.rh_max ?? '';
  $('#f_eq').value = s?.eq_rh ?? '';
  $('#f_eqdur').value = s?.eq_duration ?? 30;
  const sel = $('#f_excl');
  sel.innerHTML = '';
  for (const o of state.samples.filter(x => x.id !== id)) {
    const op = document.createElement('option');
    op.value = o.id; op.textContent = `${o.code} (#${o.id})`;
    if (s?.excludes?.includes(o.id)) op.selected = true;
    sel.appendChild(op);
  }
  renderStepRows(s ? s.steps.map(x => ({ ...x })) :
    [{ target: '', dwell: 30, rate: 2 }]);
  $('#modalDelete').style.display = s ? '' : 'none';
  $('#modalError').textContent = '';
  $('#modal').classList.remove('hidden');
}

function renderStepRows(steps) {
  const body = $('#stepBody');
  body.innerHTML = '';
  steps.forEach((st, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><input class="s-target" type="number" step="0.1" value="${st.target ?? ''}"></td>
      <td><input class="s-dwell" type="number" step="1" min="0" value="${st.dwell ?? ''}"></td>
      <td><input class="s-rate" type="number" step="0.1" min="0.1" value="${st.rate ?? ''}"></td>
      <td class="del">✕</td>`;
    tr.querySelector('.del').onclick = () => {
      if ($$('#stepBody tr').length > 1) tr.remove(); renumber();
    };
    body.appendChild(tr);
  });
}
function renumber() {
  $$('#stepBody tr').forEach((tr, i) => tr.firstElementChild.textContent = i + 1);
}

async function saveSampleFromModal() {
  const steps = $$('#stepBody tr').map(tr => ({
    target: parseFloat(tr.querySelector('.s-target').value),
    dwell: parseInt(tr.querySelector('.s-dwell').value, 10),
    rate: parseFloat(tr.querySelector('.s-rate').value),
  }));
  const body = {
    id: state.editingId,
    code: $('#f_code').value.trim(),
    rh_min: parseFloat($('#f_min').value),
    rh_max: parseFloat($('#f_max').value),
    eq_rh: $('#f_eq').value === '' ? null : parseFloat($('#f_eq').value),
    eq_duration: parseInt($('#f_eqdur').value, 10),
    steps,
    excludes: $$('#f_excl option:checked').map(o => parseInt(o.value, 10)),
  };
  try {
    await api('/api/samples', { method: 'POST', body });
    $('#modal').classList.add('hidden');
    await loadAll();
  } catch (e) {
    $('#modalError').textContent = e.message;
  }
}

// --------------------------------------------------------------------------- //
// 占用
// --------------------------------------------------------------------------- //
function renderOccs() {
  const box = $('#occList');
  box.innerHTML = '';
  if (!state.occs.length) {
    box.innerHTML = '<div style="color:#998f7d;font-size:12.5px;margin-top:6px">无已有占用。</div>';
    return;
  }
  for (const o of state.occs) {
    const div = document.createElement('div');
    div.className = 'occ-item';
    div.innerHTML = `<span>${fmtMin(o.start)}–${fmtMin(o.end)} ｜ ${num(o.rh)}%RH ｜ ${
      o.slots} 位${o.note ? ' ｜ ' + esc(o.note) : ''}</span><span class="x">✕</span>`;
    div.querySelector('.x').onclick = async () => {
      await api(`/api/occupancies/${o.id}`, { method: 'DELETE' });
      await loadAll();
    };
    box.appendChild(div);
  }
}

function openOccModal() {
  ['o_start', 'o_end', 'o_rh', 'o_note'].forEach(id => $('#' + id).value = '');
  $('#o_slots').value = 1;
  $('#occError').textContent = '';
  $('#occModal').classList.remove('hidden');
}

async function saveOcc() {
  const body = {
    start: parseInt($('#o_start').value, 10),
    end: parseInt($('#o_end').value, 10),
    rh: parseFloat($('#o_rh').value),
    slots: parseInt($('#o_slots').value, 10),
    note: $('#o_note').value.trim(),
  };
  try {
    await api('/api/occupancies', { method: 'POST', body });
    $('#occModal').classList.add('hidden');
    await loadAll();
  } catch (e) {
    $('#occError').textContent = e.message;
  }
}

// --------------------------------------------------------------------------- //
// 排程
// --------------------------------------------------------------------------- //
async function runSchedule() {
  setStatus('正在求解可执行顺序…', 'warn');
  try {
    state.result = await api('/api/schedule', {
      method: 'POST',
      body: { capacity: state.capacity,
              max_shift_delta: state.maxShiftDelta },
    });
    state.boardTimes = { ...(state.result.board_times || {}) };
    renderTimeline();
    if (state.result.feasible) {
      setStatus(`✓ 排程可行：${state.result.lanes.length} 个样本任务，总时长 ${
        fmtMin(state.result.end_minute)}。可直接拖拽泳道调整入箱时刻。`, 'ok');
    } else {
      setStatus('✗ 约束无解，请查看下方冲突与最小调整建议。', 'bad');
    }
  } catch (e) {
    setStatus('求解失败：' + e.message, 'bad');
  }
}

async function revalidate() {
  try {
    state.result = await api('/api/validate', {
      method: 'POST',
      body: { capacity: state.capacity,
              max_shift_delta: state.maxShiftDelta,
              board_times: state.boardTimes },
    });
    renderTimeline();
    if (state.result.feasible) {
      setStatus('✓ 拖拽后的手工排程通过全部约束校验' +
        '（容量 / 耐受区间 / 速率 / 独立换档上限 / 不可相邻）。', 'ok');
    } else {
      const n = state.result.violations.length;
      const nShift = state.result.violations.filter(v =>
        v.kind === 'shift-limit').length;
      setStatus(`✗ 当前手工排程存在 ${n} 处违规${nShift ?
        `（其中 ${nShift} 处独立换档上限超限，见下方调整建议）` : ''}，` +
        '时间轴上以红色标记。可继续拖动或重置。', 'bad');
    }
  } catch (e) {
    setStatus('校验失败：' + e.message, 'bad');
  }
}

// --------------------------------------------------------------------------- //
// 时间轴渲染
// --------------------------------------------------------------------------- //
function timelineMinutes() {
  const r = state.result;
  if (!r) return 60;
  let max = r.end_minute || 0;
  for (const o of state.occs) max = Math.max(max, o.end);
  for (const l of r.lanes || []) max = Math.max(max, l.unboard || l.board + 30);
  return Math.max(60, max + 20);
}

function renderTimeline() {
  const r = state.result;
  const conflictBox = $('#conflictBox');
  conflictBox.classList.add('hidden');
  conflictBox.innerHTML = '';
  $('#detail').classList.add('hidden');
  if (!r) return;

  if (!r.feasible && r.conflicts?.length) renderConflicts(r.conflicts);
  const shiftViolations = (r.violations || []).filter(v => v.kind === 'shift-limit');
  if (!r.feasible && shiftViolations.length) renderShiftViolations(shiftViolations);

  const total = timelineMinutes();
  state.pxPerMin = total > 1000 ? 0.8 : total > 500 ? 1.2 : 2;
  const W = Math.max(900, total * state.pxPerMin + 120);

  renderRuler(W, total);
  renderRhTrack(W, total, r);
  renderLanes(W, r);
  renderOccTrack(W, total);
  renderCapTrack(W, r);
  renderViolations(W, r);
}

function renderRuler(W, total) {
  const ruler = $('#ruler');
  ruler.style.width = W + 'px';
  ruler.innerHTML = '<span class="track-label" style="background:transparent">时间 →</span>';
  const step = total > 1000 ? 120 : total > 500 ? 60 : 30;
  for (let m = 0; m <= total; m += step) {
    const t = document.createElement('div');
    t.className = 'tick';
    t.style.left = (74 + m * state.pxPerMin) + 'px';
    t.textContent = fmtMin(m);
    ruler.appendChild(t);
  }
}

function renderRhTrack(W, total, r) {
  const track = $('#rhTrack');
  track.style.width = W + 'px';
  track.innerHTML = '<span class="track-label">箱内湿度</span>';
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('x', 74); svg.setAttribute('y', 0);
  svg.setAttribute('width', W - 74); svg.setAttribute('height', 64);
  svg.style.left = '74px';
  const L = 26, R = 8;
  const yOf = rh => {
    const lo = 0, hi = 100;
    return L + (1 - (rh - lo) / (hi - lo)) * (64 - L - R);
  };
  const xOf = m => m * state.pxPerMin;

  // 0/50/100 参考线
  for (const v of [0, 50, 100]) {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', 0); line.setAttribute('x2', W - 80);
    line.setAttribute('y1', yOf(v)); line.setAttribute('y2', yOf(v));
    line.setAttribute('stroke', v === 50 ? '#e2dac8' : '#f0ecdf');
    svg.appendChild(line);
    const lab = document.createElementNS(svgNS, 'text');
    lab.setAttribute('x', 2); lab.setAttribute('y', yOf(v) - 2);
    lab.setAttribute('font-size', 9); lab.setAttribute('fill', '#a89f8c');
    lab.textContent = v;
    svg.appendChild(lab);
  }
  for (const seg of r.segments || []) {
    if (seg.kind === 'hold') {
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', xOf(seg.start));
      line.setAttribute('x2', xOf(seg.end));
      line.setAttribute('y1', yOf(seg.start_rh));
      line.setAttribute('y2', yOf(seg.end_rh));
      line.setAttribute('stroke', '#5e8b6e');
      line.setAttribute('stroke-width', 2);
      line.classList.add('seg-hit');
      line.dataset.start = seg.start;
      svg.appendChild(line);
    } else {
      const x1 = xOf(seg.start), x2 = xOf(seg.end);
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', x1); line.setAttribute('x2', x2);
      line.setAttribute('y1', yOf(seg.from_rh ?? seg.start_rh));
      line.setAttribute('y2', yOf(seg.end_rh));
      line.setAttribute('stroke', '#c76a3e');
      line.setAttribute('stroke-width', 2);
      svg.appendChild(line);
    }
    // 段可点击查看来源
    const hit = document.createElementNS(svgNS, 'rect');
    hit.setAttribute('x', xOf(seg.start));
    hit.setAttribute('x', xOf(seg.start));
    hit.setAttribute('y', 0);
    hit.setAttribute('width', Math.max(3, xOf(seg.end) - xOf(seg.start)));
    hit.setAttribute('height', 64);
    hit.setAttribute('fill', 'transparent');
    hit.style.cursor = 'pointer';
    hit.onclick = () => showSegmentDetail(seg);
    svg.appendChild(hit);
  }
  track.appendChild(svg);
}

function renderLanes(W, r) {
  const box = $('#lanes');
  box.innerHTML = '';
  const byId = Object.fromEntries(state.samples.map(s => [s.id, s]));
  for (const lane of r.lanes || []) {
    const row = document.createElement('div');
    row.className = 'lane movable';
    row.style.width = W + 'px';
    row.dataset.sampleId = lane.sample_id;
    const name = document.createElement('span');
    name.className = 'lane-name';
    name.textContent = lane.code;
    name.title = `${lane.code}：耐受 ${num(lane.rh_min)}-${num(lane.rh_max)}%，` +
      `入箱平衡 ${num(lane.eq_rh)}%（拖动右侧空白区域可整体平移入箱时刻）`;
    row.appendChild(name);

    // 整条在箱期背景（拖拽手柄）
    const handle = document.createElement('div');
    handle.className = 'block board';
    handle.style.opacity = '0.0';
    handle.style.left = (74 + lane.board * state.pxPerMin) + 'px';
    handle.style.width = Math.max(8, ((lane.unboard ?? lane.board + 5) - lane.board) *
      state.pxPerMin) + 'px';
    handle.dataset.drag = '1';
    row.appendChild(handle);

    for (const p of lane.pieces) {
      const b = document.createElement('div');
      b.className = 'block ' + p.kind;
      const w = Math.max(3, (p.end - p.start) * state.pxPerMin);
      b.style.left = (74 + p.start * state.pxPerMin) + 'px';
      b.style.width = w + 'px';
      const label = phaseLabel(p, lane);
      b.textContent = label;
      b.title = `${lane.code} · ${phaseName(p.kind)}${
        p.step >= 0 ? ' 第' + (p.step + 1) + '档' : ''}：${
        fmtMin(p.start)}–${fmtMin(p.end)}`;
      b.dataset.viol = '';
      row.appendChild(b);
    }
    box.appendChild(row);
  }
  bindDrag();
}

function phaseName(k) {
  return { ramp: '换档', hold: '保持', cooldown: '冷却保持',
    'cooldown-ramp': '冷却换档', board: '入箱平衡', wait: '等待/偏离' }[k] || k;
}
function phaseLabel(p, lane) {
  if (p.kind === 'hold' && p.step >= 0) {
    const st = byStep(lane.sample_id, p.step);
    return `第${p.step + 1}档 ${num(st?.target)}% 保持`;
  }
  if (p.kind === 'ramp') {
    return p.step >= 0 ? `→第${p.step + 1}档换档` : '换档';
  }
  if (p.kind.startsWith('cooldown')) return '冷却/平衡';
  if (p.kind === 'board') return '入箱';
  return '';
}
function byStep(sid, i) {
  return state.samples.find(s => s.id === sid)?.steps?.[i];
}

function renderOccTrack(W, total) {
  const track = $('#occTrack');
  track.style.width = W + 'px';
  track.innerHTML = '<span class="track-label">已有占用</span>';
  for (const o of state.occs) {
    const b = document.createElement('div');
    b.className = 'occ-block';
    b.style.left = (74 + o.start * state.pxPerMin) + 'px';
    b.style.width = Math.max(4, (o.end - o.start) * state.pxPerMin) + 'px';
    b.textContent = `🔒 ${o.note || '占用'} ${num(o.rh)}% ×${o.slots}位`;
    b.title = `占用 ${fmtMin(o.start)}-${fmtMin(o.end)}，固定 ${num(o.rh)}%RH，${o.slots} 位`;
    track.appendChild(b);
  }
}

function renderCapTrack(W, r) {
  const track = $('#capTrack');
  track.style.width = W + 'px';
  track.innerHTML = '<span class="track-label">容量占用</span>';
  for (const c of r.capacity_series || []) {
    const ratio = c.load / state.capacity;
    const d = document.createElement('div');
    d.className = 'cap-cell';
    d.style.left = (74 + c.start * state.pxPerMin) + 'px';
    d.style.width = Math.max(3, (c.end - c.start) * state.pxPerMin) + 'px';
    d.style.background = c.load > state.capacity ? 'var(--bad)' :
      ratio > 0.8 ? '#d19a52' : ratio > 0 ? '#7fa083' : '#e8e2d2';
    d.style.color = ratio > 0 ? '#fff' : '#b7af9d';
    d.textContent = c.load;
    d.title = `${fmtMin(c.start)}-${fmtMin(c.end)}：占用 ${c.load}/${state.capacity}`;
    track.appendChild(d);
  }
}

function renderViolations(W, r) {
  const mins = {};
  for (const v of r.violations || []) {
    (mins[v.minute] = mins[v.minute] || []).push(v);
    // 泳道块标红
    for (const row of $$('#lanes .lane')) {
      const sid = parseInt(row.dataset.sampleId, 10);
      if (v.samples && !v.samples.includes(sid)) continue;
      for (const b of $$('.block', row)) {
        const st = parseFloat(b.style.left) - 74;
        const en = st + parseFloat(b.style.width);
        if (v.minute * state.pxPerMin >= st - 1 &&
            v.minute * state.pxPerMin < en + 1) {
          b.classList.add('viol');
          b.title += `\n⛔ ${v.message}`;
        }
      }
    }
  }
  // 每条泳道顶层放红色标记线（画在 lanes 容器上）
  const box = $('#lanes');
  for (const [m, vs] of Object.entries(mins)) {
    const flag = document.createElement('div');
    flag.className = 'viol-flag';
    flag.style.left = (74 + m * state.pxPerMin) + 'px';
    flag.style.top = '0';
    flag.textContent = '⛔';
    flag.title = vs.map(x => x.message).join('\n');
    box.appendChild(flag);
  }
}

// --------------------------------------------------------------------------- //
// 段来源详情
// --------------------------------------------------------------------------- //
function showSegmentDetail(seg) {
  const d = $('#detail');
  d.classList.remove('hidden');
  const sources = (seg.sources || []).map(s => {
    if (s.type === 'occupancy') return `<div class="src-line">🔒 约束来源：<b>${esc(s.label)}</b></div>`;
    return `<div class="src-line">📄 约束来源：样本 <b>${esc(s.code)}</b> 第 ${s.step} 档（${s.phase}）</div>`;
  }).join('') || '<div class="src-line">（空载/过渡段，无样本约束）</div>';
  d.innerHTML = `
    <h4>${seg.kind === 'ramp' ? '换档段' : '保持段'} ${fmtMin(seg.start)}–${
      fmtMin(seg.end)} ｜ 湿度 ${num(seg.from_rh ?? seg.start_rh)}% → ${num(seg.end_rh)}%
      ｜ 在箱：${(seg.aboard || []).map(esc).join('、') || '（空箱）'}</h4>
    ${sources}`;
}

// --------------------------------------------------------------------------- //
// 冲突面板
// --------------------------------------------------------------------------- //
function renderConflicts(conflicts) {
  const box = $('#conflictBox');
  box.classList.remove('hidden');
  box.innerHTML = '<h4>冲突约束与最小可调整项</h4>';
  conflicts.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'conflict';
    const tag = `<span class="tag ${c.severity === 'soft' ? 'soft' : ''}">${
      { capacity: '容量', range: '区间', rate: '换档速率',
        'shift-limit': '换档上限', adjacency: '不可相邻',
        occupancy: '已有占用', 'occupancy-window': '占用时间窗',
        horizon: '总机时', combination: '组合约束', 'occ-overlap': '占用重叠'
      }[c.kind] || c.kind}</span>`;
    let fix = '';
    if (c.suggestion) {
      fix = `<div class="fixit"><button data-i="${i}">⚙ 应用最小调整：${esc(c.suggestion.title)}</button></div>`;
    }
    div.innerHTML = `${tag}<span class="msg">${esc(c.message)}</span>${fix}`;
    box.appendChild(div);
  });
  $$('.fixit button', box).forEach(btn => {
    btn.onclick = () => applyFix(conflicts[+btn.dataset.i].suggestion);
  });
}

// 拖拽重校验中"独立换档上限"违规：指出相邻段、差值与可调整项
function renderShiftViolations(violations) {
  const box = $('#conflictBox');
  box.classList.remove('hidden');
  if (!box.innerHTML.trim()) box.innerHTML = '<h4>冲突约束与最小可调整项</h4>';
  violations.forEach((v, i) => {
    const segTxt = (v.adjacent_segments || []).length === 2
      ? `相邻段：${fmtMin(v.adjacent_segments[0].start)}–${
          fmtMin(v.adjacent_segments[0].end)}（${num(v.from_rh)}%）→ ${
          fmtMin(v.adjacent_segments[1].start)}–${
          fmtMin(v.adjacent_segments[1].end)}（${num(v.to_rh)}%）；`
      : `${fmtMin(v.minute)} 起换档 ${num(v.from_rh)}% → ${num(v.to_rh)}%；`;
    const div = document.createElement('div');
    div.className = 'conflict';
    const first = (v.adjustments || [])[0];
    const others = (v.adjustments || []).slice(1)
      .map(a => `<span class="mlink">· ${esc(a.label)}</span>`).join('<br>');
    div.innerHTML =
      `<span class="tag">换档上限</span>` +
      `<span class="msg">独立换档上限 ${num(v.limit)}%RH 被突破：${segTxt}` +
      `差值 <b>${num(v.delta)}%RH</b> 超限。</span>` +
      (first ? `<div class="fixit"><button data-i="${i}">⚙ 应用调整：${
        esc(first.label)}</button></div>` : '') +
      (others ? `<div class="alt-fix">其他可调整项：<br>${others}</div>` : '');
    box.appendChild(div);
    const btn = div.querySelector('.fixit button');
    if (btn) {
      btn.onclick = () => applyFix(first);
    }
  });
}

async function applyFix(sug) {
  try {
    if (sug.type === 'shift-limit') {
      // 放宽独立换档上限：保存设置；若当前有排程则立刻用同一拖拽结果重校验
      state.maxShiftDelta = sug.value;
      $('#maxShiftDelta').value = sug.value;
      await api('/api/settings', {
        method: 'POST',
        body: { max_shift_delta: sug.value },
      });
      if (state.result && (state.result.lanes || []).length) {
        await revalidate();
      }
      setStatus(`已把独立换档上限放宽为 ${sug.value}%RH，可直接拖拽或重新生成排程。`,
        'ok');
    } else if (sug.type === 'capacity') {
      state.capacity = Math.max(state.capacity, sug.value || state.capacity + 1);
      $('#capacity').value = state.capacity;
      await api('/api/settings', { method: 'POST', body: { capacity: state.capacity } });
      setStatus(`已把箱容量调整为 ${state.capacity}，请重新生成排程。`, 'ok');
    } else if (sug.type === 'adjacency' && sug.samples) {
      const [a, b] = sug.samples;
      const sa = state.samples.find(s => s.id === a);
      const sb = state.samples.find(s => s.id === b);
      if (sa && sb) {
        const ex = new Set([...(sa.excludes || []), b]);
        await api('/api/samples', {
          method: 'POST',
          body: { ...sa, excludes: [...ex] },
        });
        await loadAll();
        setStatus(`已把 ${sa.code} 与 ${sb.code} 标记为不可相邻，请重新生成排程。`, 'ok');
      }
    } else if (sug.type === 'rate' && sug.sample_id) {
      const s = state.samples.find(x => x.id === sug.sample_id);
      if (s) {
        const steps = s.steps.map((st, j) => j === sug.step - 1 ?
          { ...st, rate: Math.max(st.rate, sug.value) } : st);
        await api('/api/samples', { method: 'POST', body: { ...s, steps } });
        await loadAll();
        setStatus(`已放宽 ${s.code} 第 ${sug.step} 档速率，请重新生成排程。`, 'ok');
      }
    } else {
      setStatus('该建议需要手工调整已有占用段的时间或湿度，请在左侧修改后重新排程。', 'warn');
      return;
    }
  } catch (e) {
    setStatus('应用调整失败：' + e.message, 'bad');
  }
}

// --------------------------------------------------------------------------- //
// 拖拽
// --------------------------------------------------------------------------- //
function bindDrag() {
  $$('#lanes .lane').forEach(row => {
    const sid = parseInt(row.dataset.sampleId, 10);
    row.addEventListener('pointerdown', (e) => {
      if (!e.target.dataset.drag) return;
      if (!state.result?.feasible && state.result?.fatal === 'NO_FEASIBLE_SCHEDULE') {
        setStatus('无解排程无法拖拽；请先应用调整建议或修改输入后重新生成。', 'warn');
        return;
      }
      e.preventDefault();
      const startX = e.clientX;
      const orig = state.boardTimes[sid] ?? 0;
      const blocks = $$('.block', row);
      const init = blocks.map(b => parseFloat(b.style.left));
      document.body.style.cursor = 'grabbing';

      const move = (ev) => {
        const dm = Math.round((ev.clientX - startX) / state.pxPerMin);
        const nt = Math.max(0, orig + dm);
        state.boardTimes[sid] = nt;
        blocks.forEach((b, i) => {
          b.style.left = (init[i] + dm * state.pxPerMin) + 'px';
        });
      };
      const up = async () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.body.style.cursor = '';
        await revalidate();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  });
}

// --------------------------------------------------------------------------- //
// 导出
// --------------------------------------------------------------------------- //
function exportJSON() {
  if (!state.result) {
    alert('请先生成排程');
    return;
  }
  const payload = {
    exported_at: new Date().toISOString(),
    feasible: state.result.feasible,
    capacity: state.capacity,
    max_shift_delta: state.result.max_shift_delta ?? state.maxShiftDelta,
    board_times: state.boardTimes,
    end_minute: state.result.end_minute,
    end_display: fmtMin(state.result.end_minute),
    samples: state.result.samples || state.samples,
    occupancies: state.occs,
    chamber_segments: (state.result.segments || []).map(s => ({
      start_minute: s.start, end_minute: s.end,
      start: fmtMin(s.start), end: fmtMin(s.end),
      type: s.kind,
      rh_start: s.from_rh ?? s.start_rh, rh_end: s.end_rh,
      aboard: s.aboard, constraints: s.sources,
    })),
    sample_lanes: (state.result.lanes || []).map(l => ({
      sample_id: l.sample_id, code: l.code,
      board_minute: l.board, unboard_minute: l.unboard,
      board: fmtMin(l.board),
      unboard: l.unboard == null ? null : fmtMin(l.unboard),
      pieces: l.pieces.map(p => ({
        start_minute: p.start, end_minute: p.end,
        start: fmtMin(p.start), end: fmtMin(p.end),
        phase: phaseName(p.kind), step: p.step >= 0 ? p.step + 1 : null,
      })),
    })),
    violations: state.result.violations || [],
    conflicts: state.result.conflicts || [],
    minimal_adjustment: state.result.minimal_adjustment || null,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `humidity-schedule-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --------------------------------------------------------------------------- //
function setStatus(msg, kind = '') {
  const el = $('#statusBar');
  el.textContent = msg;
  el.className = 'status ' + kind;
}
const num = (v) => (v == null || isNaN(v)) ? '' :
  (String(v).includes('.') ? String(parseFloat(v.toFixed(2))) : String(v));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --------------------------------------------------------------------------- //
// ⑤ 实测湿度复核
// --------------------------------------------------------------------------- //
const rv = {
  result: null,       // /api/review/run 结果（未含快照）
  schedule: null,     // 载入的最近排程
};

async function rvLoadSchedule(autoload = false) {
  try {
    const s = await api('/api/schedule/latest');
    if (!s || !s.segments) {
      rvSetStatus('最近没有可用的排程快照，请先在上方点击「生成可执行排程」。', 'bad');
      return null;
    }
    if (!s.feasible) {
      rvSetStatus('最近一次排程不可行，无法复核；请先调整输入并重新生成可行排程。', 'bad');
      return null;
    }
    rv.schedule = s;
    if (!autoload) rvSetStatus(
      `已从最近排程载入时间轴：${(s.lanes || []).length} 个样本，总时长 ${
        fmtMin(s.end_minute)}。粘贴读数后执行复核。`, 'ok');
    return s;
  } catch (e) {
    rvSetStatus('载入排程失败：' + e.message, 'bad');
    return null;
  }
}

function rvParams() {
  const tol = parseFloat($('#rvTol').value);
  const dose = parseFloat($('#rvDose').value);
  const gap = parseInt($('#rvGap').value, 10);
  const start = parseInt($('#rvStart').value, 10) || 0;
  return { tolerance: tol, dose_limit: dose, max_gap: gap, start_minute: start };
}

async function rvRun() {
  const text = $('#rvReadings').value;
  if (!text.trim()) return rvSetStatus('请先粘贴传感器读数。', 'bad');
  const p = rvParams();
  if (!(p.tolerance > 0)) return rvSetStatus('允许偏差必须为正数。', 'bad');
  if (!(p.dose_limit >= 0)) return rvSetStatus('累计偏差剂量上限不能为负。', 'bad');
  if (!(p.max_gap >= 1)) return rvSetStatus('最大采样间隔必须 ≥1 分钟。', 'bad');
  rvSetStatus('正在按计划阶段切分并精确积分超带面积…', 'warn');
  try {
    rv.result = await api('/api/review/run', {
      method: 'POST',
      body: { readings_text: text, note: $('#rvNote').value.trim(), ...p },
    });
    rvRender();
    const c = rv.result.summary;
    rvSetStatus(`复核完成：${rv.result.readings_count} 个读数（第 ${
      rv.result.first_minute}–${rv.result.last_minute} 分钟），共 ${c.total} 个样本 —— ` +
      `通过 ${c.pass}、复核 ${c.review}、数据不足 ${c.insufficient}。`,
      rv.result.overall === 'pass' ? 'ok' :
      rv.result.overall === 'review' ? 'bad' : 'warn');
  } catch (e) {
    rv.result = null;
    rvSetStatus('复核失败：' + e.message, 'bad');
  }
}

async function rvSave() {
  if (!rv.result) return rvSetStatus('请先执行复核，再保存记录。', 'bad');
  const p = rvParams();
  try {
    await api('/api/review/save', {
      method: 'POST',
      body: { readings_text: $('#rvReadings').value,
              note: $('#rvNote').value.trim(), ...p },
    });
    rvSetStatus('复核记录已保存。', 'ok');
    rvLoadRecords();
  } catch (e) {
    rvSetStatus('保存失败：' + e.message, 'bad');
  }
}

function rvSetStatus(msg, kind = '') {
  const el = $('#rvStatus');
  el.textContent = msg;
  el.className = 'status ' + kind;
}

// ---- 图表 ----------------------------------------------------------------- //
function rvRender() {
  const r = rv.result;
  $('#rvTable').classList.toggle('hidden', !r);
  $('#rvOverall').classList.toggle('hidden', !r);
  if (!r) return;
  rvDrawChart(r);
  rvRenderOverall(r);
  rvRenderTable(r);
}

function rvRenderOverall(r) {
  const box = $('#rvOverall');
  box.className = 'rv-overall ' + r.overall;
  const c = r.summary;
  const label = { pass: '✓ 全部通过', review: '⚠ 存在需要复核的样本',
                  insufficient: '▦ 存在数据不足的样本' }[r.overall];
  const rule = r.overall === 'pass'
    ? '所有样本数据完整且累计剂量均未超上限。'
    : r.overall === 'review'
      ? '存在数据完整但累计剂量超过上限的样本，需修复师复核；请查看下表超带区间。'
      : '存在采样缺口/窗口缺读的样本，缺口段未插值、未计剂量，补齐数据前不得判为通过。';
  box.innerHTML = `${label}：通过 ${c.pass} / 复核 ${c.review} / 数据不足 ${
    c.insufficient}（样本共 ${c.total} 个；全部样本剂量合计 ${
    num(c.total_dose)} %RH·分钟）<div style="font-weight:400;font-size:12.5px;margin-top:2px">${
    rule}</div>`;
}

function rvDrawChart(r) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = $('#rvChart');
  svg.innerHTML = '';
  const plan = r.plan_curve;
  const meas = r.measured_points;
  const tMax = Math.max(r.end_minute, r.last_minute || 0);
  const total = Math.max(60, tMax + 10);
  const pxPerMin = total > 1200 ? 0.8 : total > 600 ? 1.2 : 2;
  const W = Math.max(900, total * pxPerMin + 90);
  svg.setAttribute('width', W);
  svg.setAttribute('viewBox', `0 0 ${W} 280`);
  const ML = 52, MR = 14, MT = 18, MB = 30;
  const pw = W - ML - MR, H = 280 - MT - MB;
  const xOf = m => ML + m * pxPerMin;
  const yOf = rh => MT + (1 - rh / 100) * H;

  const el = (tag, attrs, parent = svg) => {
    const n = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent.appendChild(n);
    return n;
  };

  // RH 网格
  for (const v of [0, 25, 50, 75, 100]) {
    el('line', { x1: ML, x2: ML + pw, y1: yOf(v), y2: yOf(v),
      stroke: v === 50 ? '#e2dac8' : '#f0ecdf' });
    const t = el('text', { x: 6, y: yOf(v) + 3, 'font-size': 10,
      fill: '#a89f8c' });
    t.textContent = v;
  }
  // 时间刻度
  const step = total > 1000 ? 120 : total > 500 ? 60 : 30;
  for (let m = 0; m <= total; m += step) {
    el('line', { x1: xOf(m), x2: xOf(m), y1: MT, y2: MT + H,
      stroke: '#f0ecdf' });
    const t = el('text', { x: xOf(m) + 2, y: 280 - 8, 'font-size': 9.5,
      fill: '#a89f8c' });
    t.textContent = fmtMin(m);
  }

  // 在箱窗口（各样本窗口并集底色）
  const wins = (r.windows || []).filter(w => w.board != null && w.unboard != null)
    .map(w => [w.board, w.unboard]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of wins) {
    if (merged.length && a <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b);
    } else merged.push([a, b]);
  }
  for (const [a, b] of merged) {
    el('rect', { x: xOf(a), y: MT, width: Math.max(1, (b - a) * pxPerMin),
      height: H, fill: 'rgba(185,138,78,.07)' });
  }

  // 允许带 P±tol：沿计划折线，以 ~1px 步长采样画填充多边形
  const tol = r.params.tolerance;
  const upper = [], lower = [];
  for (let x = 0; x <= pw; x += 4) {
    const t = x / pxPerMin;
    let v = null;
    for (let i = 0; i < plan.length - 1; i++) {
      const p1 = plan[i], p2 = plan[i + 1];
      if (p1.minute <= t && t <= p2.minute) {
        const f = p2.minute === p1.minute ? 0 :
          (t - p1.minute) / (p2.minute - p1.minute);
        v = p1.rh + f * (p2.rh - p1.rh);
        break;
      }
    }
    if (v == null) continue;
    upper.push([ML + x, yOf(Math.min(100, v + tol))]);
    lower.push([ML + x, yOf(Math.max(0, v - tol))]);
  }
  if (upper.length > 1) {
    const pts = upper.concat(lower.reverse())
      .map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    el('polygon', { points: pts, fill: 'rgba(94,139,110,.18)',
      stroke: 'rgba(94,139,110,.35)', 'stroke-width': 0.6 });
  }

  // 数据不足样本：未覆盖段（灰纹）
  for (const s of r.samples) {
    for (const g of s.uncovered || []) {
      el('rect', { x: xOf(g.start), y: MT + 2,
        width: Math.max(1, (g.end - g.start) * pxPerMin), height: H - 4,
        fill: 'url(#rvGapPattern)', opacity: 0.55 });
    }
  }
  const defs = el('defs', {});
  const pat = el('pattern', { id: 'rvGapPattern', width: 8, height: 8,
    patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  el('rect', { width: 8, height: 8, fill: '#eef0f3' }, pat);
  el('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: '#9aa6b8',
    'stroke-width': 3 }, pat);

  // 超带区间（红色半透明竖带）
  for (const s of r.samples) {
    for (const e of s.exceedances || []) {
      el('rect', { x: xOf(e.start), y: MT,
        width: Math.max(1, (e.end - e.start) * pxPerMin), height: H,
        fill: 'rgba(192,57,43,.13)' });
    }
  }

  const pathFrom = pts => pts.map((p, i) =>
    `${i ? 'L' : 'M'}${xOf(p.minute).toFixed(1)},${yOf(p.rh).toFixed(1)}`).join(' ');

  // 计划曲线
  if (plan.length > 1) {
    el('path', { d: pathFrom(plan), fill: 'none', stroke: '#3f6e8f',
      'stroke-width': 2.2 });
  }

  // 实测曲线：超间隔缺口处断开（不画跨缺口的线段）
  const gapSet = new Set((r.holes || []).map(h => `${h.start}-${h.end}`));
  let segPts = [];
  const flush = () => {
    if (segPts.length > 1) {
      el('path', { d: pathFrom(segPts), fill: 'none', stroke: '#7a4f9e',
        'stroke-width': 1.8, 'stroke-linejoin': 'round' });
    }
    segPts = [];
  };
  for (let i = 0; i < meas.length; i++) {
    if (i > 0 && gapSet.has(`${meas[i - 1].minute}-${meas[i].minute}`)) flush();
    segPts.push(meas[i]);
  }
  flush();
  // 缺口处画红色虚线
  for (const h of r.holes || []) {
    const p1 = meas.find(p => p.minute === h.start);
    const p2 = meas.find(p => p.minute === h.end);
    if (p1 && p2) {
      el('line', {
        x1: xOf(p1.minute), y1: yOf(p1.rh),
        x2: xOf(p2.minute), y2: yOf(p2.rh),
        stroke: '#c0392b', 'stroke-width': 1.2, 'stroke-dasharray': '4 3' });
    }
  }
  // 实采样点
  for (const p of meas) {
    el('circle', { cx: xOf(p.minute), cy: yOf(p.rh), r: 1.8,
      fill: '#7a4f9e' });
  }

  // 入箱/出箱标记线
  for (const w of r.windows || []) {
    if (w.board == null) continue;
    el('line', { x1: xOf(w.board), x2: xOf(w.board), y1: MT, y2: MT + H,
      stroke: '#b98a4e', 'stroke-width': 1, 'stroke-dasharray': '2 3' });
    if (w.unboard != null) {
      el('line', { x1: xOf(w.unboard), x2: xOf(w.unboard), y1: MT,
        y2: MT + H, stroke: '#6f86a8', 'stroke-width': 1,
        'stroke-dasharray': '2 3' });
    }
  }
}

// ---- 结果表 ---------------------------------------------------------------- //
function rvRenderTable(r) {
  const body = $('#rvTableBody');
  body.innerHTML = '';
  const labels = { pass: '通过', review: '复核', insufficient: '数据不足' };
  for (const s of r.samples) {
    const tr = document.createElement('tr');
    const win = s.board == null ? '—' :
      `${fmtMin(s.board)} – ${fmtMin(s.unboard)}`;
    const cover = s.board == null ? '—' :
      `${num(s.covered_minutes)} / ${num(s.window_minutes)} 分钟`;
    const doseTxt = s.dose == null ? '—（数据不足，缺口未计）' :
      `${num(s.dose)} / ${num(s.dose_limit)}`;
    const over = s.dose != null && s.dose > s.dose_limit + 1e-9;
    const ratio = s.dose == null || !s.dose_limit ? 0 :
      Math.min(1, s.dose / s.dose_limit);
    tr.innerHTML = `
      <td><b>${esc(s.code)}</b><br><span style="color:#998f7d;font-size:11px">#${
        s.sample_id}</span></td>
      <td>${win}</td>
      <td>${cover}${(s.uncovered || []).length ?
        `<br><span style="color:#42506a">${s.uncovered.length} 处缺口</span>` : ''}</td>
      <td>${doseTxt}
        ${s.dose != null ? `<div class="dose-bar ${over ? 'over' : ''}"><i style="width:${
          ratio * 100}%"></i></div>${over ? '<span style="color:var(--bad);font-size:11px">超上限</span>' : ''}` : ''}
      </td>
      <td>${(s.exceedances || []).length ?
        `${s.exceedances.length} 段，共 ${
          num(s.exceedances.reduce((a, e) => a + e.minutes, 0))} 分钟` :
        '无'}</td>
      <td><span class="badge ${s.conclusion}">${labels[s.conclusion]}</span></td>
      <td><button class="rv-toggle">明细 ▾</button></td>`;
    body.appendChild(tr);

    const dr = document.createElement('tr');
    dr.className = 'detail-row hidden';
    const td = document.createElement('td');
    td.colSpan = 7;
    td.innerHTML = rvDetailHtml(s);
    dr.appendChild(td);
    body.appendChild(dr);
    tr.querySelector('.rv-toggle').onclick = () => {
      dr.classList.toggle('hidden');
      tr.querySelector('.rv-toggle').textContent =
        dr.classList.contains('hidden') ? '明细 ▾' : '明细 ▴';
    };
  }
}

function rvDetailHtml(s) {
  const gaps = (s.uncovered || []).map(g =>
    `<div class="gapline">▦ 缺口 ${fmtMin(g.start)}–${fmtMin(g.end)}（${
      num(g.minutes)} 分钟，未插值未计剂量）：${esc(g.reason)}</div>`).join('');
  const excs = (s.exceedances || []).map(e =>
    `<div class="excline">⛔ <b>${fmtMin(e.start)}–${fmtMin(e.end)}</b>（${
      esc(e.phase)}${e.step ? ' 第' + e.step + '档' : ''}，${
      num(e.minutes)} 分钟）：实测 ${num(e.meas_start)}→${num(e.meas_end)}%，计划 ${
      num(e.plan_start)}→${num(e.plan_end)}%，最大偏差 ${num(e.max_dev)}%，该段剂量 <b>${
      num(e.dose)}</b></div>`).join('');
  const phases = (s.phases || []).map(p =>
    `<div>· ${esc(p.phase)}${p.step ? ' 第' + p.step + '档' : ''} ${
      fmtMin(p.start)}–${fmtMin(p.end)}：剂量 ${num(p.dose)}${
      p.exceed_minutes > 0 ? `（超带 ${num(p.exceed_minutes)} 分钟）` : '（在带内）'}</div>`
  ).join('');
  return `<div class="rv-detail-box">
    <h5>计划阶段切分与剂量</h5>${phases || '<div>（无阶段数据）</div>'}
    ${excs ? `<h5>超带区间</h5>${excs}` : '<h5>超带区间</h5><div>无</div>'}
    ${gaps ? `<h5>未覆盖段</h5>${gaps}` : ''}
  </div>`;
}

// ---- 记录列表 / 导出 ------------------------------------------------------- //
async function rvLoadRecords() {
  const box = $('#rvRecords');
  try {
    const list = await api('/api/reviews');
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div style="color:#998f7d;font-size:12px;padding:4px">暂无已保存的复核记录。</div>';
      return;
    }
    const labels = { pass: '通过', review: '复核', insufficient: '数据不足' };
    for (const rec of list) {
      const div = document.createElement('div');
      div.className = 'rv-record';
      const c = rec.summary || {};
      div.innerHTML = `
        <span class="rid">#${rec.id}</span>
        <span class="badge ${rec.overall}">${labels[rec.overall] || rec.overall}</span>
        <span>${rec.created_at} UTC</span>
        <span>${esc(rec.note || '（无备注）')}</span>
        <span style="color:#998f7d">读数 ${rec.readings_count} 个（${
          rec.first_minute}–${rec.last_minute} 分钟）｜通过 ${c.pass ?? '-'} / 复核 ${
          c.review ?? '-'} / 数据不足 ${c.insufficient ?? '-'}｜总剂量 ${
          num(c.total_dose)}</span>
        <span class="btns">
          <span class="mlink" data-act="load">载入</span>
          <span class="mlink" data-act="export">导出</span>
          <span class="x" data-act="del">✕</span>
        </span>`;
      div.querySelector('[data-act="load"]').onclick = () => rvLoadRecord(rec.id);
      div.querySelector('[data-act="export"]').onclick = () => rvExport(rec.id);
      div.querySelector('[data-act="del"]').onclick = async () => {
        if (!confirm(`确定删除复核记录 #${rec.id}？`)) return;
        await api(`/api/reviews/${rec.id}`, { method: 'DELETE' });
        rvLoadRecords();
      };
      box.appendChild(div);
    }
  } catch (e) {
    box.innerHTML = `<div style="color:var(--bad);font-size:12px">记录加载失败：${
      esc(e.message)}</div>`;
  }
}

async function rvLoadRecord(rid) {
  try {
    const rec = await api(`/api/reviews/${rid}`);
    rv.result = rec;
    rv.schedule = rec.schedule_snapshot || null;
    const p = rec.params || {};
    $('#rvTol').value = p.tolerance ?? 2;
    $('#rvDose').value = p.dose_limit ?? 60;
    $('#rvGap').value = p.max_gap ?? 1;
    $('#rvStart').value = p.start_minute ?? 0;
    $('#rvNote').value = rec.note || '';
    rvRender();
    rvSetStatus(`已载入复核记录 #${rid}（${rec.created_at} UTC）。`, 'ok');
    document.getElementById('reviewPanel').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    rvSetStatus('载入记录失败：' + e.message, 'bad');
  }
}

async function rvExport(rid = null) {
  let payload;
  if (rid != null) {
    payload = await api(`/api/reviews/${rid}`);
  } else {
    if (!rv.result) return rvSetStatus('请先执行复核，再导出。', 'bad');
    payload = {
      exported_at: new Date().toISOString(),
      ...rv.result,
      schedule_snapshot: rv.schedule,
    };
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `humidity-review-${rid != null ? rid + '-' : ''}${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('#rvLoadBtn').onclick = () => rvLoadSchedule();
$('#rvRunBtn').onclick = rvRun;
$('#rvSaveBtn').onclick = rvSave;
$('#rvExportBtn').onclick = () => rvExport();
$('#rvRefreshBtn').onclick = rvLoadRecords;

// 初始化：尝试静默载入最近排程；拉取记录列表
(async function rvInit() {
  await rvLoadSchedule(true);
  rvLoadRecords();
})();

// --------------------------------------------------------------------------- //
// 事件绑定
// --------------------------------------------------------------------------- //
$('#addSampleBtn').onclick = () => openSampleModal();
$('#modalCancel').onclick = () => $('#modal').classList.add('hidden');
$('#modalSave').onclick = saveSampleFromModal;
$('#modalDelete').onclick = async () => {
  if (state.editingId && confirm('确定删除该样本及其全部阶梯？')) {
    await api(`/api/samples/${state.editingId}`, { method: 'DELETE' });
    $('#modal').classList.add('hidden');
    await loadAll();
  }
};
$('#addStepBtn').onclick = () => {
  const body = $('#stepBody');
  renderStepRows([...$$('#stepBody tr').map((tr, i) => ({
    target: parseFloat(tr.querySelector('.s-target').value),
    dwell: parseInt(tr.querySelector('.s-dwell').value, 10),
    rate: parseFloat(tr.querySelector('.s-rate').value),
  })), { target: '', dwell: 30, rate: 2 }]);
};
$('#addOccBtn').onclick = openOccModal;
$('#occCancel').onclick = () => $('#occModal').classList.add('hidden');
$('#occSave').onclick = saveOcc;
$('#saveCapBtn').onclick = async () => {
  const cap = parseInt($('#capacity').value, 10);
  if (!(cap >= 1)) return setStatus('容量必须 ≥1', 'bad');
  const raw = $('#maxShiftDelta').value.trim();
  let shift = null;
  if (raw !== '') {
    shift = parseFloat(raw);
    if (!(shift > 0) || shift > 100) {
      return setStatus('独立换档上限必须是 0.1–100 之间的正数（留空表示不限制）',
        'bad');
    }
  }
  try {
    const saved = await api('/api/settings', {
      method: 'POST',
      body: { capacity: cap, max_shift_delta: shift },
    });
    state.capacity = saved.capacity;
    state.maxShiftDelta = saved.max_shift_delta ?? null;
    $('#capacity').value = state.capacity;
    $('#maxShiftDelta').value = state.maxShiftDelta ?? '';
    setStatus(`设置已保存：容量 ${cap}；独立换档上限 ${
      state.maxShiftDelta == null ? '不限制' : state.maxShiftDelta + '%RH'}。`, 'ok');
  } catch (e) {
    setStatus('设置保存失败：' + e.message, 'bad');
  }
};
$('#runBtn').onclick = runSchedule;
$('#resetDragBtn').onclick = () => {
  if (state.result?.board_times) {
    state.boardTimes = { ...state.result.board_times };
    revalidate();
  }
};
$('#exportBtn').onclick = exportJSON;

loadAll().catch(e => setStatus('初始化失败：' + e.message, 'bad'));
