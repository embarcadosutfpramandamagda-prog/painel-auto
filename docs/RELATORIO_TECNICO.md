# Relatório Técnico - Projeto 2
## Painel Automotivo (ICM) com Trampoline RTOS e Controle em Tempo Real

**Disciplina:** Sistemas Embarcados - UTFPR Ponta Grossa (PPGEE)
**Professor:** Dr. Max Mauro Dias Santos
**Alunas:** Amanda e Magda
**Data:** 27/10/2026

---

## 1. Objetivo

Construir o módulo de painel de instrumentos (ICM) de um veículo sobre o Trampoline RTOS (OSEK/VDX):
receber rotação e velocidade pela rede CAN, ler os sensores de combustível e temperatura, validar, escalar e filtrar
os sinais, detectar falhas e atualizar o painel de forma determinística. Junto com o firmware, provar por testes que
os períodos, prazos, timeouts e a proteção do dado compartilhado estão corretos.

## 2. Entradas do veículo

| Sinal | Origem | Faixa | Período / amostragem |
| :--- | :--- | :--- | :--- |
| Rotação do motor | CAN M1 `0x100` (ECM), bruto × 0,25 | 0-8000 rpm | 500 ms |
| Velocidade, marcha, freio | CAN M2 `0x101` (TCM), bruto × 0,05 | 0-250 km/h | 1000 ms |
| Combustível | ADC, 0,5-4,5 V | 0-100 % | 10 ms |
| Temperatura do motor | ADC (NTC), 0,2-4,8 V | 40-120 °C | 10 ms |
| Setas, pisca-alerta, cinto, freio de mão | entradas digitais | - | 10 ms |

Detalhes de cada byte em `DICIONARIO_SINAIS.md`; requisitos em `REQUISITOS_ICM.md`.

## 3. Configuração do Trampoline

O `oil/icm.oil` declara todos os objetos OSEK pedidos:

| Objeto | Nome | Configuração |
| :--- | :--- | :--- |
| OS | `config` | `STATUS = EXTENDED` |
| COUNTER | `SystemCounter` | tick de 1 ms |
| ISR | `ISR2_CAN` | categoria 2, só faz `SetEvent` |
| EVENT | `Event_CAN_RX` | esperado pela `Task_CAN_RX` |
| TASK | `Task_CAN_RX` | estendida, prioridade 10, `AUTOSTART` |
| TASK | Acquisition / Processing / Display / Diagnostics / Logging | básicas, prioridades 8 / 6 / 4 / 3 / 1 |
| ALARM | um por tarefa periódica | 10 / 20 / 50 / 100 / 1000 ms, `ACTIVATETASK` |
| RESOURCE | `ICM_Resource` | `STANDARD`, teto = 10 |

Fluxo de build: `OIL + C → goil → código gerado → compilar/linkar → executar`. Para o PC existe o `oil/icm_posix.oil`
(tick de 10 ms, interrupção CAN por sinal Unix), compilado no GitHub Actions.

## 4. Tarefas e escalonamento

- `ISR2_CAN` copia o frame para um FIFO e chama `SetEvent(Task_CAN_RX, Event_CAN_RX)`.
- `Task_CAN_RX` fica em `WaitEvent`, acorda, limpa o evento e decodifica tudo o que está no FIFO.
- As tarefas periódicas são básicas: rodam até o fim e chamam `TerminateTask`.
- Escalonamento totalmente preemptivo (`SCHEDULE = FULL`): a tarefa de maior prioridade pronta sempre executa.

Estados usados: SUSPENDED → READY → RUNNING → SUSPENDED; só a `Task_CAN_RX` passa por WAITING.

## 5. Dado compartilhado e exclusão mútua

Todas as tarefas leem ou escrevem o `ICM_Data` só entre `GetResource(ICM_Resource)` e `ReleaseResource(ICM_Resource)`
(funções `ICM_Lock`/`ICM_Unlock` em `src/icm_data.c`). Com o Priority Ceiling Protocol do OSEK, quem pega o recurso
sobe para a prioridade 10, então ninguém que usa o dado consegue preemptar no meio da seção crítica: sem condição de
corrida, sem inversão de prioridade ilimitada e sem deadlock. A `Task_Display` trabalha numa cópia (`ICM_GetDataCopy`),
o que deixa a seção crítica curta (60 µs).

## 6. Saídas do painel e tratamento de falhas

Cadeia de cada sinal: **Receive → Validate → Scale → Filter → Display**.

| Falha | Detecção | Reação |
| :--- | :--- | :--- |
| CAN M1 ausente | > 1000 ms sem frame | MIL + luz CAN, U0100, rpm = 0 (valor seguro), mensagem "FALHA CAN" |
| CAN M2 ausente | > 2000 ms sem frame | MIL, U0101, velocímetro "---" / 0 |
| Valor fora da faixa | rpm > 8500 ou velocidade > 260 | descarta, mantém o último válido, U0401 |
| Sensor de temperatura aberto/curto | < 0,1 V ou > 4,9 V | P0115, ponteiro abaixo da escala |
| Motor quente | ≥ 115 °C | luz TEMP vermelha + bipe contínuo, P0115 |
| Sensor de combustível aberto/curto | < 0,3 V ou > 4,7 V | P0460 |
| Reserva | ≤ 10 % | luz âmbar de reserva |

O painel mostra mensagens por prioridade (falha CAN primeiro, depois sensor, temperatura, combustível, cinto, etc.).

## 7. Verificação

### 7.1 Testes (GoogleTest)

| Conjunto | Arquivo | Testes | Cobre |
| :--- | :--- | ---: | :--- |
| Lógica | `tests/gtest/test_icm_logic.cpp` | 36 | RF-01..08, RS-01..05, limites, sensores, painel, RC-01 com threads |
| Tempo real | `tests/gtest/test_icm_timing.cpp` | 13 | OIL, períodos, prazos, RTA, RTR-01, preempção, estados, determinismo, sobrecarga |
| Harness C | `tests/test_icm.c` | 19 verificações | testes originais (`make test`) |

Todos passam (`ctest`: 5 de 5).

### 7.2 Simulação do firmware (SIL)

O `src/tasks.c` real roda num núcleo OSEK simulado por 30 s de um roteiro de direção com 9 falhas injetadas
(seta, CAN mudo, rpm inválido, sensores abertos, ventoinha, pisca-alerta, cinto, motor desligado). Resultado
(`docs/evidencias/RELATORIO_TEMPORIZACAO.md`):

| Verificação do slide 7 | Resultado |
| :--- | :--- |
| Functional Correctness | OK - 9 de 9 reações de falha corretas |
| Task Periods | OK - 10/20/50/100/1000 ms exatos |
| Deadline Compliance | OK - 0 prazos perdidos, 0 `E_OS_LIMIT` |
| Data Freshness | OK - idade máx. M1 450 ms, M2 950 ms |
| CAN Timeout Handling | OK - U0100 / U0101 no tempo, latência ISR → decodificado 115 µs (< 2 ms) |
| Resource Protection | OK - 0 violações de teto, no máx. 1 tarefa no recurso |
| Deterministic Dashboard Update | OK - 599 quadros a cada 50 ms, hash do trace igual em toda execução |
| Trace and Test Report | `jobs.csv`, `trace_estados.csv`, linhas do tempo SVG, este relatório |

Com o custo de CPU multiplicado por 30 (`icm_sil --overload 30`) o próprio SIL aponta os prazos perdidos, mostrando
que as verificações realmente detectam problema.

### 7.3 Demonstração

O site (`index.html`) tem o jogo e a **bancada de testes** (GARAGEM → TESTAR ICM). A bancada liga cada falha
por botão e tem as abas **Tarefas OSEK** (linha do tempo da CPU e tabela com período medido, resposta e estado),
**Sinal CAN** (o caminho Recebe → Valida → Escala → Filtra → Mostra de cada frame e a idade do dado) e
**Verificações** (as checagens ao vivo e o resultado do firmware C).

## 8. GitHub

Repositório `embarcadosutfpramandamagda-prog/painel-auto`. Fluxo: issue → branch → commits → pull request → revisão.
O GitHub Actions roda em todo push/PR: CMake + GoogleTest + SIL (guarda as evidências) e o build no Trampoline posix.
O site é publicado pelo GitHub Pages.

## 9. Limitações

- Os tempos de CPU em `sim/wcet.csv` são estimativas; na placa devem ser medidos (por exemplo com um pino e osciloscópio).
- No Trampoline posix o tick é 10 ms, então a resolução de tempo é menor do que na placa.
- O site reproduz a lógica do firmware em JavaScript para rodar no navegador; a referência é o código C.
