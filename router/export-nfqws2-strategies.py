"""Export shipped public strategies in the panel import format."""
from pathlib import Path
import json
import sys

root = Path(__file__).resolve().parent
flowseal = json.loads((root / "nfqws2-flowseal.json").read_text(encoding="utf-8"))
lists = [{"id": "flowseal", "name": "Flowseal · адаптации для nfqws2", "enabled": True,
          "entries": [{"id": entry.get("id", f"flowseal-{index}"), "name": entry["name"], "args": entry["args"]}
                      for index, entry in enumerate(flowseal["entries"])]}]
for name in ["zapret-manager", "martinbacker", "own"]:
    lists.append(json.loads((root / f"nfqws2-{name}.json").read_text(encoding="utf-8")))
Path(sys.argv[1] if len(sys.argv) > 1 else "nfqws2-strategies.json").write_text(
    json.dumps({"lists": lists}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
