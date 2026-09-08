"""Create a 15-day project-map demo workspace in an AnyLine database."""
import argparse
import json
import sqlite3
from collections import Counter
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path


WORKSPACE_NAME = "项目地图体验空间（15天样例）"
DONE = {"已闭环", "已取消"}


def iso(day):
    return day.isoformat()


def captured(day):
    return datetime.combine(day, time(18, 0), timezone.utc).isoformat().replace("+00:00", "Z")


def seed(database):
    today = date.today()
    day = lambda offset: iso(today + timedelta(days=offset))
    db = sqlite3.connect(str(database))
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=OFF")
    existing = db.execute("SELECT id FROM workspaces WHERE name=?", (WORKSPACE_NAME,)).fetchone()
    if existing:
        db.close()
        return {"created": False, "workspace_id": existing["id"], "name": WORKSPACE_NAME}
    users = db.execute(
        "SELECT id,display_name FROM users WHERE active=1 ORDER BY id"
    ).fetchall()
    if not users:
        db.close()
        raise RuntimeError("数据库中没有可用账号")
    creator = users[0]
    owners = [row["display_name"] for row in users]
    owner = lambda index: owners[index % len(owners)]
    try:
        db.execute("BEGIN IMMEDIATE")
        cursor = db.execute(
            "INSERT INTO workspaces(name,description,created_by,created_at,updated_at) "
            "VALUES(?,?,?,?,?)",
            (WORKSPACE_NAME,
             "用于体验项目地图六项辅助分析：最近变化、计划偏差、延期影响、历史回放、汇报演练和里程碑验收。",
             creator["id"], day(-14), day(0)),
        )
        workspace_id = cursor.lastrowid
        for index, user in enumerate(users):
            db.execute(
                "INSERT INTO workspace_members(workspace_id,user_id,role,joined_at) VALUES(?,?,?,?)",
                (workspace_id, user["id"], "admin" if index == 0 else "member", day(-14)),
            )

        line_defs = {
            "main": ("企业版发布主线", "从范围冻结到正式发布的完整路径", "#0969da", None, -14, None),
            "research": ("早期调研支线", "已反合的短支线，用于观察历史变化", "#8250df", "main", -13, -7),
            "customer": ("客户验收支线", "验证核心场景并收集试用反馈", "#bf3989", "main", -10, 3),
            "performance": ("性能攻坚支线", "压测、定位和治理热点", "#d4772c", "main", -8, 4),
        }
        line_ids = {}
        for key, (name, description, color, parent, start, merge) in line_defs.items():
            line_ids[key] = db.execute(
                "INSERT INTO lines(workspace_id,name,description,color,parent_id,fork_date,merge_date,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (workspace_id, name, description, color, line_ids.get(parent), day(start),
                 day(merge) if merge is not None else None, day(0 if key != "main" else -6)),
            ).lastrowid

        task_defs = {
            "scope": dict(line="main", name="需求范围确认", owner=owner(0), priority="高", created=-14,
                          start=-14, end=-12, status="已闭环", since=-11),
            "prototype": dict(line="research", name="交互原型评审", owner=owner(1), priority="中", created=-13,
                              start=-13, end=-10, status="已闭环", since=-9),
            "legacy": dict(line="research", name="旧版浏览器适配（已取消）", owner=owner(1), priority="低", created=-12,
                           start=-12, end=-7, status="已取消", since=-5, removed=-4),
            "api": dict(line="main", name="核心接口开发", owner=owner(0), priority="高", created=-11,
                        start=-11, end=-4, status="已闭环", since=-4),
            "script": dict(line="customer", name="客户验收脚本", owner=owner(1), priority="高", created=-9,
                           start=-9, end=-3, status="已闭环", since=-2),
            "load": dict(line="performance", name="性能压测", owner=owner(0), priority="紧急", created=-8,
                         start=-8, end=2, status="有风险", since=-3,
                         risk="高峰并发下 P95 延迟仍高于目标 18%"),
            "acceptance": dict(line="customer", name="首轮客户验收", owner=owner(1), priority="紧急", created=-5,
                               start=-5, end=1, status="等待中", since=-2,
                               risk="等待性能压测达到验收门槛"),
            "manual": dict(line="main", name="发布手册与培训", owner=owner(1), priority="中", created=-4,
                           start=-4, end=1, status="进行中", since=-4),
            "cache": dict(line="performance", name="缓存热点治理", owner=owner(0), priority="高", created=-3,
                          start=-3, end=1, status="进行中", since=-2),
            "rollback": dict(line="main", name="应急回滚演练", owner=owner(0), priority="高", created=-2,
                             start=-1, end=1, status="进行中", since=-1),
            "gray": dict(line="main", name="灰度发布", owner=owner(0), priority="紧急", created=-1,
                         start=2, end=4, status="未启动", since=-1),
        }
        task_ids = {}
        for key, item in task_defs.items():
            removed = item.get("removed")
            task_ids[key] = db.execute(
                "INSERT INTO tasks(workspace_id,line_id,name,content,goal,owner,owners,priority,next_action,risk_reason,"
                "status,start_date,end_date,status_since,deleted,del_batch,deleted_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, line_ids[item["line"]], item["name"],
                 f"体验数据：{item['name']}。双击画布节点可查看详情和动态。",
                 "按计划完成并满足发布验收标准", item["owner"],
                 json.dumps([item["owner"]], ensure_ascii=False), item["priority"],
                 "查看依赖与下一次验收节点", item.get("risk", ""), item["status"],
                 day(item["start"]), day(item["end"]), day(item["since"]),
                 1 if removed is not None else 0, workspace_id if removed is not None else None,
                 day(removed) if removed is not None else None, day(item["since"])),
            ).lastrowid
            if removed is None:
                db.execute(
                    "INSERT INTO task_followers(workspace_id,task_id,user_id,created_at) VALUES(?,?,?,?)",
                    (workspace_id, task_ids[key], creator["id"], captured(today + timedelta(days=item["created"]))),
                )

        dependency_defs = [
            ("prototype", "scope"), ("api", "scope"), ("script", "api"),
            ("load", "api"), ("acceptance", "script"), ("acceptance", "load"),
            ("cache", "load"), ("gray", "acceptance"), ("gray", "cache"),
            ("gray", "manual"), ("gray", "rollback"),
        ]
        for dependent, prerequisite in dependency_defs:
            db.execute(
                "INSERT INTO task_dependencies(workspace_id,dependent_task_id,prerequisite_task_id) VALUES(?,?,?)",
                (workspace_id, task_ids[dependent], task_ids[prerequisite]),
            )

        milestone_defs = {
            "review": dict(line="main", name="内部方案评审", target="范围和交互方案获得内部确认",
                           created=-12, date=-9, tasks=["scope", "prototype"]),
            "trial": dict(line="customer", name="客户试用验收", target="核心场景通过客户试用并收齐问题",
                          created=-6, date=1, tasks=["script", "acceptance"]),
            "release": dict(line="main", name="正式发布", target="灰度、回滚和发布材料全部就绪",
                            created=-3, date=5, tasks=["manual", "rollback", "gray"]),
        }
        milestone_ids = {}
        for key, item in milestone_defs.items():
            milestone_ids[key] = db.execute(
                "INSERT INTO milestones(workspace_id,line_id,name,target_description,milestone_date,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (workspace_id, line_ids[item["line"]], item["name"], item["target"], day(item["date"]),
                 day(item["created"]), day(-1 if key == "release" else item["created"])),
            ).lastrowid
            for task_key in item["tasks"]:
                db.execute(
                    "INSERT INTO milestone_tasks(workspace_id,milestone_id,task_id) VALUES(?,?,?)",
                    (workspace_id, milestone_ids[key], task_ids[task_key]),
                )

        activities = [
            ("scope", -14, "created", "创建了事务"),
            ("scope", -11, "status_changed", "进展状态从「进行中」更新为「已闭环」"),
            ("prototype", -11, "status_changed", "评审发现可用性风险，状态更新为「有风险」"),
            ("prototype", -9, "status_changed", "评审通过，状态更新为「已闭环」"),
            ("api", -7, "fields_updated", "事务名从「订单接口开发」调整为「核心接口开发」"),
            ("api", -5, "fields_updated", f"结束日期从「{day(-6)}」调整为「{day(-4)}」"),
            ("api", -4, "status_changed", "联调完成，状态更新为「已闭环」"),
            ("load", -3, "status_changed", "压测结果未达标，状态更新为「有风险」"),
            ("acceptance", -2, "status_changed", "因性能压测未闭环，状态更新为「等待中」"),
            ("load", -2, "fields_updated", f"结束日期从「{day(-3)}」调整为「{day(2)}」"),
            ("rollback", -2, "created", "创建了事务并加入正式发布验收"),
            ("gray", -1, "dependencies_changed", "补充了客户验收、性能治理、发布手册和回滚演练依赖"),
        ]
        for task_key, offset, kind, summary in activities:
            db.execute(
                "INSERT INTO task_activities(workspace_id,task_id,actor_id,event_type,summary,metadata,created_at) "
                "VALUES(?,?,?,?,?,'{}',?)",
                (workspace_id, task_ids[task_key], creator["id"], kind, summary,
                 captured(today + timedelta(days=offset))),
            )
        db.execute(
            "INSERT INTO task_comments(workspace_id,task_id,author_id,content,created_at) VALUES(?,?,?,?,?)",
            (workspace_id, task_ids["load"], creator["id"],
             "体验提示：可在延期影响中选择“性能压测”，输入 3 天查看连锁影响。", captured(today)),
        )

        def historical_line(key, offset):
            name, _description, color, parent, start, merge = line_defs[key]
            if key == "main" and offset < -6:
                name = "秋季版本发布"
            return {"id": line_ids[key], "name": name, "parent_id": line_ids.get(parent),
                    "fork_date": day(start), "merge_date": day(merge) if merge is not None and offset >= -7 else None,
                    "color": color}

        def historical_task(key, offset):
            item = task_defs[key]
            name, end, status = item["name"], item["end"], "未启动"
            if key == "scope": status = "已闭环" if offset >= -11 else "进行中"
            elif key == "prototype": status = "已闭环" if offset >= -9 else "有风险" if offset >= -11 else "进行中"
            elif key == "legacy": status = "已取消" if offset >= -5 else "进行中"
            elif key == "api":
                name = "核心接口开发" if offset >= -7 else "订单接口开发"
                end = -4 if offset >= -5 else -6
                status = "已闭环" if offset >= -4 else "进行中"
            elif key == "script": status = "已闭环" if offset >= -2 else "进行中"
            elif key == "load":
                end = 2 if offset >= -2 else -3
                status = "有风险" if offset >= -3 else "进行中"
            elif key == "acceptance": status = "等待中" if offset >= -2 else "未启动"
            elif key in {"manual", "rollback", "cache"}: status = "进行中" if offset >= item["created"] + 1 else "未启动"
            return {"id": task_ids[key], "line_id": line_ids[item["line"]], "name": name,
                    "owner": item["owner"], "owners": [item["owner"]],
                    "priority": item["priority"], "status": status,
                    "start_date": day(item["start"]), "end_date": day(end)}

        for offset in range(-14, 1):
            snapshot_day = today + timedelta(days=offset)
            scene_lines = [historical_line(key, offset) for key, item in line_defs.items() if offset >= item[4]]
            scene_tasks = [historical_task(key, offset) for key, item in task_defs.items()
                           if offset >= item["created"] and (item.get("removed") is None or offset < item["removed"])]
            visible_ids = {item["id"] for item in scene_tasks}
            scene_dependencies = [
                {"dependent_task_id": task_ids[dependent], "prerequisite_task_id": task_ids[prerequisite]}
                for dependent, prerequisite in dependency_defs
                if task_ids[dependent] in visible_ids and task_ids[prerequisite] in visible_ids
            ]
            scene_milestones = []
            for key, item in milestone_defs.items():
                if offset < item["created"]:
                    continue
                milestone_date = day(4 if key == "release" and offset < -1 else item["date"])
                scene_milestones.append({
                    "id": milestone_ids[key], "line_id": line_ids[item["line"]], "name": item["name"],
                    "target_description": item["target"], "milestone_date": milestone_date,
                    "acceptance_task_ids": [task_ids[task_key] for task_key in item["tasks"] if task_ids[task_key] in visible_ids],
                })
            task_by_id = {item["id"]: item for item in scene_tasks}
            unfinished = {item["id"] for item in scene_tasks if item["status"] not in DONE}
            blocked = {edge["dependent_task_id"] for edge in scene_dependencies
                       if edge["dependent_task_id"] in unfinished and edge["prerequisite_task_id"] in unfinished}
            statuses = Counter(item["status"] for item in scene_tasks)
            scene = {"tasks": scene_tasks, "lines": scene_lines,
                     "dependencies": scene_dependencies, "milestones": scene_milestones}
            db.execute(
                "INSERT INTO dashboard_snapshots(workspace_id,snapshot_date,total,done,overdue,risk,blocked,"
                "status_counts,scene,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, iso(snapshot_day), len(scene_tasks),
                 sum(item["status"] in DONE for item in scene_tasks),
                 sum(item["id"] in unfinished and item["end_date"] < iso(snapshot_day) for item in scene_tasks),
                 sum(item["status"] == "有风险" for item in scene_tasks), len(blocked),
                 json.dumps(dict(statuses), ensure_ascii=False, sort_keys=True),
                 json.dumps(scene, ensure_ascii=False, separators=(",", ":")), captured(snapshot_day)),
            )
        db.commit()
        return {"created": True, "workspace_id": workspace_id, "name": WORKSPACE_NAME,
                "members": len(users), "lines": len(line_defs), "tasks": len(task_defs),
                "active_tasks": sum(item.get("removed") is None for item in task_defs.values()),
                "milestones": len(milestone_defs), "history_days": 15}
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", default="anyline.db", type=Path)
    args = parser.parse_args()
    result = seed(args.database.resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
