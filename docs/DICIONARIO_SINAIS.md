# Dicionário de Sinais do Sistema ICM
## Instrument Cluster Module - Definição de Mensagens CAN e Sensores
**Disciplina:** Sistemas Embarcados (UTFPR PPGEE)  
**Professor:** Dr. Max Mauro Dias Santos  
**Alunas:** Amanda & Magda  

---

## 1. Barramento de Comunicação CAN (ISO 11898)
* **Taxa de Transmissão:** 500 kbps (Alta Velocidade Automotiva)
* **Formato de Identificador:** CAN Padrão 11 bits (Standard Frame)
* **Byte Order:** Big-Endian (Motorola) / Little-Endian (Intel) especificado por sinal.

---

## 2. Mensagens CAN

### Mensagem M1: Dados do Motor (*Engine Speed*)
* **ID CAN:** `0x100` (256 decimal)
* **Periodicidade:** 500 ms ($\pm 10$ ms)
* **Comprimento de Dados (DLC):** 8 Bytes
* **Transmissor:** ECM (Engine Control Module)
* **Receptor:** ICM (Instrument Cluster Module)

| Byte / Bit | Nome do Sinal | Tipo | Faixa Física | Resolução | Offset | Unidade | Descrição |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `Byte 0-1` | `Engine_Speed_RPM` | `uint16` | 0 a 8.000 | 0.25 | 0 | RPM | Rotação bruta do virabrequim. |
| `Byte 2` | `Engine_Throttle_Pos`| `uint8`  | 0 a 100   | 0.5  | 0 | %   | Posição da borboleta do acelerador. |
| `Byte 3` | `Engine_State`       | `uint8`  | 0 a 3     | 1    | 0 | enum| 0: Off, 1: Cranking, 2: Running, 3: Overrev |
| `Byte 4-7` | `Reserved_ECM`     | `uint8[4]`| -        | -    | - | -   | Reservado para expansão futura. |

---

### Mensagem M2: Dinâmica Veicular (*Vehicle Speed & Transmission*)
* **ID CAN:** `0x101` (257 decimal)
* **Periodicidade:** 1.000 ms ($\pm 10$ ms)
* **Comprimento de Dados (DLC):** 8 Bytes
* **Transmissor:** TCM / ABS (Transmission & Brake Control)
* **Receptor:** ICM (Instrument Cluster Module)

| Byte / Bit | Nome do Sinal | Tipo | Faixa Física | Resolução | Offset | Unidade | Descrição |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `Byte 0-1` | `Vehicle_Speed_Kmh`| `uint16` | 0 a 250   | 0.05 | 0 | km/h| Velocidade média das rodas tracionadas. |
| `Byte 2` | `Gear_Current`       | `int8`   | -1 a 6    | 1    | 0 | enum| -1: R (Ré), 0: N, 1 a 6: Marchas |
| `Byte 3` | `Brake_Pedal_Status` | `uint8`  | 0 a 1     | 1    | 0 | bool| 0: Desacionado, 1: Freio Ativo |
| `Byte 4` | `Handbrake_Status`   | `uint8`  | 0 a 1     | 1    | 0 | bool| 0: Solto, 1: Puxado (Ativo) |
| `Byte 5-7` | `Reserved_TCM`     | `uint8[3]`| -        | -    | - | -   | Reservado. |

---

## 3. Sinais de Sensores Periféricos (Entradas Analógicas / Digitais)

Amostrados localmente pela ECU a cada **10 ms** através da tarefa `Task_Acquisition`.

| Sinal | Canal / Tipo | Faixa Tensão | Faixa Física | Unidade | Critério de Falha |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Sensor_Fuel_Level` | Analógico (ADC 12 bits) | 0.5V a 4.5V | 0.0 a 100.0 | % | Tensão < 0.3V (curto gnd) ou > 4.7V (circuito aberto) |
| `Sensor_Coolant_Temp` | Analógico (NTC) | 0.2V a 4.8V | 40.0 a 120.0 | °C | Tensão < 0.1V ou > 4.9V |
| `Switch_Turn_Left` | Digital (GPIO In) | 0V / 12V | 0 ou 1 | bool | - |
| `Switch_Turn_Right`| Digital (GPIO In) | 0V / 12V | 0 ou 1 | bool | - |
| `Switch_Hazard` | Digital (GPIO In) | 0V / 12V | 0 ou 1 | bool | - |
| `Switch_Headlights`| Digital (GPIO In) | 0V / 12V | 0 ou 1 | bool | - |
| `Switch_Seatbelt` | Digital (GPIO In) | 0V / 12V | 0 ou 1 | bool | 0: Afivelado, 1: Desafivelado |

---

## 4. Códigos de Diagnóstico de Falha (DTCs - Diagnostic Trouble Codes)

| DTC | Definição da Falha | Condição de Ativação | Ação no Painel |
| :--- | :--- | :--- | :--- |
| **`U0100`** | Perda de Comunicação com ECM | Timeout de CAN M1 > 1.000 ms | Luz MIL acesa, aviso "CAN TIMEOUT M1", RPM = 0 |
| **`U0101`** | Perda de Comunicação com TCM | Timeout de CAN M2 > 2.000 ms | Luz MIL acesa, aviso "CAN TIMEOUT M2", Vel = 0 |
| **`P0115`** | Falha no Circuito de Arrefecimento | Sensor de Temp fora de faixa ou $\ge 115^\circ\text{C}$ | Luz Vermelha de Temperatura + Alarme Sonoro |
| **`P0460`** | Falha no Sensor de Nível de Tanque | Sensor de Combustível desconectado | Luz de Abastecimento piscando |
| **`U0401`** | Dado Inválido Recebido do ECM/TCM | RPM > 8.500 ou Velocidade > 260 km/h no frame CAN (RS-05) | Valor descartado, mantém o último válido, Luz MIL acesa |
