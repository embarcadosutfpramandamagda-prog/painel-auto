#!/usr/bin/env python3
"""Copia o resultado do firmware C (SIL + GoogleTest) para web/js/evidencias.js,
para a bancada do site mostrar na aba VERIFICAÇÕES.
Uso: python3 tools/evid2web.py [pasta_build]"""
import json, os, sys, glob, datetime
import re, subprocess

raiz = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
build = sys.argv[1] if len(sys.argv) > 1 else os.path.join(raiz, 'build')
res = json.load(open(os.path.join(raiz, 'docs', 'evidencias', 'sil_resumo.json'), encoding='utf-8'))

testes = []
# roda os executáveis de teste já compilados e conta o resultado
for exe, nome in (('test_icm_gtest', 'GoogleTest - lógica (RS/RF/RC)'),
                  ('test_timing_gtest', 'GoogleTest - tempo real (RTR)'),
                  ('test_icm', 'Harness C (make test)')):
    caminho = os.path.join(build, exe)
    if not os.path.exists(caminho):
        continue
    saida = subprocess.run([caminho], capture_output=True, text=True).stdout
    m = re.search(r'\[==========\] (\d+) tests? ran', saida)
    falhou = re.search(r'\[  FAILED  \] (\d+) tests?', saida)
    if m:
        testes.append({'suite': nome, 'total': int(m.group(1)), 'falhas': int(falhou.group(1)) if falhou else 0})
    else:
        m = re.search(r'(\d+) PASSOU, (\d+) FALHOU', saida)
        if m:
            testes.append({'suite': nome, 'total': int(m.group(1)) + int(m.group(2)), 'falhas': int(m.group(2))})
res['gtest'] = testes
res['gerado_em'] = datetime.date.today().isoformat()

out = os.path.join(raiz, 'web', 'js', 'evidencias.js')
with open(out, 'w', encoding='utf-8') as fp:
    fp.write('// gerado por tools/evid2web.py a partir de docs/evidencias/sil_resumo.json e dos testes compilados\n')
    fp.write('window.SIL_RESUMO = ' + json.dumps(res, ensure_ascii=False, indent=1) + ';\n')
print('escrito', out, '| gtest:', testes)
