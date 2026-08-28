import http.client
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from datetime import date, timedelta

from werkzeug.serving import make_server

_IMPORT_TEMP_DIR = tempfile.TemporaryDirectory()
os.environ["ANYLINE_DB_PATH"] = os.path.join(_IMPORT_TEMP_DIR.name, "import.db")
import app as anyline


class AnyLineHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.server = make_server("127.0.0.1", 0, anyline.app, threaded=True)
        cls.port = cls.server.server_port
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=5)
        cls.server.server_close()
        cls.temp_dir.cleanup()
        _IMPORT_TEMP_DIR.cleanup()

    def setUp(self):
        db_path = os.path.join(self.temp_dir.name, f"{self._testMethodName}.db")
        anyline.app.config.update(DATABASE=db_path, TESTING=True)
        anyline.init_db(db_path)
        self.today = date.today()

    def request(self, method, path, payload=None, raw_body=None):
        body = raw_body
        headers = {}
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif raw_body is not None:
            headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        content_type = response.getheader("Content-Type", "")
        raw = response.read()
        connection.close()
        data = json.loads(raw.decode("utf-8")) if "application/json" in content_type else raw
        return response.status, data

    def create_line(
        self, name="主线", fork_date=None, parent_id=None,
        description="", color=None,
    ):
        payload = {
            "name": name,
            "description": description,
            "color": color,
            "fork_date": fork_date or self.today.isoformat(),
            "parent_id": parent_id,
        }
        status, data = self.request("POST", "/api/lines", payload)
        self.assertEqual(status, 201, data)
        return data["id"]

    def create_task(self, line_id, name="事务", **overrides):
        payload = {
            "line_id": line_id,
            "name": name,
            "content": "内容",
            "goal": "目标",
            "owner": "张三",
            "priority": "高",
            "next_action": "下一步",
            "risk_reason": "",
            "status": "进行中",
            "start_date": self.today.isoformat(),
            "end_date": (self.today + timedelta(days=7)).isoformat(),
        }
        payload.update(overrides)
        status, data = self.request("POST", "/api/tasks", payload)
        self.assertEqual(status, 201, data)
        return data["id"]

    def test_index_and_empty_state(self):
        status, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"AnyLine", body)

        status, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(state["lines"], [])
        self.assertEqual(state["tasks"], [])
        self.assertFalse(state["can_undo"])
        self.assertEqual(state["priority_enum"], ["低", "中", "高", "紧急"])

    def test_configuration_validation_and_deduplication(self):
        status, data = self.request(
            "PUT", "/api/owners", {"owners": [" 张三 ", "李四", "张三", ""]}
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["owners"], ["张三", "李四"])

        status, data = self.request(
            "PUT", "/api/statuses", {"statuses": ["待办", "处理中", "待办"]}
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["statuses"], ["待办", "处理中"])
        self.assertEqual(self.request("GET", "/api/owners")[1]["owners"], ["张三", "李四"])
        self.assertEqual(self.request("GET", "/api/statuses")[1]["statuses"], ["待办", "处理中"])

        status, data = self.request("PUT", "/api/statuses", {"statuses": []})
        self.assertEqual(status, 400)
        self.assertIn("不能为空", data["error"])

        status, data = self.request("PUT", "/api/owners", {"owners": "张三"})
        self.assertEqual(status, 400)
        self.assertIn("字符串数组", data["error"])

    def test_line_crud_and_date_rules(self):
        yesterday = (self.today - timedelta(days=1)).isoformat()
        tomorrow = (self.today + timedelta(days=1)).isoformat()
        main_id = self.create_line(description="主线描述", color="#123ABC")

        _, state = self.request("GET", "/api/state")
        self.assertEqual(state["lines"][0]["description"], "主线描述")
        self.assertEqual(state["lines"][0]["color"], "#123abc")
        status, data = self.request(
            "PATCH", f"/api/lines/{main_id}", {
                "description": "更新后的描述", "color": "#abcdef",
            }
        )
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual(state["lines"][0]["description"], "更新后的描述")
        self.assertEqual(state["lines"][0]["color"], "#abcdef")
        status, data = self.request(
            "PATCH", f"/api/lines/{main_id}", {"color": "red"}
        )
        self.assertEqual(status, 400, data)

        status, data = self.request("POST", "/api/lines", {
            "name": "非法支线", "parent_id": main_id, "fork_date": yesterday,
        })
        self.assertEqual(status, 400)
        self.assertIn("不能早于", data["error"])

        branch_id = self.create_line("支线", tomorrow, main_id)
        status, _ = self.request(
            "PATCH", f"/api/lines/{branch_id}", {"merge_date": self.today.isoformat()}
        )
        self.assertEqual(status, 400)

        status, data = self.request(
            "PATCH", f"/api/lines/{main_id}", {"fork_date": tomorrow}
        )
        self.assertEqual(status, 200, data)

        day_after = (self.today + timedelta(days=2)).isoformat()
        status, data = self.request(
            "PATCH", f"/api/lines/{main_id}", {"fork_date": day_after}
        )
        self.assertEqual(status, 400)
        self.assertIn("子支线", data["error"])

        status, data = self.request(
            "PATCH", f"/api/lines/{branch_id}", {"merge_date": day_after}
        )
        self.assertEqual(status, 200, data)

    def test_task_full_crud_from_canvas_payload(self):
        line_id = self.create_line()
        task_id = self.create_task(line_id)

        status, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        task = state["tasks"][0]
        self.assertEqual(task["id"], task_id)
        self.assertEqual(task["priority"], "高")
        self.assertEqual(task["next_action"], "下一步")

        status, data = self.request("PATCH", f"/api/tasks/{task_id}", {
            "name": "更新事务", "status": "已闭环", "end_date": None,
        })
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual(state["tasks"][0]["name"], "更新事务")
        self.assertEqual(state["tasks"][0]["status"], "已闭环")
        self.assertIsNone(state["tasks"][0]["end_date"])

        status, data = self.request("DELETE", f"/api/tasks/{task_id}")
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual(state["tasks"], [])
        self.assertTrue(state["can_undo"])

        status, data = self.request("POST", "/api/undo")
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual([task["id"] for task in state["tasks"]], [task_id])

    def test_task_validation_never_returns_500(self):
        line_id = self.create_line()
        cases = [
            ({"line_id": line_id, "name": "", "start_date": self.today.isoformat()}, 400),
            ({"line_id": "bad", "name": "事务", "start_date": self.today.isoformat()}, 400),
            ({"line_id": line_id, "name": "事务", "content": [], "start_date": self.today.isoformat()}, 400),
            ({"line_id": line_id, "name": "事务", "priority": "最高", "start_date": self.today.isoformat()}, 400),
            ({"line_id": line_id, "name": "事务", "status": "不存在", "start_date": self.today.isoformat()}, 400),
            ({"line_id": line_id, "name": "事务", "start_date": "2026-02-30"}, 400),
            ({"line_id": line_id, "name": "事务", "start_date": "20260202"}, 400),
            ({"line_id": line_id, "name": "事务", "start_date": "2026-02-02", "end_date": "2026-02-01"}, 400),
        ]
        for payload, expected in cases:
            with self.subTest(payload=payload):
                status, data = self.request("POST", "/api/tasks", payload)
                self.assertEqual(status, expected, data)
                self.assertIn("error", data)

        status, data = self.request("POST", "/api/tasks", raw_body=b"[]")
        self.assertEqual(status, 400)
        self.assertIn("JSON", data["error"])

    def test_bulk_update_delete_and_undo(self):
        first_line = self.create_line("第一条线")
        second_line = self.create_line("第二条线")
        first = self.create_task(first_line, "事务一")
        second = self.create_task(first_line, "事务二")

        status, data = self.request(
            "PATCH", "/api/tasks/bulk", {"ids": [first, first], "patch": {"owner": "李四"}}
        )
        self.assertEqual(status, 400, data)

        status, data = self.request("PATCH", "/api/tasks/bulk", {
            "ids": [first, second],
            "patch": {"line_id": second_line, "owner": "李四", "priority": "紧急", "status": "有风险"},
        })
        self.assertEqual(status, 200, data)
        self.assertEqual(data["count"], 2)
        _, state = self.request("GET", "/api/state")
        self.assertTrue(all(task["line_id"] == second_line for task in state["tasks"]))
        self.assertTrue(all(task["status"] == "有风险" for task in state["tasks"]))

        status, data = self.request("DELETE", "/api/tasks/bulk", {"ids": [first, second]})
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual(state["tasks"], [])
        self.request("POST", "/api/undo")
        _, state = self.request("GET", "/api/state")
        self.assertEqual(len(state["tasks"]), 2)

    def test_recursive_delete_restore_and_purge(self):
        main_id = self.create_line("主线")
        branch_id = self.create_line("支线", self.today.isoformat(), main_id)
        self.create_task(branch_id)

        status, data = self.request("DELETE", f"/api/lines/{main_id}")
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual(state["lines"], [])
        self.assertEqual(state["tasks"], [])

        _, trash = self.request("GET", "/api/trash")
        self.assertEqual(trash["batches"][0]["line_count"], 2)
        self.assertEqual(trash["batches"][0]["task_count"], 1)
        batch = trash["batches"][0]["batch"]
        status, data = self.request("POST", "/api/trash/restore", {"batch": batch})
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual(len(state["lines"]), 2)
        self.assertEqual(len(state["tasks"]), 1)

        self.request("DELETE", f"/api/lines/{main_id}")
        status, data = self.request("POST", "/api/trash/purge")
        self.assertEqual(status, 200, data)
        _, trash = self.request("GET", "/api/trash")
        self.assertEqual(trash["batches"], [])

    def test_restore_dependency_order(self):
        line_id = self.create_line()
        task_id = self.create_task(line_id)
        self.request("DELETE", f"/api/tasks/{task_id}")
        _, trash = self.request("GET", "/api/trash")
        task_batch = trash["batches"][0]["batch"]
        self.request("DELETE", f"/api/lines/{line_id}")
        _, trash = self.request("GET", "/api/trash")
        line_batch = next(batch["batch"] for batch in trash["batches"] if batch["line_count"])

        status, data = self.request("POST", "/api/trash/restore", {"batch": task_batch})
        self.assertEqual(status, 409, data)
        status, _ = self.request("POST", "/api/trash/restore", {"batch": line_batch})
        self.assertEqual(status, 200)
        status, _ = self.request("POST", "/api/trash/restore", {"batch": task_batch})
        self.assertEqual(status, 200)


class DatabaseMigrationTests(unittest.TestCase):
    def test_legacy_schema_is_migrated(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, "legacy.db")
            db = sqlite3.connect(db_path)
            db.executescript(
                """
                CREATE TABLE lines (
                    id INTEGER PRIMARY KEY, name TEXT NOT NULL, parent_id INTEGER,
                    fork_date TEXT NOT NULL, merge_date TEXT, deleted INTEGER DEFAULT 0,
                    del_batch INTEGER
                );
                CREATE TABLE tasks (
                    id INTEGER PRIMARY KEY, line_id INTEGER NOT NULL, name TEXT NOT NULL,
                    content TEXT, goal TEXT, owner TEXT, status TEXT NOT NULL,
                    start_date TEXT NOT NULL, end_date TEXT, status_since TEXT NOT NULL,
                    deleted INTEGER DEFAULT 0, del_batch INTEGER
                );
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                """
            )
            db.commit()
            db.close()

            anyline.init_db(db_path)
            db = sqlite3.connect(db_path)
            line_columns = {row[1] for row in db.execute("PRAGMA table_info(lines)")}
            task_columns = {row[1] for row in db.execute("PRAGMA table_info(tasks)")}
            db.close()
            self.assertTrue(
                {"description", "color", "deleted_at", "updated_at"}
                .issubset(line_columns)
            )
            self.assertTrue(
                {"priority", "next_action", "risk_reason", "deleted_at", "updated_at"}
                .issubset(task_columns)
            )


if __name__ == "__main__":
    unittest.main()
