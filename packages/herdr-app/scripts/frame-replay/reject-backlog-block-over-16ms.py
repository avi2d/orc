import argparse
import json
import statistics
import subprocess
import time
from pathlib import Path

import quickjs


def example_inputs():
    tasks = [
        dict(id=f"sample-{i}", title=f"Task {i}", project="demo", kind="task",
             body="Description. " * 220, created="2026-01-01", status="new",
             priority=None, parent=None, dependsOn=[], parked=None, prState=None,
             hold=dict(reason="Waiting", questions=[], answer=None) if i < 46 else None)
        for i in range(253)
    ]
    tasks[1]["dependsOn"] = [tasks[-1]["id"]]
    backlog = dict(schema="orc.backlog.v1", tasks=tasks)
    first = json.dumps(backlog)
    tasks[0]["title"] = "Changed title"
    return (first, json.dumps(backlog),
            json.dumps(dict(schema="orc.runs.v1", runs=[], machines=[])),
            json.dumps(dict(schema="orc.attention.v1", items=[], decided=[])))


def replay(checkout, captures):
    first, second, runs, attention = example_inputs() if captures is None else (
        (captures / filename).read_text() for filename in
        ("backlog.json", "backlog2.json", "runs.json", "attention.json"))
    if first == second:
        raise ValueError("The two backlog replies must differ")
    ctx = quickjs.Context()
    ctx.set_max_stack_size(8 * 1024 * 1024)
    ctx.eval(Path(__file__).with_name("host.js").read_text())
    bundle = subprocess.check_output([
        "bun", "build", str(checkout / "packages/herdr-app/mods/orc-agents/main.ts"),
        "--format=cjs", "--target=browser", "--external=gpui-kit",
        "--external=gpui-base", "--external=herdr"], text=True)
    ctx.eval(bundle)
    for command, data in [("attention --json", attention), ("runs --json --local", runs)]:
        ctx.set("reply", data)
        ctx.eval(f"replies.set({json.dumps(command)}, reply)")
    ctx.eval("const mod = new module.exports.default()")
    blocks = {}
    for trial in range(21):
        data = second if trial % 2 else first
        ctx.set("reply", data)
        ctx.eval("replies.set('backlog --json', reply); mod.refresh(context)")
        while ctx.eval("pending.length"):
            name = ctx.eval("pending[0].name")
            start = time.perf_counter_ns()
            ctx.eval("pending.shift().deliver()")
            while ctx.execute_pending_job():
                pass
            ms = (time.perf_counter_ns() - start) / 1_000_000
            if trial and name in ("backlog --json", "yield"):
                blocks.setdefault(name, []).append(ms)
        ctx.eval("if (failure) throw failure; if (mod.list.kind !== 'ok') throw Error(mod.list.reason)")
        actual = ctx.eval("JSON.stringify(mod.local.details.map(t => t.title))")
        if json.loads(actual) != [task["title"] for task in json.loads(data)["tasks"]]:
            raise ValueError("The view did not receive the changed backlog")
    if len(blocks.get("backlog --json", [])) != 20:
        raise ValueError("Expected twenty changed backlog deliveries")
    for name, values in blocks.items():
        print(f"{name}: n={len(values)} median={statistics.median(values):.2f} "
              f"max={max(values):.2f} ms (16 ms budget)")
    return max(max(values) for values in blocks.values()) > 16


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Reject a changed backlog delivery that blocks the Agents JS thread for over 16 ms")
    parser.add_argument("checkout", type=Path)
    parser.add_argument("--captures", type=Path,
                        help="Use two backlog replies, local runs and attention instead of the public example")
    args = parser.parse_args()
    raise SystemExit(replay(args.checkout.resolve(), args.captures))
