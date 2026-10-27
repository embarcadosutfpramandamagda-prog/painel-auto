#!/usr/bin/env python3
"""
oil2sil.py - lê o oil/icm.oil e gera a configuração do núcleo simulado (SIL).

Faz pro simulador o papel que o goil faz pro Trampoline: tira do .oil as
tarefas, prioridades, alarmes (período/offset), eventos, autostart, quem usa o
ICM_Resource e a ISR. O tempo de CPU de cada uma vem do sim/wcet.csv.

    python3 tools/oil2sil.py            # gera sim/osek_sil_cfg.h e sim/icm_sil_cfg.c
    python3 tools/oil2sil.py --check    # só confere se os gerados estão em dia (usado no ctest)
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OIL = ROOT / "oil" / "icm.oil"
WCET = ROOT / "sim" / "wcet.csv"
OUT_H = ROOT / "sim" / "osek_sil_cfg.h"
OUT_C = ROOT / "sim" / "icm_sil_cfg.c"


def strip_comments(txt):
    txt = re.sub(r"/\*.*?\*/", "", txt, flags=re.S)
    return re.sub(r"//.*", "", txt)


def blocks(txt, kind):
    """devolve {nome: corpo} pra cada 'KIND nome { ... };' no nível da CPU"""
    out = {}
    for m in re.finditer(r"\b" + kind + r"\s+(\w+)\s*\{", txt):
        i, depth = m.end(), 1
        while depth:
            depth += {"{": 1, "}": -1}.get(txt[i], 0)
            i += 1
        out[m.group(1)] = txt[m.end():i - 1]
    return out


def attr(body, name, default=None):
    m = re.search(r"\b" + name + r"\s*=\s*([^;{]+)", body)
    return m.group(1).strip() if m else default


def parse():
    txt = strip_comments(OIL.read_text(encoding="utf-8"))
    cpu = txt[txt.index("CPU"):]
    tasks, isrs, alarms = blocks(cpu, "TASK"), blocks(cpu, "ISR"), blocks(cpu, "ALARM")
    wcet = {}
    for line in WCET.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        n, c, cs, d = [x.strip() for x in line.split(",")]
        wcet[n] = (int(c), int(cs), int(d))
    period = {}
    for body in alarms.values():
        t = re.search(r"TASK\s*=\s*(\w+)", body).group(1)
        period[t] = (int(attr(body, "CYCLETIME", "0")), int(attr(body, "ALARMTIME", "0")))
    procs = []
    for n, body in isrs.items():
        procs.append(dict(name=n, prio=int(attr(body, "PRIORITY", "1")), isr=True, ext=False,
                          auto=False, res=False, period=0, offset=0))
    for n, body in tasks.items():
        procs.append(dict(name=n, prio=int(attr(body, "PRIORITY")), isr=False,
                          ext=bool(re.search(r"\bEVENT\s*=", body)),
                          auto=attr(body, "AUTOSTART", "FALSE").startswith("TRUE"),
                          res=bool(re.search(r"\bRESOURCE\s*=\s*ICM_Resource", body)),
                          period=period.get(n, (0, 0))[0], offset=period.get(n, (0, 0))[1]))
    for p in procs:
        if p["name"] not in wcet:
            sys.exit(f"oil2sil: {p['name']} está no .oil mas não no sim/wcet.csv")
        p["cost"], p["cs"], p["deadline"] = wcet[p["name"]]
    ceiling = max(p["prio"] for p in procs if p["res"] and not p["isr"])
    events = list(blocks(cpu, "EVENT").keys())
    return procs, ceiling, events


def render(procs, ceiling, events):
    h = ["/* GERADO por tools/oil2sil.py a partir do oil/icm.oil e sim/wcet.csv - não editar à mão */",
         "#ifndef OSEK_SIL_CFG_H", "#define OSEK_SIL_CFG_H", "",
         f"#define SIL_PROC_COUNT {len(procs)}"]
    for i, p in enumerate(procs):
        h.append(f"#define {p['name']} {i}")
    for i, e in enumerate(events):
        h.append(f"#define {e} (1u << {i})")
    h.append("#define ICM_Resource 0")
    h.append("extern const unsigned SIL_DEADLINES_US[SIL_PROC_COUNT];")
    h.append("#define SIL_DEADLINE_US(p) (SIL_DEADLINES_US[p])")
    h += ["", "#endif", ""]
    c = ["/* GERADO por tools/oil2sil.py a partir do oil/icm.oil e sim/wcet.csv - não editar à mão */",
         '#include "osek_sil.h"', ""]
    for p in procs:
        c.append(f"extern void {p['name']}_function(void);")
    c += ["", f"const int SIL_RESOURCE_CEILING = {ceiling};", "",
          "const SIL_ProcCfg_t SIL_PROCS[SIL_PROC_COUNT] = {",
          "    /* nome, prioridade, isr, estendida, autostart, usa recurso, período ms, offset ms, custo us, recurso us, corpo */"]
    for p in procs:
        b = lambda v: "true" if v else "false"
        c.append(f'    {{ "{p["name"]}", {p["prio"]}, {b(p["isr"])}, {b(p["ext"])}, {b(p["auto"])}, {b(p["res"])}, '
                 f'{p["period"]}, {p["offset"]}, {p["cost"]}, {p["cs"]}, {p["name"]}_function }},')
    c += ["};", "", "const unsigned SIL_DEADLINES_US[SIL_PROC_COUNT] = {"]
    c.append("    " + ", ".join(f"{p['deadline'] * 1000}u /* {p['name']} */" for p in procs))
    c += ["};", ""]
    return "\n".join(h), "\n".join(c)


def main():
    h, c = render(*parse())
    if "--check" in sys.argv:
        ok = OUT_H.read_text(encoding="utf-8") == h and OUT_C.read_text(encoding="utf-8") == c
        print("oil2sil: configuração do SIL", "em dia com o .oil" if ok else "DESATUALIZADA (rode tools/oil2sil.py)")
        sys.exit(0 if ok else 1)
    OUT_H.write_text(h, encoding="utf-8")
    OUT_C.write_text(c, encoding="utf-8")
    print(f"oil2sil: gerou {OUT_H.relative_to(ROOT)} e {OUT_C.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
