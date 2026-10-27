# Painel Automotivo com Trampoline e Controle em Tempo Real

**Programa:** Mestrado em Engenharia Elétrica (PPGEE) — UTFPR Ponta Grossa  
**Disciplina:** Sistemas Embarcados (Projeto 2)  
**Professor:** Dr. Max Mauro Dias Santos, PhD  
**Dupla:** Amanda Stadler e Magda Fernandes  

---

## Descrição do Projeto

Programamos o painel de instrumentos de um veículo (velocímetro, conta-giros, nível de combustível, temperatura do motor e luzes de advertência) executando sobre o Trampoline, um sistema operacional de tempo real (RTOS) baseado no padrão automotivo internacional OSEK/VDX.

Para demonstrar o painel funcionando em tempo real com controle determinístico, desenvolvemos também um gêmeo digital interativo com simulador de direção.

---

## Como abrir

- **Online:** https://embarcadosutfpramandamagda-prog.github.io/painel-auto/
- **No computador:** baixe o projeto e abra o `index.html` no navegador. Não precisa instalar nada.

---

## O que dá para fazer no site

### 🎮 Jogar

**JOGAR** → digite seu nome → escolha o carro → escolha o modo:

| Modo | Como é |
| :--- | :--- |
| **Passeio** | Dirija livre pelo campus, sem tempo e sem pontos. Respeite a placa de 60 km/h e as lombadas. |
| **Trânsito** | 60 segundos desviando de cones e carros. Você tem 3 vidas. |
| **Corrida** | Complete a pista no menor tempo. O mapinha no canto mostra onde você está. |

**Controles:** ↑ acelera · ↓ freia · ← → trocam de faixa · Esc pausa. O combustível vai acabando: pegue os galões vermelhos na pista.

#### Teclas para testar o painel enquanto dirige:

| Tecla | O que acontece |
| :---: | :--- |
| **C** | Corta a rede CAN: o painel mostra a falha e os ponteiros vão a zero |
| **T** | Solta o sensor de temperatura |
| **F** | Solta o sensor de combustível |
| **H** | Motor esquenta: luz vermelha e bipe |
| **O** | Manda uma rotação impossível: o painel ignora |
| **B** | Cinto solto |
| **M** | Motor desligado: acendem óleo e bateria |
| **P** | Pisca-alerta |
| **R** | Mostra as tarefas do Trampoline rodando ao vivo |

---

### 🔧 Garagem

- Arraste o carro para girar 360°.
- **TESTAR ICM** abre a bancada de testes: o painel sozinho, onde cada falha tem um botão. Ela tem quatro abas:
  - **Controles:** velocidade, rotação, combustível, temperatura e os botões de falha (também dá para dirigir com as setas do teclado);
  - **Tarefas OSEK:** as tarefas do Trampoline rodando, com o tempo de cada uma;
  - **Sinal CAN:** o caminho da mensagem até o ponteiro (recebe → confere → converte → filtra → mostra);
  - **Verificações:** os testes pedidos no projeto, todos ao vivo.
- **PAINEL** mostra o interior do carro.

---

### 🏆 Classificação

Os melhores tempos e pontos do Trânsito e da Corrida, com troféus de ouro, prata e bronze.

---

### Botões do topo

- 💻 troca entre o visual pixel e o de foto real.
- 🌎 troca entre português e inglês.

---

## Como funciona por dentro (resumo)

- **O painel** foi escrito em C e dividido em tarefas: ler sensores (10 ms), filtrar (20 ms), desenhar (50 ms), procurar falhas (100 ms), contar quilômetros (1 s) e receber as mensagens CAN.
- **O Trampoline** decide qual tarefa roda e quando. A configuração está em `oil/icm.oil`.
- **A rede CAN e os sensores** são imitados: as mensagens têm o mesmo formato e os mesmos tempos de um carro.
- **Falhas:** se o CAN parar, chegar valor absurdo ou um sensor soltar, o painel avisa e usa um valor seguro.
- **Testes:** 49 testes automáticos (Google Test), mais a simulação, todos passando. A cada envio, o GitHub compila e roda o painel no Trampoline (aba Actions).
- **O site** usa HTML, CSS e JavaScript e segue a mesma lógica do painel em C.

---

## Onde está cada coisa

| Pasta | O que tem |
| :--- | :--- |
| `index.html` e `web/` | o site e o jogo |
| `src/` e `include/` | o código do painel em C |
| `oil/` | a configuração do Trampoline |
| `tests/` | os testes automáticos |
| `docs/` | requisitos, arquitetura, relatório técnico e resultados dos testes |

---

## Como rodar os testes no computador

Para rodar os testes no computador:
```bash
make test
```

Ou, com CMake:
```bash
cmake -B build && cmake --build build && ctest --test-dir build
```

---

## Autoras

- Amanda Stadler
- Magda Fernandes
