"""API 冒烟测试。"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_analyze_ok():
    resp = client.post("/api/analyze", json={
        "start_stitches": 10,
        "rows": ["k10", "[inc1 k1]*5"],
    })
    assert resp.status_code == 200
    rows = resp.json()["rows"]
    assert rows[0]["status"] == "ok"
    assert rows[0]["remaining"] == 10
    assert rows[1]["status"] == "ok"
    assert rows[1]["consumed"] == 10
    assert rows[1]["produced"] == 10


def test_analyze_shortage_payload():
    resp = client.post("/api/analyze", json={
        "start_stitches": 5,
        "rows": ["k2 dec4"],
    })
    row = resp.json()["rows"][0]
    assert row["status"] == "shortage"
    assert row["failing_instruction"] == "dec4"
    assert row["shortage"] == 1
    assert row["failing_start"] == 3 and row["failing_end"] == 7


def test_analyze_validation_error():
    resp = client.post("/api/analyze", json={"start_stitches": -1, "rows": []})
    assert resp.status_code == 422


def test_analyze_adaptive_repeat_payload():
    resp = client.post("/api/analyze", json={
        "start_stitches": 20,
        "rows": ["[k2]*~4 k4"],
    })
    row = resp.json()["rows"][0]
    assert row["status"] == "ok"
    assert len(row["adaptive_blocks"]) == 1
    blk = row["adaptive_blocks"][0]
    assert blk["actual_repeats"] == 8
    assert blk["target_remaining"] == 4
    assert blk["star_pos"] == 4 and blk["start"] == 0 and blk["end"] == 7
    assert row["expanded_count"] == 9


def test_analyze_adaptive_indivisible_error():
    resp = client.post("/api/analyze", json={
        "start_stitches": 20,
        "rows": ["[k2]*~5", "k1"],
    })
    rows = resp.json()["rows"]
    assert rows[0]["status"] == "error"
    assert rows[0]["error_pos"] == 4
    assert rows[1]["status"] == "blocked"


def test_index_served():
    resp = client.get("/")
    assert resp.status_code == 200
    assert "编织" in resp.text


def test_analyze_stitch_changes_payload():
    resp = client.post("/api/analyze", json={
        "start_stitches": 10,
        "rows": ["[inc2]*~4 k4", "k16"],
    })
    rows = resp.json()["rows"]
    row = rows[0]
    assert row["status"] == "ok"
    assert row["stitch_changes"] == [
        {"start": 1, "end": 5, "instruction": "inc2", "executions": 6,
         "consumed": 6, "produced": 12, "net": 6},
    ]
    # 净变化合计与该行产出减消耗核对一致
    assert row["stitch_net"] == 6 == row["produced"] - row["consumed"]
    # 纯 k 行生成空清单，净变化为 0
    assert rows[1]["status"] == "ok"
    assert rows[1]["stitch_changes"] == [] and rows[1]["stitch_net"] == 0


def test_analyze_stitch_changes_absent_for_failed_and_blocked():
    resp = client.post("/api/analyze", json={
        "start_stitches": 4,
        "rows": ["dec5", "inc2"],
    })
    rows = resp.json()["rows"]
    assert rows[0]["status"] == "shortage"
    assert rows[0]["stitch_changes"] == [] and rows[0]["stitch_net"] is None
    assert rows[1]["status"] == "blocked"
    assert rows[1]["stitch_changes"] == [] and rows[1]["stitch_net"] is None


# ---------------------------------------------------------------- 尺码联检
def test_sizes_analyze_independent_blocking():
    # S 起始 4 针：第 1 行 dec5 短缺，仅 S 的后续行被阻断；M 起始 10 针正常走完全程
    resp = client.post("/api/sizes/analyze", json={
        "sizes": [
            {"name": "S", "start_stitches": 4},
            {"name": "M", "start_stitches": 10},
        ],
        "rows": ["dec5", "k1"],
    })
    assert resp.status_code == 200
    sizes = resp.json()["sizes"]
    assert [s["name"] for s in sizes] == ["S", "M"]
    assert [s["start_stitches"] for s in sizes] == [4, 10]

    s_rows, m_rows = sizes[0]["rows"], sizes[1]["rows"]
    assert s_rows[0]["status"] == "shortage"
    assert s_rows[0]["failing_instruction"] == "dec5"
    assert s_rows[1]["status"] == "blocked"
    # M 不受 S 阻断影响：第 1 行 dec5 只消耗 5 针（未全部消耗），产出 1 针传递给第 2 行
    assert m_rows[0]["status"] == "unconsumed" and m_rows[0]["remaining"] == 1
    assert m_rows[1]["status"] == "ok" and m_rows[1]["available"] == 1


def test_sizes_analyze_adaptive_per_size():
    # 同一自适应行按各尺码起始针数独立推导实际重复次数
    resp = client.post("/api/sizes/analyze", json={
        "sizes": [
            {"name": "S", "start_stitches": 20},
            {"name": "L", "start_stitches": 28},
        ],
        "rows": ["[k2]*~4 k4"],
    })
    sizes = resp.json()["sizes"]
    assert sizes[0]["rows"][0]["status"] == "ok"
    assert sizes[0]["rows"][0]["adaptive_blocks"][0]["actual_repeats"] == 8
    assert sizes[1]["rows"][0]["status"] == "ok"
    assert sizes[1]["rows"][0]["adaptive_blocks"][0]["actual_repeats"] == 12


def test_sizes_analyze_adaptive_error_only_blocks_that_size():
    # [k3]*~5：20 针时 (20-5)/3 整除通过；24 针时 (24-5)=19 不能被 3 整除报错，
    # 仅该尺码后续行被阻断
    resp = client.post("/api/sizes/analyze", json={
        "sizes": [
            {"name": "S", "start_stitches": 20},
            {"name": "M", "start_stitches": 24},
        ],
        "rows": ["[k3]*~5 k5", "k5"],
    })
    sizes = resp.json()["sizes"]
    # S：第 1 行耗 20 产 20；第 2 行 k5 只消耗 5 针（未全部消耗），未被阻断
    assert sizes[0]["rows"][0]["status"] == "ok"
    assert sizes[0]["rows"][1]["status"] == "unconsumed"
    assert sizes[1]["rows"][0]["status"] == "error"
    assert sizes[1]["rows"][1]["status"] == "blocked"


def test_sizes_analyze_validation():
    base_rows = ["k2"]
    two = [{"name": "S", "start_stitches": 4}, {"name": "M", "start_stitches": 6}]

    # 尺码数量越界：少于 2 个 / 多于 8 个
    resp = client.post("/api/sizes/analyze", json={"sizes": two[:1], "rows": base_rows})
    assert resp.status_code == 422
    nine = [{"name": f"S{i}", "start_stitches": 4} for i in range(9)]
    resp = client.post("/api/sizes/analyze", json={"sizes": nine, "rows": base_rows})
    assert resp.status_code == 422

    # 名称重复 / 空白
    dup = [{"name": "S", "start_stitches": 4}, {"name": "S", "start_stitches": 6}]
    resp = client.post("/api/sizes/analyze", json={"sizes": dup, "rows": base_rows})
    assert resp.status_code == 422
    blank = [{"name": " ", "start_stitches": 4}, {"name": "M", "start_stitches": 6}]
    resp = client.post("/api/sizes/analyze", json={"sizes": blank, "rows": base_rows})
    assert resp.status_code == 422

    # 起始针数为负
    neg = [{"name": "S", "start_stitches": -1}, {"name": "M", "start_stitches": 6}]
    resp = client.post("/api/sizes/analyze", json={"sizes": neg, "rows": base_rows})
    assert resp.status_code == 422

    # 合法下限（2 个）与上限（8 个）均可通过
    resp = client.post("/api/sizes/analyze", json={"sizes": two, "rows": base_rows})
    assert resp.status_code == 200 and len(resp.json()["sizes"]) == 2
    eight = [{"name": f"S{i}", "start_stitches": 4} for i in range(8)]
    resp = client.post("/api/sizes/analyze", json={"sizes": eight, "rows": base_rows})
    assert resp.status_code == 200 and len(resp.json()["sizes"]) == 8
