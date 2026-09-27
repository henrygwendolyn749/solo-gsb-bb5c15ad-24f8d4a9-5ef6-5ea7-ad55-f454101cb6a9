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
def test_analyze_sizes_independent_blocking():
    """某尺码短缺只阻断自己的后续行，其他尺码继续审校。"""
    resp = client.post("/api/analyze_sizes", json={
        "rows": ["k4 dec6", "k5"],
        "sizes": [
            {"name": "S", "start_stitches": 4},
            {"name": "L", "start_stitches": 10},
        ],
    })
    assert resp.status_code == 200
    sizes = resp.json()["sizes"]
    assert [s["name"] for s in sizes] == ["S", "L"]
    assert [s["start_stitches"] for s in sizes] == [4, 10]

    s_rows = sizes[0]["rows"]
    assert s_rows[0]["status"] == "shortage"  # 4 针执行 k4 后仅剩 0 针，dec6 短缺
    assert s_rows[0]["failing_instruction"] == "dec6"
    assert s_rows[1]["status"] == "blocked"

    l_rows = sizes[1]["rows"]
    assert l_rows[0]["status"] == "ok"
    assert l_rows[0]["consumed"] == 10 and l_rows[0]["produced"] == 5
    assert l_rows[1]["status"] == "ok"
    assert l_rows[1]["available"] == 5  # 跨行针数传递不受 S 尺码影响


def test_analyze_sizes_adaptive_repeat_per_size():
    """同一自适应块按各尺码起始针数分别推导实际重复次数。"""
    resp = client.post("/api/analyze_sizes", json={
        "rows": ["[k2]*~4 k4"],
        "sizes": [
            {"name": "S", "start_stitches": 20},
            {"name": "M", "start_stitches": 24},
        ],
    })
    sizes = resp.json()["sizes"]
    assert sizes[0]["rows"][0]["status"] == "ok"
    assert sizes[0]["rows"][0]["adaptive_blocks"][0]["actual_repeats"] == 8
    assert sizes[1]["rows"][0]["status"] == "ok"
    assert sizes[1]["rows"][0]["adaptive_blocks"][0]["actual_repeats"] == 10


def test_analyze_sizes_syntax_error_isolated():
    """语法错误尺码被阻断，其余尺码正常。"""
    resp = client.post("/api/analyze_sizes", json={
        "rows": ["k2", "k1"],
        "sizes": [
            {"name": "S", "start_stitches": 2},
            {"name": "M", "start_stitches": 2},
        ],
    })
    assert resp.status_code == 200
    sizes = resp.json()["sizes"]
    assert all(s["rows"][0]["status"] == "ok" for s in sizes)

    resp = client.post("/api/analyze_sizes", json={
        "rows": ["k2", "[k1", "k1"],
        "sizes": [
            {"name": "S", "start_stitches": 2},
            {"name": "M", "start_stitches": 2},
        ],
    })
    sizes = resp.json()["sizes"]
    # 两个尺码共用同一份行指令，语法错误行对两者都报错并各自阻断
    for s in sizes:
        assert s["rows"][1]["status"] == "error"
        assert s["rows"][2]["status"] == "blocked"


def test_analyze_sizes_name_normalized():
    resp = client.post("/api/analyze_sizes", json={
        "rows": ["k2"],
        "sizes": [
            {"name": "  S  ", "start_stitches": 2},
            {"name": "M", "start_stitches": 4},
        ],
    })
    assert resp.status_code == 200
    assert resp.json()["sizes"][0]["name"] == "S"


def test_analyze_sizes_validation():
    base = {"rows": ["k2"]}
    # 尺码数量越界（< 2 / > 8）
    assert client.post("/api/analyze_sizes", json={
        **base, "sizes": [{"name": "S", "start_stitches": 2}],
    }).status_code == 422
    assert client.post("/api/analyze_sizes", json={
        **base,
        "sizes": [{"name": f"Z{i}", "start_stitches": 2} for i in range(9)],
    }).status_code == 422
    # 名称为空 / 全空白
    assert client.post("/api/analyze_sizes", json={
        **base,
        "sizes": [{"name": "S", "start_stitches": 2}, {"name": "   ", "start_stitches": 2}],
    }).status_code == 422
    # 名称重复（去空白后）
    assert client.post("/api/analyze_sizes", json={
        **base,
        "sizes": [{"name": "S", "start_stitches": 2}, {"name": " S ", "start_stitches": 4}],
    }).status_code == 422
    # 起始针数为负
    assert client.post("/api/analyze_sizes", json={
        **base,
        "sizes": [{"name": "S", "start_stitches": -1}, {"name": "M", "start_stitches": 2}],
    }).status_code == 422
