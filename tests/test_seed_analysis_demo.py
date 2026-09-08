import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import date, timedelta

import app as anyline
from scripts.seed_analysis_demo import WORKSPACE_NAME, seed


class AnalysisDemoSeedTests(unittest.TestCase):
    def test_seed_builds_evolving_15_day_workspace_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary:
            database = f"{temporary}/demo.db"
            anyline.init_db(database)
            first = seed(database)
            second = seed(database)
            self.assertTrue(first["created"])
            self.assertFalse(second["created"])
            self.assertEqual(first["workspace_id"], second["workspace_id"])
            workspace_id = first["workspace_id"]
            with closing(sqlite3.connect(database)) as db:
                db.row_factory = sqlite3.Row
                self.assertEqual(db.execute(
                    "SELECT name FROM workspaces WHERE id=?", (workspace_id,)
                ).fetchone()["name"], WORKSPACE_NAME)
                self.assertEqual(db.execute(
                    "SELECT COUNT(*) FROM lines WHERE workspace_id=? AND deleted=0", (workspace_id,)
                ).fetchone()[0], 4)
                self.assertEqual(db.execute(
                    "SELECT COUNT(*) FROM tasks WHERE workspace_id=? AND deleted=0", (workspace_id,)
                ).fetchone()[0], 10)
                self.assertEqual(db.execute(
                    "SELECT COUNT(*) FROM milestones WHERE workspace_id=? AND deleted=0", (workspace_id,)
                ).fetchone()[0], 3)
                snapshots = db.execute(
                    "SELECT snapshot_date,scene FROM dashboard_snapshots WHERE workspace_id=? "
                    "ORDER BY snapshot_date", (workspace_id,)
                ).fetchall()
                self.assertEqual(len(snapshots), 15)
                self.assertEqual(snapshots[0]["snapshot_date"],
                                 (date.today() - timedelta(days=14)).isoformat())
                self.assertEqual(snapshots[-1]["snapshot_date"], date.today().isoformat())
                scenes = [json.loads(row["scene"]) for row in snapshots]
                self.assertLess(len(scenes[0]["tasks"]), len(scenes[-1]["tasks"]))
                early_names = {task["name"] for task in scenes[3]["tasks"]}
                current_names = {task["name"] for task in scenes[-1]["tasks"]}
                self.assertIn("订单接口开发", early_names)
                self.assertIn("旧版浏览器适配（已取消）", early_names)
                self.assertIn("核心接口开发", current_names)
                self.assertNotIn("旧版浏览器适配（已取消）", current_names)
                current_tasks = {task["name"]: task for task in scenes[-1]["tasks"]}
                self.assertEqual(current_tasks["性能压测"]["status"], "有风险")
                self.assertEqual(current_tasks["首轮客户验收"]["status"], "等待中")
                self.assertEqual(current_tasks["灰度发布"]["status"], "未启动")
                self.assertEqual(scenes[-1]["milestones"][-1]["name"], "正式发布")
                self.assertNotEqual(scenes[-3]["milestones"][-1]["milestone_date"],
                                    scenes[-1]["milestones"][-1]["milestone_date"])
                activity_summaries = [row[0] for row in db.execute(
                    "SELECT summary FROM task_activities WHERE workspace_id=?", (workspace_id,)
                )]
                self.assertTrue(any("结束日期" in summary for summary in activity_summaries))
                self.assertTrue(any("状态更新" in summary for summary in activity_summaries))


if __name__ == "__main__":
    unittest.main()
