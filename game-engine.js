/**
 * =====================================================================
 * UTFPR TOP GEAR — Motor de Jogo Pseudo-3D em PIXEL ART + Painel ICM
 * Modos: PASSEIO | TRÂNSITO | CORRIDA
 *
 * - O jogo é desenhado em baixa resolução e ampliado sem suavização
 *   (image-rendering: pixelated) → estética pixel igual ao resto do site.
 * - Embaixo da pista fica o Instrument Cluster Module (ICM) do carro
 *   escolhido: velocímetro, conta-giros, combustível, temperatura, setas,
 *   luzes de aviso, marcha, odômetro, trip e display de mensagens.
 * - O painel NÃO lê a física do jogo diretamente: os valores passam pelo
 *   mesmo caminho do projeto em C (src/tasks.c, src/icm_data.c, oil/icm.oil):
 *     ECU → frames CAN M1 (500 ms) / M2 (1000 ms) → ISR2_CAN → Task_CAN_RX
 *     → Task_Acquisition (10 ms) → Task_Processing (20 ms, filtros)
 *     → Task_Display (50 ms) → Task_Diagnostics (100 ms, timeouts/DTCs)
 *     → Task_Logging (1000 ms, odômetro/telemetria)
 *   Tudo dirigido por um relógio simulado de 1 ms (determinístico).
 * =====================================================================
 */
(function () {
  'use strict';

  /* ===================================================================
     CONSTANTES DE PISTA E FÍSICA
     =================================================================== */
  const LANE_COUNT = 3;
  const SEGMENT_LENGTH = 200;
  const ROAD_WIDTH = 1000;
  const CAMERA_HEIGHT = 800;
  const CAMERA_DEPTH = 0.84;
  const DRAW_DISTANCE = 90;
  const TOTAL_SEGMENTS = 600;

  const MAX_SPEED = 320;          // unidades de mundo / s
  const ACCEL = 160;
  const BRAKE = 240;
  const DECEL = 70;
  const LANE_SWITCH_SPEED = 9;
  const PASSEIO_SPEED_LIMIT = 100; // ≈ 58 km/h (placa de 60)
  const KMH_PER_UNIT = 185 / MAX_SPEED; // 320 → 185 km/h; com boost ×1.35 → 250 km/h

  // Câmbio automático de 5 marchas (rpm = 900 + km/h × relação)
  const GEAR_RATIO = [0, 124, 70, 46.7, 33, 25.2];

  /* ===================================================================
     CONSTANTES DO ICM (iguais a include/can_types.h e include/icm_data.h)
     =================================================================== */
  const CAN_ID_M1_ENGINE = 0x100;
  const CAN_ID_M2_VEHICLE = 0x101;
  const CAN_M1_PERIOD_MS = 500;
  const CAN_M2_PERIOD_MS = 1000;
  const CAN_M1_TIMEOUT_MS = 1000;
  const CAN_M2_TIMEOUT_MS = 2000;
  const COOLANT_HOT_C = 115;
  const FUEL_RESERVE_PCT = 10;

  const FLAG_MIL_CHECK_ENG = 1 << 0;
  const FLAG_CAN_M1_TIMEOUT = 1 << 1;
  const FLAG_CAN_M2_TIMEOUT = 1 << 2;
  const FLAG_COOLANT_HOT = 1 << 3;
  const FLAG_LOW_FUEL = 1 << 4;
  const FLAG_HANDBRAKE_ON = 1 << 7;
  const FLAG_FUEL_SENSOR = 1 << 9;   // P0460
  const FLAG_TEMP_SENSOR = 1 << 10;  // P0115 (fora de faixa)

  // Tarefas na mesma ordem/prioridade do oil/icm.oil
  const TASK_DEFS = [
    { id: 'ISR2_CAN',          short: 'ISR2 CAN', prio: 20, period: 0,    color: '#ff6b6b' },
    { id: 'Task_CAN_RX',       short: 'CAN RX',   prio: 10, period: 0,    color: '#ffa94d' },
    { id: 'Task_Acquisition',  short: 'ACQ',      prio: 8,  period: 10,   color: '#ffd43b' },
    { id: 'Task_Processing',   short: 'PROC',     prio: 6,  period: 20,   color: '#69db7c' },
    { id: 'Task_Display',      short: 'DISP',     prio: 4,  period: 50,   color: '#4dabf7' },
    { id: 'Task_Diagnostics',  short: 'DIAG',     prio: 3,  period: 100,  color: '#b197fc' },
    { id: 'Task_Logging',      short: 'LOG',      prio: 1,  period: 1000, color: '#f783ac' }
  ];

  /* ===================================================================
     CARROS (tema do painel + sprite + dados de bordo)
     =================================================================== */
  const CARS = [
    {
      id: 'camaro', name: 'CAMARO 69', odo: 87412.0,
      theme: {
        panel: '#16171b', panelHi: '#2b2d34', panelLo: '#0c0c0f',
        trim: '#8a5a2b', trimDark: '#6a4220', trimLine: '#a86f38',
        bezel: '#c9cfd6', bezelDark: '#6f7782', face: '#0b0d11',
        tick: '#e9e9e9', label: '#e9e9e9', needle: '#ff6a1a', red: '#e3342f',
        lcdBg: '#170f04', lcdText: '#ffb627', lcdDim: '#4a3209', lcdWarn: '#ff5a3c',
        off: '#2e3037', accent: '#2bb3c0', bar: '#ffb627'
      }
    },
    {
      id: 'corvette', name: 'CORVETTE 56', odo: 12956.0,
      theme: {
        panel: '#ef6aa8', panelHi: '#f891c2', panelLo: '#c94a86',
        trim: '#ffffff', trimDark: '#f4c6dd', trimLine: '#ffe4f1',
        bezel: '#f3f5f8', bezelDark: '#a9707f', face: '#fff4fa',
        tick: '#7a1347', label: '#7a1347', needle: '#e6007e', red: '#e3342f',
        lcdBg: '#2a0718', lcdText: '#ff9ad6', lcdDim: '#5b1c3e', lcdWarn: '#ffd166',
        off: '#cf5a93', accent: '#ffffff', bar: '#ff4fb0'
      }
    }
  ];

  /* ===================================================================
     PALETAS DO MUNDO (modo pixel do site ⇄ modo foto real do site)
     =================================================================== */
  const PAL = {
    pixel: {
      sky: ['#3d9ce6', '#47a4ec', '#51abf1', '#5ab1f3'],
      grassA: '#5cb84a', grassB: '#51a943',
      walkA: '#dcd2a0', walkB: '#d0c690', edge: '#f2c418',
      roadA: '#5e636d', roadB: '#575c66', lane: '#f1f1f1',
      cloud: '#ffffff', cloudShade: '#cfe8fb'
    },
    real: {
      sky: ['#5aa3ef', '#64abf3', '#6fb4f7', '#78bafa'],
      grassA: '#7aa63b', grassB: '#709c34',
      walkA: '#cdc6b0', walkB: '#c2bba5', edge: '#f2c418',
      roadA: '#6b6f77', roadB: '#64686f', lane: '#f4f4f4',
      cloud: '#ffffff', cloudShade: '#dceaf8'
    }
  };

  // Recorte do fundo do campus (frações da imagem) — faixa de prédios até o gramado
  const BACKDROP = {
    pixel: { src: 'assets/web/inicial.jpg', sx: 0.37, sy: 0.41, sw: 0.63, sh: 0.275 },
    real:  { src: 'assets/web/inicial_real.jpg', sx: 0.37, sy: 0.37, sw: 0.63, sh: 0.30 }
  };

  /* ===================================================================
     TEXTOS (PT ⇄ EN)
     =================================================================== */
  let lang = 'pt';
  const GAME_TEXT = {
    pt: {
      mode: 'MODO', time: 'TEMPO', go: 'VAI!', pilot: 'PILOTO', pts: 'PTS',
      result: '* RESULTADO OFICIAL *', years: 'ANOS', trackTime: 'TEMPO DE PISTA', maxSpeed: 'VEL. MAX',
      saving: 'SALVANDO NO RANKING...', paused: 'PAUSADO',
      resume: 'ESC  VOLTAR A DIRIGIR', quit: 'Q    SAIR PARA O MENU',
      tests: '- TESTES DO PAINEL (ICM) -',
      kCan: 'C  FALHA NO BARRAMENTO CAN', kTemp: 'T  SENSOR TEMP. FORA DA FAIXA',
      kFan: 'H  FALHA NA VENTOINHA', kFuel: 'F  SENSOR COMBUSTIVEL', kRtos: 'R  MOSTRAR TAREFAS RTOS',
      on: 'LIGADO', off: 'DESL.', hint: 'ESC: PAUSA E TESTES',
      msgCanM1: 'FALHA CAN U0100', msgCanM2: 'FALHA CAN U0101', msgTempS: 'SENS.TEMP P0115',
      msgHot: 'MOTOR QUENTE!', msgFuelS: 'SENS.COMB P0460', msgNoFuel: 'SEM COMBUSTIVEL',
      msgReserve: 'RESERVA', msgLimit: 'LIMITE 60 KM/H', msgBoost: 'BOOST!', msgBulb: 'TESTE DE LUZES',
      msgHand: 'FREIO DE MAO', fuel: 'COMB', lives: 'VIDAS', dtc: 'DTC', none: 'NENHUM',
      rtosTitle: 'TRAMPOLINE OSEK - TAREFAS', last1s: 'ULTIMO 1000 MS', frames: 'FRAMES',
      modes: { 'PASSEIO': 'PASSEIO', 'TRÂNSITO': 'TRANSITO', 'CORRIDA': 'CORRIDA' }
    },
    en: {
      mode: 'MODE', time: 'TIME', go: 'GO!', pilot: 'DRIVER', pts: 'PTS',
      result: '* OFFICIAL RESULT *', years: 'Y/O', trackTime: 'TRACK TIME', maxSpeed: 'TOP SPEED',
      saving: 'SAVING TO RANKING...', paused: 'PAUSED',
      resume: 'ESC  KEEP DRIVING', quit: 'Q    BACK TO MENU',
      tests: '- DASHBOARD TESTS (ICM) -',
      kCan: 'C  CAN BUS FAILURE', kTemp: 'T  TEMP SENSOR OUT OF RANGE',
      kFan: 'H  COOLING FAN FAILURE', kFuel: 'F  FUEL LEVEL SENSOR', kRtos: 'R  SHOW RTOS TASKS',
      on: 'ON', off: 'OFF', hint: 'ESC: PAUSE AND TESTS',
      msgCanM1: 'CAN FAULT U0100', msgCanM2: 'CAN FAULT U0101', msgTempS: 'TEMP SENS P0115',
      msgHot: 'ENGINE HOT!', msgFuelS: 'FUEL SENS P0460', msgNoFuel: 'OUT OF FUEL',
      msgReserve: 'LOW FUEL', msgLimit: 'LIMIT 60 KM/H', msgBoost: 'BOOST!', msgBulb: 'BULB CHECK',
      msgHand: 'PARKING BRAKE', fuel: 'FUEL', lives: 'LIVES', dtc: 'DTC', none: 'NONE',
      rtosTitle: 'TRAMPOLINE OSEK - TASKS', last1s: 'LAST 1000 MS', frames: 'FRAMES',
      modes: { 'PASSEIO': 'CRUISE', 'TRÂNSITO': 'TRAFFIC', 'CORRIDA': 'RACE' }
    }
  };
  function T(key) { return (GAME_TEXT[lang] || GAME_TEXT.pt)[key]; }
  function modeLabel(m) { return (T('modes') || {})[m] || m; }
  function setLang(l) { lang = (l === 'en') ? 'en' : 'pt'; }

  /* ===================================================================
     ESTADO GERAL
     =================================================================== */
  let canvas, ctx, g;               // g = contexto de desenho atual (tela ou offscreen)
  let W = 320, H = 180, pixelScale = 2;
  let RH = 115, CH = 65, horizonY = 46; // altura da vista da pista / do painel / linha do horizonte
  let visual = 'pixel';

  let gameRunning = false;
  let gamePaused = false;
  let gameMode = 'PASSEIO';
  let playerInfo = { name: 'PILOTO', age: 21, car: 'CAMARO 69', carIndex: 0 };
  let onGameOverCallback = null;
  let car = CARS[0];

  // Jogador
  let playerLane = 1, playerX = 0, targetX = 0;
  let speed = 0, position = 0, score = 0;
  let lives = 3, combo = 1, timeElapsed = 0, gameDuration = 60;
  let speedViolationTime = 0, speedRespected = true, raceFinished = false, checkpointsPassed = 0;
  let boostTimer = 0, boostActive = false;
  let maxKmh = 0;
  let hitFlash = 0;

  let countdownActive = false, countdownValue = 3, countdownTimer = 0;
  let gameOverActive = false, gameOverTimer = 0, finalResult = null;

  let segments = [], obstacles = [], boostItems = [], sceneryObjects = [], speedBumps = [];
  let bgOffset = 0, cloudDrift = 0;

  const keys = {};
  let lastTime = 0, animFrameId = null;
  let resizeObs = null;

  // Veículo "real" (o que a ECU mede) — alimenta os frames CAN e os sensores
  const veh = {
    kmh: 0, rpm: 850, gear: 0, throttle: 0, brake: false, handbrake: true,
    fuel: 20, coolant: 62, turn: 0, turnTimer: 0
  };

  // Injeção de falhas para demonstrar o diagnóstico
  const faults = { can: false, tempSensor: false, fan: false, fuelSensor: false };
  let showRtos = false;

  /* ===================================================================
     ICM: DADO COMPARTILHADO + SIMULAÇÃO OSEK (relógio de 1 ms)
     =================================================================== */
  let icm = null;     // ICM_Data_t
  let disp = null;    // cópia publicada pela Task_Display (é o que o painel desenha)
  let simMs = 0, simAcc = 0;
  let canFifo = [];
  let taskStats = {};
  let telemetry = [];
  let resourceLocks = 0;

  function GetResource() { resourceLocks++; }      // ICM_Resource (Priority Ceiling)
  function ReleaseResource() { resourceLocks--; }

  function icmInit() {
    icm = {
      rawRpm: 0, rawSpeed: 0, rawFuel: veh.fuel, rawTemp: veh.coolant,
      engine_rpm: 0, vehicle_speed_kmh: 0, gear: 0, brake: false, handbrake: true,
      fuel_level_percent: veh.fuel, coolant_temp_celsius: veh.coolant, turn_signal: 0,
      odometer_km: car.odo, trip_a_km: 0,
      last_m1_time_ms: 0, last_m2_time_ms: 0, current_time_ms: 0,
      warning_flags: 0, active_dtc: 'NONE', dtcHistory: [],
      fuelSensorOk: true, tempSensorOk: true, engine_state: 2,
      framesM1: 0, framesM2: 0
    };
    disp = Object.assign({}, icm, { needleSpeed: 0, needleRpm: 0 });
    simMs = 0; simAcc = 0; canFifo = [];
    telemetry = [];
    taskStats = {};
    TASK_DEFS.forEach(t => { taskStats[t.id] = { count: 0, hist: [] }; });
  }

  function markActivation(id) {
    const s = taskStats[id];
    s.count++;
    s.hist.push(simMs);
    while (s.hist.length && s.hist[0] < simMs - 1000) s.hist.shift();
  }

  // ECU / TCM do "carro": colocam frames no barramento (se ele não estiver em falha)
  function busTransmit(frame) {
    if (faults.can) return;          // barramento mudo → timeouts no ICM
    canFifo.push(frame);
    ISR2_CAN();                      // interrupção do controlador CAN
  }

  function ISR2_CAN() {
    markActivation('ISR2_CAN');
    // SetEvent(Task_CAN_RX, Event_CAN_RX) → tarefa de maior prioridade roda já
    Task_CAN_RX();
  }

  function Task_CAN_RX() {
    markActivation('Task_CAN_RX');
    while (canFifo.length) {
      const f = canFifo.shift();
      GetResource();
      if (f.id === CAN_ID_M1_ENGINE) {
        const raw = (f.data[0] << 8) | f.data[1];
        icm.rawRpm = Math.min(8000, raw * 0.25);
        icm.engine_state = f.data[3];
        icm.last_m1_time_ms = f.ts;
        icm.framesM1++;
      } else if (f.id === CAN_ID_M2_VEHICLE) {
        const raw = (f.data[0] << 8) | f.data[1];
        icm.rawSpeed = Math.min(250, raw * 0.05);
        icm.gear = (f.data[2] << 24) >> 24;   // int8
        icm.brake = f.data[3] !== 0;
        icm.handbrake = f.data[4] !== 0;
        icm.last_m2_time_ms = f.ts;
        icm.framesM2++;
      }
      ReleaseResource();
    }
  }

  // 10 ms — lê sensores analógicos (tensões) e chaves das setas
  function Task_Acquisition() {
    markActivation('Task_Acquisition');
    // Nível de combustível: 0.5 V..4.5 V; falha se < 0.3 V ou > 4.7 V
    const vFuel = faults.fuelSensor ? 4.92 : 0.5 + (veh.fuel / 100) * 4.0;
    // Temperatura (NTC): 0.2 V..4.8 V ↔ 40..120 °C; falha se < 0.1 V ou > 4.9 V
    const vTemp = faults.tempSensor ? 4.97 : 0.2 + ((veh.coolant - 40) / 80) * 4.6;
    GetResource();
    icm.fuelSensorOk = vFuel >= 0.3 && vFuel <= 4.7;
    icm.tempSensorOk = vTemp >= 0.1 && vTemp <= 4.9;
    if (icm.fuelSensorOk) icm.rawFuel = Math.max(0, Math.min(100, (vFuel - 0.5) / 4.0 * 100));
    if (icm.tempSensorOk) icm.rawTemp = 40 + (vTemp - 0.2) / 4.6 * 80;
    icm.turn_signal = veh.turn;
    ReleaseResource();
  }

  // 20 ms — ICM_FilterAndScale(): filtros passa-baixas (mesmos alfas do icm_data.c)
  function Task_Processing() {
    markActivation('Task_Processing');
    GetResource();
    icm.vehicle_speed_kmh += 0.25 * (icm.rawSpeed - icm.vehicle_speed_kmh);
    icm.engine_rpm += 0.35 * (icm.rawRpm - icm.engine_rpm);
    icm.fuel_level_percent += 0.05 * (icm.rawFuel - icm.fuel_level_percent);
    icm.coolant_temp_celsius += 0.05 * (icm.rawTemp - icm.coolant_temp_celsius);
    ReleaseResource();
  }

  // 50 ms — publica a cópia que o display desenha (ICM_GetDataCopy) + inércia dos ponteiros
  function Task_Display() {
    markActivation('Task_Display');
    GetResource();
    const ns = disp ? disp.needleSpeed : 0;
    const nr = disp ? disp.needleRpm : 0;
    disp = Object.assign({}, icm);
    ReleaseResource();
    // Motor de passo do ponteiro: fundo de escala em ~0.8 s (vel.) e ~0.5 s (rpm)
    const stepS = 250 / 16, stepR = 8000 / 10;
    disp.needleSpeed = ns + Math.max(-stepS, Math.min(stepS, disp.vehicle_speed_kmh - ns));
    disp.needleRpm = nr + Math.max(-stepR, Math.min(stepR, disp.engine_rpm - nr));
  }

  // 100 ms — ICM_EvaluateDiagnostics(): timeouts CAN, faixas, superaquecimento, reserva
  function Task_Diagnostics() {
    markActivation('Task_Diagnostics');
    const now = simMs;
    GetResource();
    icm.current_time_ms = now;
    let flags = 0;
    let dtc = 'NONE';
    const active = [];

    if (icm.last_m1_time_ms > 0 && (now - icm.last_m1_time_ms) > CAN_M1_TIMEOUT_MS) {
      flags |= FLAG_CAN_M1_TIMEOUT | FLAG_MIL_CHECK_ENG;
      dtc = 'U0100'; active.push('U0100');
      icm.engine_rpm = 0; icm.rawRpm = 0;            // valor seguro
    }
    if (icm.last_m2_time_ms > 0 && (now - icm.last_m2_time_ms) > CAN_M2_TIMEOUT_MS) {
      flags |= FLAG_CAN_M2_TIMEOUT | FLAG_MIL_CHECK_ENG;
      if (dtc === 'NONE') dtc = 'U0101';
      active.push('U0101');
      icm.vehicle_speed_kmh = 0; icm.rawSpeed = 0;   // valor seguro
    }
    if (!icm.tempSensorOk) {
      flags |= FLAG_TEMP_SENSOR | FLAG_MIL_CHECK_ENG;
      if (dtc === 'NONE') dtc = 'P0115';
      active.push('P0115');
    } else if (icm.coolant_temp_celsius >= COOLANT_HOT_C) {
      flags |= FLAG_COOLANT_HOT;
      if (dtc === 'NONE') dtc = 'P0115';
      active.push('P0115');
    }
    if (!icm.fuelSensorOk) {
      flags |= FLAG_FUEL_SENSOR | FLAG_MIL_CHECK_ENG;
      if (dtc === 'NONE') dtc = 'P0460';
      active.push('P0460');
    } else if (icm.fuel_level_percent <= FUEL_RESERVE_PCT) {
      flags |= FLAG_LOW_FUEL;
    }
    if (icm.handbrake) flags |= FLAG_HANDBRAKE_ON;

    icm.warning_flags = flags;
    icm.active_dtc = dtc;
    active.forEach(code => { if (icm.dtcHistory.indexOf(code) < 0) icm.dtcHistory.push(code); });
    ReleaseResource();
  }

  // 1000 ms — ICM_UpdateLogging(): odômetro, trip e telemetria
  function Task_Logging() {
    markActivation('Task_Logging');
    GetResource();
    const distKm = (icm.vehicle_speed_kmh / 3600) * 1.0;
    icm.odometer_km += distKm;
    icm.trip_a_km += distKm;
    telemetry.push({
      t: simMs, speed: +icm.vehicle_speed_kmh.toFixed(1), rpm: Math.round(icm.engine_rpm),
      fuel: +icm.fuel_level_percent.toFixed(1), temp: +icm.coolant_temp_celsius.toFixed(1),
      flags: icm.warning_flags, dtc: icm.active_dtc
    });
    if (telemetry.length > 300) telemetry.shift();
    ReleaseResource();
  }

  // Um tick de 1 ms do SystemCounter: alarmes disparam na ordem de prioridade
  function osTick() {
    simMs++;
    // Mensagens periódicas no barramento (ECM e TCM)
    if (simMs % CAN_M1_PERIOD_MS === 0) {
      const raw = Math.round(Math.min(8000, veh.rpm) / 0.25);
      busTransmit({ id: CAN_ID_M1_ENGINE, ts: simMs,
        data: [(raw >> 8) & 255, raw & 255, Math.round(veh.throttle * 200) & 255, veh.rpm > 7000 ? 3 : 2, 0, 0, 0, 0] });
    }
    if (simMs % CAN_M2_PERIOD_MS === 0) {
      const raw = Math.round(Math.min(250, veh.kmh) / 0.05);
      busTransmit({ id: CAN_ID_M2_VEHICLE, ts: simMs,
        data: [(raw >> 8) & 255, raw & 255, veh.gear & 255, veh.brake ? 1 : 0, veh.handbrake ? 1 : 0, 0, 0, 0] });
    }
    // Alarmes periódicos (prioridade 8 → 1)
    if (simMs % 10 === 0) Task_Acquisition();
    if (simMs % 20 === 0) Task_Processing();
    if (simMs % 50 === 0) Task_Display();
    if (simMs % 100 === 0) Task_Diagnostics();
    if (simMs % 1000 === 0) Task_Logging();
  }

  /* ===================================================================
     PRNG DETERMINÍSTICO
     =================================================================== */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ===================================================================
     CIRCUITO DA UTFPR
     =================================================================== */
  function buildCircuit() {
    segments = [];
    for (let i = 0; i < TOTAL_SEGMENTS; i++) {
      let curve = 0;
      if (i >= 40 && i < 80) curve = 1.2;
      if (i >= 120 && i < 170) curve = -1.8;
      if (i >= 220 && i < 270) curve = 2.0;
      if (i >= 320 && i < 370) curve = -1.5;
      if (i >= 420 && i < 470) curve = 1.6;
      if (i >= 510 && i < 560) curve = -1.2;
      segments.push({ index: i, curve: curve });
    }
    buildScenery();
    obstacles = []; speedBumps = []; boostItems = [];
    if (gameMode === 'TRÂNSITO') buildTrafficObstacles();
    if (gameMode === 'PASSEIO') buildSpeedBumps();
    if (gameMode === 'CORRIDA') buildBoostItems();
  }

  function buildScenery() {
    sceneryObjects = [];
    const rng = mulberry32(1909); // 1909: fundação da UTFPR
    for (let i = 6; i < TOTAL_SEGMENTS; i += 2) {
      if (i % 60 === 10) sceneryObjects.push({ segIndex: i, type: 'totem', side: -1, offset: 1.45 });
      if (i % 14 === 0 && rng() > 0.25) {
        sceneryObjects.push({
          segIndex: i, type: 'building', side: rng() > 0.5 ? 1 : -1, offset: 1.9 + rng() * 0.5,
          width: 240 + rng() * 120, height: 180 + rng() * 160, color: rng() > 0.5 ? '#b8593a' : '#c97a48'
        });
      }
      if (rng() > 0.35) {
        sceneryObjects.push({ segIndex: i, type: 'araucaria', side: rng() > 0.5 ? 1 : -1, offset: 1.4 + rng() * 1.0, height: 200 + rng() * 100 });
      }
      if (rng() > 0.7) {
        sceneryObjects.push({ segIndex: i, type: 'ipe', side: rng() > 0.5 ? 1 : -1, offset: 1.5 + rng() * 0.8,
          color: rng() > 0.5 ? '#f6c90e' : '#ec5fa6', height: 140 + rng() * 60 });
      }
      if (i % 8 === 0) sceneryObjects.push({ segIndex: i, type: 'lamp', side: i % 16 === 0 ? 1 : -1, offset: 1.3 });
      if (i % 11 === 0 && rng() > 0.4) {
        sceneryObjects.push({ segIndex: i, type: 'student', side: rng() > 0.5 ? 1 : -1, offset: 1.32 + rng() * 0.25,
          shirt: rng() > 0.5 ? '#f2c418' : '#1f2937', hasBackpack: rng() > 0.3 });
      }
    }
  }

  function buildTrafficObstacles() {
    const rng = mulberry32(456);
    for (let i = 25; i < TOTAL_SEGMENTS - 15; i += 4) {
      const difficulty = 0.25 + (i / TOTAL_SEGMENTS) * 0.45;
      if (rng() < difficulty) {
        const types = ['cone', 'placa', 'fusca', 'barreira'];
        obstacles.push({ segIndex: i, lane: Math.floor(rng() * LANE_COUNT), type: types[Math.floor(rng() * types.length)], hit: false,
          color: ['#2f6fd6', '#e9e4d4', '#d94141', '#3aa55d'][Math.floor(rng() * 4)] });
      }
    }
  }

  function buildSpeedBumps() {
    for (let i = 35; i < TOTAL_SEGMENTS - 20; i += 28) speedBumps.push({ segIndex: i });
  }

  function buildBoostItems() {
    const rng = mulberry32(888);
    for (let i = 18; i < TOTAL_SEGMENTS - 10; i += 16) {
      if (rng() > 0.35) boostItems.push({ segIndex: i, lane: Math.floor(rng() * LANE_COUNT), collected: false });
    }
  }

  /* ===================================================================
     CONTROLES
     =================================================================== */
  function setTurn(dir) { veh.turn = dir; veh.turnTimer = 1.3; }

  function onKeyDown(e) {
    if (!gameRunning) return;
    keys[e.code] = true;

    if (e.code === 'Escape') {
      if (!gameOverActive) togglePause();
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyQ' && gamePaused) { exitToMenu(); e.preventDefault(); return; }

    // Testes do painel (funcionam dirigindo ou no pause)
    if (!e.repeat) {
      if (e.code === 'KeyC') { faults.can = !faults.can; redrawIfPaused(); }
      if (e.code === 'KeyT') { faults.tempSensor = !faults.tempSensor; redrawIfPaused(); }
      if (e.code === 'KeyH') { faults.fan = !faults.fan; redrawIfPaused(); }
      if (e.code === 'KeyF') { faults.fuelSensor = !faults.fuelSensor; redrawIfPaused(); }
      if (e.code === 'KeyR') { showRtos = !showRtos; redrawIfPaused(); }
    }

    if (!gamePaused && !countdownActive && !gameOverActive) {
      if ((e.code === 'ArrowLeft' || e.code === 'KeyA') && playerLane > 0) { playerLane--; setTurn(1); }
      if ((e.code === 'ArrowRight' || e.code === 'KeyD') && playerLane < LANE_COUNT - 1) { playerLane++; setTurn(2); }
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
  }

  function onKeyUp(e) { keys[e.code] = false; }

  function redrawIfPaused() { if (gamePaused) drawPauseScreen(); }

  function onTouchStart(e) {
    if (!gameRunning) return;
    e.preventDefault();
    if (gamePaused || countdownActive || gameOverActive) return;
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches[0];
    if (!touch) return;
    const tx = touch.clientX - rect.left, ty = touch.clientY - rect.top;
    if (tx < rect.width * 0.35 && playerLane > 0) { playerLane--; setTurn(1); }
    else if (tx > rect.width * 0.65 && playerLane < LANE_COUNT - 1) { playerLane++; setTurn(2); }
    if (ty < rect.height * 0.62) { keys['ArrowUp'] = true; keys['ArrowDown'] = false; }
    else { keys['ArrowDown'] = true; keys['ArrowUp'] = false; }
  }

  function onTouchEnd(e) { e.preventDefault(); keys['ArrowUp'] = false; keys['ArrowDown'] = false; }

  /* ===================================================================
     INICIALIZAÇÃO
     =================================================================== */
  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    g = ctx;
  }

  function setVisualMode(real) {
    const v = real ? 'real' : 'pixel';
    if (v === visual) return;
    visual = v;
    if (canvas) { prepareBackdrop(); buildStaticLayers(); }
  }

  function start(mode, pInfo, onGameOver) {
    gameMode = mode;
    const carIndex = (typeof pInfo.carIndex === 'number') ? pInfo.carIndex
      : ((pInfo.car && pInfo.car.includes('CORVETTE')) ? 1 : 0);
    car = CARS[carIndex] || CARS[0];
    playerInfo = { name: pInfo.name || 'PILOTO', age: pInfo.age || 21, car: pInfo.car || car.name, carIndex: carIndex };
    if (typeof pInfo.realMode === 'boolean') visual = pInfo.realMode ? 'real' : 'pixel';
    onGameOverCallback = onGameOver;

    playerLane = 1; playerX = 0; targetX = 0;
    speed = 0; position = 0; score = 0;
    lives = 3; combo = 1; timeElapsed = 0;
    speedViolationTime = 0; speedRespected = true; raceFinished = false; checkpointsPassed = 0;
    boostTimer = 0; boostActive = false; maxKmh = 0; hitFlash = 0;
    gameOverActive = false; gameOverTimer = 0; finalResult = null;
    gameDuration = (mode === 'CORRIDA') ? 999 : 60;
    bgOffset = 0; cloudDrift = 0;
    faults.can = faults.tempSensor = faults.fan = faults.fuelSensor = false;
    showRtos = false;

    Object.assign(veh, { kmh: 0, rpm: 850, gear: 0, throttle: 0, brake: false, handbrake: true,
      fuel: mode === 'CORRIDA' ? 38 : 19, coolant: 62, turn: 0, turnTimer: 0 });
    icmInit();

    buildCircuit();
    resizeCanvas();

    countdownActive = true; countdownValue = 3; countdownTimer = 0;
    gameRunning = true; gamePaused = false;

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', resizeCanvas);
    // A tela do tablet muda de tamanho ao trocar pixel ⇄ real: acompanha o contêiner
    if (window.ResizeObserver && !resizeObs) {
      let lastW = 0, lastH = 0;
      resizeObs = new ResizeObserver(entries => {
        const r = entries[0].contentRect;
        if (Math.abs(r.width - lastW) > 0.5 || Math.abs(r.height - lastH) > 0.5) { lastW = r.width; lastH = r.height; resizeCanvas(); }
      });
      resizeObs.observe(canvas.parentElement);
    }
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });

    lastTime = performance.now();
    animFrameId = requestAnimationFrame(gameLoop);
  }

  // Resolução interna baixa + ampliação inteira (cada "pixel" do jogo = N px da tela)
  function resizeCanvas() {
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const cssW = Math.max(1, rect.width), cssH = Math.max(1, rect.height);
    pixelScale = cssW < 520 ? 2 : Math.max(2, Math.round(cssW / 380));
    W = Math.ceil(cssW / pixelScale);
    H = Math.ceil(cssH / pixelScale);
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = (W * pixelScale) + 'px';
    canvas.style.height = (H * pixelScale) + 'px';
    ctx.imageSmoothingEnabled = false;

    CH = Math.max(30, Math.round(H * 0.37));
    RH = H - CH;
    horizonY = Math.round(RH * 0.40);
    prepareBackdrop();
    buildStaticLayers();
    if (gamePaused) drawPauseScreen();
  }

  function stop() {
    gameRunning = false;
    gamePaused = false;
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('resize', resizeCanvas);
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    if (canvas) {
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchend', onTouchEnd);
    }
    Object.keys(keys).forEach(k => keys[k] = false);
  }

  function togglePause() {
    if (!gameRunning || gameOverActive) return;
    gamePaused = !gamePaused;
    if (gamePaused) {
      Object.keys(keys).forEach(k => keys[k] = false);
      drawPauseScreen();
    } else {
      lastTime = performance.now();
      animFrameId = requestAnimationFrame(gameLoop);
    }
  }

  function exitToMenu() {
    const result = { score: 0, mode: gameMode, time: Math.floor(timeElapsed * 10) / 10, playerInfo: { ...playerInfo }, aborted: true };
    stop();
    if (onGameOverCallback) onGameOverCallback(result);
  }

  function isRunning() { return gameRunning; }

  /* ===================================================================
     LOOP
     =================================================================== */
  function gameLoop(timestamp) {
    if (!gameRunning || gamePaused) return;
    const dt = Math.min((timestamp - lastTime) / 1000, 0.05);
    lastTime = timestamp;
    update(dt);
    draw();
    animFrameId = requestAnimationFrame(gameLoop);
  }

  function update(dt) {
    // Relógio do RTOS anda sempre que o jogo não está pausado (inclusive na contagem = ignição ligada)
    updateVehicle(dt);
    simAcc += dt * 1000;
    while (simAcc >= 1) { simAcc -= 1; osTick(); }

    if (veh.turnTimer > 0) { veh.turnTimer -= dt; if (veh.turnTimer <= 0) veh.turn = 0; }
    if (hitFlash > 0) hitFlash -= dt;

    if (countdownActive) {
      countdownTimer += dt;
      if (countdownTimer >= 1.0) {
        countdownTimer -= 1.0;
        countdownValue--;
        if (countdownValue < 0) { countdownActive = false; veh.handbrake = false; }
      }
      return;
    }

    if (gameOverActive) {
      gameOverTimer += dt;
      if (gameOverTimer >= 4.5) finishGame();
      return;
    }

    timeElapsed += dt;

    const accel = keys['ArrowUp'] || keys['KeyW'];
    const brake = keys['ArrowDown'] || keys['KeyS'] || keys['Space'];
    if (accel) speed += ACCEL * dt;
    else if (brake) speed -= BRAKE * dt;
    else speed -= DECEL * dt;

    let maxSpd = MAX_SPEED;
    if (gameMode === 'PASSEIO') maxSpd = MAX_SPEED * 0.58;
    if (boostActive) maxSpd *= 1.35;
    if (veh.coolant >= COOLANT_HOT_C) maxSpd *= 0.6;   // proteção do motor
    if (veh.fuel <= 0) maxSpd *= 0.3;                    // sem combustível
    if (speed > maxSpd) speed = Math.max(maxSpd, speed - BRAKE * dt);
    speed = Math.max(0, speed);

    if (boostActive) { boostTimer -= dt; if (boostTimer <= 0) boostActive = false; }

    position += speed * dt * 3;
    const trackLen = TOTAL_SEGMENTS * SEGMENT_LENGTH;
    if (position >= trackLen) {
      if (gameMode === 'CORRIDA') { raceFinished = true; triggerGameOver(); return; }
      position -= trackLen;
    }

    targetX = (playerLane - 1) * ROAD_WIDTH * 0.33;
    playerX += (targetX - playerX) * Math.min(1, LANE_SWITCH_SPEED * dt);

    const currentSegIdx = Math.floor(position / SEGMENT_LENGTH) % TOTAL_SEGMENTS;
    bgOffset += segments[currentSegIdx].curve * speed * dt * 0.018;
    cloudDrift += dt * 2;

    if (gameMode === 'PASSEIO') {
      if (speed > PASSEIO_SPEED_LIMIT) { speedViolationTime += dt; speedRespected = false; }
      for (const bump of speedBumps) {
        if (Math.abs(currentSegIdx - bump.segIndex) < 2 && speed > 50) speed *= 0.93;
      }
      const bonus = speedRespected ? 1.5 : (speedViolationTime > 10 ? 0.7 : 1.0);
      score = Math.floor((position / 8) * bonus);
    }

    if (gameMode === 'TRÂNSITO') {
      for (const obs of obstacles) {
        if (obs.hit) continue;
        if (Math.abs(currentSegIdx - obs.segIndex) < 2 && obs.lane === playerLane) {
          obs.hit = true; lives--; combo = 1; speed *= 0.45; hitFlash = 0.35;
          if (lives <= 0) { triggerGameOver(); return; }
        }
      }
      combo = Math.min(combo + dt * 0.12, 4.0);
      score = Math.floor((position / 10) * combo);
    }

    if (gameMode === 'CORRIDA') {
      checkpointsPassed = Math.min(3, Math.floor(position / (trackLen / 3)));
      for (const item of boostItems) {
        if (item.collected) continue;
        if (Math.abs(currentSegIdx - item.segIndex) < 2 && item.lane === playerLane) {
          item.collected = true; boostActive = true; boostTimer = 3.5;
        }
      }
      score = Math.max(5000, Math.floor(22000 - timeElapsed * 110));
    }

    if (gameMode !== 'CORRIDA' && timeElapsed >= gameDuration) triggerGameOver();
  }

  // Física do trem de força: o que a ECU mede de verdade
  function updateVehicle(dt) {
    const driving = !countdownActive && !gameOverActive;
    const accel = driving && (keys['ArrowUp'] || keys['KeyW']);
    veh.throttle += ((accel ? 1 : 0) - veh.throttle) * Math.min(1, dt * 6);
    veh.brake = driving && !!(keys['ArrowDown'] || keys['KeyS'] || keys['Space']);
    veh.kmh = speed * KMH_PER_UNIT;
    if (veh.kmh > maxKmh) maxKmh = veh.kmh;

    let rpmTarget;
    if (!driving && countdownActive) {
      veh.gear = 0;                            // P/N na largada
      rpmTarget = 850 + Math.sin(performance.now() / 90) * 25;
    } else {
      if (veh.gear < 1) veh.gear = 1;
      rpmTarget = 900 + veh.kmh * GEAR_RATIO[veh.gear];
      if (rpmTarget > 6300 && veh.gear < 5) { veh.gear++; rpmTarget = 900 + veh.kmh * GEAR_RATIO[veh.gear]; }
      else if (rpmTarget < 2300 && veh.gear > 1) { veh.gear--; rpmTarget = 900 + veh.kmh * GEAR_RATIO[veh.gear]; }
      if (veh.kmh < 6) rpmTarget = Math.max(rpmTarget, 850 + veh.throttle * 2200);
      rpmTarget += veh.throttle * 250;
    }
    veh.rpm += (Math.min(8000, rpmTarget) - veh.rpm) * Math.min(1, dt * 8);

    // Consumo (%/s) proporcional à rotação e ao acelerador
    if (veh.fuel > 0) veh.fuel = Math.max(0, veh.fuel - dt * (0.03 + (veh.rpm / 8000) * (0.08 + 0.24 * veh.throttle)));

    // Arrefecimento: aquece até ~88 °C; giro alto e falha da ventoinha esquentam mais
    let tTarget = 88 + Math.max(0, veh.rpm - 6000) / 2000 * 24 + (faults.fan ? 31 : 0);
    tTarget = Math.min(119, tTarget);
    veh.coolant += (tTarget - veh.coolant) * Math.min(1, dt / (faults.fan ? 3.5 : 5));
  }

  function triggerGameOver() {
    gameOverActive = true;
    gameOverTimer = 0;
    finalResult = {
      score: score, mode: gameMode, time: Math.floor(timeElapsed * 10) / 10,
      playerInfo: { ...playerInfo }, maxKmh: Math.round(maxKmh),
      dtcs: icm ? icm.dtcHistory.slice() : []
    };
  }

  function finishGame() {
    const result = finalResult;
    stop();
    if (onGameOverCallback) onGameOverCallback(result);
  }

  /* ===================================================================
     PRIMITIVAS PIXEL (sempre em coordenadas inteiras → bordas nítidas)
     =================================================================== */
  const R = Math.round;
  function rect(x, y, w, h, c) {
    const x0 = R(x), y0 = R(y), x1 = R(x + w), y1 = R(y + h);
    if (x1 <= x0 || y1 <= y0) return;
    g.fillStyle = c;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  function rectMin(x, y, w, h, c) { // garante pelo menos 1×1
    g.fillStyle = c;
    g.fillRect(R(x), R(y), Math.max(1, R(w)), Math.max(1, R(h)));
  }
  function span(xl, xr, y, c) {
    const a = R(xl), b = R(xr);
    if (b <= a) return;
    g.fillStyle = c;
    g.fillRect(a, y, b - a, 1);
  }
  function ellipse(cx, cy, rx, ry, c) {
    if (rx < 0.5 || ry < 0.5) return;
    g.fillStyle = c;
    const y0 = Math.ceil(cy - ry), y1 = Math.floor(cy + ry);
    for (let y = y0; y <= y1; y++) {
      const t = (y + 0.5 - cy) / ry;
      if (Math.abs(t) > 1) continue;
      const hw = rx * Math.sqrt(1 - t * t);
      const a = R(cx - hw), b = R(cx + hw);
      if (b > a) g.fillRect(a, y, b - a, 1);
    }
  }
  function disc(cx, cy, r, c) { ellipse(cx, cy, r, r, c); }
  function plot(x, y, c) { g.fillStyle = c; g.fillRect(R(x), R(y), 1, 1); }
  function line(x0, y0, x1, y1, c) {
    x0 = R(x0); y0 = R(y0); x1 = R(x1); y1 = R(y1);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    g.fillStyle = c;
    for (let i = 0; i < 400; i++) {
      g.fillRect(x0, y0, 1, 1);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  function triangleUp(cx, topY, baseY, halfW, c) { // triângulo isósceles por linhas
    const h = baseY - topY;
    if (h < 1) return;
    for (let y = Math.ceil(topY); y < baseY; y++) {
      const t = (y - topY + 0.5) / h;
      span(cx - halfW * t, cx + halfW * t, y, c);
    }
  }

  /* ===================================================================
     FONTE BITMAP 3×5 (nítida em qualquer escala, sem depender de web font)
     =================================================================== */
  const GLYPHS = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
    '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001010010010',
    '8': '111101111101111', '9': '111101111001111',
    'A': '010101111101101', 'B': '110101110101110', 'C': '011100100100011', 'D': '110101101101110',
    'E': '111100110100111', 'F': '111100110100100', 'G': '011100101101011', 'H': '101101111101101',
    'I': '111010010010111', 'J': '001001001101010', 'K': '101101110101101', 'L': '100100100100111',
    'M': '101111111101101', 'N': '110101101101101', 'O': '010101101101010', 'P': '110101110100100',
    'Q': '010101101110011', 'R': '110101110101101', 'S': '011100010001110', 'T': '111010010010010',
    'U': '101101101101111', 'V': '101101101101010', 'W': '101101111111101', 'X': '101101010101101',
    'Y': '101101010010010', 'Z': '111001010100111',
    ' ': '000000000000000', '.': '000000000000010', ':': '000010000010000', '-': '000000111000000',
    '/': '001001010100100', '%': '101001010100101', '+': '000010111010000', '!': '010010010000010',
    '?': '110001010000010', '°': '010101010000000', '>': '100010001010100', '<': '001010100010001',
    '(': '010100100100010', ')': '010001001001010', '*': '000101010101000', '=': '000111000111000',
    ',': '000000000010100', '_': '000000000000111', '#': '101111101111101', "'": '010010000000000',
    '•': '000000010000000', '[': '110100100100110', ']': '011001001001011', '|': '010010010010010'
  };
  function norm(str) {
    return String(str).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/★/g, '*');
  }
  function textW(str, s) { s = s || 1; const n = norm(str).length; return n ? n * 4 * s - s : 0; }
  function text(str, x, y, c, s, align, shadow) {
    s = s || 1;
    str = norm(str);
    const w = textW(str, s);
    let x0 = R(x);
    if (align === 'center') x0 = R(x - w / 2);
    else if (align === 'right') x0 = R(x - w);
    const y0 = R(y);
    if (shadow) { const so = Math.max(1, Math.round(s / 3)); text(str, x0 + so, y0 + so, shadow, s, 'left'); }
    g.fillStyle = c;
    for (let i = 0; i < str.length; i++) {
      const gl = GLYPHS[str[i]] || GLYPHS['?'];
      for (let r = 0; r < 5; r++) {
        for (let col = 0; col < 3; col++) {
          if (gl.charCodeAt(r * 3 + col) === 49) g.fillRect(x0 + (i * 4 + col) * s, y0 + r * s, s, s);
        }
      }
    }
    return w;
  }

  /* ===================================================================
     ÍCONES DAS LUZES DE AVISO (bitmaps)
     =================================================================== */
  const ICONS = {
    turnL: ['...X...', '..XX...', '.XXXXXX', 'XXXXXXX', '.XXXXXX', '..XX...', '...X...'],
    turnR: ['...X...', '...XX..', 'XXXXXX.', 'XXXXXXX', 'XXXXXX.', '...XX..', '...X...'],
    engine: ['..XXX....', '...X.....', 'XXXXXXX.X', 'X.XXXXXXX', 'XXXXXXXXX', 'X.XXXXX.X', '..XXXXX..'],
    temp: ['...X...', '...XX..', '...X...', '...XX..', '..XXX..', '..XXX..', 'X.X.X.X'],
    fuel: ['XXXX...', 'X..X.X.', 'X..X..X', 'XXXX..X', 'XXXX..X', 'XXXX.X.', 'XXXXX..'],
    brake: ['..XXX..', '.X...X.', 'X.XX..X', 'X.X.X.X', 'X.XX..X', '.XX..X.', '..XXX..']
  };
  function icon(name, x, y, c) {
    const rows = ICONS[name];
    g.fillStyle = c;
    for (let r = 0; r < rows.length; r++) {
      for (let col = 0; col < rows[r].length; col++) {
        if (rows[r][col] === 'X') g.fillRect(R(x) + col, R(y) + r, 1, 1);
      }
    }
    return rows[0].length;
  }

  /* ===================================================================
     CAMADAS PRÉ-RENDERIZADAS (céu, nuvens, fundo do campus, painel estático)
     =================================================================== */
  const layers = { sky: null, clouds: [], backdrop: null, backdropW: 0, cluster: null };
  const bgImgs = {};

  function offscreen(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;
    return { c, cx };
  }
  function withLayer(cx, fn) { const prev = g; g = cx; try { fn(); } finally { g = prev; } }

  function prepareBackdrop() {
    const cfg = BACKDROP[visual];
    let img = bgImgs[visual];
    if (!img) {
      img = new Image();
      img.onload = () => { prepareBackdrop(); if (gamePaused) drawPauseScreen(); };
      img.src = cfg.src;
      bgImgs[visual] = img;
    }
    layers.backdrop = null;
    if (!img.complete || !img.naturalWidth) return;
    const sx = img.naturalWidth * cfg.sx, sy = img.naturalHeight * cfg.sy;
    const sw = img.naturalWidth * cfg.sw, sh = img.naturalHeight * cfg.sh;
    const bh = Math.max(8, Math.round(horizonY * 0.78));
    const bw = Math.max(8, Math.round(sw * bh / sh));
    // Redução em 2 passos com suavização (qualidade), depois desenhado sem suavização (pixel)
    const mid = offscreen(bw * 2, bh * 2);
    mid.cx.imageSmoothingEnabled = true;
    mid.cx.imageSmoothingQuality = 'high';
    mid.cx.drawImage(img, sx, sy, sw, sh, 0, 0, bw * 2, bh * 2);
    const out = offscreen(bw, bh);
    out.cx.imageSmoothingEnabled = true;
    out.cx.imageSmoothingQuality = 'high';
    out.cx.drawImage(mid.c, 0, 0, bw, bh);
    layers.backdrop = out.c;
    layers.backdropW = bw;
  }

  function buildStaticLayers() {
    const pal = PAL[visual];
    // Céu em faixas com dithering entre elas (estilo 16-bit)
    const sky = offscreen(W, horizonY);
    withLayer(sky.cx, () => {
      const n = pal.sky.length;
      for (let i = 0; i < n; i++) {
        const y0 = Math.floor(i * horizonY / n), y1 = Math.floor((i + 1) * horizonY / n);
        rect(0, y0, W, y1 - y0, pal.sky[i]);
        if (i < n - 1) {
          g.fillStyle = pal.sky[i + 1];
          for (let x = (y1 - 1) % 2; x < W; x += 2) g.fillRect(x, y1 - 1, 1, 1);
        }
      }
    });
    layers.sky = sky.c;

    // Nuvens pixel (3 formatos)
    layers.clouds = [];
    const shapes = [[[0, 0, 9], [8, -3, 8], [16, 0, 7]], [[0, 0, 6], [6, -2, 7], [13, 0, 5]], [[0, 0, 11], [10, -4, 9], [19, -1, 8], [27, 1, 6]]];
    const k = Math.max(0.55, horizonY / 70);
    shapes.forEach(sh => {
      const cw = Math.ceil(44 * k), chh = Math.ceil(22 * k);
      const cl = offscreen(cw, chh);
      withLayer(cl.cx, () => {
        sh.forEach(([x, y, r]) => disc(4 * k + x * k + r * k * 0.6, chh * 0.62 + y * k, r * k * 0.62, pal.cloud));
        rect(2 * k, chh * 0.62 + 2 * k, cw - 6 * k, chh * 0.38 - 2 * k, pal.cloud);
        rect(3 * k, chh - 3 * k, cw - 8 * k, 1 * k + 1, pal.cloudShade);
      });
      layers.clouds.push(cl.c);
    });

    buildClusterStatic();
  }

  /* ===================================================================
     DESENHO PRINCIPAL
     =================================================================== */
  function draw() {
    g = ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, RH); ctx.clip();
    drawSky();
    drawRoadAndScenery();
    drawPlayerCar();
    drawTopHud();
    if (hitFlash > 0) { g.fillStyle = 'rgba(255,40,40,' + (hitFlash * 1.2).toFixed(2) + ')'; g.fillRect(0, 0, W, RH); }
    if (gameMode === 'PASSEIO' && !countdownActive && speed > PASSEIO_SPEED_LIMIT && Math.floor(performance.now() / 200) % 2) {
      rect(0, 0, W, 2, '#ff3b30'); rect(0, RH - 2, W, 2, '#ff3b30'); rect(0, 0, 2, RH, '#ff3b30'); rect(W - 2, 0, 2, RH, '#ff3b30');
    }
    if (showRtos) drawRtosOverlay();
    if (countdownActive) drawCountdown();
    ctx.restore();

    drawCluster();
    if (gameOverActive) drawGameOver();
  }

  function drawSky() {
    if (layers.sky) ctx.drawImage(layers.sky, 0, 0);
    // Nuvens com paralaxe
    const span2 = W + 80;
    for (let i = 0; i < 5; i++) {
      const img = layers.clouds[i % layers.clouds.length];
      if (!img) continue;
      let x = (i * span2 / 5 + cloudDrift - bgOffset * 0.35 + i * 17) % span2;
      if (x < 0) x += span2;
      const y = R(horizonY * (0.08 + (i % 3) * 0.13));
      ctx.drawImage(img, R(x - 50), y);
    }
    // Faixa de prédios do campus (imagem do site) repetida com espelhamento → sem emenda
    if (layers.backdrop) {
      const bw = layers.backdropW, bh = layers.backdrop.height;
      const y = horizonY - bh;
      const off = bgOffset;
      let k = Math.floor(off / bw);
      for (let x = k * bw - off; x < W; x += bw, k++) {
        const xx = R(x);
        if ((k & 1) === 0) {
          ctx.drawImage(layers.backdrop, xx, y);
        } else {
          ctx.save(); ctx.translate(xx + bw, y); ctx.scale(-1, 1); ctx.drawImage(layers.backdrop, 0, 0); ctx.restore();
        }
      }
    }
  }

  function drawRoadAndScenery() {
    const pal = PAL[visual];
    const baseSeg = Math.floor(position / SEGMENT_LENGTH);
    const offsetZ = position % SEGMENT_LENGTH;
    const pts = [];
    let curveAccum = 0;
    for (let n = 0; n <= DRAW_DISTANCE; n++) {
      const segIdx = (baseSeg + n) % TOTAL_SEGMENTS;
      const seg = segments[segIdx];
      const z = Math.max(1, n * SEGMENT_LENGTH - offsetZ);
      curveAccum += seg.curve;
      const worldX = curveAccum * 12;
      const scale = CAMERA_DEPTH / z;
      pts.push({
        segIdx, seg, scale,
        y: horizonY + scale * CAMERA_HEIGHT * (RH * 0.5),
        w: scale * (ROAD_WIDTH * 0.5) * (W * 0.5),
        x: (W * 0.5) + scale * worldX * (W * 0.5)
      });
    }

    // Gramado de fundo até o horizonte
    rect(0, horizonY, W, RH - horizonY, pal.grassA);

    for (let n = DRAW_DISTANCE; n >= 1; n--) {
      const p2 = pts[n], p1 = pts[n - 1];
      if (p2.y >= RH) continue;
      const light = (Math.floor(p2.segIdx / 3) % 2 === 0);
      const isBump = gameMode === 'PASSEIO' && speedBumps.some(b => b.segIndex === p2.segIdx);
      const isFinish = gameMode === 'CORRIDA' && p2.segIdx >= TOTAL_SEGMENTS - 3;
      const yTop = Math.max(horizonY, Math.ceil(p2.y));
      const yBot = Math.min(RH, Math.ceil(p1.y));
      for (let y = yTop; y < yBot; y++) {
        const t = (y + 0.5 - p2.y) / (p1.y - p2.y);
        const x = p2.x + (p1.x - p2.x) * t;
        const w = p2.w + (p1.w - p2.w) * t;
        span(0, W, y, light ? pal.grassA : pal.grassB);
        span(x - w * 1.2, x + w * 1.2, y, light ? pal.walkA : pal.walkB);
        const edge = Math.max(1, w * 0.04);
        span(x - w - edge, x + w + edge, y, pal.edge);
        if (isFinish) {
          const cells = 12, cw = (2 * w) / cells, row = Math.floor((y - yTop) / Math.max(1, (yBot - yTop) / 2));
          for (let c = 0; c < cells; c++) span(x - w + c * cw, x - w + (c + 1) * cw, y, ((c + row) % 2) ? '#111111' : '#ffffff');
        } else if (isBump) {
          const stripes = 8, sw = (2 * w) / stripes;
          for (let s = 0; s < stripes; s++) span(x - w + s * sw, x - w + (s + 1) * sw, y, (s % 2) ? '#1c1c1c' : '#f6c90e');
        } else {
          span(x - w, x + w, y, light ? pal.roadA : pal.roadB);
          if (light && n > 1) {
            const lw = Math.max(1, w * 0.022);
            for (let l = 1; l < LANE_COUNT; l++) {
              const lx = x + w * ((l / LANE_COUNT) * 2 - 1);
              span(lx - lw / 2, lx + lw / 2, y, pal.lane);
            }
          }
        }
      }

      if (gameMode === 'TRÂNSITO') {
        for (const obs of obstacles) if (obs.segIndex === p2.segIdx && !obs.hit) drawObstacle(obs, p2);
      }
      if (gameMode === 'CORRIDA') {
        for (const item of boostItems) if (item.segIndex === p2.segIdx && !item.collected) drawBoostItem(item, p2);
      }
      for (const sc of sceneryObjects) if (sc.segIndex === p2.segIdx) drawSceneryItem(sc, p2);
    }
  }

  /* ===================================================================
     CENÁRIO EM PIXEL ART
     =================================================================== */
  function drawSceneryItem(sc, p) {
    const hw = p.w;
    const x = p.x + sc.side * hw * sc.offset;
    const by = R(p.y);
    if (x < -W * 0.3 || x > W * 1.3) return;

    if (sc.type === 'building') {
      const h = hw * sc.height * 0.0036, w = hw * sc.width * 0.0036;
      if (h < 2) return;
      rect(x - w / 2, by - h, w, h, sc.color);
      rect(x - w / 2, by - h, w, Math.max(1, h * 0.06), '#e8d9b5');           // friso claro
      triangleUp(x, by - h - h * 0.2, by - h, w * 0.56, '#8e3b1f');            // telhado
      if (h >= 8) {
        const cols = Math.max(2, Math.floor(w / 5)), rows = Math.max(1, Math.floor(h / 7));
        const ww = Math.max(1, w / cols * 0.5), wh = Math.max(1, h / rows * 0.42);
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          rect(x - w / 2 + (c + 0.25) * (w / cols), by - h + h * 0.14 + r * (h * 0.8 / rows), ww, wh, '#a9d6f5');
        }
        rect(x - w * 0.07, by - h * 0.22, w * 0.14, h * 0.22, '#5a2a14');      // porta
      }
    }

    if (sc.type === 'totem') {
      const h = hw * 0.72, w = Math.max(1, h * 0.32);
      if (h < 3) return;
      rect(x - w * 0.6, by - Math.max(1, h * 0.06), w * 1.2, Math.max(1, h * 0.06), '#6b7280');
      rect(x - w / 2, by - h, w, h * 0.94, '#c3c7cd');
      rect(x - w * 0.38, by - h * 0.9, w * 0.5, h * 0.8, '#1c1c1c');
      rect(x + w * 0.18, by - h * 0.9, Math.max(1, w * 0.14), h * 0.8, '#f2c418');
    }

    if (sc.type === 'araucaria') {
      const h = hw * sc.height * 0.0036;
      if (h < 3) return;
      rectMin(x - h * 0.035, by - h * 0.9, h * 0.07, h * 0.9, '#5c3a21');
      ellipse(x, by - h * 0.92, h * 0.44, Math.max(1, h * 0.08), '#1f6b35');
      ellipse(x, by - h * 1.0, h * 0.34, Math.max(1, h * 0.07), '#2a8143');
      ellipse(x, by - h * 0.78, h * 0.3, Math.max(1, h * 0.06), '#185a2c');
    }

    if (sc.type === 'ipe') {
      const h = hw * sc.height * 0.0036;
      if (h < 3) return;
      rectMin(x - h * 0.04, by - h * 0.55, h * 0.08, h * 0.55, '#6b4f38');
      disc(x, by - h * 0.7, h * 0.33, sc.color);
      disc(x + h * 0.08, by - h * 0.62, h * 0.2, sc.color === '#f6c90e' ? '#d9a80b' : '#c9468a');
    }

    if (sc.type === 'lamp') {
      const h = hw * 0.5;
      if (h < 3) return;
      rectMin(x, by - h, Math.max(1, h * 0.04), h, '#4b5563');
      rectMin(x - h * 0.12, by - h, h * 0.16, Math.max(1, h * 0.04), '#4b5563');
      rectMin(x - h * 0.14, by - h + Math.max(1, h * 0.04), Math.max(1, h * 0.1), Math.max(1, h * 0.05), '#fff3a3');
    }

    if (sc.type === 'student') {
      const h = hw * 0.34;
      if (h < 4) return;
      rectMin(x - h * 0.12, by - h * 0.3, h * 0.09, h * 0.3, '#1e293b');
      rectMin(x + h * 0.03, by - h * 0.3, h * 0.09, h * 0.3, '#1e293b');
      rectMin(x - h * 0.15, by - h * 0.7, h * 0.3, h * 0.42, sc.shirt);
      if (sc.hasBackpack) rectMin(x - h * 0.28, by - h * 0.66, h * 0.13, h * 0.3, '#0f172a');
      rectMin(x - h * 0.1, by - h * 0.92, h * 0.2, h * 0.2, '#e0a882');
      rectMin(x - h * 0.11, by - h * 0.95, h * 0.22, Math.max(1, h * 0.07), '#3b2416');
    }
  }

  function laneX(lane, p) { return p.x + p.w * ((lane / LANE_COUNT) * 2 - 1 + 1 / LANE_COUNT); }

  function drawObstacle(obs, p) {
    const ox = laneX(obs.lane, p), by = R(p.y);
    const size = p.w * 0.16;
    if (size < 1.5) return;

    if (obs.type === 'cone') {
      triangleUp(ox, by - size * 1.25, by - size * 0.12, size * 0.42, '#ff7a1a');
      rect(ox - size * 0.26, by - size * 0.7, size * 0.52, Math.max(1, size * 0.16), '#ffffff');
      rect(ox - size * 0.55, by - Math.max(1, size * 0.14), size * 1.1, Math.max(1, size * 0.14), '#c2410c');
    }
    if (obs.type === 'placa') {
      rectMin(ox - size * 0.05, by - size * 1.2, Math.max(1, size * 0.1), size * 1.2, '#6b7280');
      const cy = by - size * 1.25, rr = size * 0.55;
      for (let y = Math.ceil(cy - rr); y <= cy + rr; y++) {
        const hw = rr - Math.abs(y - cy);
        span(ox - hw - 1, ox + hw + 1, y, '#1c1c1c');
        if (hw > 1) span(ox - hw + 0.5, ox + hw - 0.5, y, '#f6c90e');
      }
      if (size >= 9) text('!', ox, cy - 2, '#1c1c1c', 1, 'center');
    }
    if (obs.type === 'barreira') {
      const bw = size * 2.2, bh = Math.max(2, size * 0.42);
      rectMin(ox - bw * 0.42, by - size * 0.95, Math.max(1, size * 0.1), size * 0.95, '#6b7280');
      rectMin(ox + bw * 0.38, by - size * 0.95, Math.max(1, size * 0.1), size * 0.95, '#6b7280');
      const blocks = 6, bk = bw / blocks;
      for (let b = 0; b < blocks; b++) rect(ox - bw / 2 + b * bk, by - size * 1.0, bk, bh, (b % 2) ? '#ffffff' : '#e3342f');
    }
    if (obs.type === 'fusca') {
      const cw = size * 2.3, ch = size * 1.05, top = by - ch;
      rect(ox - cw * 0.5, top + ch * 0.35, cw, ch * 0.55, obs.color);
      ellipse(ox, top + ch * 0.38, cw * 0.36, ch * 0.32, obs.color);
      rect(ox - cw * 0.22, top + ch * 0.12, cw * 0.44, Math.max(1, ch * 0.2), '#263445');
      rect(ox - cw * 0.46, top + ch * 0.5, Math.max(1, cw * 0.12), Math.max(1, ch * 0.16), '#e3342f');
      rect(ox + cw * 0.34, top + ch * 0.5, Math.max(1, cw * 0.12), Math.max(1, ch * 0.16), '#e3342f');
      rect(ox - cw * 0.5, top + ch * 0.82, cw, Math.max(1, ch * 0.08), '#c9cfd6');
      rect(ox - cw * 0.46, top + ch * 0.88, cw * 0.18, ch * 0.12, '#111111');
      rect(ox + cw * 0.28, top + ch * 0.88, cw * 0.18, ch * 0.12, '#111111');
    }
  }

  function drawBoostItem(item, p) {
    const ix = laneX(item.lane, p), by = R(p.y);
    const s = p.w * 0.15;
    if (s < 1.5) return;
    const pulse = (Math.floor(performance.now() / 160) % 2) ? 1 : 0;
    const cy = by - s * 1.0 - pulse;
    for (let y = Math.ceil(cy - s * 0.8); y <= cy + s * 0.8; y++) {
      const hw = s * 0.5 * (1 - Math.abs(y - cy) / (s * 0.8));
      span(ix - hw, ix + hw, y, y < cy ? '#5ef08a' : '#1fbf5a');
    }
    if (s >= 6) rectMin(ix - s * 0.12, cy - s * 0.4, s * 0.16, s * 0.25, '#ffffff');
  }

  /* ===================================================================
     CARRO DO JOGADOR (sprite pixel, visão traseira)
     =================================================================== */
  function drawPlayerCar() {
    const k = Math.max(1, Math.round(W / 190));          // tamanho do "pixel" do sprite
    const cw = 32 * k, chh = 16 * k;
    const carBottom = RH - Math.max(2, Math.round(RH * 0.03));
    const carRowY = carBottom - chh * 0.4;
    const sc = (carRowY - horizonY) / (CAMERA_HEIGHT * RH * 0.5);
    const roadHW = sc * ROAD_WIDTH * 0.25 * W;
    const cx = W / 2 + (playerX / (ROAD_WIDTH * 0.5)) * roadHW;
    const moving = veh.kmh > 3 && !countdownActive && !gameOverActive;
    const bounce = moving && (Math.floor(performance.now() / (veh.kmh > 120 ? 60 : 110)) % 2) ? k : 0;
    const ox = R(cx - cw / 2), oy = R(carBottom - chh) - bounce;
    const cell = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(ox + x * k, oy + y * k, w * k, h * k); };

    // sombra
    g.fillStyle = 'rgba(10,14,22,0.35)';
    g.fillRect(ox + k, oy + 14 * k + bounce, 30 * k, 2 * k);

    const braking = veh.brake;
    const tail = braking ? '#ff4848' : '#d8262e';
    const tailHi = braking ? '#ffd1d1' : '#ff6b6b';

    if (car.id === 'corvette') {
      const body = '#f06aa8', bodyD = '#c94a86', bodyL = '#f9a8d0';
      cell(1, 10, 5, 5, '#111214'); cell(26, 10, 5, 5, '#111214');
      cell(2, 4, 28, 2, bodyL);
      cell(1, 6, 30, 5, body); cell(0, 7, 32, 3, body);
      cell(1, 10, 30, 1, bodyD);
      // cockpit aberto: bancos brancos e motorista loira
      cell(8, 3, 16, 2, '#f8fafc'); cell(9, 1, 6, 3, '#f8fafc'); cell(17, 1, 6, 3, '#f8fafc');
      cell(10, 0, 4, 2, '#f7d774'); cell(11, 2, 3, 2, '#f7d774'); cell(9, 1, 1, 3, '#e8c25a');
      cell(7, 4, 18, 1, '#e8b4cf');
      // lanternas redondas
      cell(3, 7, 3, 2, tail); cell(4, 6, 1, 1, tail); cell(4, 7, 1, 1, tailHi);
      cell(26, 7, 3, 2, tail); cell(27, 6, 1, 1, tail); cell(27, 7, 1, 1, tailHi);
      cell(15, 7, 2, 2, '#ffffff');
      cell(13, 8, 6, 2, '#f5f1e1'); cell(14, 8, 4, 1, '#c2410c');
      cell(1, 11, 30, 1, '#e5e9ee'); cell(1, 12, 30, 1, '#9aa3ad');
      cell(5, 10, 2, 2, '#e5e9ee'); cell(25, 10, 2, 2, '#e5e9ee');
      cell(7, 13, 2, 1, '#6b7280'); cell(23, 13, 2, 1, '#6b7280');
    } else {
      const body = '#1f8fa0', bodyD = '#136573', bodyL = '#4fbdca';
      cell(1, 10, 5, 5, '#111214'); cell(26, 10, 5, 5, '#111214');
      cell(8, 0, 16, 1, '#121418'); cell(7, 1, 18, 4, '#121418');
      cell(9, 1, 14, 3, '#2b3c4b'); cell(10, 1, 3, 1, '#5e7d93');
      cell(14, 2, 4, 2, '#3a2416');                             // cabelo do piloto
      cell(2, 5, 28, 2, bodyL);
      cell(0, 6, 32, 6, body);
      cell(0, 11, 32, 1, bodyD);
      cell(12, 5, 2, 2, '#f1f1f1'); cell(18, 5, 2, 2, '#f1f1f1');   // faixas SS
      cell(2, 7, 7, 3, '#1b1c20'); cell(23, 7, 7, 3, '#1b1c20');
      cell(3, 8, 5, 1, tail); cell(24, 8, 5, 1, tail);
      cell(3, 8, 1, 1, tailHi); cell(28, 8, 1, 1, tailHi);
      cell(10, 7, 12, 3, '#16171b'); cell(15, 8, 2, 1, '#f2c418');
      cell(13, 10, 6, 1, '#f5f1e1');
      cell(0, 12, 32, 1, '#d7dde4'); cell(0, 13, 32, 1, '#8d96a1');
      cell(6, 14, 2, 1, '#6b7280'); cell(24, 14, 2, 1, '#6b7280');
    }

    if (braking) { g.fillStyle = 'rgba(255,60,60,0.25)'; g.fillRect(ox - k, oy + 6 * k, cw + 2 * k, 5 * k); }

    if (boostActive && Math.floor(performance.now() / 70) % 2) {
      cell(6, 15, 2, 1, '#ffd43b'); cell(24, 15, 2, 1, '#ffd43b');
      g.fillStyle = '#ff922b'; g.fillRect(ox + 6 * k, oy + 16 * k, 2 * k, k); g.fillRect(ox + 24 * k, oy + 16 * k, 2 * k, k);
    }

    // Setas piscando no carro também
    if (veh.turn && Math.floor(simMs / 333) % 2 === 0) {
      if (veh.turn === 1) cell(0, 8, 2, 2, '#ffb020'); else cell(30, 8, 2, 2, '#ffb020');
    }
  }

  /* ===================================================================
     HUD SUPERIOR (pontos, tempo, vidas / checkpoint / limite)
     =================================================================== */
  function drawTopHud() {
    if (countdownActive || gameOverActive) return;
    g.fillStyle = 'rgba(12,10,28,0.62)';
    g.fillRect(0, 0, W, 9);
    rect(0, 9, W, 1, 'rgba(255,187,0,0.55)');
    text(T('pts') + ' ' + score, 3, 2, '#ffd34d');

    let tStr;
    if (gameMode === 'CORRIDA') tStr = T('time') + ' ' + timeElapsed.toFixed(1) + 'S';
    else tStr = T('time') + ' ' + Math.max(0, Math.ceil(gameDuration - timeElapsed)) + 'S';
    const low = gameMode !== 'CORRIDA' && gameDuration - timeElapsed < 10;
    text(tStr, W / 2, 2, low && Math.floor(performance.now() / 250) % 2 ? '#ff6b6b' : '#ffffff', 1, 'center');

    if (gameMode === 'TRÂNSITO') {
      for (let i = 0; i < 3; i++) drawHeart(W - 8 - i * 7, 2, i < lives ? '#ff4d6d' : '#4b4b5a');
    } else if (gameMode === 'CORRIDA') {
      const bw = Math.min(46, W * 0.18), bx = W - 3 - bw;
      text('CP ' + checkpointsPassed + '/3', bx - 3, 2, '#ffffff', 1, 'right');
      rect(bx, 3, bw, 3, '#1e293b');
      rect(bx, 3, bw * Math.min(1, position / (TOTAL_SEGMENTS * SEGMENT_LENGTH)), 3, '#3ddc4a');
    } else {
      // placa de 60
      const cx = W - 10, cy = 17;
      disc(cx, cy, 7, '#e3342f'); disc(cx, cy, 5, '#ffffff');
      text('60', cx + 0.5, cy - 2, '#111111', 1, 'center');
    }
  }
  function drawHeart(x, y, c) {
    const rows = ['.X.X.', 'XXXXX', 'XXXXX', '.XXX.', '..X..'];
    g.fillStyle = c;
    rows.forEach((r, i) => { for (let j = 0; j < 5; j++) if (r[j] === 'X') g.fillRect(x + j, y + i, 1, 1); });
  }

  /* ===================================================================
     PAINEL DE INSTRUMENTOS (ICM)
     =================================================================== */
  let cl = null; // geometria do painel

  function clusterGeometry() {
    const y0 = RH, h = CH;
    const m = 3;
    const barW = Math.max(5, Math.round(W * 0.022));
    const r = Math.max(10, Math.floor(Math.min(h * 0.44, W * 0.14)));
    const cy = y0 + Math.round(h * 0.52);
    const tachX = m + barW + 5 + r;
    const speedX = W - (m + barW + 5 + r);
    const cl0 = tachX + r + 4, cr0 = speedX - r - 4;
    return {
      y0, h, m, barW, r, cy, tachX, speedX, cl: cl0, cr: cr0, cw: cr0 - cl0,
      fuelX: m, tempX: W - m - barW, barY: y0 + 5, barH: h - 12,
      iconY: y0 + 3, lcdY: y0 + 13, lcdH: h - 18
    };
  }

  function gaugeAngle(frac) { return (225 - 270 * Math.max(0, Math.min(1, frac))) * Math.PI / 180; }

  function buildClusterStatic() {
    cl = clusterGeometry();
    const th = car.theme;
    const lay = offscreen(W, H);
    withLayer(lay.cx, () => {
      // fundo do painel
      rect(0, cl.y0, W, cl.h, th.panel);
      rect(0, cl.y0, W, 1, th.panelLo);
      rect(0, cl.y0 + 1, W, 1, th.panelHi);
      // friso inferior (madeira no Camaro, faixa branca no Corvette)
      rect(0, H - 3, W, 3, th.trim);
      for (let x = (car.id === 'camaro' ? 2 : 0); x < W; x += (car.id === 'camaro' ? 9 : 6)) rect(x, H - 2, car.id === 'camaro' ? 4 : 3, 1, th.trimLine);
      rect(0, H - 3, W, 1, th.trimDark);

      drawGaugeStatic(cl.tachX, cl.cy, cl.r, 8, 1, 6.5, 'X1000');
      drawGaugeStatic(cl.speedX, cl.cy, cl.r, 250, 10, null, 'KM/H');

      // molduras das barras (combustível / temperatura)
      [cl.fuelX, cl.tempX].forEach(bx => {
        rect(bx - 1, cl.barY - 1, cl.barW + 2, cl.barH + 2, th.bezelDark);
        rect(bx, cl.barY, cl.barW, cl.barH, th.face);
      });
      // LCD central
      rect(cl.cl - 1, cl.lcdY - 1, cl.cw + 2, cl.lcdH + 2, th.bezelDark);
      rect(cl.cl, cl.lcdY, cl.cw, cl.lcdH, th.lcdBg);
    });
    layers.cluster = lay.c;
  }

  function drawGaugeStatic(cx, cy, r, max, minorStep, redFrom, unit) {
    const th = car.theme;
    disc(cx, cy, r + 1, th.bezelDark);
    disc(cx, cy, r, th.bezel);
    disc(cx, cy, r - 2, th.face);
    // zona vermelha
    if (redFrom != null) {
      for (let v = redFrom; v <= max; v += max / 200) {
        const a = gaugeAngle(v / max);
        plot(cx + Math.cos(a) * (r - 3), cy - Math.sin(a) * (r - 3), th.red);
        plot(cx + Math.cos(a) * (r - 4), cy - Math.sin(a) * (r - 4), th.red);
      }
    }
    // marcas
    const majorEvery = max === 8 ? 1 : 50;
    const steps = Math.round(max / (max === 8 ? 0.5 : minorStep));
    for (let i = 0; i <= steps; i++) {
      const v = i * (max / steps);
      const a = gaugeAngle(v / max);
      const isMajor = Math.abs(v / majorEvery - Math.round(v / majorEvery)) < 1e-6;
      const c = (redFrom != null && v >= redFrom) ? th.red : th.tick;
      if (isMajor) {
        line(cx + Math.cos(a) * (r - 3), cy - Math.sin(a) * (r - 3), cx + Math.cos(a) * (r - 5), cy - Math.sin(a) * (r - 5), c);
      } else if (r >= 18) {
        plot(cx + Math.cos(a) * (r - 3), cy - Math.sin(a) * (r - 3), c);
      }
    }
    // números
    if (r >= 22) {
      const labels = max === 8 ? (r >= 26 ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : [0, 2, 4, 6, 8])
                               : (r >= 30 ? [0, 50, 100, 150, 200, 250] : [0, 100, 200]);
      labels.forEach(v => {
        const a = gaugeAngle(v / max);
        const lr = r - (max === 8 ? 12 : (r >= 30 ? 12 : 10));
        const lx = cx + Math.cos(a) * lr, ly = cy - Math.sin(a) * lr;
        text(String(v), lx + 0.5, ly - 2, (redFrom != null && v >= redFrom) ? th.red : th.label, 1, 'center');
      });
    }
    if (r >= 24) text(unit, cx + 0.5, cy + Math.round(r * 0.42), th.label, 1, 'center');
  }

  function drawNeedle(cx, cy, r, frac, color) {
    const a = gaugeAngle(frac);
    const tipR = r - 4;
    const tx = cx + Math.cos(a) * tipR, ty = cy - Math.sin(a) * tipR;
    const bx = cx - Math.cos(a) * Math.max(2, r * 0.15), byy = cy + Math.sin(a) * Math.max(2, r * 0.15);
    line(bx, byy, tx, ty, color);
    if (r >= 20) {
      // espessura de 2 px: segunda linha deslocada no eixo menos inclinado
      const horizontal = Math.abs(Math.cos(a)) > Math.abs(Math.sin(a));
      line(bx + (horizontal ? 0 : 1), byy + (horizontal ? 1 : 0), tx, ty, color);
    }
    disc(cx, cy, Math.max(1.5, r * 0.09), car.theme.bezel);
    plot(cx, cy, car.theme.bezelDark);
  }

  function drawBar(bx, by, bw, bh, frac, colorFn, topLbl, botLbl, lblX) {
    const th = car.theme;
    const blocks = Math.max(4, Math.min(10, Math.floor((bh - 2) / 3)));
    const gap = 1, bhh = Math.max(1, Math.floor((bh - 2 - gap * (blocks - 1)) / blocks));
    const lit = Math.round(Math.max(0, Math.min(1, frac)) * blocks);
    for (let i = 0; i < blocks; i++) {
      const y = by + bh - 1 - (i + 1) * bhh - i * gap;
      rect(bx + 1, y, bw - 2, bhh, i < lit ? colorFn(i, blocks) : th.off);
    }
    // letras no vão entre a barra e o mostrador (F/E, H/C)
    if (bh >= 16) {
      text(topLbl, lblX, by, th.label);
      text(botLbl, lblX, by + bh - 5, th.label);
    }
  }

  function drawCluster() {
    if (!layers.cluster || !cl || !disp) return;
    g = ctx;
    ctx.drawImage(layers.cluster, 0, 0);
    const th = car.theme;
    const d = disp;
    const now = simMs;
    const bulbCheck = now < 1500;                         // teste de lâmpadas na ignição
    const sweep = bulbCheck ? Math.sin(Math.PI * Math.min(1, now / 1500)) : 0;
    const blink = Math.floor(now / 333) % 2 === 0;        // pisca-pisca 1.5 Hz
    const blinkFast = Math.floor(now / 200) % 2 === 0;
    const f = d.warning_flags;

    // Ponteiros
    drawNeedle(cl.tachX, cl.cy, cl.r, bulbCheck ? sweep : d.needleRpm / 8000, th.needle);
    drawNeedle(cl.speedX, cl.cy, cl.r, bulbCheck ? sweep : d.needleSpeed / 250, th.needle);

    // Combustível (blocos; reserva em vermelho; sensor em falha pisca)
    const fuelFrac = (f & FLAG_FUEL_SENSOR) ? (blinkFast ? 1 : 0) : (bulbCheck ? sweep : d.fuel_level_percent / 100);
    drawBar(cl.fuelX, cl.barY, cl.barW, cl.barH, fuelFrac,
      (i) => (f & FLAG_FUEL_SENSOR) ? th.lcdWarn : (i === 0 ? th.red : th.bar), 'F', 'E', cl.fuelX + cl.barW + 1);
    // Temperatura (topo vermelho; sensor fora da faixa = vazio piscando)
    const tempFrac = (f & FLAG_TEMP_SENSOR) ? 0 : (bulbCheck ? sweep : (d.coolant_temp_celsius - 50) / (125 - 50));
    drawBar(cl.tempX, cl.barY, cl.barW, cl.barH, tempFrac,
      (i, n) => i >= n - 2 ? th.red : th.bar, 'H', 'C', cl.tempX - 4);

    // Luzes de aviso
    let lamps = [
      { n: 'turnL', on: bulbCheck || (d.turn_signal === 1 && blink), c: '#3ddc4a' },
      { n: 'brake', on: bulbCheck || !!(f & FLAG_HANDBRAKE_ON), c: '#ff3b30' },
      { n: 'engine', on: bulbCheck || !!(f & FLAG_MIL_CHECK_ENG), c: '#ffb000' },
      { n: 'temp', on: bulbCheck || !!(f & (FLAG_COOLANT_HOT | FLAG_TEMP_SENSOR)), c: '#ff3b30' },
      { n: 'fuel', on: bulbCheck || !!(f & FLAG_LOW_FUEL) || (!!(f & FLAG_FUEL_SENSOR) && blinkFast), c: '#ffb000' },
      { n: 'can', on: bulbCheck || !!(f & (FLAG_CAN_M1_TIMEOUT | FLAG_CAN_M2_TIMEOUT)), c: '#ffb000' },
      { n: 'turnR', on: bulbCheck || (d.turn_signal === 2 && blink), c: '#3ddc4a' }
    ];
    const wOf = l => l.n === 'can' ? 11 : ICONS[l.n][0].length;
    // Tela estreita: mantém setas, injeção, temperatura e combustível
    if (lamps.reduce((a, l) => a + wOf(l) + 2, -2) > cl.cw) lamps = lamps.filter(l => l.n !== 'brake' && l.n !== 'can');
    if (lamps.reduce((a, l) => a + wOf(l) + 1, -1) > cl.cw) lamps = lamps.filter(l => l.n === 'turnL' || l.n === 'turnR' || l.n === 'engine');
    const widths = lamps.map(wOf);
    const total = widths.reduce((a, b) => a + b, 0);
    const gapI = Math.max(1, Math.floor((cl.cw - total) / (lamps.length - 1)));
    let ix = cl.cl + Math.max(0, Math.floor((cl.cw - total - gapI * (lamps.length - 1)) / 2));
    lamps.forEach((l, i) => {
      const c = l.on ? l.c : th.off;
      if (l.n === 'can') text('CAN', ix, cl.iconY + 1, c);
      else icon(l.n, ix, cl.iconY, c);
      ix += widths[i] + gapI;
    });

    // LCD central
    const lx = cl.cl + 2, lr = cl.cl + cl.cw - 2;
    let ly = cl.lcdY + 2;
    const big = cl.lcdH >= 30 && cl.cw >= 70 ? 2 : 1;
    const msg = currentMessage(d, bulbCheck);
    const roomBelow = (cl.lcdY + cl.lcdH - 1 - (ly + (big === 2 ? 12 : 7))) >= 6;
    if (!roomBelow && msg && msg.warn && Math.floor(now / 1000) % 2 === 1) {
      // LCD pequeno (celular): alterna velocidade ⇄ aviso a cada 1 s
      text(fitText(msg.text, cl.cw - 4), (lx + lr) / 2, ly, th.lcdWarn, 1, 'center');
      return;
    }
    const gearStr = countdownActive ? 'P' : (d.gear >= 1 ? 'D' + d.gear : 'N');
    text(gearStr, lx, ly, th.lcdText, big);
    const spdStr = (f & FLAG_CAN_M2_TIMEOUT) ? '---' : (bulbCheck ? '888' : String(Math.round(d.vehicle_speed_kmh)));
    const unitW = textW('KM/H');
    text('KM/H', lr, ly + (big === 2 ? 5 : 0), th.lcdText, 1, 'right');
    text(spdStr, lr - unitW - 3, ly, (f & FLAG_CAN_M2_TIMEOUT) ? th.lcdWarn : th.lcdText, big, 'right');
    ly += big === 2 ? 12 : 7;

    const lines = [];
    lines.push('ODO ' + String(Math.floor(d.odometer_km)).padStart(6, '0') + ' KM');
    lines.push('TRIP A ' + d.trip_a_km.toFixed(2) + ' KM');
    const ls = (cl.lcdH >= 50 && cl.cw >= 150) ? 2 : 1;      // escala das linhas
    const lh = 6 * ls + (ls === 2 ? 0 : 1);
    const maxLines = Math.floor((cl.lcdY + cl.lcdH - 1 - ly) / lh);
    const shown = lines.slice(0, Math.max(0, maxLines - 1));
    shown.forEach(s => { text(fitText(s, (cl.cw - 4) / ls), lx, ly, th.lcdText, ls); ly += lh; });
    if (maxLines >= 1 && msg) {
      const ms = textW(msg.text, ls) <= cl.cw - 4 ? ls : 1;
      text(fitText(msg.text, (cl.cw - 4) / ms), (lx + lr) / 2, ly, msg.warn ? th.lcdWarn : th.lcdText, ms, 'center');
    }
  }

  function fitText(s, maxW) {
    s = norm(s);
    while (s.length > 1 && textW(s) > maxW) s = s.slice(0, -1);
    return s;
  }

  function currentMessage(d, bulbCheck) {
    const f = d.warning_flags;
    if (bulbCheck) return { text: T('msgBulb') };
    if (f & FLAG_CAN_M1_TIMEOUT) return { text: T('msgCanM1'), warn: true };
    if (f & FLAG_CAN_M2_TIMEOUT) return { text: T('msgCanM2'), warn: true };
    if (f & FLAG_TEMP_SENSOR) return { text: T('msgTempS'), warn: true };
    if (f & FLAG_COOLANT_HOT) return { text: T('msgHot') + ' ' + Math.round(d.coolant_temp_celsius) + '°C', warn: true };
    if (f & FLAG_FUEL_SENSOR) return { text: T('msgFuelS'), warn: true };
    if (veh.fuel <= 0) return { text: T('msgNoFuel'), warn: true };
    if (f & FLAG_LOW_FUEL) return { text: T('msgReserve') + ' ' + Math.round(d.fuel_level_percent) + '%', warn: true };
    if (countdownActive || (f & FLAG_HANDBRAKE_ON)) return { text: T('msgHand') };
    if (gameMode === 'PASSEIO' && speed > PASSEIO_SPEED_LIMIT) return { text: T('msgLimit'), warn: true };
    if (boostActive) return { text: T('msgBoost') };
    return { text: T('fuel') + ' ' + Math.round(d.fuel_level_percent) + '%  ' + Math.round(d.coolant_temp_celsius) + '°C' };
  }

  /* ===================================================================
     PAINEL DE TAREFAS DO RTOS (tecla R) — igual ao gráfico do slide 7
     =================================================================== */
  function drawRtosOverlay() {
    const rows = TASK_DEFS.length;
    const lineH = 7;
    const pw = Math.min(W - 6, 230);
    const ph = Math.min(RH - 14, 10 + rows * lineH + 9);
    const px = 3, py = 12;
    g.fillStyle = 'rgba(8,10,24,0.86)';
    g.fillRect(px, py, pw, ph);
    rect(px, py, pw, 1, '#ffbb00');
    text(T('rtosTitle'), px + 3, py + 3, '#ffd34d');
    const nameW = 38, cntW = 24;
    const tlx = px + 3 + nameW + cntW + 4, tlw = pw - (tlx - px) - 4;
    let y = py + 11;
    TASK_DEFS.forEach(t => {
      if (y + 5 > py + ph - 1) return;
      const st = taskStats[t.id];
      text(t.short, px + 3, y, t.color);
      text(String(st.count), px + 3 + nameW + cntW, y, '#e2e8f0', 1, 'right');
      if (tlw > 20) {
        rect(tlx, y + 2, tlw, 1, '#2a2f45');
        g.fillStyle = t.color;
        st.hist.forEach(ts => {
          const xx = tlx + Math.round((1 - (simMs - ts) / 1000) * (tlw - 1));
          g.fillRect(xx, y, 1, 5);
        });
      }
      y += lineH;
    });
    if (y + 5 <= py + ph) {
      text('M1 ' + icm.framesM1 + '  M2 ' + icm.framesM2 + '  ' + T('dtc') + ' ' + (icm.dtcHistory.join(' ') || T('none')), px + 3, y + 1, '#94a3b8');
    }
  }

  /* ===================================================================
     TELAS ESPECIAIS
     =================================================================== */
  function drawCountdown() {
    g.fillStyle = 'rgba(10,12,30,0.55)';
    g.fillRect(0, 0, W, RH);
    const s = Math.max(3, Math.floor(RH / 16));
    const label = countdownValue > 0 ? String(countdownValue) : T('go');
    text(label, W / 2, RH * 0.36 - s * 2.5, countdownValue > 0 ? '#ffd34d' : '#3ddc4a', s, 'center', '#1c0326');
    const s2 = W >= 260 ? 2 : 1;
    text(T('mode') + ': ' + modeLabel(gameMode), W / 2, RH * 0.66, '#ffffff', s2, 'center', '#1c0326');
    text(T('pilot') + ': ' + playerInfo.name + ' • ' + car.name, W / 2, RH * 0.66 + 6 * s2 + 3, '#cbd5e1', 1, 'center');
    text(T('hint'), W / 2, RH - 8, '#94a3b8', 1, 'center');
  }

  function drawGameOver() {
    g.fillStyle = 'rgba(10,8,26,0.92)';
    g.fillRect(0, 0, W, H);
    const s = W >= 260 ? 2 : 1;
    let y = Math.round(H * 0.1);
    text(T('result'), W / 2, y, '#ffd34d', s, 'center', '#3b0a2e');
    y += 6 * s + 6;
    if (finalResult) {
      const r = finalResult;
      text(T('mode') + ': ' + modeLabel(r.mode), W / 2, y, '#ffbb00', 1, 'center'); y += 9;
      text(T('pilot') + ': ' + r.playerInfo.name + ' (' + r.playerInfo.age + ' ' + T('years') + ')', W / 2, y, '#ffffff', 1, 'center'); y += 10;
      const s3 = Math.max(2, Math.min(5, Math.floor(H / 36)));
      text(r.score + ' ' + T('pts'), W / 2, y, '#3ddc4a', s3, 'center', '#0b3d1a'); y += 5 * s3 + 8;
      text(T('trackTime') + ': ' + r.time + 'S • ' + r.playerInfo.car, W / 2, y, '#94a3b8', 1, 'center'); y += 8;
      text(T('maxSpeed') + ': ' + r.maxKmh + ' KM/H', W / 2, y, '#94a3b8', 1, 'center'); y += 8;
      text(T('dtc') + ': ' + ((r.dtcs && r.dtcs.length) ? r.dtcs.join(' ') : T('none')), W / 2, y, (r.dtcs && r.dtcs.length) ? '#ff9f43' : '#94a3b8', 1, 'center');
    }
    text(T('saving'), W / 2, H - 10, '#64748b', 1, 'center');
  }

  function drawPauseScreen() {
    if (!canvas || !ctx) return;
    draw();
    g = ctx;
    g.fillStyle = 'rgba(10,8,26,0.86)';
    g.fillRect(0, 0, W, H);
    const s = W >= 260 ? 3 : 2;
    let y = Math.round(H * 0.08);
    text(T('paused'), W / 2, y, '#ffd34d', s, 'center', '#3b0a2e');
    y += 5 * s + 7;
    text(T('resume'), W / 2, y, '#ffffff', 1, 'center'); y += 8;
    text(T('quit'), W / 2, y, '#ff6b6b', 1, 'center'); y += 12;
    text(T('tests'), W / 2, y, '#ffbb00', 1, 'center'); y += 9;
    const items = [[T('kCan'), faults.can], [T('kTemp'), faults.tempSensor], [T('kFan'), faults.fan], [T('kFuel'), faults.fuelSensor], [T('kRtos'), showRtos]];
    const colW = Math.min(W - 10, 170);
    const x0 = R(W / 2 - colW / 2);
    items.forEach(([label, on]) => {
      if (y + 5 > H - 2) return;
      text(fitText(label, colW - 30), x0, y, '#cbd5e1');
      text(on ? T('on') : T('off'), x0 + colW, y, on ? '#3ddc4a' : '#64748b', 1, 'right');
      y += 8;
    });
  }

  /* ===================================================================
     API GLOBAL
     =================================================================== */
  window.UTFPRGame = {
    init: init,
    start: start,
    setLang: setLang,
    setVisualMode: setVisualMode,
    stop: stop,
    togglePause: togglePause,
    exitToMenu: exitToMenu,
    isRunning: isRunning,
    isShowingResult: function () { return gameOverActive; },
    // Para depuração / relatório: estado do ICM e telemetria do Task_Logging
    getIcmSnapshot: function () { return disp ? JSON.parse(JSON.stringify(disp)) : null; },
    getTelemetry: function () { return telemetry.slice(); },
    getTaskStats: function () { const o = {}; Object.keys(taskStats).forEach(k => { o[k] = taskStats[k].count; }); return o; },
    injectFault: function (name, on) { if (name in faults) faults[name] = !!on; }
  };

})();
