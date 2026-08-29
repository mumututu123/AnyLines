import http.client
import io
import json
import os
import base64
import sqlite3
import tempfile
import threading
import unittest
from datetime import date, timedelta

from openpyxl import load_workbook
from werkzeug.serving import make_server

_IMPORT_TEMP_DIR = tempfile.TemporaryDirectory()
os.environ["ANYLINE_DB_PATH"] = os.path.join(_IMPORT_TEMP_DIR.name, "import.db")
os.environ["ANYLINE_ADMIN_USERNAME"] = "admin"
os.environ["ANYLINE_ADMIN_PASSWORD"] = "admin123"
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
        self.cookie = None
        status, data = self.request(
            "POST", "/api/auth/login", {"username": "admin", "password": "admin123"}
        )
        self.assertEqual(status, 200, data)

    def request(self, method, path, payload=None, raw_body=None):
        body = raw_body
        headers = {}
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif raw_body is not None:
            headers["Content-Type"] = "application/json"
        if self.cookie:
            headers["Cookie"] = self.cookie
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        set_cookie = response.getheader("Set-Cookie")
        if set_cookie:
            self.cookie = set_cookie.split(";", 1)[0]
        content_type = response.getheader("Content-Type", "")
        raw = response.read()
        connection.close()
        data = json.loads(raw.decode("utf-8")) if "application/json" in content_type else raw
        return response.status, data

    def login(self, username, password):
        self.cookie = None
        return self.request(
            "POST", "/api/auth/login", {"username": username, "password": password}
        )

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
        self.assertIn(b'id="workspace-select"', body)
        self.assertIn(b'id="btn-view-dashboard"', body)
        self.assertIn(b'id="dashboard-view"', body)
        self.assertNotIn(b'id="btn-workspace-create"', body)
        self.assertNotIn(b'id="btn-delete-line"', body)
        self.assertNotIn(b'id="btn-undo"', body)

        status, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(state["lines"], [])
        self.assertEqual(state["tasks"], [])
        self.assertFalse(state["can_undo"])
        self.assertEqual(state["priority_enum"], ["低", "中", "高", "紧急"])
        self.assertEqual(state["status_colors"]["进行中"], "#0969da")

    def test_canvas_merge_uses_rounded_polyline(self):
        status, body = self.request("GET", "/static/app.js")
        self.assertEqual(status, 200)
        source = body.decode("utf-8")

        self.assertIn(
            "const horizontalDistance = verticalDistance / BRANCH_SLOPE;",
            source,
        )
        self.assertIn(
            "` Q ${corner.x} ${corner.y}, ${diagonalStart.x} ${diagonalStart.y} `",
            source,
        )
        self.assertIn("cx: merge.end.x, cy: merge.end.y", source)
        self.assertNotIn("d += ` C ${mx + 24}", source)
        self.assertIn('e.key === "Delete"', source)
        self.assertIn('e.key.toLowerCase() === "z"', source)

    def test_authentication_is_required(self):
        self.cookie = None
        status, data = self.request("GET", "/api/state")
        self.assertEqual(status, 401, data)
        self.assertIn("登录", data["error"])

        status, data = self.login("admin", "wrong-password")
        self.assertEqual(status, 401, data)
        status, data = self.login("admin", "admin123")
        self.assertEqual(status, 200, data)
        self.assertTrue(data["authenticated"])
        self.assertEqual(data["current_workspace"]["role"], "admin")

    def test_workspace_isolation_and_member_permissions(self):
        default_line = self.create_line("默认空间主线")
        status, created = self.request(
            "POST", "/api/workspaces", {"name": "第二项目", "description": "隔离测试"}
        )
        self.assertEqual(status, 201, created)
        second_workspace = created["id"]
        second_line = self.create_line("第二空间主线")
        status, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual([line["id"] for line in state["lines"]], [second_line])

        status, member = self.request(
            "POST", f"/api/workspaces/{second_workspace}/members", {
                "username": "member1", "display_name": "普通成员",
                "password": "member123", "role": "member",
            }
        )
        self.assertEqual(status, 201, member)
        admin_cookie = self.cookie

        status, login = self.login("member1", "member123")
        self.assertEqual(status, 200, login)
        self.assertEqual(login["current_workspace"]["id"], second_workspace)
        status, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual([line["id"] for line in state["lines"]], [second_line])
        status, _ = self.request("POST", "/api/lines", {
            "name": "成员可写主线", "fork_date": self.today.isoformat(),
        })
        self.assertEqual(status, 201)
        second_task = self.create_task(second_line, "第二空间事务")
        self.assertEqual(
            self.request("PUT", "/api/owners", {"owners": ["空间二责任人"]})[0], 200
        )
        self.assertEqual(
            self.request("POST", "/api/workspaces", {"name": "越权空间"})[0], 403
        )
        self.assertEqual(
            self.request("GET", f"/api/workspaces/{second_workspace}/members")[0], 403
        )
        session_data = self.request("GET", "/api/auth/session")[1]
        self.assertEqual(len(session_data["workspaces"]), 1)

        self.cookie = admin_cookie
        default_workspace = next(
            workspace["id"] for workspace in
            self.request("GET", "/api/auth/session")[1]["workspaces"]
            if workspace["name"] == "默认项目"
        )
        self.assertEqual(
            self.request(
                "POST", f"/api/workspaces/{default_workspace}/select"
            )[0], 200
        )
        state = self.request("GET", "/api/state")[1]
        self.assertEqual([line["id"] for line in state["lines"]], [default_line])
        self.assertEqual(state["owners"], [])
        self.assertEqual(
            self.request(
                "PATCH", f"/api/lines/{second_line}", {"name": "跨空间修改"}
            )[0], 404
        )
        self.assertEqual(
            self.request(
                "PATCH", f"/api/tasks/{second_task}", {"name": "跨空间事务"}
            )[0], 404
        )
        self.assertEqual(
            self.request(
                "POST", "/api/tasks/export", {"scope": "selected", "ids": [second_task]}
            )[0], 404
        )

    def test_admin_can_manage_member_role_and_password(self):
        auth = self.request("GET", "/api/auth/session")[1]
        workspace_id = auth["current_workspace"]["id"]
        status, created = self.request(
            "POST", f"/api/workspaces/{workspace_id}/members", {
                "username": "project-admin", "display_name": "项目成员",
                "password": "initial123", "role": "member",
            }
        )
        self.assertEqual(status, 201, created)
        user_id = created["user_id"]

        members = self.request(
            "GET", f"/api/workspaces/{workspace_id}/members"
        )[1]["members"]
        managed = next(member for member in members if member["id"] == user_id)
        self.assertEqual(managed["role"], "member")
        self.assertTrue(managed["can_manage_account"])

        status, data = self.request(
            "PATCH", f"/api/workspaces/{workspace_id}/members/{user_id}", {
                "display_name": "项目管理员", "password": "changed123",
                "role": "admin",
            }
        )
        self.assertEqual(status, 200, data)
        self.assertEqual(self.login("project-admin", "initial123")[0], 401)
        status, login = self.login("project-admin", "changed123")
        self.assertEqual(status, 200, login)
        self.assertEqual(login["current_workspace"]["role"], "admin")
        self.assertEqual(
            self.request("POST", "/api/workspaces", {"name": "管理员新空间"})[0],
            201,
        )

    def test_configuration_validation_and_deduplication(self):
        status, data = self.request(
            "PUT", "/api/owners", {"owners": [" 张三 ", "李四", "张三", ""]}
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["owners"], ["张三", "李四"])

        status, data = self.request(
            "PUT", "/api/statuses", {
                "statuses": ["待办", "处理中", "待办"],
                "colors": {"待办": "#AABBCC", "处理中": "#123456"},
            }
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["statuses"], ["待办", "处理中"])
        self.assertEqual(data["colors"], {"待办": "#aabbcc", "处理中": "#123456"})
        self.assertEqual(self.request("GET", "/api/owners")[1]["owners"], ["张三", "李四"])
        status_config = self.request("GET", "/api/statuses")[1]
        self.assertEqual(status_config["statuses"], ["待办", "处理中"])
        self.assertEqual(status_config["colors"]["待办"], "#aabbcc")
        state = self.request("GET", "/api/state")[1]
        self.assertEqual(state["status_colors"]["处理中"], "#123456")

        status, data = self.request("PUT", "/api/statuses", {"statuses": []})
        self.assertEqual(status, 400)
        self.assertIn("不能为空", data["error"])

        status, data = self.request("PUT", "/api/statuses", {
            "statuses": ["待办"], "colors": {"待办": "red"},
        })
        self.assertEqual(status, 400)
        self.assertIn("#RRGGBB", data["error"])

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
            "end_date": None,
        })
        self.assertEqual(status, 400, data)
        self.assertIn("结束日期不能为空", data["error"])

        updated_end = (self.today + timedelta(days=10)).isoformat()
        status, data = self.request("PATCH", f"/api/tasks/{task_id}", {
            "name": "更新事务", "status": "已闭环", "end_date": updated_end,
        })
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual(state["tasks"][0]["name"], "更新事务")
        self.assertEqual(state["tasks"][0]["status"], "已闭环")
        self.assertEqual(state["tasks"][0]["end_date"], updated_end)

        status, data = self.request("DELETE", f"/api/tasks/{task_id}")
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual(state["tasks"], [])
        self.assertTrue(state["can_undo"])

        status, data = self.request("POST", "/api/undo")
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual([task["id"] for task in state["tasks"]], [task_id])

    def test_task_dependencies_and_closure_guard(self):
        line_id = self.create_line()
        prerequisite_one = self.create_task(line_id, "前置事务一")
        prerequisite_two = self.create_task(
            line_id, "前置事务二", status="已闭环"
        )
        dependent_one = self.create_task(
            line_id, "依赖事务一",
            prerequisite_ids=[prerequisite_one, prerequisite_two],
        )
        dependent_two = self.create_task(line_id, "依赖事务二")

        status, data = self.request(
            "POST", f"/api/tasks/{dependent_two}/dependencies",
            {"prerequisite_task_id": prerequisite_one},
        )
        self.assertEqual(status, 201, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual(
            {
                (row["dependent_task_id"], row["prerequisite_task_id"])
                for row in state["dependencies"]
            },
            {
                (dependent_one, prerequisite_one),
                (dependent_one, prerequisite_two),
                (dependent_two, prerequisite_one),
            },
        )

        status, data = self.request(
            "PATCH", f"/api/tasks/{dependent_one}", {"status": "已闭环"}
        )
        self.assertEqual(status, 409, data)
        self.assertIn("前置事务一", data["error"])
        status, data = self.request(
            "PATCH", "/api/tasks/bulk",
            {"ids": [dependent_one, dependent_two], "patch": {"status": "已闭环"}},
        )
        self.assertEqual(status, 409, data)

        status, data = self.request(
            "PATCH", f"/api/tasks/{prerequisite_one}", {"status": "已闭环"}
        )
        self.assertEqual(status, 200, data)
        status, data = self.request(
            "PATCH", f"/api/tasks/{dependent_one}", {"status": "已闭环"}
        )
        self.assertEqual(status, 200, data)

        status, data = self.request("DELETE", f"/api/tasks/{prerequisite_one}")
        self.assertEqual(status, 409, data)
        status, data = self.request(
            "DELETE", f"/api/tasks/{dependent_two}/dependencies",
            {"prerequisite_task_id": prerequisite_one},
        )
        self.assertEqual(status, 200, data)

        cycle_one = self.create_task(line_id, "环路一")
        cycle_two = self.create_task(line_id, "环路二")
        status, data = self.request(
            "PATCH", f"/api/tasks/{cycle_one}",
            {"prerequisite_ids": [cycle_two]},
        )
        self.assertEqual(status, 200, data)
        status, data = self.request(
            "PATCH", f"/api/tasks/{cycle_two}",
            {"prerequisite_ids": [cycle_one]},
        )
        self.assertEqual(status, 400, data)
        self.assertIn("循环", data["error"])
        status, data = self.request(
            "PATCH", f"/api/tasks/{cycle_one}",
            {"prerequisite_ids": [cycle_one]},
        )
        self.assertEqual(status, 400, data)

        cycle_three = self.create_task(line_id, "环路三")
        status, data = self.request(
            "PATCH", f"/api/tasks/{cycle_two}",
            {"prerequisite_ids": [cycle_three]},
        )
        self.assertEqual(status, 200, data)
        status, data = self.request(
            "POST", f"/api/tasks/{cycle_three}/dependencies",
            {"prerequisite_task_id": cycle_one},
        )
        self.assertEqual(status, 400, data)
        self.assertIn("循环", data["error"])
        _, state = self.request("GET", "/api/state")
        self.assertNotIn(
            (cycle_three, cycle_one),
            {
                (row["dependent_task_id"], row["prerequisite_task_id"])
                for row in state["dependencies"]
            },
        )

        undo_source = self.create_task(line_id, "撤销来源")
        undo_target = self.create_task(line_id, "撤销目标")
        status, data = self.request(
            "POST", f"/api/tasks/{undo_source}/dependencies",
            {"prerequisite_task_id": undo_target},
        )
        self.assertEqual(status, 201, data)
        status, data = self.request("POST", "/api/undo")
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertNotIn(
            (undo_source, undo_target),
            {
                (row["dependent_task_id"], row["prerequisite_task_id"])
                for row in state["dependencies"]
            },
        )

    def test_general_undo_for_canvas_edits(self):
        main_id = self.create_line("初始主线")
        status, data = self.request("POST", "/api/undo")
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual(state["lines"], [])
        self.assertFalse(state["can_undo"])

        main_id = self.create_line("初始主线")
        status, data = self.request(
            "PATCH", f"/api/lines/{main_id}", {"name": "修改后的主线"}
        )
        self.assertEqual(status, 200, data)
        self.request("POST", "/api/undo")
        _, state = self.request("GET", "/api/state")
        self.assertEqual(state["lines"][0]["name"], "初始主线")

        task_id = self.create_task(main_id, "初始事务")
        self.request("POST", "/api/undo")
        _, state = self.request("GET", "/api/state")
        self.assertEqual(state["tasks"], [])

        task_id = self.create_task(main_id, "初始事务")
        status, data = self.request(
            "PATCH", f"/api/tasks/{task_id}",
            {"name": "修改后的事务", "status": "已闭环"},
        )
        self.assertEqual(status, 200, data)
        self.request("POST", "/api/undo")
        _, state = self.request("GET", "/api/state")
        self.assertEqual(state["tasks"][0]["name"], "初始事务")
        self.assertEqual(state["tasks"][0]["status"], "进行中")

        branch_id = self.create_line("待反合支线", parent_id=main_id)
        merge_date = (self.today + timedelta(days=2)).isoformat()
        status, data = self.request(
            "PATCH", f"/api/lines/{branch_id}", {"merge_date": merge_date}
        )
        self.assertEqual(status, 200, data)
        self.request("POST", "/api/undo")
        _, state = self.request("GET", "/api/state")
        branch = next(line for line in state["lines"] if line["id"] == branch_id)
        self.assertIsNone(branch["merge_date"])

        status, data = self.request("POST", "/api/undo")
        self.assertEqual(status, 400, data)
        self.assertIn("没有可撤销", data["error"])

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

    def test_task_required_fields_and_modal_controls(self):
        line_id = self.create_line()
        valid = {
            "line_id": line_id,
            "name": "必填校验事务",
            "content": "内容",
            "owner": "张三",
            "status": "进行中",
            "start_date": self.today.isoformat(),
            "end_date": (self.today + timedelta(days=1)).isoformat(),
        }
        labels = {
            "name": "事务名", "content": "事务内容", "owner": "责任人",
            "status": "进展状态", "start_date": "起始日期", "end_date": "结束日期",
        }
        for key, label in labels.items():
            payload = dict(valid)
            payload[key] = ""
            status, data = self.request("POST", "/api/tasks", payload)
            self.assertEqual(status, 400, (key, data))
            self.assertIn(f"{label}不能为空", data["error"])

        status, body = self.request("GET", "/static/app.js")
        self.assertEqual(status, 200)
        source = body.decode("utf-8")
        self.assertIn('search.placeholder = "搜索事务名、内容、责任人或所属线"', source)
        self.assertIn('field(parent, "依赖事务（可多选）", wrapper)', source)
        self.assertIn('moreSummary.textContent = "更多描述"', source)
        self.assertIn('mark.className = "required-mark"', source)
        self.assertIn('$("#modal-header-tools").appendChild(del)', source)

        task_id = self.create_task(line_id)
        status, data = self.request(
            "PATCH", "/api/tasks/bulk",
            {"ids": [task_id], "patch": {"owner": " "}},
        )
        self.assertEqual(status, 400, data)
        self.assertIn("责任人不能为空", data["error"])

    def test_task_content_images_are_persisted_served_and_undoable(self):
        line_id = self.create_line()
        png_base64 = (
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
            "+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        data_url = f"data:image/png;base64,{png_base64}"
        task_id = self.create_task(line_id, images=[{"data_url": data_url}])

        _, state = self.request("GET", "/api/state")
        self.assertEqual(len(state["task_images"]), 1)
        image_id = state["task_images"][0]["id"]
        self.assertEqual(state["task_images"][0]["task_id"], task_id)
        status, content = self.request("GET", f"/api/task-images/{image_id}")
        self.assertEqual(status, 200)
        self.assertEqual(content, base64.b64decode(png_base64))

        status, data = self.request("PATCH", f"/api/tasks/{task_id}", {
            "images": [{"id": image_id}, {"data_url": data_url}],
        })
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual(len(state["task_images"]), 2)

        status, data = self.request("PATCH", f"/api/tasks/{task_id}", {
            "images": [{"id": image_id}],
        })
        self.assertEqual(status, 200, data)
        _, state = self.request("GET", "/api/state")
        self.assertEqual(len(state["task_images"]), 1)
        self.request("POST", "/api/undo")
        _, state = self.request("GET", "/api/state")
        self.assertEqual(len(state["task_images"]), 2)

        status, data = self.request("PATCH", f"/api/tasks/{task_id}", {
            "images": [{"data_url": "data:image/svg+xml;base64,PHN2Zy8+"}],
        })
        self.assertEqual(status, 400, data)
        self.assertIn("仅支持", data["error"])

        status, body = self.request("GET", "/static/app.js")
        self.assertEqual(status, 200)
        source = body.decode("utf-8")
        self.assertIn('textarea.addEventListener("paste"', source)
        self.assertIn('reader.readAsDataURL(file)', source)
        self.assertIn('preview.src = image.src || image.data_url', source)

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

    def test_excel_export_all_and_selected(self):
        main_id = self.create_line("产品主线")
        branch_id = self.create_line("交付支线", parent_id=main_id)
        first = self.create_task(main_id, "=1+1")
        second = self.create_task(branch_id, "交付事务", owner="李四")

        status, content = self.request(
            "POST", "/api/tasks/export", {"scope": "all", "ids": None}
        )
        self.assertEqual(status, 200)
        self.assertTrue(content.startswith(b"PK"))
        workbook = load_workbook(io.BytesIO(content))
        sheet = workbook["事务"]
        self.assertEqual(sheet.freeze_panes, "A2")
        self.assertEqual(sheet.auto_filter.ref, "A1:P3")
        self.assertEqual(
            [cell.value for cell in sheet[1]],
            [column[0] for column in anyline.TASK_EXPORT_COLUMNS],
        )
        self.assertEqual(sheet["E2"].value, "=1+1")
        self.assertEqual(sheet["E2"].data_type, "s")
        self.assertEqual(sheet["C2"].value, "主线")
        self.assertEqual(sheet["C3"].value, "支线")
        self.assertEqual(sheet["D3"].value, "产品主线")

        status, content = self.request(
            "POST", "/api/tasks/export", {"scope": "selected", "ids": [second]}
        )
        self.assertEqual(status, 200)
        sheet = load_workbook(io.BytesIO(content))["事务"]
        self.assertEqual(sheet.auto_filter.ref, "A1:P2")
        self.assertEqual(sheet.max_row, 2)
        self.assertEqual(sheet["A2"].value, second)
        self.assertEqual(sheet["E2"].value, "交付事务")

        for payload, expected in (
            ({"scope": "selected", "ids": []}, 400),
            ({"scope": "selected", "ids": [first, first]}, 400),
            ({"scope": "selected", "ids": [999999]}, 404),
            ({"scope": "unknown"}, 400),
        ):
            with self.subTest(payload=payload):
                status, data = self.request("POST", "/api/tasks/export", payload)
                self.assertEqual(status, expected, data)

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
                INSERT INTO lines(id,name,parent_id,fork_date,deleted)
                VALUES(1,'历史主线',NULL,'2026-01-01',0);
                INSERT INTO tasks(
                    id,line_id,name,status,start_date,status_since,deleted
                ) VALUES(1,1,'历史事务','未启动','2026-01-01','2026-01-01',0);
                INSERT INTO meta(key,value) VALUES('owners','["历史责任人"]');
                """
            )
            db.commit()
            db.close()

            anyline.init_db(db_path)
            db = sqlite3.connect(db_path)
            line_columns = {row[1] for row in db.execute("PRAGMA table_info(lines)")}
            task_columns = {row[1] for row in db.execute("PRAGMA table_info(tasks)")}
            table_names = {
                row[0] for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            workspace_id = db.execute("SELECT workspace_id FROM lines WHERE id=1").fetchone()[0]
            task_workspace_id = db.execute(
                "SELECT workspace_id FROM tasks WHERE id=1"
            ).fetchone()[0]
            admin_count = db.execute(
                "SELECT COUNT(*) FROM workspace_members WHERE role='admin'"
            ).fetchone()[0]
            migrated_owners = db.execute(
                "SELECT value FROM workspace_meta WHERE workspace_id=? AND key='owners'",
                (workspace_id,),
            ).fetchone()[0]
            db.close()
            self.assertTrue(
                {"description", "color", "deleted_at", "updated_at", "workspace_id"}
                .issubset(line_columns)
            )
            self.assertTrue(
                {
                    "priority", "next_action", "risk_reason", "deleted_at",
                    "updated_at", "workspace_id",
                }
                .issubset(task_columns)
            )
            self.assertIn("task_images", table_names)
            self.assertEqual(task_workspace_id, workspace_id)
            self.assertEqual(admin_count, 1)
            self.assertEqual(json.loads(migrated_owners), ["历史责任人"])


if __name__ == "__main__":
    unittest.main()
