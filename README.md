# 古籍修复湿度阶梯试验编排台

面向纸张修复师的**恒湿箱阶梯程序排程**工具：录入多个纸张样本的耐受湿度区间、
阶梯（目标湿度 / 保持时长 / 升降速率）、冷却/平衡间隔与**不可相邻**条件，
设置恒湿箱容量、**独立换档上限**（每次换档最大目标湿度差值，可留空不限制）
与**已有占用**，系统在以下硬约束同时成立的前提下，
自动把多样本阶梯拆成带冷却/平衡间隔的可执行时间段：

1. **容量约束**：任意分钟在箱样本数 + 占用位数 ≤ 箱容量；
2. **区间兼容**：箱内当前湿度必须同时落在所有在箱样本的耐受区间内；
3. **换档速率上限**：每分钟湿度位移 ≤ 当前在箱样本各自声明的升降速率（取在箱最小值）；
4. **独立换档上限**（箱级设置，与样本速率无关）：时间轴上**相邻两段目标湿度**
   （每次换档的前后停留湿度）差值绝对值 ≤ 设置值；留空（旧数据）表示不限制；
5. **不可相邻**：被标记互斥的样本在箱时间段不得重叠；
6. （附加）**已有占用**：占用段内湿度恒定、占用容量，任何换档不得穿过占用段。

无解时会列出**冲突约束**并给出排序后的**最小可调整项**
（一键应用：加互斥标记 / 调容量 / 放宽独立换档上限 / 提示修改阶梯目标或后移占用）。

页面时间轴支持**拖拽泳道**改变入箱时刻，松手即重新校验，红色标记违规分钟；
每一段都可点击查看**约束来源**（来自哪个样本的哪一档 / 哪条占用）；
排程可导出为 JSON。

---

## 实测湿度复核

排程执行后，可在页面下方 **⑤ 实测湿度复核** 面板对一次试验的实测数据做复核：

1. 点击「从最近排程载入时间轴」（打开页面时也会自动尝试载入最近排程快照）；
2. 粘贴**按分钟递增**的传感器读数：每行一个值（裸值从「起始分钟」逐分钟顺延），
   或写 `12, 50.5` 显式指定分钟，两种写法可混用，`#` 开头为注释；
3. 设置**允许偏差**（计划 ±tolerance 的允许带，%RH）、**累计偏差剂量上限**
   （%RH·分钟）与**最大采样间隔**（分钟）。

复核规则：

* 计划与实测都视为**分段线性曲线**：计划曲线由排程快照重建（hold 水平、
  ramp 斜线），实测曲线在采样点间线性插值；
* 在每个样本「入箱 → 出箱」窗口内，按该样本的**计划阶段**（入箱/换档/保持/冷却）
  切分，收集所有折点与 ±允许偏差穿带点后**精确解析积分**
  超带量 `max(0, |实测−计划| − 允许偏差)` 的面积（单位 %RH·分钟）；
* 相邻采样间隔**超过**最大采样间隔的区间**不插值**（图上红色虚线），窗口两端
  **不外推**；未覆盖段（灰色斜纹）不计剂量，样本结论标为「**数据不足**」；
* 结论：数据完整且剂量 ≤ 上限 → **通过**；数据完整但剂量超限 → **复核**；
  存在任何未覆盖段 → **数据不足**（即只有数据完整且剂量不超限才通过）。

页面在同一坐标系叠加计划/实测两条曲线、允许带、超带区间与数据缺口；
表格列出每个样本的在箱窗口、数据覆盖分钟数、累计剂量（带占上限比例条）、
超带区间数，「明细」展开各计划阶段的切分剂量、每个超带区间
（时间/阶段/实测值/计划值/最大偏差/剂量）与每个缺口及原因。
复核记录可保存（含排程快照）、从记录列表载入、删除，并可导出 JSON。

---

## 一条命令启动

```bash
docker compose up --build
```

然后浏览器访问：

> **http://localhost:8000**

数据通过命名卷 `humidity-data` 持久化到 `/app/data/humidity.db`（SQLite），
`docker compose down` 不丢数据；如要清空：`docker compose down -v`。

---

## 技术栈

| 层 | 实现 |
| --- | --- |
| 前端 | 原生 HTML / CSS / JavaScript（无框架、无构建步骤），SVG 画湿度曲线、Pointer Events 拖拽 |
| 后端 | Flask（REST API）+ waitress 生产级 WSGI |
| 存储 | SQLite（样本、阶梯、互斥关系、占用、容量/独立换档上限设置、排程快照、复核记录） |
| 编排引擎 | `app/scheduler.py`，纯标准库分钟级确定性仿真 + 排列/启发式搜索，可独立单测 |
| 复核引擎 | `app/review.py`，纯标准库分段线性曲线重建与超带剂量解析积分，可独立单测 |

### 本地不使用 Docker 运行

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m app.server          # 默认 8000 端口
```

### 运行引擎单元测试

```bash
python3 -m unittest discover -s app/tests -v
```

---

## 排程模型说明

每个样本在箱内经历：

```
入箱(平衡湿度 eq_rh) → 第1档(换档→目标→保持dwell) → 第2档 → …
                    → 冷却换档回 eq_rh → 平衡保持 eq_duration → 出箱
```

- 时间轴为**整数分钟**，`rh[t]` 表示第 t 分钟箱内设定湿度；
- 换档速率按整分钟位移向下取整（`per = floor(rate)`），最后一分钟可只走余数，
  从不错过任何样本的速率上限；
- **独立换档上限**比较的是每次换档**两端停留湿度**（一次换档可能跨多个移动分钟、
  被切成多段斜线，判定时按整次换档合并计算），因此它约束的是"这一档跳到下一档
  的目标湿度差"，与每分钟走多快无关；
- 多样本共享同一湿度曲线：换档需等"被该湿度约束、当前档未完成"的全部在箱样本
  保持计时完成；目标不同的样本可在耐受区间内**顺路搭车**，若其当前档未完成，
  控制器随后优先把它送回目标湿度重做该档保持；已完成的档不重做。

### 搜索与无解诊断

- ≤7 个样本时枚举全部装载顺序的排列；更多样本用 5 组启发式顺序候选；
- 固定顺序下逐样本贪心找**最早可行入箱分钟**（每次试排跑完整仿真，
  遇到停滞/违规跳到下一候选分钟）；
- 全部顺序失败时，汇总以下冲突并按调整代价排序给出最小建议：
  静态冲突（区间不相交、占用超容量、占用重叠、样本自身相邻目标差超过独立换档
  上限）、占用时间窗压迫、同档聚类的容量缺口、总机时不足、
  错峰也无法避开的独立换档超限、最紧张换档的速率放宽量等。

---

## REST API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/samples` | 列出 / 新建或更新样本（POST body 带 `id` 即更新） |
| DELETE | `/api/samples/{id}` | 删除样本 |
| GET/POST | `/api/occupancies` | 列出 / 新增已有占用 |
| DELETE | `/api/occupancies/{id}` | 删除占用 |
| GET/POST | `/api/settings` | 读 / 写箱容量与独立换档上限（见下） |
| POST | `/api/schedule` | 自动排程（body 可空，用库中数据） |
| POST | `/api/validate` | 手工排程校验，body: `{board_times:{样本id:入箱分钟}}` |
| GET | `/api/schedule/latest` | 最近一次排程快照 |
| POST | `/api/review/run` | 执行实测复核（不保存） |
| POST | `/api/review/save` | 执行复核并保存记录（记录内嵌排程快照） |
| GET | `/api/reviews` | 已保存复核记录列表 |
| GET/DELETE | `/api/reviews/{id}` | 读取 / 删除单条复核记录 |
| GET | `/` | 编排台页面 |

### 样本 JSON 示例

```json
{
  "code": "P-017",
  "rh_min": 40, "rh_max": 75,
  "eq_rh": 50, "eq_duration": 30,
  "steps": [
    {"target": 65, "dwell": 30, "rate": 5},
    {"target": 50, "dwell": 20, "rate": 3}
  ],
  "excludes": [3]
}
```

### 恒湿箱设置

`GET /api/settings` 返回：

```json
{ "capacity": 3, "max_shift_delta": null }
```

`max_shift_delta` 即**独立换档上限**（每次换档相邻段目标湿度最大差值，%RH）：

- `null` / 缺省 = 不启用（**没有该字段的旧数据库与旧排程快照自动按不限制处理**）；
- `POST /api/settings` body `{"max_shift_delta": 15}` 启用并持久化；
- 传 `null`（或空字符串）可清除该设置；只传 `capacity` 时保持原值不变；
- `/api/schedule`、`/api/validate` 的 body 也可临时携带 `max_shift_delta`，
  不传则使用已保存的设置；拖拽重排与自动排程使用**同一条规则**。

超限被拒绝时，违规/冲突信息包含相邻段（起止分钟与目标湿度）、实际差值与
可调整项：放宽 `max_shift_delta`（一键应用）、修改相应样本的相邻档目标、
后移/调整端点占用段。

### 复核请求与导出 JSON

`POST /api/review/run` 与 `/api/review/save` 的 body：

```json
{
  "readings_text": "50.0\n50.2\n# 也可：12, 50.5",
  "tolerance": 2,
  "dose_limit": 60,
  "max_gap": 1,
  "start_minute": 0,
  "note": "可选备注"
}
```

返回（= 导出 JSON 主体）包含：

* `params`（允许偏差 / 剂量上限 / 最大采样间隔 / 起始分钟）、
  `readings_count`、`first_minute`、`last_minute`、`holes[]`（超间隔缺口）；
* `plan_curve[]`（重建后的计划折线顶点）、`measured_points[]`（实测采样点）；
* `overall`（`pass` / `review` / `insufficient`）与
  `summary`（三类结论计数、全部样本剂量合计）；
* `samples[]`：每样本 `board/unboard`、`window_minutes`、`covered_minutes`、
  `dose`、`conclusion`、`uncovered[]`（未覆盖段及原因）、
  `phases[]`（按计划阶段切分的剂量）、`exceedances[]`
  （超带区间：起止分钟、阶段、实测/计划端点值、最大偏差、剂量）。
* 保存记录额外内嵌 `schedule_snapshot`，可脱离当前排程独立复核/导出。

### 导出的排程 JSON 包含

`feasible`、`capacity`、`max_shift_delta`、`board_times`、`end_minute`、
`chamber_segments[]`（每段含 `constraints` 约束来源与 `aboard` 在箱样本）、
`sample_lanes[]`（每样本入/出箱分钟与阶梯分段）、
`violations[]`（拖拽校验违规；`shift-limit` 类型另含 `delta`、`limit`、
`adjacent_segments`、`adjustments`）、无解时的 `conflicts[]` 与
`minimal_adjustment`。

---

## 目录

```
app/
  scheduler.py     # 编排引擎（无框架依赖，可独立单测）
  review.py        # 实测湿度复核引擎（折线重建/覆盖分析/精确积分）
  db.py            # SQLite 持久化
  server.py        # Flask 路由 + waitress
  static/
    index.html     # 单页界面
    style.css
    app.js         # 时间轴/SVG/拖拽/复核图表/导出
  tests/test_scheduler.py
  tests/test_review.py
Dockerfile
docker-compose.yml
requirements.txt
README.md
```
