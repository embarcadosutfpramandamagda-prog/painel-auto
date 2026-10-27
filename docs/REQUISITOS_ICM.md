# Especificação de Requisitos do Sistema - Módulo ICM
## Instrument Cluster Module (ICM) com Trampoline RTOS
**Disciplina:** Sistemas Embarcados (UTFPR PPGEE)  
**Professor:** Dr. Max Mauro Dias Santos  
**Alunas:** Amanda & Magda  
**Data:** Outubro de 2026  

---

## 1. Visão Geral do Sistema
O **Instrument Cluster Module (ICM)** é a Unidade de Controle Eletrônico (ECU) responsável por receber dados do trem de força (via barramento CAN) e sensores periféricos da carroceria, processar e filtrar esses dados em tempo real sob o sistema operacional **Trampoline RTOS (OSEK/VDX & AUTOSAR OS 4.2)**, e apresentá-los no painel de instrumentos automotivo de forma segura e determinística.

---

## 2. Requisitos Funcionais (RF)

| ID | Nome do Requisito | Descrição |
| :--- | :--- | :--- |
| **RF-01** | Indicação de Rotação do Motor | O sistema deve receber a rotação do motor (0 a 8.000 RPM) via mensagem CAN M1 a cada 500 ms e exibir no tacômetro. |
| **RF-02** | Indicação de Velocidade Veicular | O sistema deve receber a velocidade (0 a 250 km/h) via mensagem CAN M2 a cada 1.000 ms e exibir no velocímetro. |
| **RF-03** | Monitoramento de Nível de Combustível | O sistema deve amostrar o sensor analógico de combustível (0 a 100%) a cada 10 ms e atualizar o mostrador. |
| **RF-04** | Monitoramento de Temperatura do Motor | O sistema deve amostrar o sensor de temperatura do líquido de arrefecimento (40°C a 120°C) a cada 10 ms. |
| **RF-05** | Sinalização de Direção (Setas) | O sistema deve ler os comandos de seta (Esquerda, Direita e Alerta) e acionar os piscas com frequência de 1,5 Hz (Duty Cycle de 50%). |
| **RF-06** | Indicação de Marcha | O sistema deve indicar a marcha selecionada (P, R, N, 1, 2, 3, 4, 5, 6) e alertar caso haja rotação incompatível. |
| **RF-07** | Odômetro e Computador de Bordo | O sistema deve calcular odômetro total, odômetro parcial (Trip A) e consumo instantâneo a cada 1.000 ms. |
| **RF-08** | Luzes-Espia de Advertência | O sistema deve controlar o acendimento das luzes de advertência (*Check Engine*, Cinto, Freio de Mão, Bateria, Óleo). |

---

## 3. Requisitos Temporais e de Tempo Real (RTR)

| ID | Requisito Temporal | Período / Disparo | Deadline | Prioridade | Implementação OSEK |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **RTR-01** | Recepção de Frames CAN | Orientado a Evento (Interrupção) | < 2 ms | Máxima | `ISR2_CAN` dispara `SetEvent(Task_CAN_RX, Event_CAN_RX)` |
| **RTR-02** | Aquisição de Sensores | Periódico: **10 ms** | 10 ms | Alta | `Task_Acquisition` acionada por alarme `Alarm_Acquisition` |
| **RTR-03** | Processamento e Filtragem | Periódico: **20 ms** | 20 ms | Média-Alta | `Task_Processing` acionada por alarme `Alarm_Processing` |
| **RTR-04** | Atualização do Display (20 FPS) | Periódico: **50 ms** | 50 ms | Média | `Task_Display` acionada por alarme `Alarm_Display` |
| **RTR-05** | Diagnóstico e Detecção de Falhas | Periódico: **100 ms** | 100 ms | Média-Baixa | `Task_Diagnostics` acionada por alarme `Alarm_Diagnostics` |
| **RTR-06** | Registro de Log e Odômetro | Periódico: **1.000 ms** | 1000 ms | Baixa | `Task_Logging` acionada por alarme `Alarm_Logging` |

---

## 4. Requisitos de Segurança e Tratamento de Falhas (RS)

| ID | Falha Monitorada | Critério de Detecção | Ação de Segurança (Fail-Safe) |
| :--- | :--- | :--- | :--- |
| **RS-01** | *Timeout* de CAN M1 (RPM) | Ausência de recepção por mais de **1.000 ms** (> 2 períodos) | Acende luz de falha CAN (`MIL`), registra código de diagnóstico (DTC U0100) e fixa tacômetro em 0 RPM. |
| **RS-02** | *Timeout* de CAN M2 (Velocidade) | Ausência de recepção por mais de **2.000 ms** (> 2 períodos) | Acende luz de falha CAN (`MIL`), registra DTC U0101 e fixa velocímetro em 0 km/h. |
| **RS-03** | Superaquecimento do Motor | Temperatura de arrefecimento $\ge 115^\circ\text{C}$ | Acende luz vermelha de advertência de temperatura e emite sinal sonoro contínuo. |
| **RS-04** | Nível Crítico de Combustível | Nível de combustível $\le 10\%$ | Acende luz âmbar de reserva de combustível no painel. |
| **RS-05** | Sinal Fora de Faixa (*Out-of-Range*) | Velocidade > 260 km/h ou RPM > 8.500 | Descarta valor discrepante, mantém o último valor válido e sinaliza falha no diagnóstico. |

---

## 5. Requisitos de Sincronização e Concorrência (RC)

* **RC-01:** O acesso à estrutura compartilhada `ICM_Data` deve ser estritamente atômico e protegido via `GetResource(ICM_Resource)` e `ReleaseResource(ICM_Resource)`.
* **RC-02:** A gestão do recurso deve utilizar o **Priority Ceiling Protocol (PCP)** nativo do OSEK/VDX para mitigar completamente o risco de inversão de prioridade ilimitada e condições de corrida (*race conditions*).

---

## 6. Matriz de Rastreabilidade do Projeto

Cada linha liga o requisito ao objeto do `oil/icm.oil`, à tarefa/ISR em `src/tasks.c`, ao recurso, à saída no painel
e ao teste que prova o requisito. Os testes `GoogleTest` estão em `tests/gtest/` (lógica: `test_icm_logic.cpp`,
tempo real: `test_icm_timing.cpp`); as verificações do SIL estão em `docs/evidencias/RELATORIO_TEMPORIZACAO.md`.

| Requisito | Objeto OIL | Tarefa / ISR | Recurso | Saída no painel | Teste / evidência |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **RF-01** | `ISR2_CAN`, `Event_CAN_RX` | `Task_CAN_RX` | `ICM_Resource` | Conta-giros 0-8000 rpm | `IcmTest.RF01_M1DecodesRpmWithQuarterResolution`, `IcmTest.Boundary_RpmZeroAndFullScale` |
| **RF-02** | `ISR2_CAN`, `Event_CAN_RX` | `Task_CAN_RX` | `ICM_Resource` | Velocímetro 0-250 km/h, marcha, freio de mão | `IcmTest.RF02_M2DecodesSpeedGearAndHandbrake`, `IcmTest.RF02_ReverseGearIsSignedByte`, `IcmTest.Boundary_SpeedZeroAndFullScale` |
| **RF-03** | `Alarm_Acquisition` | `Task_Acquisition` | `ICM_Resource` | Ponteiro de combustível | `IcmTest.RF03_FuelVoltsScaleLinearly`, `IcmTest.RF03_FuelSensorElectricalBoundaries` |
| **RF-04** | `Alarm_Acquisition` | `Task_Acquisition` | `ICM_Resource` | Ponteiro de temperatura | `IcmTest.RF04_TempVoltsScaleLinearly`, `IcmTest.RF04_TempSensorElectricalBoundaries`, `IcmTest.SensorFaultKeepsLastGoodValueAndRaisesP0115` |
| **RF-05** | `Alarm_Acquisition` | `Task_Acquisition` → `Task_Display` | `ICM_Resource` | Setas e pisca-alerta a 1,5 Hz / 50 % | `TurnSignal.RF05_OneAndHalfHertzFiftyPercent`, `DisplayTest.HazardBlinksBothArrowsTogether` |
| **RF-06** | `Alarm_Display` | `Task_Display` | `ICM_Resource` | Marcha + aviso "GIRO ALTO" | `IcmTest.RF02_M2DecodesSpeedGearAndHandbrake`; bancada do site |
| **RF-07** | `Alarm_Logging` | `Task_Logging` | `ICM_Resource` | Odômetro, Trip A, consumo km/L | `IcmTest.RF07_OdometerIntegratesSpeed` |
| **RF-08** | `Alarm_Diagnostics` | `Task_Diagnostics` | `ICM_Resource` | MIL, cinto, freio de mão, óleo, bateria | `IcmTest.RF08_HandbrakeSeatbeltOilBattery`, `IcmTest.RF08_NoOilLampWhenM1Lost`, `DisplayTest.BulbCheckLightsEverythingFirst1500ms` |
| **RTR-01** | `ISR2_CAN` (cat. 2), `Event_CAN_RX` | `ISR2_CAN` → `SetEvent` → `Task_CAN_RX` | - | Frame decodificado | `Timing.RTR01_CanFrameDecodedWithin2ms` (SIL: 115 µs) |
| **RTR-02..06** | `Alarm_Acquisition/Processing/Display/Diagnostics/Logging` | tarefas básicas 10/20/50/100/1000 ms | `ICM_Resource` | - | `OilConfig.PrioritiesAndPeriodsMatchOil`, `Timing.TaskPeriodsAreExact`, `Timing.NoDeadlineMissAndMeasuredWithinAnalyticBound` |
| **RTR-03** | `Alarm_Processing` | `Task_Processing` | `ICM_Resource` | Sinais filtrados e escalados | `DisplayTest.NeedleMovesWithLimitedStep` |
| **RTR-04** | `Alarm_Display` | `Task_Display` | `ICM_Resource` | Painel a 20 quadros/s | `Dashboard.UpdatesEvery50msAndIsDeterministic`, `Dashboard.DataFreshness`, `DisplayTest.FreshnessAgeOfLastFrames` |
| **RS-01** | `Alarm_Diagnostics` | `Task_Diagnostics` | `ICM_Resource` | MIL + luz CAN + U0100, rpm = 0 | `IcmTest.RS01_NoTimeoutAtExactly1000ms`, `IcmTest.RS01_TimeoutAfter1000msSetsU0100MilAndSafeRpm`, `IcmTest.RS01_NeverReceivedIsNotTimeout`, `IcmTest.RS01_RecoversWhenFramesComeBack` |
| **RS-02** | `Alarm_Diagnostics` | `Task_Diagnostics` | `ICM_Resource` | MIL + U0101, velocidade "---" / 0 | `IcmTest.RS02_M2TimeoutBoundaryAt2000ms`, `DisplayTest.M2TimeoutShowsDashesAndCanLamp` |
| **RS-03** | `Alarm_Diagnostics` | `Task_Diagnostics` | `ICM_Resource` | Luz TEMP + bipe contínuo | `IcmTest.RS03_CoolantJustBelowAndAt115` |
| **RS-04** | `Alarm_Diagnostics` | `Task_Diagnostics` | `ICM_Resource` | Luz de reserva | `IcmTest.RS04_FuelReserveBoundary`, `IcmTest.RS04_NoReserveLampWhenFuelSensorFailed` |
| **RS-05** | `ISR2_CAN`, `Event_CAN_RX` | `Task_CAN_RX` (valida) + `Task_Diagnostics` | `ICM_Resource` | MIL + U0401, mantém o último valor | `IcmTest.RS05_Rpm8500IsAcceptedAndClampedTo8000`, `IcmTest.RS05_RpmAbove8500IsDiscardedKeepsLastValid`, `IcmTest.RS05_SpeedAbove260IsDiscarded`, `IcmTest.RS05_ValidFrameClearsOutOfRange` |
| **RC-01** | `RESOURCE ICM_Resource` | todas as tarefas | `ICM_Resource` | Painel sem dado misturado | `ResourceTest.RC01_ConcurrentWritersAndReadersSeeConsistentData`, `ResourceTest.RC01_LockUnlockIsReentrantSafe` |
| **RC-02** | `RESOURCE ICM_Resource` (teto 10) | todas as tarefas | `ICM_Resource` | - | `Scheduler.PreemptionByPriorityWithResourceRespected`, `Scheduler.NominalLoadHasNoResourceErrors` |
| Estados OSEK | `TASK ... SCHEDULE = FULL` | todas | - | - | `Scheduler.TaskStateSequenceSuspendedReadyRunning`, `Scheduler.OnlyExtendedTaskEverWaits`, `Scheduler.JobsReleasedTogetherRunInPriorityOrder` |
| Falhas no tempo | - | firmware inteiro | - | DTCs do roteiro de 30 s | `FaultHandling.DemoScenarioEveryFaultDetectedInTime`, `Overload.DeadlineMissesAreDetected` |
