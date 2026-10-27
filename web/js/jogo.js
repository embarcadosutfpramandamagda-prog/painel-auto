/*
 * jogo.js - o jogo de corrida (Passeio, Trânsito, Corrida) e o painel do carro.
 *
 * O canvas é desenhado em resolução baixa (uns 350 px de largura) e o CSS
 * amplia sem suavizar, por isso fica com cara de pixel art.
 *
 * O painel de instrumentos não lê a velocidade do jogo direto. A ideia foi
 * imitar o caminho do firmware em C (src/tasks.c e src/icm_data.c):
 *
 *   carro manda M1 (rpm, 500 ms) e M2 (velocidade, 1000 ms) no "barramento"
 *   -> ISR2_CAN -> Task_CAN_RX -> Acquisition 10 ms -> Processing 20 ms
 *   -> Display 50 ms -> Diagnostics 100 ms -> Logging 1000 ms
 *
 * Tudo roda num relógio de 1 ms simulado, então o comportamento é o mesmo
 * em qualquer computador. Períodos, timeouts, filtros e DTCs são os mesmos
 * valores do código C; se mudar lá, tem que mudar aqui também.
 */
(function () {
  'use strict';

  /* --- Pista e física --- */
  const LANE_COUNT = 3;
  const SEGMENT_LENGTH = 200;
  const ROAD_WIDTH = 1000;
  const CAMERA_HEIGHT = 800;
  const CAMERA_DEPTH = 0.84;
  const DRAW_DISTANCE = 90;
  const TOTAL_SEGMENTS = 1800;     // 3,6 km de pista

  // escala do mundo: 1 unidade = 1 cm. A pista tem 1000 unidades (3 faixas de ~3,3 m)
  // e cada segmento 200 (2 m). Assim o chão passa na mesma velocidade que o velocímetro marca.
  const UNITS_PER_METER = 100;
  const LANE_SWITCH_SPEED = 9;
  const PASSEIO_SPEED_LIMIT = 60;  // km/h, igual à placa
  const SPEED_CAP_KMH = 250;       // fim de escala do velocímetro (RF-02)
  const G = 9.81;

  /* --- Constantes do ICM (as mesmas de include/can_types.h e include/icm_data.h) --- */
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
  const FLAG_BATTERY_FAULT = 1 << 5;  // dínamo/alternador sem carregar (motor parado)
  const FLAG_OIL_PRESS_LOW = 1 << 6;  // sem pressão de óleo (motor parado)
  const FLAG_HANDBRAKE_ON = 1 << 7;
  const FLAG_SEATBELT_WARN = 1 << 8;
  const FLAG_SIGNAL_OOR = 1 << 11;    // RS-05: valor do CAN fora da faixa descartado (U0401)
  const RPM_OOR = 8500, SPEED_OOR = 260;
  const FLAG_FUEL_SENSOR = 1 << 9;   // P0460
  const FLAG_TEMP_SENSOR = 1 << 10;  // P0115 por sensor fora da faixa

  // mesmas prioridades do oil/icm.oil (só pra mostrar no quadro da tecla R)
  const TASK_DEFS = [
    // cost = tempo de CPU estimado em µs, o mesmo do sim/wcet.csv (firmware C no SIL)
    { id: 'ISR2_CAN',          short: 'ISR2 CAN', prio: 20, period: 0,    deadline: 1,    cost: 25,   color: '#ff6b6b' },
    { id: 'Task_CAN_RX',       short: 'CAN RX',   prio: 10, period: 0,    deadline: 2,    cost: 90,   color: '#ffa94d' },
    { id: 'Task_Acquisition',  short: 'ACQ',      prio: 8,  period: 10,   deadline: 10,   cost: 180,  color: '#ffd43b' },
    { id: 'Task_Processing',   short: 'PROC',     prio: 6,  period: 20,   deadline: 20,   cost: 140,  color: '#69db7c' },
    { id: 'Task_Display',      short: 'DISP',     prio: 4,  period: 50,   deadline: 50,   cost: 1200, color: '#4dabf7' },
    { id: 'Task_Diagnostics',  short: 'DIAG',     prio: 3,  period: 100,  deadline: 100,  cost: 220,  color: '#b197fc' },
    { id: 'Task_Logging',      short: 'LOG',      prio: 1,  period: 1000, deadline: 1000, cost: 450,  color: '#f783ac' }
  ];

  /* --- Carros: cores do painel e odômetro inicial --- */
  // spec: números aproximados dos carros de verdade.
  //  Camaro 69 SS 396: câmbio automático TH400 de 3 marchas, diferencial 3.55, pneu F70-14.
  //  Corvette 56 V8 265: câmbio manual de 3 marchas, diferencial 3.55, pneu 6.70-15.
  // powerW é a potência que chega na roda (bem menos que o "hp bruto" do catálogo),
  // cdA é o arrasto (Cd x área frontal) e grip é a aceleração máxima antes de patinar (m/s²).
  const CARS = [
    {
      id: 'camaro', name: 'CAMARO 69', odo: 87412.0,
      spec: { mass: 1600, powerW: 150000, cdA: 0.95, grip: 5.2, brake: 7.0,
              ratios: [2.48, 1.48, 1.00], final: 3.55, tire: 2.07,
              idle: 750, redline: 6500, limiter: 6800, auto: true, shiftTime: 0.25, launch: 2400 },
      theme: {
        dash: '#17181c', dashGrain: '#1d1f24', pad: '#2a2c32', padLo: '#0d0e10', housing: '#101114',
        wood: ['#3f210f', '#6b3a1c', '#8a4d25', '#a8652f'], cupShadow: '#060607',
        face: '#0b0c0f', faceShadow: '#050506', tick: '#eeeeee', label: '#eeeeee', labelDim: '#8d939c',
        needle: '#ff6a1a', red: '#e3342f', vent: '#0a0a0c', ventSlat: '#2b2d33',
        lampRim: '#2b2d33', lampOff: '#0e0f12', lampOffText: '#2f3238',
        winRim: '#2a1608', winBg: '#0d0803', winText: '#ffb627', winWarn: '#ff5a3c', winDim: '#3a2608'
      }
    },
    {
      id: 'corvette', name: 'CORVETTE 56', odo: 12956.0,
      spec: { mass: 1350, powerW: 100000, cdA: 0.88, grip: 4.6, brake: 6.2,
              ratios: [2.21, 1.32, 1.00], final: 3.55, tire: 2.20,
              idle: 700, redline: 5500, limiter: 5800, auto: false, shiftTime: 0.45, launch: 2800 },
      theme: {
        dash: '#ee6aa7', dashHi: '#f9a3cb', dashMid: '#f58bbc', dashLo: '#c24983',
        face: '#1c1719', faceShadow: '#120e10', tick: '#f6f0e4', label: '#f6f0e4', labelDim: '#a99a9f',
        labelDash: '#7a1347', needle: '#ff3355', red: '#ff3b3b', lampPlate: '#1c1719',
        lampRim: '#3a2c31', lampOff: '#151113', lampOffText: '#3b3034',
        winRim: '#8b939e', winBg: '#f3e3bd', winText: '#5a2a12', winWarn: '#c81e1e', winDim: '#d8c495'
      }
    }
  ];

  /* --- Cores do cenário (uma paleta pra cada modo do site) --- */
  const PAL = {
    pixel: {
      sky: ['#3d9ce6', '#47a4ec', '#51abf1', '#5ab1f3'],
      grassA: '#5cb84a', grassB: '#51a943',
      walkA: '#dcd2a0', walkB: '#d0c690', edge: '#f2c418',
      roadA: '#5e636d', roadB: '#575c66', lane: '#f1f1f1',
      cloud: '#ffffff', cloudShade: '#cfe8fb', haze: '#9fd0f2'
    },
    real: {
      sky: ['#5aa3ef', '#64abf3', '#6fb4f7', '#78bafa'],
      grassA: '#7aa63b', grassB: '#709c34',
      walkA: '#cdc6b0', walkB: '#c2bba5', edge: '#f2c418',
      roadA: '#6b6f77', roadB: '#64686f', lane: '#f4f4f4',
      cloud: '#ffffff', cloudShade: '#dceaf8', haze: '#b6d3ee'
    }
  };

  // pedaço das fotos do campus usado no horizonte (frações da imagem): dos prédios até o gramado
  const BACKDROP = {
    pixel: { src: 'web/img/cenarios/campus-pixel.jpg', sx: 0.37, sy: 0.41, sw: 0.63, sh: 0.275 },
    real:  { src: 'web/img/cenarios/campus-real.jpg', sx: 0.37, sy: 0.37, sw: 0.63, sh: 0.30 }
  };

  /* --- Textos em português e inglês --- */
  let lang = 'pt';
  const GAME_TEXT = {
    pt: {
      mode: 'MODO', time: 'TEMPO', go: 'VAI!', pilot: 'PILOTO', pts: 'PTS',
      result: '* RESULTADO OFICIAL *', years: 'ANOS', trackTime: 'TEMPO DE PISTA', maxSpeed: 'VEL. MAX',
      saving: 'SALVANDO NA CLASSIFICACAO...', paused: 'PAUSADO',
      resume: 'CONTINUAR', quit: 'MENU INICIAL', keysHint: 'TECLADO: ESC CONTINUA, Q VOLTA AO MENU',
      tests: '- TESTES DO PAINEL (ICM) -',
      kCan: 'C  FALHA NO BARRAMENTO CAN', kTemp: 'T  SENSOR TEMP. FORA DA FAIXA',
      kFan: 'H  FALHA NA VENTOINHA', kFuel: 'F  SENSOR COMBUSTIVEL', kRtos: 'R  MOSTRAR TAREFAS RTOS',
      kOor: 'O  CAN FORA DA FAIXA (9999 RPM)', kBelt: 'B  CINTO SOLTO', kHaz: 'P  PISCA-ALERTA', kStall: 'M  DESLIGAR O MOTOR',
      on: 'LIGADO', off: 'DESL.', hint: 'II OU ESC: PAUSA E TESTES',
      msgCanM1: 'FALHA CAN U0100', msgCanM2: 'FALHA CAN U0101', msgTempS: 'SENS.TEMP P0115',
      msgHot: 'MOTOR QUENTE!', msgFuelS: 'SENS.COMB P0460', msgNoFuel: 'SEM COMBUSTIVEL',
      msgReserve: 'RESERVA', msgLimit: 'LIMITE 60 KM/H', msgBoost: 'BOOST!', msgBulb: 'TESTE DE LUZES',
      lBrake: 'FREIO', lMil: 'MOTOR', lTemp: 'TEMP', lFuel: 'COMB', lOil: 'OLEO', trip: 'TRIP',
      lBelt: 'CINTO', lBat: 'BAT', msgOor: 'SINAL INVALIDO U0401', msgBelt: 'APERTE O CINTO',
      msgRev: 'GIRO ALTO! TROQUE MARCHA', msgEcon: 'CONSUMO', msgStall: 'MOTOR DESLIGADO',
      startBanner: 'LARGADA', finishBanner: 'CHEGADA',
      msgHand: 'FREIO DE MAO', fuel: 'COMB', lives: 'VIDAS', dtc: 'DTC', none: 'NENHUM',
      rtosTitle: 'TRAMPOLINE OSEK - TAREFAS', last1s: 'ULTIMO 1000 MS', frames: 'FRAMES',
      modes: { 'PASSEIO': 'PASSEIO', 'TRÂNSITO': 'TRANSITO', 'CORRIDA': 'CORRIDA' }
    },
    en: {
      mode: 'MODE', time: 'TIME', go: 'GO!', pilot: 'DRIVER', pts: 'PTS',
      result: '* OFFICIAL RESULT *', years: 'Y/O', trackTime: 'TRACK TIME', maxSpeed: 'TOP SPEED',
      saving: 'SAVING TO RANKING...', paused: 'PAUSED',
      resume: 'RESUME', quit: 'MAIN MENU', keysHint: 'KEYBOARD: ESC RESUMES, Q GOES TO MENU',
      tests: '- DASHBOARD TESTS (ICM) -',
      kCan: 'C  CAN BUS FAILURE', kTemp: 'T  TEMP SENSOR OUT OF RANGE',
      kFan: 'H  COOLING FAN FAILURE', kFuel: 'F  FUEL LEVEL SENSOR', kRtos: 'R  SHOW RTOS TASKS',
      kOor: 'O  CAN OUT OF RANGE (9999 RPM)', kBelt: 'B  SEATBELT UNBUCKLED', kHaz: 'P  HAZARD LIGHTS', kStall: 'M  ENGINE OFF',
      on: 'ON', off: 'OFF', hint: 'II OR ESC: PAUSE AND TESTS',
      msgCanM1: 'CAN FAULT U0100', msgCanM2: 'CAN FAULT U0101', msgTempS: 'TEMP SENS P0115',
      msgHot: 'ENGINE HOT!', msgFuelS: 'FUEL SENS P0460', msgNoFuel: 'OUT OF FUEL',
      msgReserve: 'LOW FUEL', msgLimit: 'LIMIT 60 KM/H', msgBoost: 'BOOST!', msgBulb: 'BULB CHECK',
      lBrake: 'BRAKE', lMil: 'CHECK', lTemp: 'TEMP', lFuel: 'FUEL', lOil: 'OIL', trip: 'TRIP',
      lBelt: 'BELT', lBat: 'BATT', msgOor: 'INVALID SIGNAL U0401', msgBelt: 'FASTEN SEATBELT',
      msgRev: 'HIGH RPM! SHIFT UP', msgEcon: 'ECONOMY', msgStall: 'ENGINE OFF',
      startBanner: 'START', finishBanner: 'FINISH',
      msgHand: 'PARKING BRAKE', fuel: 'FUEL', lives: 'LIVES', dtc: 'DTC', none: 'NONE',
      rtosTitle: 'TRAMPOLINE OSEK - TASKS', last1s: 'LAST 1000 MS', frames: 'FRAMES',
      modes: { 'PASSEIO': 'CRUISE', 'TRÂNSITO': 'TRAFFIC', 'CORRIDA': 'RACE' }
    }
  };
  function T(key) { return (GAME_TEXT[lang] || GAME_TEXT.pt)[key]; }
  function modeLabel(m) { return (T('modes') || {})[m] || m; }
  function setLang(l) { lang = (l === 'en') ? 'en' : 'pt'; }

  /* --- Estado da partida --- */
  let canvas, ctx, g;               // g é onde as funções de desenho pintam (tela ou camada offscreen)
  let W = 320, H = 180, pixelScale = 2;
  let RH = 115, CH = 65, horizonY = 46; // altura da pista, altura do painel e linha do horizonte
  let visual = 'pixel';

  let gameRunning = false;
  let gamePaused = false;
  let gameMode = 'PASSEIO';
  let playerInfo = { name: 'PILOTO', age: 21, car: 'CAMARO 69', carIndex: 0 };
  let onGameOverCallback = null;
  let car = CARS[0];

  // jogador
  let playerLane = 1, playerX = 0, targetX = 0;
  let speed = 0, position = 0, score = 0;   // speed em km/h, position em unidades do mundo (cm)
  let distanceM = 0, lap = 0, bumpShake = 0;
  let lives = 3, combo = 1, timeElapsed = 0, gameDuration = 60;
  let speedViolationTime = 0, speedRespected = true, raceFinished = false, checkpointsPassed = 0;
  let boostTimer = 0, boostActive = false;
  let maxKmh = 0;
  let hitFlash = 0;
  // galões de gasolina: aparecem na pista quando o tanque baixa; pegar um soma combustível
  let fuelCans = [], fuelPickup = 0;
  const CAN_REFILL = 20;   // % por galão

  let countdownActive = false, countdownValue = 3, countdownTimer = 0;
  let gameOverActive = false, gameOverTimer = 0, finalResult = null;

  let segments = [], obstacles = [], boostItems = [], sceneryObjects = [], speedBumps = [];
  let bgOffset = 0, cloudDrift = 0;

  const keys = {};
  let lastTime = 0, animFrameId = null;
  // áreas clicáveis desenhadas no canvas (em pixels do jogo): pausa, continuar, menu
  const hit = { pause: null, resume: null, quit: null };
  let lastUiTap = 0;
  let resizeObs = null;

  // o carro "de verdade": é daqui que saem os frames CAN e as leituras dos sensores
  const veh = {
    kmh: 0, rpm: 850, gear: 0, throttle: 0, brake: false, handbrake: true,
    fuel: 20, coolant: 62, turn: 0, turnTimer: 0, shiftTimer: 0
  };

  // falhas que dá pra ligar com o teclado pra mostrar o diagnóstico
  const faults = { can: false, tempSensor: false, fan: false, fuelSensor: false, oor: false, belt: false, stall: false };
  let hazard = false;
  let showRtos = false;

  /* --- ICM: dado compartilhado e simulação das tarefas OSEK --- */
  let icm = null;     // ICM_Data_t
  let disp = null;    // cópia que a Task_Display publica; o painel só desenha isso
  let simMs = 0, simAcc = 0;
  let canFifo = [];
  let taskStats = {};
  let telemetry = [];
  let resourceLocks = 0;

  function GetResource() { resourceLocks++; if (resourceLocks > maxLocks) maxLocks = resourceLocks; }      // no JS não tem concorrência de verdade, fica só pra ficar igual ao C
  function ReleaseResource() { resourceLocks--; }

  function icmInit() {
    icm = {
      rawRpm: 0, rawSpeed: 0, rawFuel: veh.fuel, rawTemp: veh.coolant,
      engine_rpm: 0, vehicle_speed_kmh: 0, gear: 0, brake: false, handbrake: true,
      fuel_level_percent: veh.fuel, coolant_temp_celsius: veh.coolant, turn_signal: 0,
      odometer_km: car.odo, trip_a_km: 0,
      last_m1_time_ms: 0, last_m2_time_ms: 0, current_time_ms: 0,
      warning_flags: 0, active_dtc: 'NONE', dtcHistory: [],
      fuelSensorOk: true, tempSensorOk: true, engine_state: 2, signal_out_of_range: false,
      seatbelt_buckled: true, instant_fuel_economy: 0,
      framesM1: 0, framesM2: 0
    };
    disp = Object.assign({}, icm, { needleSpeed: 0, needleRpm: 0 });
    simMs = 0; simAcc = 0; canFifo = [];
    telemetry = [];
    taskStats = {};
    TASK_DEFS.forEach(t => { taskStats[t.id] = { count: 0, hist: [], last: -1, minP: 0, maxP: 0, lastResp: 0, maxResp: 0, misses: 0 }; });
    tickJobs = []; jobLog = []; cpuFreeUs = 0; resourceErrors = 0; maxLocks = 0;
    lastDispMs = -1; dispMin = 0; dispMax = 0;
  }

  /* linha do tempo das tarefas (o que a bancada mostra): cada ativação vira um job com
     o custo do sim/wcet.csv, executado em ordem de prioridade na CPU simulada */
  let tickJobs = [], jobLog = [], cpuFreeUs = 0, resourceErrors = 0, maxLocks = 0;
  let lastDispMs = -1, dispMin = 0, dispMax = 0;
  const TASK_BY_ID = {};
  TASK_DEFS.forEach(t => { TASK_BY_ID[t.id] = t; });

  function scheduleTick() {
    if (!tickJobs.length) return;
    tickJobs.sort((a, b) => TASK_BY_ID[b.id].prio - TASK_BY_ID[a.id].prio);   // maior prioridade primeiro
    let t = Math.max(cpuFreeUs, simMs * 1000);
    tickJobs.forEach(j => {
      const def = TASK_BY_ID[j.id], st = taskStats[j.id];
      j.start = t; j.end = t + def.cost; t = j.end;
      const resp = j.end - j.release;
      st.lastResp = resp; if (resp > st.maxResp) st.maxResp = resp;
      if (resp > def.deadline * 1000) st.misses++;
      jobLog.push(j);
    });
    cpuFreeUs = t;
    tickJobs = [];
    while (jobLog.length && jobLog[0].release < (simMs - 1100) * 1000) jobLog.shift();
  }

  function markActivation(id) {
    const s = taskStats[id];
    if (s.last >= 0 && TASK_BY_ID[id].period) {
      const p = simMs - s.last;
      if (!s.minP || p < s.minP) s.minP = p;
      if (p > s.maxP) s.maxP = p;
    }
    s.last = simMs;
    tickJobs.push({ id: id, release: simMs * 1000 });
    s.count++;
    s.hist.push(simMs);
    while (s.hist.length && s.hist[0] < simMs - 1000) s.hist.shift();
  }

  // ECU e TCM do carro colocando frames no barramento
  function busTransmit(frame) {
    if (faults.can) return;          // tecla C: barramento mudo, o ICM vai acusar timeout
    canFifo.push(frame);
    ISR2_CAN();                      // chegou frame: interrupção do controlador CAN
  }

  function ISR2_CAN() {
    markActivation('ISR2_CAN');
    // equivale ao SetEvent(Task_CAN_RX); como ela tem prioridade maior, roda na hora
    Task_CAN_RX();
  }

  function Task_CAN_RX() {
    markActivation('Task_CAN_RX');
    while (canFifo.length) {
      const f = canFifo.shift();
      GetResource();
      if (f.id === CAN_ID_M1_ENGINE) {
        const raw = (f.data[0] << 8) | f.data[1];
        const rpm = raw * 0.25;
        // RS-05: acima de 8500 rpm o valor é descartado e fica o último válido
        const okM1 = rpm <= RPM_OOR;
        if (!okM1) icm.signal_out_of_range = true;
        else { icm.rawRpm = Math.min(8000, rpm); icm.signal_out_of_range = false; }
        icm.lastM1 = { ts: f.ts, bytes: f.data.slice(0, 4), raw: raw, value: rpm, valid: okM1 };
        icm.engine_state = f.data[3];
        icm.last_m1_time_ms = f.ts;
        icm.framesM1++;
      } else if (f.id === CAN_ID_M2_VEHICLE) {
        const raw = (f.data[0] << 8) | f.data[1];
        const kmh = raw * 0.05;
        const okM2 = kmh <= SPEED_OOR;
        if (!okM2) icm.signal_out_of_range = true;
        else icm.rawSpeed = Math.min(250, kmh);
        icm.lastM2 = { ts: f.ts, bytes: f.data.slice(0, 5), raw: raw, value: kmh, valid: okM2 };
        icm.gear = (f.data[2] << 24) >> 24;   // int8
        icm.brake = f.data[3] !== 0;
        icm.handbrake = f.data[4] !== 0;
        icm.last_m2_time_ms = f.ts;
        icm.framesM2++;
      }
      ReleaseResource();
    }
  }

  // 10 ms: lê os sensores (em volts, como viria do ADC) e as setas
  function Task_Acquisition() {
    markActivation('Task_Acquisition');
    // combustível: 0.5 a 4.5 V. Abaixo de 0.3 ou acima de 4.7 é fio solto/curto
    const vFuel = faults.fuelSensor ? 4.92 : 0.5 + (veh.fuel / 100) * 4.0;
    // temperatura (NTC): 0.2 a 4.8 V = 40 a 120 °C. Fora de 0.1..4.9 V é falha
    const vTemp = faults.tempSensor ? 4.97 : 0.2 + ((veh.coolant - 40) / 80) * 4.6;
    GetResource();
    icm.fuelSensorOk = vFuel >= 0.3 && vFuel <= 4.7;
    icm.tempSensorOk = vTemp >= 0.1 && vTemp <= 4.9;
    if (icm.fuelSensorOk) icm.rawFuel = Math.max(0, Math.min(100, (vFuel - 0.5) / 4.0 * 100));
    if (icm.tempSensorOk) icm.rawTemp = 40 + (vTemp - 0.2) / 4.6 * 80;
    icm.turn_signal = hazard ? 3 : veh.turn;      // 3 = pisca-alerta (TURN_HAZARD)
    icm.seatbelt_buckled = !faults.belt;
    ReleaseResource();
  }

  // 20 ms: mesmo filtro passa-baixas do ICM_FilterAndScale() (mesmos alfas)
  function Task_Processing() {
    markActivation('Task_Processing');
    GetResource();
    icm.vehicle_speed_kmh += 0.25 * (icm.rawSpeed - icm.vehicle_speed_kmh);
    icm.engine_rpm += 0.35 * (icm.rawRpm - icm.engine_rpm);
    icm.fuel_level_percent += 0.05 * (icm.rawFuel - icm.fuel_level_percent);
    icm.coolant_temp_celsius += 0.05 * (icm.rawTemp - icm.coolant_temp_celsius);
    ReleaseResource();
  }

  // 50 ms: copia o ICM_Data pro display (igual ao ICM_GetDataCopy)
  function Task_Display() {
    markActivation('Task_Display');
    if (lastDispMs >= 0) { const iv = simMs - lastDispMs; if (!dispMin || iv < dispMin) dispMin = iv; if (iv > dispMax) dispMax = iv; }
    lastDispMs = simMs;
    GetResource();
    const ns = disp ? disp.needleSpeed : 0;
    const nr = disp ? disp.needleRpm : 0;
    disp = Object.assign({}, icm);
    ReleaseResource();
    // o ponteiro anda com velocidade limitada, tipo motor de passo de painel:
    // escala toda em ~0.8 s no velocímetro e ~0.5 s no conta-giros
    const stepS = 250 / 16, stepR = 8000 / 10;
    disp.needleSpeed = ns + Math.max(-stepS, Math.min(stepS, disp.vehicle_speed_kmh - ns));
    disp.needleRpm = nr + Math.max(-stepR, Math.min(stepR, disp.engine_rpm - nr));
  }

  // 100 ms: mesma lógica do ICM_EvaluateDiagnostics()
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
      icm.engine_rpm = 0; icm.rawRpm = 0;            // fail-safe: rpm vai a zero
    }
    if (icm.last_m2_time_ms > 0 && (now - icm.last_m2_time_ms) > CAN_M2_TIMEOUT_MS) {
      flags |= FLAG_CAN_M2_TIMEOUT | FLAG_MIL_CHECK_ENG;
      if (dtc === 'NONE') dtc = 'U0101';
      active.push('U0101');
      icm.vehicle_speed_kmh = 0; icm.rawSpeed = 0;   // fail-safe: velocidade vai a zero
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
    if (!icm.seatbelt_buckled) flags |= FLAG_SEATBELT_WARN;
    // motor parado (estado 0 no M1): sem pressão de óleo e sem carga na bateria
    if (icm.last_m1_time_ms > 0 && !(flags & FLAG_CAN_M1_TIMEOUT) && icm.engine_state === 0) flags |= FLAG_OIL_PRESS_LOW | FLAG_BATTERY_FAULT;
    if (icm.signal_out_of_range) {
      flags |= FLAG_SIGNAL_OOR | FLAG_MIL_CHECK_ENG;
      if (dtc === 'NONE') dtc = 'U0401';
      active.push('U0401');
    }

    icm.warning_flags = flags;
    icm.active_dtc = dtc;
    active.forEach(code => { if (icm.dtcHistory.indexOf(code) < 0) icm.dtcHistory.push(code); });
    ReleaseResource();
  }

  // 1000 ms: odômetro, trip e telemetria (ICM_UpdateLogging)
  function Task_Logging() {
    markActivation('Task_Logging');
    GetResource();
    const distKm = (icm.vehicle_speed_kmh / 3600) * 1.0;
    icm.odometer_km += distKm;
    icm.trip_a_km += distKm;
    if (icm.vehicle_speed_kmh > 5 && icm.engine_rpm > 500) {
      icm.instant_fuel_economy = 8 * (icm.vehicle_speed_kmh / (icm.engine_rpm * 0.035 + 10));
    } else icm.instant_fuel_economy = 0;
    telemetry.push({
      t: simMs, speed: +icm.vehicle_speed_kmh.toFixed(1), rpm: Math.round(icm.engine_rpm),
      fuel: +icm.fuel_level_percent.toFixed(1), temp: +icm.coolant_temp_celsius.toFixed(1),
      flags: icm.warning_flags, dtc: icm.active_dtc
    });
    if (telemetry.length > 300) telemetry.shift();
    ReleaseResource();
  }

  // um tick de 1 ms do SystemCounter. Quando várias tarefas vencem no mesmo ms,
  // a ordem das chamadas segue a prioridade (maior primeiro)
  function osTick() {
    simMs++;
    // mensagens periódicas do ECM (M1) e do TCM (M2)
    if (simMs % CAN_M1_PERIOD_MS === 0) {
      const raw = Math.round((faults.oor ? 9999 : Math.min(8000, veh.rpm)) / 0.25);   // tecla O: ECM mandando 9999 rpm
      const engState = engineOff() ? 0 : (veh.rpm > 7000 ? 3 : 2);
      busTransmit({ id: CAN_ID_M1_ENGINE, ts: simMs,
        data: [(raw >> 8) & 255, raw & 255, Math.round(veh.throttle * 200) & 255, engState, 0, 0, 0, 0] });
    }
    if (simMs % CAN_M2_PERIOD_MS === 0) {
      const raw = Math.round(Math.min(250, veh.kmh) / 0.05);
      busTransmit({ id: CAN_ID_M2_VEHICLE, ts: simMs,
        data: [(raw >> 8) & 255, raw & 255, veh.gear & 255, veh.brake ? 1 : 0, veh.handbrake ? 1 : 0, 0, 0, 0] });
    }
    // alarmes das tarefas periódicas (prioridade 8 até 1)
    if (simMs % 10 === 0) Task_Acquisition();
    if (simMs % 20 === 0) Task_Processing();
    if (simMs % 50 === 0) Task_Display();
    if (simMs % 100 === 0) Task_Diagnostics();
    if (simMs % 1000 === 0) Task_Logging();
    if (resourceLocks !== 0) { resourceErrors++; resourceLocks = 0; }   // toda tarefa tem que devolver o recurso
    scheduleTick();
  }

  /* --- Gerador pseudoaleatório com semente fixa --- */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* --- Pista e cenário --- */
  // circuito fechado: 4 curvas de 90° pra direita e uns "S" nas retas. [segmentos, curva]
  const CIRCUIT = [
    [120, 0], [100, 1.6], [140, 0], [60, -1.4], [60, 1.4], [110, 0],
    [100, 1.6], [160, 0], [50, 1.2], [50, -1.2], [60, 0],
    [100, 1.6], [140, 0], [60, -1.4], [60, 1.4], [110, 0],
    [100, 1.6], [120, 0]
  ];   // soma 1800 = TOTAL_SEGMENTS
  const MAP_TURN = (Math.PI / 2) / (1.6 * 100);   // quanto cada "1 de curva" gira no mapa (curva de 1.6 x 100 = 90°)
  let minimap = null;

  function buildCircuit() {
    segments = [];
    CIRCUIT.forEach(([len, curve]) => { for (let k = 0; k < len; k++) segments.push({ index: segments.length, curve: curve }); });
    while (segments.length < TOTAL_SEGMENTS) segments.push({ index: segments.length, curve: 0 });
    buildMinimap();
    buildScenery();
    obstacles = []; speedBumps = []; boostItems = [];
    if (gameMode === 'TRÂNSITO') buildTrafficObstacles();
    if (gameMode === 'PASSEIO') buildSpeedBumps();
    if (gameMode === 'CORRIDA') buildBoostItems();
  }

  function buildScenery() {
    sceneryObjects = [];
    const rng = mulberry32(1909); // 1909, ano de fundação da UTFPR
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
      // arbustos baixos pra encher o gramado perto da pista
      if (rng() > 0.55) sceneryObjects.push({ segIndex: i, type: 'bush', side: rng() > 0.5 ? 1 : -1, offset: 1.28 + rng() * 0.5,
        shade: rng() > 0.5 ? 0 : 1 });
      // placas de estrada e outdoors
      if (i % 150 === 40) sceneryObjects.push({ segIndex: i, type: 'sign', side: 1, offset: 1.36, text: (i / 150) % 2 ? 'UTFPR' : 'P.GROSSA' });
      if (i % 300 === 120) sceneryObjects.push({ segIndex: i, type: 'billboard', side: -1, offset: 1.75,
        text: ['ICM TRAMPOLINE', 'OSEK VDX', 'CAN 500 MS', 'RTOS 1909'][(i / 300 | 0) % 4] });
    }
    // modo corrida: pórtico de largada/chegada, pórticos de checkpoint e arquibancada
    if (gameMode === 'CORRIDA') {
      sceneryObjects.push({ segIndex: TOTAL_SEGMENTS - 2, type: 'gantry', label: T('finishBanner'), checker: true });
      sceneryObjects.push({ segIndex: 4, type: 'gantry', label: T('startBanner'), checker: true });
      [1, 2].forEach(k => sceneryObjects.push({ segIndex: Math.round(TOTAL_SEGMENTS * k / 3), type: 'gantry', label: 'CHECKPOINT ' + k, checker: false }));
      for (let i = 10; i < 70; i += 6) {
        sceneryObjects.push({ segIndex: i, type: 'stands', side: -1, offset: 1.55 });
        sceneryObjects.push({ segIndex: TOTAL_SEGMENTS - 60 + i - 10, type: 'stands', side: 1, offset: 1.55 });
      }
    }
    // índice por segmento: o desenho não precisa varrer a lista inteira a cada faixa
    sceneryBySeg = new Array(TOTAL_SEGMENTS);
    sceneryObjects.forEach(sc => { (sceneryBySeg[sc.segIndex] = sceneryBySeg[sc.segIndex] || []).push(sc); });
  }
  let sceneryBySeg = [];

  function buildTrafficObstacles() {
    const rng = mulberry32(456);
    for (let i = 60; i < TOTAL_SEGMENTS - 30; i += 16) {
      const difficulty = 0.25 + (i / TOTAL_SEGMENTS) * 0.45;
      if (rng() < difficulty) {
        const types = ['cone', 'placa', 'fusca', 'barreira'];
        obstacles.push({ segIndex: i, lane: Math.floor(rng() * LANE_COUNT), type: types[Math.floor(rng() * types.length)], hit: false,
          color: ['#2f6fd6', '#e9e4d4', '#d94141', '#3aa55d'][Math.floor(rng() * 4)] });
      }
    }
  }

  function buildSpeedBumps() {
    for (let i = 110; i < TOTAL_SEGMENTS - 40; i += 70) speedBumps.push({ segIndex: i, lap: -1 });   // uma a cada 140 m
  }

  function buildBoostItems() {
    const rng = mulberry32(888);
    for (let i = 90; i < TOTAL_SEGMENTS - 30; i += 90) {
      if (rng() > 0.35) boostItems.push({ segIndex: i, lane: Math.floor(rng() * LANE_COUNT), collected: false });
    }
  }

  /* --- Controles --- */
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

    // teclas de teste do painel, valem dirigindo ou no pause
    if (!e.repeat) {
      if (e.code === 'KeyC') { faults.can = !faults.can; redrawIfPaused(); }
      if (e.code === 'KeyT') { faults.tempSensor = !faults.tempSensor; redrawIfPaused(); }
      if (e.code === 'KeyH') { faults.fan = !faults.fan; redrawIfPaused(); }
      if (e.code === 'KeyF') { faults.fuelSensor = !faults.fuelSensor; redrawIfPaused(); }
      if (e.code === 'KeyR') { showRtos = !showRtos; redrawIfPaused(); }
      if (e.code === 'KeyO') { faults.oor = !faults.oor; redrawIfPaused(); }
      if (e.code === 'KeyB') { faults.belt = !faults.belt; redrawIfPaused(); }
      if (e.code === 'KeyM') { faults.stall = !faults.stall; redrawIfPaused(); }
      if (e.code === 'KeyP') { hazard = !hazard; redrawIfPaused(); }
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

  // converte o clique da tela pra coordenada do jogo e vê se acertou algum botão
  function inside(r, x, y) { return r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h; }
  function toGame(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width * W, y: (e.clientY - rect.top) / rect.height * H };
  }

  function onPointerDown(e) {
    if (!gameRunning || gameOverActive) return;
    const p = toGame(e);
    let used = false;
    if (gamePaused) {
      if (inside(hit.resume, p.x, p.y)) { togglePause(); used = true; }
      else if (inside(hit.quit, p.x, p.y)) { swallowNextClick(); exitToMenu(); used = true; }
    } else if (inside(hit.pause, p.x, p.y)) {
      togglePause(); used = true;
    }
    if (used) { lastUiTap = performance.now(); e.preventDefault(); }
  }

  // no celular o toque ainda gera um "click" depois que o jogo já fechou;
  // sem isso ele cai no botão JOGAR que fica embaixo e abre o jogo de novo
  function swallowNextClick() {
    const eat = ev => { ev.stopPropagation(); ev.preventDefault(); };
    document.addEventListener('click', eat, true);
    setTimeout(() => document.removeEventListener('click', eat, true), 500);
  }

  // mãozinha em cima dos botões
  function onPointerMove(e) {
    if (!gameRunning || e.pointerType === 'touch') return;
    const p = toGame(e);
    const over = gamePaused ? (inside(hit.resume, p.x, p.y) || inside(hit.quit, p.x, p.y)) : inside(hit.pause, p.x, p.y);
    canvas.style.cursor = over ? 'pointer' : '';
  }

  function onTouchStart(e) {
    if (!gameRunning) return;
    e.preventDefault();
    if (gamePaused || countdownActive || gameOverActive) return;
    if (performance.now() - lastUiTap < 400) return;   // o toque foi no botão de pausa, não é pra trocar de faixa
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

  /* --- Início e fim da partida --- */
  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    g = ctx;
  }

  function setVisualMode(real) {
    const v = real ? 'real' : 'pixel';
    if (v === visual) return;
    visual = v;
    if (benchMode) { resizeBench(); return; }
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
    speed = 0; position = 0; score = 0; distanceM = 0; lap = 0; bumpShake = 0;
    lives = 3; combo = 1; timeElapsed = 0;
    speedViolationTime = 0; speedRespected = true; raceFinished = false; checkpointsPassed = 0;
    boostTimer = 0; boostActive = false; maxKmh = 0; hitFlash = 0; fuelCans = []; fuelPickup = 0;
    gameOverActive = false; gameOverTimer = 0; finalResult = null;
    gameDuration = (mode === 'CORRIDA') ? 999 : 60;
    bgOffset = 0; cloudDrift = 0;
    faults.can = faults.tempSensor = faults.fan = faults.fuelSensor = faults.oor = faults.belt = faults.stall = false;
    hazard = false;
    showRtos = false;

    Object.assign(veh, { kmh: 0, rpm: car.spec.idle, gear: 0, throttle: 0, brake: false, handbrake: true, shiftTimer: 0,
      fuel: mode === 'CORRIDA' ? 42 : 26, coolant: 62, turn: 0, turnTimer: 0 });
    icmInit();
    bulbUntil = 1500;
    stopBench();

    buildCircuit();
    resizeCanvas();

    countdownActive = true; countdownValue = 3; countdownTimer = 0;
    gameRunning = true; gamePaused = false;

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', resizeCanvas);
    // trocar pixel/real muda o tamanho da tela do tablet; sem isso o canvas ficava cortado
    if (window.ResizeObserver && !resizeObs) {
      let lastW = 0, lastH = 0;
      resizeObs = new ResizeObserver(entries => {
        const r = entries[0].contentRect;
        if (Math.abs(r.width - lastW) > 0.5 || Math.abs(r.height - lastH) > 0.5) { lastW = r.width; lastH = r.height; resizeCanvas(); }
      });
      resizeObs.observe(canvas.parentElement);
    }
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });

    lastTime = performance.now();
    animFrameId = requestAnimationFrame(gameLoop);
  }

  // resolução baixa e ampliação inteira: cada pixel do jogo vira N pixels da tela
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
    alarmSound(false);
    if (hiCanvas) hiCanvas.style.display = 'none';
    gameRunning = false;
    gamePaused = false;
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('resize', resizeCanvas);
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    if (canvas) {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.style.cursor = '';
    }
    Object.keys(keys).forEach(k => keys[k] = false);
  }

  function togglePause() {
    if (!gameRunning || gameOverActive) return;
    gamePaused = !gamePaused;
    if (gamePaused) {
      alarmSound(false);
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
  function isPaused() { return gameRunning && gamePaused; }

  let bulbUntil = 1500;   // até quando (em ms do RTOS) dura o teste de lâmpadas

  /* --- Bancada de testes (painel fora do jogo, na garagem) ---
   * Mesmo ICM e mesmo painel do jogo, só que os valores vêm dos controles da tela em vez
   * da física: os controles mexem no "carro", o carro manda os frames M1/M2, a ISR acorda a
   * Task_CAN_RX e o resto do caminho é idêntico (filtro, diagnóstico, display).
   */
  let benchMode = false, benchObs = null, benchFrame = null, benchLast = 0;
  let benchDrive = false;      // true = dirigindo pelo teclado (↑ ↓), false = valores dos controles
  let benchOnTurn = null;      // avisa o site.js quando a seta muda pelo teclado
  const bench = { kmh: 0, rpm: 850, fuel: 60, temp: 88, turn: 0, hand: false };

  // teclado na bancada: ↑/W acelera, ↓/S/espaço freia (física do carro), ←/→ ligam e desligam as setas
  function benchKeyDown(e) {
    if (!benchMode || e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    const drive = ['ArrowUp', 'KeyW', 'ArrowDown', 'KeyS', 'Space'];
    if (drive.includes(e.code)) {
      if (!benchDrive) { benchDrive = true; speed = veh.kmh; if (veh.gear < 1) veh.gear = 1; }
      keys[e.code] = true; e.preventDefault();
    }
    if (!e.repeat && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      const want = e.code === 'ArrowLeft' ? 1 : 2;
      bench.turn = bench.turn === want ? 0 : want;
      if (benchOnTurn) benchOnTurn(bench.turn);
      e.preventDefault();
    }
  }
  function benchKeyUp(e) { keys[e.code] = false; }

  function startBench(canvasEl, opts) {
    if (gameRunning) stop();
    stopBench();
    init(canvasEl);
    benchMode = true;
    car = CARS[opts && opts.carIndex] || CARS[0];
    if (opts && typeof opts.realMode === 'boolean') visual = opts.realMode ? 'real' : 'pixel';
    gameMode = 'BANCADA';
    countdownActive = false; gameOverActive = false; boostActive = false; speed = 0;
    faults.can = faults.tempSensor = faults.fan = faults.fuelSensor = faults.oor = faults.belt = faults.stall = false;
    hazard = false;
    Object.assign(bench, { kmh: 0, rpm: car.spec.idle, fuel: 60, temp: 88, turn: 0, hand: false });
    Object.assign(veh, { kmh: 0, rpm: car.spec.idle, gear: 0, throttle: 0.2, brake: false, handbrake: false, shiftTimer: 0,
      fuel: 60, coolant: 88, turn: 0, turnTimer: 0 });
    icmInit();
    bulbUntil = 1500;
    resizeBench();
    if (window.ResizeObserver) { benchObs = new ResizeObserver(() => resizeBench()); benchObs.observe(canvas.parentElement); }
    benchDrive = false;
    Object.keys(keys).forEach(k => keys[k] = false);
    window.addEventListener('keydown', benchKeyDown);
    window.addEventListener('keyup', benchKeyUp);
    benchLast = performance.now();
    benchFrame = requestAnimationFrame(benchLoop);
  }

  function resizeBench() {
    if (!benchMode || !canvas) return;
    const r = canvas.parentElement.getBoundingClientRect();
    const cssW = Math.max(1, r.width), cssH = Math.max(1, r.height);
    if (visual === 'real') {
      // modo real: canvas em resolução de tela, painel liso
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      canvas.style.imageRendering = 'auto';
      return;
    }
    canvas.style.imageRendering = '';
    pixelScale = cssW < 520 ? 2 : Math.max(2, Math.round(cssW / 380));
    W = Math.ceil(cssW / pixelScale); H = Math.ceil(cssH / pixelScale);
    canvas.width = W; canvas.height = H;
    canvas.style.width = (W * pixelScale) + 'px'; canvas.style.height = (H * pixelScale) + 'px';
    ctx.imageSmoothingEnabled = false;
    RH = 0; CH = H;                        // o canvas inteiro é o painel
    buildClusterStatic();
  }

  function benchLoop(t) {
    if (!benchMode) return;
    const dt = Math.min((t - benchLast) / 1000, 0.05);
    benchLast = t;
    veh.turn = bench.turn; veh.handbrake = bench.hand;
    if (benchDrive) {
      // dirigindo: mesma física do jogo (câmbio, potência, freio, consumo, temperatura)
      updateVehicle(dt);
      veh.fuel = Math.max(0, veh.fuel - dt * 0.4 * (0.2 + veh.rpm / 8000));   // gasta mais rápido que no jogo, pra dar pra ver
      Object.assign(bench, { kmh: veh.kmh, rpm: veh.rpm, fuel: veh.fuel, temp: veh.coolant });
    } else {
      // valores dos controles: o "carro" vai atrás com inércia, como ponteiro de verdade
      const off = faults.stall || bench.fuel <= 0;
      veh.kmh += (bench.kmh - veh.kmh) * Math.min(1, dt * 3);
      veh.rpm += ((off ? 0 : bench.rpm) - veh.rpm) * Math.min(1, dt * 5);
      // motor ligado gasta combustível, mais quanto maior a rotação
      if (!off) bench.fuel = Math.max(0, bench.fuel - dt * (0.1 + bench.rpm / 8000));
      veh.fuel = bench.fuel; veh.coolant = bench.temp;
      veh.gear = veh.kmh < 1 ? 0 : (veh.kmh < 70 ? 1 : (veh.kmh < 120 ? 2 : 3));
      speed = veh.kmh;
    }
    simAcc += dt * 1000;
    while (simAcc >= 1) { simAcc -= 1; osTick(); }
    g = ctx;
    if (visual === 'real') drawRealCluster(ctx, canvas.width, canvas.height);
    else { ctx.clearRect(0, 0, W, H); drawCluster(); }
    alarmSound(true);
    benchFrame = requestAnimationFrame(benchLoop);
  }

  function stopBench() {
    if (!benchMode) return;
    benchMode = false;
    window.removeEventListener('keydown', benchKeyDown);
    window.removeEventListener('keyup', benchKeyUp);
    if (benchFrame) cancelAnimationFrame(benchFrame);
    if (benchObs) { benchObs.disconnect(); benchObs = null; }
    alarmSound(false);
  }

  // controles da bancada: valores (kmh, rpm, fuel, temp) e liga/desliga (setas, falhas...)
  function benchSet(key, value) {
    if (key in bench) {
      // mexeu num controle de valor: sai do modo teclado, partindo de onde o carro está
      if (benchDrive && key !== 'turn' && key !== 'hand') {
        benchDrive = false;
        Object.assign(bench, { kmh: veh.kmh, rpm: veh.rpm, fuel: veh.fuel, temp: veh.coolant });
      }
      bench[key] = value; return;
    }
    if (key === 'hazard') hazard = !!value;
    else if (key in faults) faults[key] = !!value;
    else if (key === 'bulb') bulbUntil = simMs + 1500;
  }

  /* --- Alarme sonoro (RS-03) ---
   * Motor quente: bipe contínuo (liga/desliga a cada 200 ms) enquanto a flag estiver ativa.
   * Cinto solto: um "plim" por segundo, como nos carros.
   */
  let audio = null;
  function alarmSound(on) {
    if (!audio && !on) return;
    try {
      if (!audio) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ac = new AC(), osc = ac.createOscillator(), gain = ac.createGain();
        osc.type = 'square'; gain.gain.value = 0;
        osc.connect(gain); gain.connect(ac.destination); osc.start();
        audio = { ac, osc, gain };
      }
      const f = (disp && on) ? disp.warning_flags : 0;
      let vol = 0, freq = 880;
      if (f & FLAG_COOLANT_HOT) { vol = Math.floor(simMs / 200) % 2 === 0 ? 0.06 : 0; freq = 880; }
      else if (f & FLAG_SEATBELT_WARN) { vol = simMs % 1000 < 140 ? 0.05 : 0; freq = 660; }
      audio.osc.frequency.setValueAtTime(freq, audio.ac.currentTime);
      audio.gain.gain.setTargetAtTime(vol, audio.ac.currentTime, 0.005);
    } catch (e) { /* sem áudio não tem problema, o painel continua */ }
  }

  /* --- Loop principal --- */
  function gameLoop(timestamp) {
    if (!gameRunning || gamePaused) return;
    const dt = Math.min((timestamp - lastTime) / 1000, 0.05);
    lastTime = timestamp;
    update(dt);
    draw();
    alarmSound(!gameOverActive);
    animFrameId = requestAnimationFrame(gameLoop);
  }

  function update(dt) {
    // o relógio do RTOS corre até na contagem regressiva (é a ignição ligada)
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

    if (boostActive) { boostTimer -= dt; if (boostTimer <= 0) boostActive = false; }
    if (bumpShake > 0) bumpShake -= dt;

    // a velocidade já foi calculada no updateVehicle; aqui o carro anda na pista
    const stepM = speed / 3.6 * dt;
    distanceM += stepM;
    position += stepM * UNITS_PER_METER;
    const trackLen = TOTAL_SEGMENTS * SEGMENT_LENGTH;
    if (position >= trackLen) {
      if (gameMode === 'CORRIDA') { raceFinished = true; triggerGameOver(); return; }
      position -= trackLen; lap++;
    }

    targetX = (playerLane - 1) * ROAD_WIDTH * 0.33;
    playerX += (targetX - playerX) * Math.min(1, LANE_SWITCH_SPEED * dt);

    const currentSegIdx = Math.floor(position / SEGMENT_LENGTH) % TOTAL_SEGMENTS;
    // prédios do fundo giram nas curvas, proporcional ao quanto o carro andou
    bgOffset += segments[currentSegIdx].curve * (stepM * UNITS_PER_METER / SEGMENT_LENGTH) * 0.36;
    cloudDrift += dt * 2;

    if (gameMode === 'PASSEIO') {
      if (speed > PASSEIO_SPEED_LIMIT) { speedViolationTime += dt; speedRespected = false; }
      // lombada: passou acima de 25 km/h, o carro dá um tranco e perde velocidade
      for (const bump of speedBumps) {
        if (bump.lap === lap || currentSegIdx < bump.segIndex || currentSegIdx > bump.segIndex + 2) continue;
        bump.lap = lap;
        if (speed > 25) { speed -= (speed - 20) * 0.35; bumpShake = 0.35; speedRespected = false; }
      }
      score = 0;   // passeio não tem pontuação
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
      score = Math.floor(distanceM * 1.85 * combo);
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

    updateFuelCans(dt, currentSegIdx);

    // o passeio é livre: não acaba sozinho (sai pelo pause → MENU INICIAL)
    if (gameMode === 'TRÂNSITO' && timeElapsed >= gameDuration) triggerGameOver();
  }

  // quanto menos combustível, mais perto um do outro os galões aparecem (de ~600 m até ~200 m)
  function updateFuelCans(dt, seg) {
    if (fuelPickup > 0) fuelPickup -= dt;
    const ahead = c => (c.segIndex - seg + TOTAL_SEGMENTS) % TOTAL_SEGMENTS;
    // pegou?
    for (const c of fuelCans) {
      if (c.collected) continue;
      const d = ahead(c);
      if ((d < 2 || d > TOTAL_SEGMENTS - 2) && c.lane === playerLane) {
        c.collected = true;
        veh.fuel = Math.min(100, veh.fuel + CAN_REFILL);
        fuelPickup = 1.6;
      }
    }
    // tira os que ficaram pra trás
    fuelCans = fuelCans.filter(c => !c.collected && ahead(c) < TOTAL_SEGMENTS - 40);
    if (veh.fuel >= 45) return;
    const spacing = 100 + veh.fuel * 7;
    const farthest = fuelCans.reduce((m, c) => Math.max(m, ahead(c)), 0);
    if (fuelCans.length === 0 || farthest < spacing) {
      const at = Math.round(seg + Math.max(110, farthest + spacing)) % TOTAL_SEGMENTS;
      const busy = obstacles.some(o => Math.abs(o.segIndex - at) < 4) || speedBumps.some(b => Math.abs(b.segIndex - at) < 4);
      if (!busy) fuelCans.push({ segIndex: at, lane: Math.floor(Math.random() * LANE_COUNT), collected: false });
    }
  }

  // rotação que o motor teria numa marcha, a partir da velocidade (sem patinar)
  function engineOff() { return faults.stall || veh.fuel <= 0; }   // na bancada o veh.fuel vem do controle

  function gearRpm(kmh, gear) {
    const sp = car.spec;
    return (kmh / 3.6) / sp.tire * 60 * sp.ratios[gear - 1] * sp.final;
  }

  // motor, câmbio e dinâmica do carro (o que a ECU e o TCM mediriam)
  function updateVehicle(dt) {
    const sp = car.spec;
    const driving = !countdownActive && !gameOverActive;
    const accel = driving && (keys['ArrowUp'] || keys['KeyW']);
    const braking = driving && !!(keys['ArrowDown'] || keys['KeyS'] || keys['Space']);
    veh.throttle += ((accel ? 1 : 0) - veh.throttle) * Math.min(1, dt * 6);
    veh.brake = braking;

    let rpmTarget;
    if (!driving && countdownActive) {
      veh.gear = 0;                            // parado na largada, ponto morto e freio de mão
      rpmTarget = sp.idle + Math.sin(performance.now() / 90) * 20 + veh.throttle * 3000;
    } else {
      if (veh.gear < 1) veh.gear = 1;
      const thr = veh.throttle;
      // troca de marcha: o automático sobe cedo se você alivia o pé; o "motorista" do manual estica mais
      const upAt = sp.auto ? 1800 + (sp.redline - 500 - 1800) * thr : 2200 + (sp.redline - 300 - 2200) * thr;
      const downAt = sp.auto ? 1100 + 1500 * thr : 1300 + 1200 * thr;
      if (veh.shiftTimer <= 0) {
        if (veh.gear < 3 && gearRpm(speed, veh.gear) > upAt) { veh.gear++; veh.shiftTimer = sp.shiftTime; }
        else if (veh.gear > 1 && gearRpm(speed, veh.gear) < downAt) { veh.gear--; veh.shiftTimer = sp.shiftTime * 0.8; }
      }
      if (veh.shiftTimer > 0) veh.shiftTimer -= dt;

      // força na roda: limitada pela potência e pela aderência dos pneus
      let power = sp.powerW * thr;
      if (boostActive) power *= 1.5;                       // "nitro" da corrida
      if (veh.coolant >= COOLANT_HOT_C) power *= 0.55;      // motor quente: a injeção corta potência
      if (engineOff()) power = 0;                           // pane seca ou motor desligado (tecla M)
      if (veh.shiftTimer > 0) power *= sp.auto ? 0.5 : 0;  // no manual a embreagem fica aberta na troca
      const gr = gearRpm(speed, veh.gear);
      if (gr >= sp.limiter) power = 0;                      // corte de giro
      const v = speed / 3.6;
      let a = Math.min(sp.grip * (power > 0 ? 1 : 0), power / (sp.mass * Math.max(v, 1)));
      // o que segura: ar, rolamento e freio-motor
      a -= 0.6 * sp.cdA * v * v / sp.mass + 0.15 + (thr < 0.1 && v > 1 ? 0.35 + 0.6 * gr / sp.redline : 0);
      if (braking) a -= sp.brake;
      speed = Math.max(0, Math.min(SPEED_CAP_KMH, speed + a * 3.6 * dt));

      // rotação: acoplada na roda; parado/saindo, o conversor (ou a embreagem) deixa o motor subir
      rpmTarget = Math.max(gearRpm(speed, veh.gear), sp.idle);
      if (veh.gear === 1 && speed < 30) rpmTarget = Math.max(rpmTarget, sp.idle + thr * (sp.launch - sp.idle) * (1 - speed / 30));
      if (veh.shiftTimer > 0 && !sp.auto) rpmTarget = Math.max(sp.idle, rpmTarget * 0.9);
      if (engineOff()) rpmTarget = 0;
    }
    veh.kmh = speed;
    if (veh.kmh > maxKmh) maxKmh = veh.kmh;
    veh.rpm += (Math.min(8000, rpmTarget) - veh.rpm) * Math.min(1, dt * 10);

    // consumo em %/s, depende da rotação e do acelerador
    if (veh.fuel > 0) veh.fuel = Math.max(0, veh.fuel - dt * (0.03 + (veh.rpm / 8000) * (0.08 + 0.24 * veh.throttle)));

    // temperatura sobe até uns 88 °C; giro alto e a falha da ventoinha (H) esquentam mais
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

  /* --- Desenho em pixel --- */
  const R = Math.round;
  function rect(x, y, w, h, c) {
    const x0 = R(x), y0 = R(y), x1 = R(x + w), y1 = R(y + h);
    if (x1 <= x0 || y1 <= y0) return;
    g.fillStyle = c;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  function rectMin(x, y, w, h, c) { // igual ao rect, mas nunca some (mínimo 1x1)
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
  function triangleUp(cx, topY, baseY, halfW, c) { // triângulo preenchido linha por linha
    const h = baseY - topY;
    if (h < 1) return;
    for (let y = Math.ceil(topY); y < baseY; y++) {
      const t = (y - topY + 0.5) / h;
      span(cx - halfW * t, cx + halfW * t, y, c);
    }
  }

  /* --- Fonte 3x5 --- */
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
    '•': '000000010000000', 'ª': '011101011000111', '[': '110100100100110', ']': '011001001001011', '|': '010010010010010'
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

  /* --- Ícones das luzes de aviso --- */
  const ICONS = {
    turnL: ['...X...', '..XX...', '.XXXXXX', 'XXXXXXX', '.XXXXXX', '..XX...', '...X...'],
    turnR: ['...X...', '...XX..', 'XXXXXX.', 'XXXXXXX', 'XXXXXX.', '...XX..', '...X...'],
    engine: ['..XXX....', '...X.....', 'XXXXXXX.X', 'X.XXXXXXX', 'XXXXXXXXX', 'X.XXXXX.X', '..XXXXX..'],
    temp: ['...X...', '...XX..', '...X...', '...XX..', '..XXX..', '..XXX..', 'X.X.X.X'],
    fuel: ['XXXX...', 'X..X.X.', 'X..X..X', 'XXXX..X', 'XXXX..X', 'XXXX.X.', 'XXXXX..'],
    brake: ['..XXX..', '.X...X.', 'X.XX..X', 'X.X.X.X', 'X.XX..X', '.XX..X.', '..XXX..'],
    belt: ['..XX...', '..XX...', '.XXXX.X', 'X.XXXX.', '..XXX..', '.XX.X..', '.X..X..'],
    oil: ['.......', 'XX.....', '.XXXXX.', '..XXXXX', '..XXXX.', '..XXXX.', '.....X.'],
    bat: ['.X...X.', 'XXXXXXX', 'X.....X', 'XXX.X.X', 'X..XXXX', 'X...X.X', 'XXXXXXX']
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

  /* --- Camadas desenhadas uma vez só --- */
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
    // reduz a foto em dois passos com suavização (fica mais bonito);
    // depois ela é desenhada sem suavização, aí vira pixel
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
    // céu em faixas, com uma linha quadriculada entre elas tipo jogo de 16 bits
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
      // sol com um halo em degraus (estilo 16 bits)
      const sx = W * 0.3, sy = horizonY * 0.28, sr = Math.max(3, horizonY * 0.1);
      disc(sx, sy, sr * 2.1, 'rgba(255,250,210,0.18)');
      disc(sx, sy, sr * 1.5, 'rgba(255,245,190,0.35)');
      disc(sx, sy, sr, '#fff6c2');
      disc(sx - sr * 0.2, sy - sr * 0.2, sr * 0.6, '#ffffff');
    });
    layers.sky = sky.c;

    // 3 formatos de nuvem
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

  /* --- Desenho de cada quadro --- */
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
    if ((gameMode === 'CORRIDA' || gameMode === 'TRÂNSITO') && !gameOverActive) drawMinimap();
    if (hitFlash > 0) { g.fillStyle = 'rgba(255,40,40,' + (hitFlash * 1.2).toFixed(2) + ')'; g.fillRect(0, 0, W, RH); }
    if (gameMode === 'PASSEIO' && !countdownActive && speed > PASSEIO_SPEED_LIMIT && Math.floor(performance.now() / 200) % 2) {
      rect(0, 0, W, 2, '#ff3b30'); rect(0, RH - 2, W, 2, '#ff3b30'); rect(0, 0, 2, RH, '#ff3b30'); rect(W - 2, 0, 2, RH, '#ff3b30');
    }
    if (fuelPickup > 0 && !countdownActive) {
      const up = Math.round((1.6 - fuelPickup) * 10);
      text('+' + CAN_REFILL + '% ' + T('fuel'), W / 2, RH * 0.55 - up, '#3ddc4a', W >= 260 ? 2 : 1, 'center', '#0b2a12');
    }
    if (showRtos) drawRtosOverlay();
    if (countdownActive) drawCountdown();
    if (!gameOverActive) drawPauseButton();
    ctx.restore();

    // modo real: painel liso em alta resolução por cima (menos no pause e no resultado, que cobrem a tela toda)
    const hc = (!gamePaused && !gameOverActive && !benchMode) ? syncHiCanvas() : (hiCanvas && (hiCanvas.style.display = 'none'), null);
    if (hc) drawRealCluster(hiCtx, hc.width, hc.height);
    else drawCluster();
    if (gameOverActive) drawGameOver();
  }

  function drawSky() {
    if (layers.sky) ctx.drawImage(layers.sky, 0, 0);
    // nuvens andam mais devagar que os prédios nas curvas
    const span2 = W + 80;
    for (let i = 0; i < 5; i++) {
      const img = layers.clouds[i % layers.clouds.length];
      if (!img) continue;
      let x = (i * span2 / 5 + cloudDrift - bgOffset * 0.35 + i * 17) % span2;
      if (x < 0) x += span2;
      const y = R(horizonY * (0.08 + (i % 3) * 0.13));
      ctx.drawImage(img, R(x - 50), y);
    }
    // prédios do campus repetidos lado a lado, um normal e um espelhado, pra não aparecer emenda
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

    // gramado do horizonte pra baixo
    rect(0, horizonY, W, RH - horizonY, pal.grassA);

    for (let n = DRAW_DISTANCE; n >= 1; n--) {
      const p2 = pts[n], p1 = pts[n - 1];
      if (p2.y >= RH) continue;
      const light = (Math.floor(p2.segIdx / 3) % 2 === 0);
      const isBump = gameMode === 'PASSEIO' && speedBumps.some(b => b.segIndex === p2.segIdx);
      const isFinish = gameMode === 'CORRIDA' && p2.segIdx >= TOTAL_SEGMENTS - 3;
      const yTop = Math.max(horizonY, Math.ceil(p2.y));
      const yBot = Math.min(RH, Math.ceil(p1.y));
      // névoa: quanto mais longe, mais a cor puxa pro azul do céu (em 5 degraus, pra continuar pixel art)
      const fz = Math.min(4, Math.floor(Math.pow(n / DRAW_DISTANCE, 1.4) * 5));
      const F = c => fog(c, fz, pal.haze);
      const curb = Math.abs(p2.seg.curve) > 0.5;              // zebra só nas curvas
      const curbOn = (p2.segIdx % 2) === 0;
      for (let y = yTop; y < yBot; y++) {
        const t = (y + 0.5 - p2.y) / (p1.y - p2.y);
        const x = p2.x + (p1.x - p2.x) * t;
        const w = p2.w + (p1.w - p2.w) * t;
        span(0, W, y, F(light ? pal.grassA : pal.grassB));
        span(x - w * 1.2, x + w * 1.2, y, F(light ? pal.walkA : pal.walkB));
        const edge = Math.max(1, w * (curb ? 0.07 : 0.04));
        span(x - w - edge, x + w + edge, y, curb ? F(curbOn ? '#d8262e' : '#f4f4f4') : F(pal.edge));
        if (isFinish) {
          const cells = 12, cw = (2 * w) / cells, row = Math.floor((y - yTop) / Math.max(1, (yBot - yTop) / 2));
          for (let c = 0; c < cells; c++) span(x - w + c * cw, x - w + (c + 1) * cw, y, ((c + row) % 2) ? '#111111' : '#ffffff');
        } else if (isBump) {
          const stripes = 8, sw = (2 * w) / stripes;
          for (let s = 0; s < stripes; s++) span(x - w + s * sw, x - w + (s + 1) * sw, y, (s % 2) ? '#1c1c1c' : '#f6c90e');
        } else {
          span(x - w, x + w, y, F(light ? pal.roadA : pal.roadB));
          // faixa branca contínua na borda do asfalto
          const bw = Math.max(1, w * 0.018);
          if (w > 6) { span(x - w + bw, x - w + bw * 2, y, F('#e8e8e8')); span(x + w - bw * 2, x + w - bw, y, F('#e8e8e8')); }
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
      for (const fc of fuelCans) if (fc.segIndex === p2.segIdx && !fc.collected) drawFuelCan(fc, p2);
      const list = sceneryBySeg[p2.segIdx];
      if (list) for (const sc of list) drawSceneryItem(sc, p2);
    }
  }

  // mistura uma cor com a névoa (cache, porque roda em toda linha da tela)
  const fogCache = {};
  function fog(hex, k, haze) {
    if (!k) return hex;
    const key = hex + k + haze;
    let c = fogCache[key];
    if (c) return c;
    const a = parseInt(hex.slice(1), 16), b = parseInt(haze.slice(1), 16), f = k * 0.11;
    const mix = (sh) => Math.round(((a >> sh) & 255) * (1 - f) + ((b >> sh) & 255) * f);
    c = '#' + ((1 << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).slice(1);
    fogCache[key] = c;
    return c;
  }

  /* --- Objetos do cenário --- */
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

    if (sc.type === 'bush') {
      const h = hw * 0.16;
      if (h < 1.5) return;
      const c1 = sc.shade ? '#2f7d3a' : '#3c8f3f', c2 = sc.shade ? '#245f2d' : '#2d7034', c3 = '#5bb04f';
      ellipse(x, by - h * 0.45, h * 1.1, h * 0.5, c2);
      ellipse(x - h * 0.3, by - h * 0.62, h * 0.6, h * 0.42, c1);
      ellipse(x + h * 0.35, by - h * 0.58, h * 0.55, h * 0.38, c1);
      if (h >= 4) plot(x - h * 0.4, by - h * 0.85, c3);
    }

    if (sc.type === 'sign') {
      // placa azul de estrada com nome, em dois postes
      const h = hw * 0.62, w = h * 1.05;
      if (h < 4) return;
      const pw = Math.max(1, h * 0.03);
      rectMin(x - w * 0.38, by - h, pw, h, '#6b7280'); rectMin(x + w * 0.38, by - h, pw, h, '#6b7280');
      const ph = h * 0.36;
      rect(x - w / 2, by - h - ph * 0.3, w, ph, '#f4f4f4');
      rect(x - w / 2 + Math.max(1, w * 0.03), by - h - ph * 0.3 + Math.max(1, w * 0.03), w - 2 * Math.max(1, w * 0.03), ph - 2 * Math.max(1, w * 0.03), '#1d4fa3');
      if (ph >= 8) text(fitText(sc.text, w - 4), x + 0.5, by - h - ph * 0.3 + ph / 2 - 2, '#ffffff', 1, 'center');
    }

    if (sc.type === 'billboard') {
      const h = hw * 0.95, w = h * 1.5;
      if (h < 5) return;
      rectMin(x - w * 0.3, by - h * 0.55, Math.max(1, h * 0.04), h * 0.55, '#4b5563');
      rectMin(x + w * 0.3, by - h * 0.55, Math.max(1, h * 0.04), h * 0.55, '#4b5563');
      const ph = h * 0.5;
      rect(x - w / 2, by - h, w, ph, '#1c0326');
      rect(x - w / 2 + 1, by - h + 1, w - 2, ph - 2, '#ffbb00');
      rect(x - w / 2 + 1, by - h + ph - Math.max(1, ph * 0.18), w - 2, Math.max(1, ph * 0.18) - 1, '#d99a00');
      if (ph >= 9) text(fitText(sc.text, w - 4), x + 0.5, by - h + ph * 0.38 - 2, '#1c0326', 1, 'center');
    }

    if (sc.type === 'stands') {
      // arquibancada com torcida (pontinhos coloridos que mexem)
      const h = hw * 0.55, w = hw * 0.9;
      if (h < 4) return;
      rect(x - w / 2, by - h, w, h, '#6b7280');
      const rows = Math.max(2, Math.floor(h / 3));
      for (let r = 0; r < rows; r++) {
        const yy = by - h + r * (h / rows);
        rect(x - w / 2, yy + h / rows - 1, w, 1, '#4b5563');
        if (h >= 8) {
          for (let k = 0; k < w; k += 2) {
            const col = ['#ff4d6d', '#ffd34d', '#4fc3f7', '#ffffff', '#3ddc4a'][(k * 7 + r * 3) % 5];
            const jump = (Math.floor(performance.now() / 300) + k + r) % 5 === 0 ? 1 : 0;
            plot(x - w / 2 + k + 0.5, yy + 0.5 - jump, col);
          }
        }
      }
      rect(x - w / 2, by - h - Math.max(1, h * 0.1), w, Math.max(1, h * 0.1), '#d8262e');   // cobertura
    }

    if (sc.type === 'gantry') {
      // pórtico sobre a pista: dois postes e a faixa (quadriculada na largada/chegada)
      const left = p.x - hw * 1.12, right = p.x + hw * 1.12;
      const h = hw * 0.75, bh = Math.max(2, hw * 0.16);
      if (hw < 6 || right < 0 || left > W) return;
      const pw = Math.max(1, hw * 0.04);
      rect(left, by - h, pw, h, '#9ca3af'); rect(right - pw, by - h, pw, h, '#9ca3af');
      const top = by - h - bh;
      if (sc.checker) {
        const cells = Math.max(6, Math.floor((right - left) / Math.max(2, bh / 2)));
        const cw = (right - left) / cells;
        for (let c = 0; c < cells; c++) for (let r = 0; r < 2; r++)
          rect(left + c * cw, top + r * bh / 2, cw + 0.5, bh / 2 + 0.5, (c + r) % 2 ? '#111111' : '#ffffff');
        if (bh >= 9) {
          const tw = textW(sc.label) + 6;
          rect(p.x - tw / 2, top + bh / 2 - 4, tw, 8, '#d8262e');
          text(sc.label, p.x + 0.5, top + bh / 2 - 2, '#ffffff', 1, 'center');
        }
      } else {
        rect(left, top, right - left, bh, '#1d4fa3');
        rect(left, top, right - left, Math.max(1, bh * 0.15), '#ffbb00');
        if (bh >= 8) text(fitText(sc.label, right - left - 4), p.x + 0.5, top + bh / 2 - 2, '#ffffff', 1, 'center');
      }
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

  // galão vermelho de gasolina (com alça e bico), pulando de leve pra chamar atenção
  function drawFuelCan(fc, p) {
    const ix = laneX(fc.lane, p), by = R(p.y);
    const s = p.w * 0.13;
    if (s < 1.5) return;
    const bob = (Math.floor(performance.now() / 220) % 2) ? 1 : 0;
    const w = s, h = s * 1.25, x = ix - w / 2, y = by - h - bob - s * 0.15;
    rect(ix - w * 0.55, by - Math.max(1, s * 0.08), w * 1.1, Math.max(1, s * 0.08), 'rgba(0,0,0,0.35)');
    rect(x, y + h * 0.18, w, h * 0.82, '#d8262e');
    rect(x, y + h * 0.18, Math.max(1, w * 0.18), h * 0.82, '#ff5a4f');
    rect(x + w * 0.15, y, w * 0.45, Math.max(1, h * 0.2), '#a3161c');           // alça
    rect(x + w * 0.7, y + h * 0.02, Math.max(1, w * 0.18), Math.max(1, h * 0.22), '#f2c418');   // bico
    if (s >= 7) {
      rect(x + w * 0.25, y + h * 0.45, w * 0.5, Math.max(1, h * 0.12), '#ffffff');
      rect(x + w * 0.44, y + h * 0.32, Math.max(1, w * 0.12), h * 0.38, '#ffffff');
    }
  }

  /* --- Carro do jogador --- */
  function drawPlayerCar() {
    const k = Math.max(1, Math.round(W / 190));          // tamanho de cada quadradinho do sprite
    const cw = 32 * k, chh = 16 * k;
    const carBottom = RH - Math.max(2, Math.round(RH * 0.03));
    const carRowY = carBottom - chh * 0.4;
    const sc = (carRowY - horizonY) / (CAMERA_HEIGHT * RH * 0.5);
    const roadHW = sc * ROAD_WIDTH * 0.25 * W;
    const cx = W / 2 + (playerX / (ROAD_WIDTH * 0.5)) * roadHW;
    const moving = veh.kmh > 3 && !countdownActive && !gameOverActive;
    const bounce = moving && (Math.floor(performance.now() / (veh.kmh > 120 ? 60 : 110)) % 2) ? k : 0;
    const shake = bumpShake > 0 ? (Math.floor(bumpShake * 40) % 2 ? -2 : 1) * k : 0;   // tranco da lombada
    const ox = R(cx - cw / 2), oy = R(carBottom - chh) - bounce + shake;
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
      // conversível aberto: bancos brancos e a motorista loira
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
      cell(14, 2, 4, 2, '#3a2416');                             // cabeça do motorista
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

    // seta piscando na traseira também
    if (veh.turn && Math.floor(simMs / 333) % 2 === 0) {
      if (veh.turn === 1) cell(0, 8, 2, 2, '#ffb020'); else cell(30, 8, 2, 2, '#ffb020');
    }
  }

  /* --- Mapinha do circuito (modo corrida) --- */
  function buildMinimap() {
    // anda pela pista somando a direção de cada segmento
    let x = 0, y = 0, hd = 0;
    const pts = [];
    for (let i = 0; i <= TOTAL_SEGMENTS; i++) {
      pts.push([x, y]);
      if (i === TOTAL_SEGMENTS) break;
      hd += segments[i].curve * MAP_TURN;
      x += Math.sin(hd); y -= Math.cos(hd);
    }
    // os "S" deixam o fim um pouco fora do começo: distribui o erro ao longo da volta pra fechar certinho
    const ex = pts[pts.length - 1][0] - pts[0][0], ey = pts[pts.length - 1][1] - pts[0][1];
    pts.forEach((p, i) => { const t = i / (pts.length - 1); p[0] -= ex * t; p[1] -= ey * t; });
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    minimap = { pts, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }

  function drawMinimap() {
    if (!minimap) return;
    const mw = Math.max(34, Math.round(W * 0.17)), mh = Math.round(mw * 0.78);
    const bx = W - mw - 3, by = 12;
    g.fillStyle = 'rgba(12,10,28,0.72)'; g.fillRect(bx, by, mw, mh);
    rect(bx, by, mw, 1, '#ffbb00'); rect(bx, by + mh - 1, mw, 1, 'rgba(255,187,0,0.5)');
    const pad = 4;
    const sx = (mw - 2 * pad) / (minimap.maxX - minimap.minX), sy = (mh - 2 * pad) / (minimap.maxY - minimap.minY);
    const sc = Math.min(sx, sy);
    const ox = bx + mw / 2 - (minimap.minX + minimap.maxX) / 2 * sc, oy = by + mh / 2 - (minimap.minY + minimap.maxY) / 2 * sc;
    const P = i => [ox + minimap.pts[i][0] * sc, oy + minimap.pts[i][1] * sc];
    const seg = Math.min(TOTAL_SEGMENTS, Math.floor(position / SEGMENT_LENGTH));
    const step = 12;
    // pista inteira em cinza e o pedaço já percorrido em verde
    for (let i = 0; i < TOTAL_SEGMENTS; i += step) {
      const a = P(i), b = P(Math.min(TOTAL_SEGMENTS, i + step));
      const done = i + step <= seg;
      line(a[0], a[1], b[0], b[1], done ? '#3ddc4a' : '#94a3b8');
      if (mw >= 50) line(a[0] + 1, a[1], b[0] + 1, b[1], done ? '#2a9e35' : '#64748b');
    }
    // checkpoints (1/3 e 2/3) e largada/chegada quadriculada
    if (gameMode === 'CORRIDA') [1, 2].forEach(k => { const c = P(Math.round(TOTAL_SEGMENTS * k / 3)); rect(R(c[0]) - 1, R(c[1]) - 1, 3, 3, checkpointsPassed >= k ? '#3ddc4a' : '#ffbb00'); });
    const f = P(0);
    for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 4; xx++) rect(R(f[0]) - 2 + xx, R(f[1]) - 1 + yy, 1, 1, (xx + yy) % 2 ? '#111111' : '#ffffff');
    // o carro: piscando, na cor do carro escolhido
    const cpos = P(seg);
    if (Math.floor(performance.now() / 250) % 2 === 0 || mw < 50) {
      rect(R(cpos[0]) - 1, R(cpos[1]) - 1, 3, 3, '#1c0326');
      rect(R(cpos[0]), R(cpos[1]), 1, 1, car.id === 'corvette' ? '#ff6fb5' : '#4fc3f7');
      if (mw >= 50) { rect(R(cpos[0]) - 1, R(cpos[1]) - 1, 3, 3, car.id === 'corvette' ? '#ff6fb5' : '#4fc3f7'); }
    }
  }

  /* --- Faixa de cima (pontos, tempo, vidas) --- */
  function drawTopHud() {
    if (countdownActive || gameOverActive) return;
    g.fillStyle = 'rgba(12,10,28,0.62)';
    g.fillRect(0, 0, W, 9);
    rect(0, 9, W, 1, 'rgba(255,187,0,0.55)');
    if (gameMode !== 'PASSEIO') text(T('pts') + ' ' + score, 13, 2, '#ffd34d');

    let tStr;
    if (gameMode === 'CORRIDA' || gameMode === 'PASSEIO') tStr = T('time') + ' ' + timeElapsed.toFixed(1) + 'S';
    else tStr = T('time') + ' ' + Math.max(0, Math.ceil(gameDuration - timeElapsed)) + 'S';
    const low = gameMode === 'TRÂNSITO' && gameDuration - timeElapsed < 10;
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
  // botão "II" no canto de cima, pra quem joga com mouse ou no celular
  function drawPauseButton() {
    const r = { x: 1, y: 1, w: 9, h: 8 };
    hit.pause = { x: 0, y: 0, w: 16, h: 14 };   // área de toque um pouco maior que o desenho
    rect(r.x, r.y, r.w, r.h, '#ffbb00');
    rect(r.x, r.y + r.h - 1, r.w, 1, '#c98a00');
    rect(r.x + 2, r.y + 2, 2, 4, '#1c0326');
    rect(r.x + 5, r.y + 2, 2, 4, '#1c0326');
  }

  // botão pixel com texto no meio; devolve a área clicável
  function pixelButton(label, cx, y, s, bg, fg) {
    const tw = textW(label, s);
    const w = tw + 8 * s, h = 5 * s + 6 * s;
    const x = R(cx - w / 2);
    rect(x + s, y + s, w, h, '#000000');          // sombra
    rect(x, y, w, h, '#1c0326');                   // borda
    rect(x + s, y + s, w - 2 * s, h - 2 * s, bg);
    rect(x + s, y + h - 2 * s, w - 2 * s, s, 'rgba(0,0,0,0.25)');
    text(label, cx, y + 3 * s, fg, s, 'center');
    return { x: x, y: y, w: w + s, h: h + s };
  }

  function drawHeart(x, y, c) {
    const rows = ['.X.X.', 'XXXXX', 'XXXXX', '.XXX.', '..X..'];
    g.fillStyle = c;
    rows.forEach((r, i) => { for (let j = 0; j < 5; j++) if (r[j] === 'X') g.fillRect(x + j, y + i, 1, 1); });
  }

  /* --- Painel de instrumentos ---
   * Cada carro tem o painel desenhado do jeito do original:
   *  Camaro 69: painel preto, dois copos grandes e fundos (velocímetro e conta-giros) com aro cromado,
   *             combustível e temperatura em copos pequenos no meio, faixa de madeira embaixo.
   *  Corvette 56: painel pintado na cor do carro, velocímetro em leque (meia-lua) na frente do motorista,
   *             conta-giros no centro com quatro relógios pequenos dos lados e o rádio em cima.
   * O que não existia nos carros (mostrador de mensagens, luz da injeção e do CAN) entra como se
   * fosse um acessório instalado depois: o display fica na madeira no Camaro e no lugar do rádio no Corvette.
   * As escalas seguem os requisitos: velocímetro 0-250 km/h (RF-02) e conta-giros 0-8000 rpm (RF-01).
   */
  let cl = null;   // geometria do painel, recalculada a cada resize

  // fundo aceso de uma lente: vermelho ou âmbar bem escuro, pra letra brilhar
  function lampOnBg(c) { return c === '#ff4a3a' ? '#3d0c08' : (c === '#3ddc4a' ? '#0b2a10' : '#3a2600'); }
  const CHROME = ['#ffffff', '#e4e8ed', '#b9c0c9', '#8b939e', '#5c636d'];

  function deg(a) { return a * Math.PI / 180; }

  // aro cromado: claro em cima à esquerda, escuro embaixo à direita (luz vindo do para-brisa)
  function chromeRing(cx, cy, rOut, rIn) {
    const x0 = Math.floor(cx - rOut - 1), x1 = Math.ceil(cx + rOut + 1);
    const y0 = Math.floor(cy - rOut - 1), y1 = Math.ceil(cy + rOut + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.sqrt(dx * dx + dy * dy);
        if (d > rOut || d < rIn) continue;
        const light = (-dx - dy) / (d || 1);               // 1 = virado pra cima/esquerda
        const edge = d > rOut - 1 || d < rIn + 1;
        let i = light > 0.55 ? 0 : light > 0.1 ? 1 : light > -0.4 ? 2 : 3;
        if (edge) i = Math.min(4, i + 1);
        g.fillStyle = CHROME[i];
        g.fillRect(x, y, 1, 1);
      }
    }
  }

  // fundo do mostrador; a parte de cima fica na sombra da "capelinha" (o copo é fundo)
  function gaugeFace(cx, cy, r, face, shadow, hood) {
    disc(cx, cy, r, face);
    if (!hood) return;
    const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
    const yLim = cy - r + Math.max(2, Math.round(r * hood));
    g.fillStyle = shadow;
    for (let y = Math.floor(cy - r); y < yLim; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) g.fillRect(x, y, 1, 1);
      }
    }
  }

  // escala de um mostrador: marcas, números e faixa vermelha
  // o = { cx, cy, r, start, sweep, max, minor, major, labels, labelR, red, tick, label, redColor }
  function gaugeScale(o) {
    const ang = v => deg(o.start - o.sweep * (v / o.max));
    if (o.red) {
      for (let v = o.red; v <= o.max; v += o.max / 240) {
        const a = ang(v);
        for (let k = 2; k <= 3; k++) plot(o.cx + Math.cos(a) * (o.r - k), o.cy - Math.sin(a) * (o.r - k), o.redColor);
      }
    }
    for (let v = 0; v <= o.max + 1e-6; v += o.minor) {
      const a = ang(v);
      const isMajor = Math.abs(v / o.major - Math.round(v / o.major)) < 1e-6;
      const c = (o.red && v >= o.red - 1e-6) ? o.redColor : o.tick;
      const len = isMajor ? Math.max(2, Math.round(o.r * 0.09)) : 1;
      const r0 = o.r - 1.5;
      if (isMajor || o.r >= 16) {
        line(o.cx + Math.cos(a) * r0, o.cy - Math.sin(a) * r0,
             o.cx + Math.cos(a) * (r0 - len + 0.5), o.cy - Math.sin(a) * (r0 - len + 0.5), c);
      }
    }
    (o.labels || []).forEach(v => {
      const a = ang(v);
      const lx = o.cx + Math.cos(a) * o.labelR, ly = o.cy - Math.sin(a) * o.labelR;
      text(String(v === 0 && o.zeroLabel != null ? o.zeroLabel : (o.labelDiv ? v / o.labelDiv : v)), lx + 0.5, ly - 2,
        (o.red && v >= o.red) ? o.redColor : o.label, 1, 'center');
    });
  }

  // ponteiro: haste fina com contrapeso e capinha cromada no centro
  function needle(cx, cy, len, tail, angDeg, color, thick) {
    const a = deg(angDeg);
    const tx = cx + Math.cos(a) * len, ty = cy - Math.sin(a) * len;
    const bx = cx - Math.cos(a) * tail, by = cy + Math.sin(a) * tail;
    line(bx, by, tx, ty, color);
    if (thick) {
      const horizontal = Math.abs(Math.cos(a)) > Math.abs(Math.sin(a));
      line(bx + (horizontal ? 0 : 1), by + (horizontal ? 1 : 0), tx + (horizontal ? 0 : 1), ty + (horizontal ? 1 : 0), color);
    }
  }
  function needleCap(cx, cy, r) {
    disc(cx, cy, r, CHROME[3]);
    disc(cx - 0.4, cy - 0.4, Math.max(0.8, r - 1), CHROME[1]);
  }

  // odômetro de tambor: 5 dígitos de km e um de décimo (invertido). O último rola de verdade.
  function drumOdometer(x, y, km, s) {
    const cw = 4, ch = 7;
    const total = Math.max(0, km);
    const tenths = Math.floor(total * 10);
    const frac = total * 10 - tenths;                    // quanto do décimo já rodou
    const digits = String(tenths % 1000000).padStart(6, '0');
    rect(x - 1, y - 1, cw * 6 + 1, ch + 2, '#3a3d44');
    for (let i = 0; i < 6; i++) {
      const last = i === 5;
      const bx = x + i * cw;
      rect(bx, y, cw - 1, ch, last ? '#f1ede4' : '#0d0e10');
      const fg = last ? '#1a1a1a' : '#f1ede4';
      if (last) {
        // tambor rolando: o número atual sobe e o próximo aparece por baixo
        const off = Math.round(frac * ch);
        g.save(); g.beginPath(); g.rect(bx, y, cw - 1, ch); g.clip();
        text(digits[i], bx, y + 1 - off, fg);
        text(String((+digits[i] + 1) % 10), bx, y + 1 - off + ch, fg);
        g.restore();
      } else {
        text(digits[i], bx, y + 1, fg);
      }
    }
    return cw * 6;
  }

  // lente de luz-espia com texto, do jeito dos carros antigos (BRAKE, OIL, GEN...)
  function lampLens(x, y, w, label, on, color, th, h) {
    h = h || 7;
    rect(x, y, w, h, th.lampRim);
    rect(x + 1, y + 1, w - 2, h - 2, on ? lampOnBg(color) : th.lampOff);
    text(fitText(label, w - 2), x + w / 2 + 0.5, y + Math.floor((h - 5) / 2), on ? color : th.lampOffText, 1, 'center');
  }
  // luz de seta: triângulo verde
  function turnArrow(x, y, dir, on, th) {
    const c = on ? '#3ddc4a' : th.lampOffText;
    for (let i = 0; i < 4; i++) {
      const hh = i;                                    // meia altura da coluna
      const xx = dir < 0 ? x + i : x + 6 - i;
      rect(xx, y + 3 - hh, 1, hh * 2 + 1, c);
    }
    rect(dir < 0 ? x + 4 : x, y + 2, 3, 3, c);
  }

  // as luzes que o ICM precisa mostrar, na ordem em que aparecem
  function lampStates(d, bulb, blink, blinkFast) {
    const f = d.warning_flags;
    return [
      { k: 'brake', label: T('lBrake'), on: bulb || !!(f & FLAG_HANDBRAKE_ON), c: '#ff4a3a' },
      { k: 'mil', label: T('lMil'), on: bulb || !!(f & FLAG_MIL_CHECK_ENG), c: '#ffb000' },
      { k: 'can', label: 'CAN', on: bulb || !!(f & (FLAG_CAN_M1_TIMEOUT | FLAG_CAN_M2_TIMEOUT)), c: '#ffb000' },
      { k: 'temp', label: T('lTemp'), on: bulb || !!(f & (FLAG_COOLANT_HOT | FLAG_TEMP_SENSOR)), c: '#ff4a3a' },
      { k: 'fuel', label: T('lFuel'), on: bulb || !!(f & FLAG_LOW_FUEL) || (!!(f & FLAG_FUEL_SENSOR) && blinkFast), c: '#ffb000' },
      { k: 'belt', label: T('lBelt'), on: bulb || (!!(f & FLAG_SEATBELT_WARN) && blink), c: '#ff4a3a' },
      { k: 'oil', label: T('lOil'), on: bulb || !!(f & FLAG_OIL_PRESS_LOW), c: '#ff4a3a' },
      { k: 'bat', label: T('lBat'), on: bulb || !!(f & FLAG_BATTERY_FAULT), c: '#ff4a3a' }
    ];
  }
  // coluna de lentes; se não couber, divide em duas colunas; se nem assim, usa os pictogramas
  function lampColumn(x, y, w, h, lamps, th) {
    const isArrow = l => l.k === 'turnL' || l.k === 'turnR';
    for (const cols of [1, 2]) {
      const colW = Math.floor((w - (cols - 1) * 2) / cols);
      if (colW < 15) break;
      const lensW = Math.min(colW - 2, colW >= 40 ? 33 : 23);
      const rows = Math.ceil(lamps.length / cols);
      const lh = h >= rows * 12 ? 9 : 7;
      if (h < rows * (lh + 1) - 1) continue;
      const gap = Math.max(1, Math.min(6, Math.floor((h - rows * lh) / Math.max(1, rows - 1))));
      const used = rows * lh + gap * (rows - 1);
      const y0 = y + Math.floor((h - used) / 2);
      lamps.forEach((l, i) => {
        const col = cols === 1 ? 0 : (i % cols), row = cols === 1 ? i : Math.floor(i / cols);
        const lx = x + col * (colW + 2) + Math.floor((colW - lensW) / 2), yy = y0 + row * (lh + gap);
        if (isArrow(l)) turnArrow(lx + Math.floor(lensW / 2) - 3, yy + Math.floor((lh - 7) / 2), l.k === 'turnL' ? -1 : 1, l.on, th);
        else lampLens(lx, yy, lensW, l.label, l.on, l.c, th, lh);
      });
      return;
    }
    // pouco espaço (celular): grade de ícones 7x7; se não couber todo mundo, mostra primeiro as acesas
    const map = { brake: 'brake', mil: 'engine', temp: 'temp', fuel: 'fuel', belt: 'belt', oil: 'oil', bat: 'bat' };
    const cols = Math.max(1, Math.floor((w + 2) / 10));
    const cap = cols * Math.max(1, Math.floor((h + 2) / 9));
    let list = lamps.filter(l => !isArrow(l));
    if (list.length > cap) list = list.filter(l => l.on).concat(list.filter(l => !l.on)).slice(0, cap);
    const rowsN = Math.ceil(list.length / cols);
    const y00 = y + Math.floor((h - (rowsN * 9 - 2)) / 2);
    list.forEach((l, i) => {
      const cx = x + (i % cols) * 10 + Math.floor((w - (cols * 10 - 2)) / 2), cy = y00 + Math.floor(i / cols) * 9;
      const c = l.on ? l.c : th.lampOffText;
      if (l.k === 'can') { text('C', cx + 2, cy + 1, c); }
      else icon(map[l.k], cx, cy, c);
    });
  }

  // mostrador de mensagens (o "acessório" do ICM): marcha à esquerda, mensagem no meio
  function messageWindow(x, y, w, h, d, bulb, th) {
    rect(x - 1, y - 1, w + 2, h + 2, th.winRim);
    rect(x, y, w, h, th.winBg);
    const ty = y + Math.floor((h - 5) / 2);
    const gearTxt = countdownActive ? (car.spec.auto ? 'P' : 'N') : (d.gear >= 1 ? (car.spec.auto ? 'D' + d.gear : d.gear + 'ª') : 'N');
    const gw = textW(gearTxt);
    text(gearTxt, x + 2, ty, th.winText);
    rect(x + 4 + gw, y + 1, 1, h - 2, th.winDim);
    const msg = currentMessage(d, bulb);
    const mx0 = x + 6 + gw, mw = w - (6 + gw) - 2;
    if (msg) text(fitText(msg.text, mw), mx0 + mw / 2, ty, msg.warn ? th.winWarn : th.winText, 1, 'center');
  }

  function clusterGeometry() {
    const y0 = RH, h = CH;
    return car.id === 'corvette' ? corvetteGeometry(y0, h) : camaroGeometry(y0, h);
  }

  /* --- Camaro 69 --- */
  function camaroGeometry(y0, h) {
    const woodH = Math.max(8, Math.round(h * 0.17));
    const top = y0 + 3, bottom = H - woodH - 1;
    const R0 = Math.floor(Math.min((bottom - top) / 2, W * 0.105));
    const rs = Math.max(5, Math.floor((bottom - top - 3) / 4));      // copos pequenos (2 empilhados)
    const cx = Math.round(W / 2);
    const gap = Math.max(3, Math.round(R0 * 0.18));
    const cy = Math.round((top + bottom) / 2);
    const speedX = cx - rs - gap - R0, tachX = cx + rs + gap + R0;
    const sideW = speedX - R0 - 4 - 3;                                  // espaço das luzes nas pontas
    return { y0, h, woodH, woodY: H - woodH, R: R0, rs, cx, cy, speedX, tachX,
      fuelY: cy - rs - 1, tempY: cy + rs + 1, sideW, top, bottom };
  }

  function buildCamaroStatic(th) {
    const c = cl;
    // painel preto com textura de vinil granulado
    rect(0, c.y0, W, c.h, th.dash);
    const rng = mulberry32(69);
    g.fillStyle = th.dashGrain;
    for (let i = 0; i < W * c.h * 0.08; i++) g.fillRect(Math.floor(rng() * W), c.y0 + Math.floor(rng() * c.h), 1, 1);
    rect(0, c.y0, W, 2, th.pad); rect(0, c.y0 + 2, W, 1, th.padLo);
    // carcaça dos instrumentos, um pouco mais clara e com filete cromado
    const hx0 = c.speedX - c.R - 4, hx1 = c.tachX + c.R + 4;
    rect(hx0, c.top - 2, hx1 - hx0, c.woodY - c.top + 1, th.housing);
    rect(hx0, c.top - 2, hx1 - hx0, 1, CHROME[2]);
    // madeira (jacarandá) de ponta a ponta, com veios
    rect(0, c.woodY, W, c.woodH, th.wood[1]);
    for (let yy = 0; yy < c.woodH; yy++) {
      for (let x = 0; x < W; x++) {
        const v = Math.sin(x * 0.09 + Math.sin(x * 0.021 + yy * 0.7) * 2.3 + yy * 0.9);
        if (v > 0.72) { g.fillStyle = th.wood[2]; g.fillRect(x, c.woodY + yy, 1, 1); }
        else if (v < -0.85) { g.fillStyle = th.wood[0]; g.fillRect(x, c.woodY + yy, 1, 1); }
      }
    }
    rect(0, c.woodY, W, 1, th.wood[3]); rect(0, H - 1, W, 1, th.wood[0]);

    // copos grandes
    [c.speedX, c.tachX].forEach(x => {
      disc(x, c.cy, c.R + 2, th.cupShadow);
      chromeRing(x, c.cy, c.R + 1, c.R - 1.2);
      gaugeFace(x, c.cy, c.R - 1.2, th.face, th.faceShadow, 0.16);
    });
    const big = c.R >= 22;
    // arco de 240 graus, como nos relógios do Camaro
    gaugeScale({ cx: c.speedX, cy: c.cy, r: c.R - 1.5, start: 210, sweep: 240, max: 250, minor: 10, major: 50,
      labels: big ? [0, 50, 100, 150, 200, 250] : [], labelR: c.R - 1.5 - Math.max(8, c.R * 0.36),
      tick: th.tick, label: th.label, redColor: th.red });
    gaugeScale({ cx: c.tachX, cy: c.cy, r: c.R - 1.5, start: 210, sweep: 240, max: 8000, minor: 500, major: 1000,
      labels: big ? [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000] : [], labelDiv: 1000,
      labelR: c.R - 1.5 - Math.max(7, c.R * 0.32), red: car.spec.redline, tick: th.tick, label: th.label, redColor: th.red });
    if (c.R >= 26) {
      text('KM/H', c.speedX + 0.5, c.cy - Math.round(c.R * 0.33), th.labelDim, 1, 'center');
      text('RPM', c.tachX + 0.5, c.cy - Math.round(c.R * 0.42), th.labelDim, 1, 'center');
      text('X1000', c.tachX + 0.5, c.cy + Math.round(c.R * 0.30), th.labelDim, 1, 'center');
    }
    // copos pequenos: combustível em cima, temperatura embaixo
    [c.fuelY, c.tempY].forEach(y => {
      disc(c.cx, y, c.rs + 2, th.cupShadow);
      chromeRing(c.cx, y, c.rs + 1, c.rs - 0.8);
      gaugeFace(c.cx, y, c.rs - 0.8, th.face, th.faceShadow, c.rs >= 9 ? 0.2 : 0);
    });
    smallScale(c.cx, c.fuelY, c.rs, 'E', 'F', 'low', th);
    smallScale(c.cx, c.tempY, c.rs, 'C', 'H', 'high', th);

    // nas pontas: saídas de ar verticais (como no carro) e a coluna de luzes
    if (c.sideW >= 14) {
      const vw = Math.min(10, Math.max(4, Math.round(c.sideW * 0.22)));
      [3, W - 3 - vw].forEach(vx => {
        rect(vx, c.top + 1, vw, c.woodY - c.top - 3, th.vent);
        for (let yy = c.top + 2; yy < c.woodY - 3; yy += 2) rect(vx + 1, yy, vw - 2, 1, th.ventSlat);
      });
    }
  }

  // escala de um relógio pequeno: arco de 120 graus em cima, letras nas pontas
  function smallScale(cx, cy, r, lo, hi, redEnd, th) {
    const py = cy + Math.round(r * 0.35);                  // eixo do ponteiro um pouco abaixo do centro
    const rr = r - 1.5;
    for (let i = 0; i <= 4; i++) {
      const a = deg(150 - 120 * i / 4);
      const red = (redEnd === 'low' && i === 0) || (redEnd === 'high' && i === 4);
      line(cx + Math.cos(a) * rr, py - Math.sin(a) * rr, cx + Math.cos(a) * (rr - (i % 2 ? 1 : 2)), py - Math.sin(a) * (rr - (i % 2 ? 1 : 2)), red ? th.red : th.tick);
    }
    if (r >= 9) {
      text(lo, cx - r + 3, cy + Math.round(r * 0.35) - 1, redEnd === 'low' ? th.red : th.label);
      text(hi, cx + r - 5, cy + Math.round(r * 0.35) - 1, redEnd === 'high' ? th.red : th.label);
    }
  }
  function smallNeedle(cx, cy, r, frac, th) {
    const py = cy + Math.round(r * 0.35);
    const f = Math.max(-0.06, Math.min(1.04, frac));       // abaixo de E / acima de H quando o sensor abre
    needle(cx, py, r - 2.5, 0, 150 - 120 * f, th.needle, false);
    needleCap(cx, py, 1.2);
  }

  function drawCamaro(d, bulb, sweep, blink, blinkFast, th) {
    const c = cl;
    const f = d.warning_flags;
    // ponteiros grandes
    const sFrac = bulb ? sweep : d.needleSpeed / 250, rFrac = bulb ? sweep : d.needleRpm / 8000;
    const len = c.R - 3, thick = c.R >= 18;
    needle(c.speedX, c.cy, len, Math.max(2, c.R * 0.2), 210 - 240 * Math.max(0, Math.min(1, sFrac)), th.needle, thick);
    needle(c.tachX, c.cy, len, Math.max(2, c.R * 0.2), 210 - 240 * Math.max(0, Math.min(1, rFrac)), th.needle, thick);
    needleCap(c.speedX, c.cy, Math.max(1.5, c.R * 0.1));
    needleCap(c.tachX, c.cy, Math.max(1.5, c.R * 0.1));
    // odômetro de tambor dentro do velocímetro
    // odômetro de tambor acima do eixo do ponteiro, como nos velocímetros GM da época
    if (c.R >= 24) drumOdometer(c.speedX - 12, c.cy + Math.round(c.R * 0.42), d.odometer_km);
    // combustível e temperatura
    const fuelFrac = (f & FLAG_FUEL_SENSOR) ? -0.06 : (bulb ? sweep : d.fuel_level_percent / 100);
    const tempFrac = (f & FLAG_TEMP_SENSOR) ? -0.06 : (bulb ? sweep : (d.coolant_temp_celsius - 40) / (130 - 40));
    smallNeedle(c.cx, c.fuelY, c.rs, fuelFrac, th);
    smallNeedle(c.cx, c.tempY, c.rs, tempFrac, th);
    // luzes nas pontas, metade de cada lado
    const lamps = lampStates(d, bulb, blink, blinkFast);
    const tl = { k: 'turnL', on: bulb || ((d.turn_signal === 1 || d.turn_signal === 3) && blink) }, tr = { k: 'turnR', on: bulb || ((d.turn_signal === 2 || d.turn_signal === 3) && blink) };
    const vw = c.sideW >= 14 ? Math.min(10, Math.max(4, Math.round(c.sideW * 0.22))) + 3 : 0;
    const lw = c.sideW - vw;
    if (lw >= 9) {
      const big = c.R >= 16;
      // esquerda: freio, injeção, CAN, cinto / direita: temperatura, combustível, óleo, bateria
      const left = [lamps[0], lamps[1], lamps[2], lamps[5]], right = [lamps[3], lamps[4], lamps[6], lamps[7]];
      lampColumn(3 + vw, c.top, lw, c.woodY - c.top - 2, big ? [tl].concat(left) : left, th);
      lampColumn(W - 3 - vw - lw, c.top, lw, c.woodY - c.top - 2, big ? [tr].concat(right) : right, th);
    }
    if (c.R < 16) {   // celular: as setas vão pra madeira
      turnArrow(2, c.woodY + Math.floor((c.woodH - 7) / 2), -1, bulb || ((d.turn_signal === 1 || d.turn_signal === 3) && blink), th);
      turnArrow(W - 9, c.woodY + Math.floor((c.woodH - 7) / 2), 1, bulb || ((d.turn_signal === 2 || d.turn_signal === 3) && blink), th);
    }
    // mostrador de mensagens embutido na madeira, embaixo dos instrumentos
    const ww = W < 260 ? W - 24 : Math.min(W - 24, c.tachX - c.speedX + Math.round(c.R * 0.8));
    const wh = Math.min(c.woodH - 2, 7);
    messageWindow(Math.round(c.cx - ww / 2), c.woodY + Math.floor((c.woodH - wh) / 2), ww, wh, d, bulb, th);
  }

  /* --- Corvette 56 --- */
  function corvetteGeometry(y0, h) {
    let top = y0 + 3;
    const bottom = H - 3;                                     // filete cromado embaixo
    // velocímetro em leque: meia-lua com o eixo embaixo
    const odoH = h >= 60 ? 10 : 0;
    const Rs = Math.floor(Math.min(bottom - top - odoH - 3, W * 0.16));
    // se sobrar altura (bancada de testes), centraliza tudo na vertical
    top += Math.max(0, Math.floor((bottom - top - (Rs + odoH + 6)) / 2));
    const sx = 4 + Rs + 2, sy = top + Rs + 1;
    // centro do painel: rádio (mostrador de mensagens) em cima, conta-giros e 4 relógios embaixo
    const winH = h >= 50 ? 9 : 7;
    const midL = sx + Rs + 8;
    const rT = Math.max(8, Math.floor(Math.min((bottom - top - winH - 4) / 2, W * 0.07)));
    const rSm = Math.max(4, Math.floor(rT * 0.42));
    const step = rSm * 2 + Math.max(2, Math.round(rSm * 0.5));
    const groupW = rT * 2 + 4 * step + 6;
    const lampW = Math.max(16, Math.min(30, Math.round(W * 0.085)));   // 8 lentes empilhadas (ou ícones no celular)
    const midR = W - 4 - lampW - 4;
    const tx = Math.round(midL + (midR - midL) / 2);
    const ty = top + winH + 3 + rT;
    return { y0, h, top, bottom, Rs, sx, sy, odoH, winH, rT, rSm, step, groupW, tx, ty, midL, midR,
      lampX: W - 4 - lampW, lampW };
  }

  function buildCorvetteStatic(th) {
    const c = cl;
    // painel pintado: faixa clara no alto (luz), sombra embaixo, filete cromado no pé
    rect(0, c.y0, W, c.h, th.dash);
    rect(0, c.y0, W, 2, th.dashHi);
    rect(0, c.y0 + 2, W, 1, th.dashMid);
    rect(0, H - 4, W, 1, th.dashLo);
    rect(0, H - 3, W, 2, CHROME[1]); rect(0, H - 1, W, 1, CHROME[3]);
    // "capelinha" em cima do velocímetro, mais escura, como o capô do instrumento no carro
    ellipse(c.sx, c.sy, c.Rs + 4, c.Rs + 4, th.dashLo);
    rect(c.sx - c.Rs - 4, c.sy + 1, c.Rs * 2 + 9, c.Rs + 4, th.dash);
    // velocímetro em leque
    for (let y = Math.floor(c.sy - c.Rs - 2); y <= c.sy + 1; y++) {
      for (let x = Math.floor(c.sx - c.Rs - 2); x <= c.sx + c.Rs + 2; x++) {
        const dx = x + 0.5 - c.sx, dy = y + 0.5 - c.sy, dd = Math.sqrt(dx * dx + dy * dy);
        if (dd <= c.Rs + 1.5 && dy <= 0.5) {
          let col;
          if (dd > c.Rs - 1) col = CHROME[(-dx - dy) / (dd || 1) > 0.3 ? 1 : (-dx - dy) / (dd || 1) > -0.3 ? 2 : 3];
          else col = dy < -(c.Rs * 0.8) ? th.faceShadow : th.face;
          g.fillStyle = col; g.fillRect(x, y, 1, 1);
        }
      }
    }
    rect(c.sx - c.Rs - 1, c.sy + 1, c.Rs * 2 + 3, 2, CHROME[2]);      // base cromada do leque
    rect(c.sx - c.Rs - 1, c.sy + 3, c.Rs * 2 + 3, 1, CHROME[4]);
    gaugeScale({ cx: c.sx, cy: c.sy, r: c.Rs - 1, start: 174, sweep: 168, max: 250, minor: 10, major: 50,
      labels: c.Rs >= 34 ? [0, 50, 100, 150, 200, 250] : (c.Rs >= 20 ? [0, 100, 200] : []), labelR: c.Rs - 1 - Math.max(8, c.Rs * 0.26),
      tick: th.tick, label: th.label, redColor: th.red });
    if (c.Rs >= 30) text('KM/H', c.sx + 0.5, c.sy - Math.round(c.Rs * 0.40), th.labelDim, 1, 'center');
    // caixinha do odômetro embaixo do leque
    if (c.odoH) rect(c.sx - 14, c.sy + 4, 27, c.odoH - 1, CHROME[2]);

    // rádio / mostrador de mensagens
    const ww = Math.min(c.midR - c.midL, Math.max(c.groupW, 60));
    c.winX = Math.round(c.tx - ww / 2); c.winY = c.top; c.winW = ww;
    rect(c.winX - 2, c.winY - 1, ww + 4, c.winH + 2, CHROME[2]);
    if (c.winH >= 9) {   // botões do rádio nas pontas
      disc(c.winX - 5, c.winY + c.winH / 2, 2.2, CHROME[1]);
      disc(c.winX + ww + 4, c.winY + c.winH / 2, 2.2, CHROME[1]);
    }

    // conta-giros no centro
    chromeRing(c.tx, c.ty, c.rT + 1.5, c.rT - 1);
    gaugeFace(c.tx, c.ty, c.rT - 1, th.face, th.faceShadow, 0.12);
    gaugeScale({ cx: c.tx, cy: c.ty, r: c.rT - 1.5, start: 225, sweep: 270, max: 8000, minor: 500, major: 1000,
      labels: c.rT >= 20 ? [0, 2000, 4000, 6000, 8000] : [], labelDiv: 1000, labelR: c.rT - 1.5 - Math.max(7, c.rT * 0.3),
      red: car.spec.redline, tick: th.tick, label: th.label, redColor: th.red });
    if (c.rT >= 20) text('RPM', c.tx + 0.5, c.ty + Math.round(c.rT * 0.34), th.labelDim, 1, 'center');
    // quatro relógios pequenos: combustível e temperatura à esquerda, óleo e bateria à direita
    c.small = [
      { x: c.tx - c.rT - 4 - c.step * 1.5, k: 'temp' }, { x: c.tx - c.rT - 4 - c.step * 0.5, k: 'fuel' },
      { x: c.tx + c.rT + 4 + c.step * 0.5, k: 'oil' }, { x: c.tx + c.rT + 4 + c.step * 1.5, k: 'amp' }
    ];
    c.small.forEach(s => {
      s.x = Math.round(s.x);
      chromeRing(s.x, c.ty + 1, c.rSm + 1, c.rSm - 0.8);
      gaugeFace(s.x, c.ty + 1, c.rSm - 0.8, th.face, th.faceShadow, 0);
      const ends = { temp: ['C', 'H', 'high'], fuel: ['E', 'F', 'low'], oil: ['0', '8', null], amp: ['-', '+', null] }[s.k];
      smallScale(s.x, c.ty + 1, c.rSm, ends[0], ends[1], ends[2], th);
    });
    if (c.rSm >= 6) {
      const lbl = { temp: 'TEMP', fuel: T('lFuel'), oil: T('lOil'), amp: 'BAT' };
      c.small.forEach(s => text(fitText(lbl[s.k], c.step - 1), s.x + 0.5, c.ty + c.rSm + 3, th.labelDash, 1, 'center'));
    }
    // placa cromada das luzes, no lado do passageiro
    rect(c.lampX - 1, c.top - 1, c.lampW + 2, c.bottom - c.top - 2, CHROME[3]);
    rect(c.lampX, c.top, c.lampW, c.bottom - c.top - 4, th.lampPlate);
  }

  function drawCorvette(d, bulb, sweep, blink, blinkFast, th) {
    const c = cl;
    const f = d.warning_flags;
    // ponteiro do leque: sai do eixo embaixo
    const sFrac = Math.max(0, Math.min(1, bulb ? sweep : d.needleSpeed / 250));
    needle(c.sx, c.sy, c.Rs - 3, 0, 174 - 168 * sFrac, th.needle, c.Rs >= 20);
    rect(c.sx - 2, c.sy - 1, 5, 2, CHROME[1]);
    if (c.odoH) drumOdometer(c.sx - 12, c.sy + 6, d.odometer_km);
    // setas dentro do leque, perto do eixo (como no original)
    if (c.Rs >= 18) {
      turnArrow(c.sx - Math.round(c.Rs * 0.55) - 3, c.sy - 9, -1, bulb || ((d.turn_signal === 1 || d.turn_signal === 3) && blink), th);
      turnArrow(c.sx + Math.round(c.Rs * 0.55) - 3, c.sy - 9, 1, bulb || ((d.turn_signal === 2 || d.turn_signal === 3) && blink), th);
    }
    // conta-giros
    const rFrac = Math.max(0, Math.min(1, bulb ? sweep : d.needleRpm / 8000));
    needle(c.tx, c.ty, c.rT - 3, Math.max(2, c.rT * 0.2), 225 - 270 * rFrac, th.needle, c.rT >= 18);
    needleCap(c.tx, c.ty, Math.max(1.5, c.rT * 0.11));
    // relógios pequenos
    const oilFrac = d.engine_rpm > 300 ? Math.min(0.85, 0.25 + d.engine_rpm / 6000 * 0.55) : 0;  // pressão do óleo sobe com o giro
    const ampFrac = d.engine_rpm > 1200 ? 0.62 : 0.42;                                           // dínamo carregando ou não
    const fr = {
      fuel: (f & FLAG_FUEL_SENSOR) ? -0.06 : (bulb ? sweep : d.fuel_level_percent / 100),
      temp: (f & FLAG_TEMP_SENSOR) ? -0.06 : (bulb ? sweep : (d.coolant_temp_celsius - 40) / (130 - 40)),
      oil: bulb ? sweep : oilFrac, amp: bulb ? sweep : ampFrac
    };
    c.small.forEach(s => smallNeedle(s.x, c.ty + 1, c.rSm, fr[s.k], th));
    // rádio = mostrador de mensagens
    messageWindow(c.winX, c.winY, c.winW, c.winH, d, bulb, th);
    // luzes
    const lamps = lampStates(d, bulb, blink, blinkFast);
    if (c.Rs < 18) {   // celular: setas entram junto com as outras luzes
      turnArrow(c.sx - 9, c.sy - 8, -1, bulb || ((d.turn_signal === 1 || d.turn_signal === 3) && blink), th);
      turnArrow(c.sx + 3, c.sy - 8, 1, bulb || ((d.turn_signal === 2 || d.turn_signal === 3) && blink), th);
    }
    lampColumn(c.lampX + 1, c.top + 1, c.lampW - 2, c.bottom - c.top - 6, lamps, th);
  }

  function buildClusterStatic() {
    cl = clusterGeometry();
    const th = car.theme;
    const lay = offscreen(W, H);
    withLayer(lay.cx, () => {
      if (car.id === 'corvette') buildCorvetteStatic(th); else buildCamaroStatic(th);
    });
    layers.cluster = lay.c;
  }

  function drawCluster() {
    if (!layers.cluster || !cl || !disp) return;
    g = ctx;
    ctx.drawImage(layers.cluster, 0, 0);
    const now = simMs;
    const bulb = now < bulbUntil;                              // ao ligar, acende tudo por 1.5 s (teste de lâmpadas)
    const sweep = bulb ? Math.sin(Math.PI * Math.min(1, 1 - (bulbUntil - now) / 1500)) : 0;
    const blink = Math.floor(now / 333) % 2 === 0;             // seta pisca a 1.5 Hz
    const blinkFast = Math.floor(now / 200) % 2 === 0;
    if (car.id === 'corvette') drawCorvette(disp, bulb, sweep, blink, blinkFast, car.theme);
    else drawCamaro(disp, bulb, sweep, blink, blinkFast, car.theme);
  }

  /* --- Painel realista (modo foto real) ---
   * No modo real o painel é desenhado liso, em alta resolução, inspirado nas fotos dos interiores
   * (web/img/carros/<carro>/interior-real.jpg). Mesmos dados e mesmas luzes do painel pixel.
   * A parte que não muda (fundo, molduras, escalas) fica num canvas guardado; a cada quadro
   * só desenhamos ponteiros, luzes, odômetro e o mostrador de mensagens.
   */
  let hiCanvas = null, hiCtx = null, hiStatic = null, hiKey = '';

  function rrect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function chromeGrad(c, x0, y0, x1, y1) {
    const gr = c.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, '#fbfcfd'); gr.addColorStop(0.35, '#a7adb5'); gr.addColorStop(0.55, '#eef0f2');
    gr.addColorStop(0.8, '#6d737b'); gr.addColorStop(1, '#c9cdd2');
    return gr;
  }
  // caixa funda com moldura cromada (como as do Camaro)
  function chromeBox(c, x, y, w, h, r, t) {
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = t * 3; c.shadowOffsetY = t;
    rrect(c, x, y, w, h, r); c.fillStyle = chromeGrad(c, x, y, x + w * 0.3, y + h); c.fill();
    c.restore();
    rrect(c, x + t, y + t, w - 2 * t, h - 2 * t, Math.max(1, r - t));
    const ig = c.createLinearGradient(0, y + t, 0, y + h - t);
    ig.addColorStop(0, '#020203'); ig.addColorStop(0.25, '#0d0e11'); ig.addColorStop(1, '#16181c');
    c.fillStyle = ig; c.fill();
  }
  function ringChrome(c, cx, cy, r, t) {
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.arc(cx, cy, r - t, 0, Math.PI * 2, true);
    c.fillStyle = chromeGrad(c, cx - r, cy - r, cx + r * 0.6, cy + r); c.fill();
  }
  // mostrador redondo: fundo, escala, números (tudo estático)
  // o = { start, sweep, max, minor, major, labels, labelDiv, red, unit, sub, face }
  function realGaugeStatic(c, cx, cy, R, o) {
    ringChrome(c, cx, cy, R, R * 0.07);
    const fg = c.createRadialGradient(cx, cy - R * 0.2, R * 0.1, cx, cy, R * 0.95);
    fg.addColorStop(0, o.face ? o.face[0] : '#1d1f24'); fg.addColorStop(1, o.face ? o.face[1] : '#050506');
    c.beginPath(); c.arc(cx, cy, R * 0.93, 0, Math.PI * 2); c.fillStyle = fg; c.fill();
    const ang = v => (o.start - o.sweep * v / o.max) * Math.PI / 180;
    const rr = R * 0.88;
    if (o.red) {
      c.beginPath(); c.arc(cx, cy, rr - R * 0.04, -ang(o.red), -ang(o.max), false);
      c.strokeStyle = '#d9312b'; c.lineWidth = R * 0.07; c.stroke();
    }
    c.lineCap = 'butt';
    for (let v = 0; v <= o.max + 1e-6; v += o.minor) {
      const a = ang(v), major = Math.abs(v / o.major - Math.round(v / o.major)) < 1e-6;
      const l = major ? R * 0.13 : R * 0.065;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * rr, cy - Math.sin(a) * rr);
      c.lineTo(cx + Math.cos(a) * (rr - l), cy - Math.sin(a) * (rr - l));
      c.strokeStyle = (o.red && v >= o.red) ? '#ff5a4f' : '#f2f2ee';
      c.lineWidth = major ? Math.max(1.5, R * 0.025) : Math.max(1, R * 0.012);
      c.stroke();
    }
    c.fillStyle = '#f2f2ee'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `600 ${Math.round(R * (o.labelSize || 0.15))}px "Helvetica Neue", Arial, sans-serif`;
    (o.labels || []).forEach(v => {
      const a = ang(v), lr = rr - R * 0.27;
      c.fillStyle = (o.red && v >= o.red) ? '#ff5a4f' : '#f2f2ee';
      c.fillText(String(o.labelDiv ? v / o.labelDiv : v), cx + Math.cos(a) * lr, cy - Math.sin(a) * lr);
    });
    c.fillStyle = '#9aa0a8';
    c.font = `500 ${Math.round(R * 0.1)}px "Helvetica Neue", Arial, sans-serif`;
    if (o.unit) c.fillText(o.unit, cx, cy + R * (o.unitY || -0.36));
    if (o.sub) c.fillText(o.sub, cx, cy + R * 0.33);
  }
  function realNeedle(c, cx, cy, R, angDeg, len, color) {
    const a = angDeg * Math.PI / 180, L = R * (len || 0.82), b = R * 0.045;
    const tx = cx + Math.cos(a) * L, ty = cy - Math.sin(a) * L;
    const px = -Math.sin(a), py = -Math.cos(a);
    c.save();
    c.shadowColor = 'rgba(255,110,40,0.55)'; c.shadowBlur = R * 0.08;
    c.beginPath();
    c.moveTo(cx - Math.cos(a) * R * 0.18 + px * b, cy + Math.sin(a) * R * 0.18 + py * b);
    c.lineTo(tx + px * b * 0.25, ty + py * b * 0.25);
    c.lineTo(tx - px * b * 0.25, ty - py * b * 0.25);
    c.lineTo(cx - Math.cos(a) * R * 0.18 - px * b, cy + Math.sin(a) * R * 0.18 - py * b);
    c.closePath(); c.fillStyle = color || '#ff6a1a'; c.fill();
    c.restore();
    const hg = c.createRadialGradient(cx - R * 0.03, cy - R * 0.03, 1, cx, cy, R * 0.11);
    hg.addColorStop(0, '#ffffff'); hg.addColorStop(0.5, '#a8aeb6'); hg.addColorStop(1, '#3a3e44');
    c.beginPath(); c.arc(cx, cy, R * 0.1, 0, Math.PI * 2); c.fillStyle = hg; c.fill();
  }
  function glassGlare(c, cx, cy, R) {
    const gg = c.createLinearGradient(cx - R, cy - R, cx + R * 0.2, cy + R * 0.3);
    gg.addColorStop(0, 'rgba(255,255,255,0.13)'); gg.addColorStop(0.5, 'rgba(255,255,255,0.02)'); gg.addColorStop(1, 'rgba(255,255,255,0)');
    c.beginPath(); c.arc(cx, cy, R * 0.93, 0, Math.PI * 2); c.fillStyle = gg; c.fill();
  }
  function realOdometer(c, x, y, cw, ch, km) {
    const tenths = Math.floor(Math.max(0, km) * 10), frac = km * 10 - tenths;
    const digits = String(tenths % 1000000).padStart(6, '0');
    rrect(c, x - 2, y - 2, cw * 6 + 4, ch + 4, 2); c.fillStyle = '#3a3d44'; c.fill();
    c.font = `600 ${Math.round(ch * 0.8)}px "Courier New", monospace`; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let i = 0; i < 6; i++) {
      const last = i === 5, bx = x + i * cw;
      const dg = c.createLinearGradient(0, y, 0, y + ch);
      dg.addColorStop(0, last ? '#bfb9ad' : '#000'); dg.addColorStop(0.5, last ? '#f4efe4' : '#16171a'); dg.addColorStop(1, last ? '#bfb9ad' : '#000');
      c.fillStyle = dg; c.fillRect(bx, y, cw - 1, ch);
      c.fillStyle = last ? '#111' : '#efeae0';
      if (last) {
        c.save(); c.beginPath(); c.rect(bx, y, cw - 1, ch); c.clip();
        c.fillText(digits[i], bx + cw / 2, y + ch / 2 - frac * ch);
        c.fillText(String((+digits[i] + 1) % 10), bx + cw / 2, y + ch * 1.5 - frac * ch);
        c.restore();
      } else c.fillText(digits[i], bx + cw / 2, y + ch / 2);
    }
  }
  // lente de luz-espia: apagada fica quase invisível, acesa brilha
  function realLamp(c, x, y, w, h, label, on, color) {
    rrect(c, x, y, w, h, h * 0.25); c.fillStyle = '#060607'; c.fill();
    c.strokeStyle = '#2a2c31'; c.lineWidth = 1; c.stroke();
    c.save();
    if (on) { c.shadowColor = color; c.shadowBlur = h * 0.9; }
    c.fillStyle = on ? color : '#2b2d33';
    let fs = Math.round(h * 0.56);
    c.font = `700 ${fs}px "Helvetica Neue", Arial, sans-serif`;
    while (fs > 6 && c.measureText(label).width > w * 0.88) { fs--; c.font = `700 ${fs}px "Helvetica Neue", Arial, sans-serif`; }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(label, x + w / 2, y + h / 2 + 0.5);
    c.restore();
  }
  function realArrow(c, cx, cy, s, dir, on) {
    c.save();
    if (on) { c.shadowColor = '#3ddc4a'; c.shadowBlur = s * 0.8; }
    c.beginPath();
    c.moveTo(cx + dir * s, cy); c.lineTo(cx - dir * s * 0.1, cy - s * 0.7); c.lineTo(cx - dir * s * 0.1, cy - s * 0.3);
    c.lineTo(cx - dir * s, cy - s * 0.3); c.lineTo(cx - dir * s, cy + s * 0.3); c.lineTo(cx - dir * s * 0.1, cy + s * 0.3);
    c.lineTo(cx - dir * s * 0.1, cy + s * 0.7); c.closePath();
    c.fillStyle = on ? '#4cff5c' : '#1a2a1c'; c.fill();
    c.restore();
  }
  // mostrador de mensagens: VFD âmbar (Camaro) ou mostrador de rádio creme (Corvette)
  function realMessage(c, x, y, w, h, d, bulb, style) {
    const radio = style === 'radio';
    rrect(c, x - h * 0.12, y - h * 0.12, w + h * 0.24, h * 1.24, h * 0.2);
    c.fillStyle = chromeGrad(c, x, y, x, y + h); c.fill();
    rrect(c, x, y, w, h, h * 0.12);
    const bg = c.createLinearGradient(0, y, 0, y + h);
    if (radio) { bg.addColorStop(0, '#fff3d6'); bg.addColorStop(1, '#e8d4a6'); } else { bg.addColorStop(0, '#050302'); bg.addColorStop(1, '#140b03'); }
    c.fillStyle = bg; c.fill();
    const gearTxt = countdownActive ? (car.spec.auto ? 'P' : 'N') : (d.gear >= 1 ? (car.spec.auto ? 'D' + d.gear : d.gear + 'ª') : 'N');
    const msg = currentMessage(d, bulb);
    const fs = Math.round(h * 0.56);
    c.save();
    c.textBaseline = 'middle';
    c.font = `700 ${fs}px "Courier New", monospace`;
    const txt = radio ? '#5a2a12' : '#ffb627', warn = radio ? '#c81e1e' : '#ff5a3c';
    if (!radio) { c.shadowColor = 'rgba(255,170,40,0.8)'; c.shadowBlur = h * 0.25; }
    c.fillStyle = txt; c.textAlign = 'left';
    c.fillText(gearTxt, x + h * 0.3, y + h / 2);
    const gw = c.measureText(gearTxt).width + h * 0.6;
    c.fillStyle = radio ? 'rgba(90,42,18,0.3)' : 'rgba(255,182,39,0.25)';
    c.fillRect(x + gw, y + h * 0.15, Math.max(1, h * 0.05), h * 0.7);
    if (msg) {
      let s = msg.text;
      c.font = `700 ${fs}px "Courier New", monospace`;
      while (s.length > 1 && c.measureText(s).width > w - gw - h * 0.5) s = s.slice(0, -1);
      if (msg.warn && !radio) c.shadowColor = 'rgba(255,80,50,0.9)';
      c.fillStyle = msg.warn ? warn : txt; c.textAlign = 'center';
      c.fillText(s, x + gw + (w - gw) / 2, y + h / 2);
    }
    c.restore();
  }
  function woodStrip(c, x, y, w, h) {
    const wg = c.createLinearGradient(0, y, 0, y + h);
    wg.addColorStop(0, '#6e3a18'); wg.addColorStop(0.5, '#8a4b22'); wg.addColorStop(1, '#4d260f');
    c.fillStyle = wg; c.fillRect(x, y, w, h);
    const rng = mulberry32(1969);
    c.lineWidth = 1;
    for (let i = 0; i < 70; i++) {
      const yy = y + rng() * h, amp = h * (0.05 + rng() * 0.12), ph = rng() * 6, k = 0.004 + rng() * 0.01;
      c.beginPath();
      for (let xx = x; xx <= x + w; xx += 6) c.lineTo(xx, yy + Math.sin(xx * k + ph) * amp);
      c.strokeStyle = rng() > 0.5 ? 'rgba(40,18,6,0.35)' : 'rgba(170,100,50,0.25)';
      c.stroke();
    }
    c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(x, y, w, Math.max(1, h * 0.04));
    c.fillStyle = 'rgba(0,0,0,0.4)'; c.fillRect(x, y + h - Math.max(1, h * 0.05), w, Math.max(1, h * 0.05));
  }
  function chromeKnob(c, cx, cy, r) {
    const kg = c.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 1, cx, cy, r);
    kg.addColorStop(0, '#ffffff'); kg.addColorStop(0.6, '#9aa1a9'); kg.addColorStop(1, '#40444a');
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fillStyle = kg; c.fill();
    c.beginPath(); c.arc(cx, cy, r * 0.55, 0, Math.PI * 2); c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 1; c.stroke();
  }

  /* layout do Camaro realista (w x h em pixels de tela) */
  function realCamaroGeo(w, h) {
    const woodH = h * 0.2, top = h * 0.06, bottom = h - woodH - h * 0.05;
    const R = Math.min((bottom - top) / 2 * 0.86, w * 0.1);
    const cy = (top + bottom) / 2, cx = w / 2;
    const rs = R * 0.36;
    const gap = R * 0.5;
    const speedX = cx - rs - gap - R, tachX = cx + rs + gap + R;
    return { w, h, woodH, woodY: h - woodH, top, bottom, R, cy, cx, rs, speedX, tachX,
      fuelY: cy - rs * 1.15, tempY: cy + rs * 1.15,
      sideL: speedX - R * 1.18, sideR: tachX + R * 1.18 };
  }
  function realCamaroStatic(c, G) {
    const { w, h } = G;
    const bg = c.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#202125'); bg.addColorStop(1, '#0c0c0e');
    c.fillStyle = bg; c.fillRect(0, 0, w, h);
    // vinil granulado
    const rng = mulberry32(7);
    c.fillStyle = 'rgba(255,255,255,0.025)';
    for (let i = 0; i < w * h / 60; i++) c.fillRect(rng() * w, rng() * h, 1, 1);
    // caixas cromadas quadradas (velocímetro e conta-giros) e a do meio
    const pad = G.R * 0.16, t = Math.max(2, G.R * 0.05);
    [G.speedX, G.tachX].forEach(x => chromeBox(c, x - G.R - pad, G.cy - G.R - pad, 2 * (G.R + pad), 2 * (G.R + pad), G.R * 0.18, t));
    chromeBox(c, G.cx - G.rs * 1.45, G.top + G.R * 0.02, G.rs * 2.9, (G.bottom - G.top) - G.R * 0.04, G.rs * 0.3, t);
    realGaugeStatic(c, G.speedX, G.cy, G.R, { start: 210, sweep: 240, max: 250, minor: 10, major: 50,
      labels: [0, 50, 100, 150, 200, 250], unit: 'KM/H', unitY: -0.36 });
    realGaugeStatic(c, G.tachX, G.cy, G.R, { start: 210, sweep: 240, max: 8000, minor: 500, major: 1000,
      labels: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000], labelDiv: 1000, red: car.spec.redline,
      unit: 'RPM', sub: 'X1000', labelSize: 0.16 });
    // relógios pequenos: combustível e temperatura (arco de 120° com o eixo embaixo)
    [[G.fuelY, 'E', 'F', 'FUEL', 'low'], [G.tempY, 'C', 'H', 'TEMP', 'high']].forEach(([y, lo, hi, nm, red]) => {
      const r = G.rs;
      ringChrome(c, G.cx, y, r, r * 0.08);
      c.beginPath(); c.arc(G.cx, y, r * 0.92, 0, Math.PI * 2); c.fillStyle = '#08090b'; c.fill();
      const py = y + r * 0.3;
      for (let i = 0; i <= 4; i++) {
        const a = (150 - 30 * i) * Math.PI / 180;
        c.beginPath(); c.moveTo(G.cx + Math.cos(a) * r * 0.78, py - Math.sin(a) * r * 0.78);
        c.lineTo(G.cx + Math.cos(a) * r * (i % 2 ? 0.66 : 0.58), py - Math.sin(a) * r * (i % 2 ? 0.66 : 0.58));
        c.strokeStyle = (red === 'low' && i === 0) || (red === 'high' && i === 4) ? '#ff5a4f' : '#eeeeea';
        c.lineWidth = Math.max(1, r * 0.05); c.stroke();
      }
      c.font = `700 ${Math.round(r * 0.26)}px "Helvetica Neue", Arial, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = red === 'low' ? '#ff5a4f' : '#eeeeea'; c.fillText(lo, G.cx - r * 0.62, py + r * 0.12);
      c.fillStyle = red === 'high' ? '#ff5a4f' : '#eeeeea'; c.fillText(hi, G.cx + r * 0.62, py + r * 0.12);
      c.fillStyle = '#8d939c'; c.font = `500 ${Math.round(r * 0.2)}px "Helvetica Neue", Arial, sans-serif`;
      c.fillText(nm, G.cx, py + r * 0.4);
    });
    // madeira embaixo, com o botão cromado do farol à esquerda
    woodStrip(c, 0, G.woodY, w, G.woodH);
    chromeKnob(c, G.speedX - G.R * 0.7, G.woodY + G.woodH / 2, G.woodH * 0.3);
    // saídas de ar nas pontas
    [w * 0.012, w - w * 0.012 - w * 0.03].forEach(vx => {
      rrect(c, vx, G.top, w * 0.03, G.bottom - G.top, 3); c.fillStyle = '#060607'; c.fill();
      for (let yy = G.top + 4; yy < G.bottom - 2; yy += Math.max(3, h * 0.025)) { c.fillStyle = '#2c2e33'; c.fillRect(vx + 2, yy, w * 0.03 - 4, 1.5); }
    });
  }
  function realCamaroDynamic(c, G, d, bulb, sweep, blink, blinkFast) {
    const f = d.warning_flags;
    const sF = bulb ? sweep : d.needleSpeed / 250, rF = bulb ? sweep : d.needleRpm / 8000;
    realOdometer(c, G.speedX - G.R * 0.36, G.cy + G.R * 0.38, G.R * 0.12, G.R * 0.17, d.odometer_km);
    realNeedle(c, G.speedX, G.cy, G.R, 210 - 240 * Math.max(0, Math.min(1, sF)));
    realNeedle(c, G.tachX, G.cy, G.R, 210 - 240 * Math.max(0, Math.min(1, rF)));
    glassGlare(c, G.speedX, G.cy, G.R); glassGlare(c, G.tachX, G.cy, G.R);
    const fuelF = (f & FLAG_FUEL_SENSOR) ? -0.06 : (bulb ? sweep : d.fuel_level_percent / 100);
    const tempF = (f & FLAG_TEMP_SENSOR) ? -0.06 : (bulb ? sweep : (d.coolant_temp_celsius - 40) / 90);
    [[G.fuelY, fuelF], [G.tempY, tempF]].forEach(([y, fr]) => {
      const fr2 = Math.max(-0.06, Math.min(1.04, fr));
      realNeedle(c, G.cx, y + G.rs * 0.3, G.rs, 150 - 120 * fr2, 0.75);
    });
    // luzes nas pontas: seta + 4 de cada lado
    const lamps = lampStates(d, bulb, blink, blinkFast);
    const left = [lamps[0], lamps[1], lamps[2], lamps[5]], right = [lamps[3], lamps[4], lamps[6], lamps[7]];
    const colW = (G.sideL - G.w * 0.05), lw = Math.min(colW * 0.86, G.R * 0.95), lh = Math.min((G.bottom - G.top) / 6.2, lw * 0.36);
    const drawCol = (cx, list, dir, on) => {
      const step = (G.bottom - G.top) / 5;
      realArrow(c, cx, G.top + step * 0.5, lh * 0.75, dir, on);
      list.forEach((l, i) => realLamp(c, cx - lw / 2, G.top + step * (i + 1.5) - lh / 2, lw, lh, l.label, l.on, l.c));
    };
    drawCol(G.w * 0.05 + colW / 2, left, -1, bulb || ((d.turn_signal === 1 || d.turn_signal === 3) && blink));
    drawCol(G.w - G.w * 0.05 - colW / 2, right, 1, bulb || ((d.turn_signal === 2 || d.turn_signal === 3) && blink));
    // mostrador de mensagens no lugar do rádio, na madeira
    const mw = (G.tachX + G.R) - (G.speedX - G.R * 0.2), mh = G.woodH * 0.56;
    realMessage(c, G.speedX - G.R * 0.2 + G.R * 0.25, G.woodY + (G.woodH - mh) / 2, mw - G.R * 0.25, mh, d, bulb, 'vfd');
  }

  /* layout do Corvette realista */
  function realCorvetteGeo(w, h) {
    const top = h * 0.07, bottom = h * 0.9;
    const Rs = Math.min((bottom - top) * 0.74, w * 0.16);
    const sx = w * 0.04 + Rs, sy = top + Rs + Math.max(0, (bottom - top - Rs * 1.32) / 2);
    const plateW = w * 0.12, plateX = w - w * 0.025 - plateW;
    const midL = sx + Rs + w * 0.03, midR = plateX - w * 0.02;
    const tx = (midL + midR) / 2;
    const winH = (bottom - top) * 0.17;
    const rT = Math.min((bottom - top - winH) * 0.36, w * 0.075);
    const ty = top + winH + (bottom - top - winH) / 2 + h * 0.02;
    const rSm = rT * 0.42;
    return { w, h, top, bottom, Rs, sx, sy, plateW, plateX, midL, midR, tx, ty, rT, rSm, winH,
      small: [[tx - rT - rSm * 3.6, 'temp'], [tx - rT - rSm * 1.4, 'fuel'], [tx + rT + rSm * 1.4, 'oil'], [tx + rT + rSm * 3.6, 'amp']] };
  }
  function realCorvetteStatic(c, G) {
    const { w, h } = G;
    const bg = c.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#f9a3cb'); bg.addColorStop(0.12, '#ef72ad'); bg.addColorStop(0.75, '#e2609c'); bg.addColorStop(1, '#b9437a');
    c.fillStyle = bg; c.fillRect(0, 0, w, h);
    // brilho da pintura
    const hl = c.createLinearGradient(0, 0, w, 0);
    hl.addColorStop(0, 'rgba(255,255,255,0)'); hl.addColorStop(0.45, 'rgba(255,255,255,0.10)'); hl.addColorStop(0.6, 'rgba(255,255,255,0)');
    c.fillStyle = hl; c.fillRect(0, 0, w, h * 0.5);
    c.fillStyle = chromeGrad(c, 0, h - h * 0.05, 0, h); c.fillRect(0, h - h * 0.05, w, h * 0.05);
    // velocímetro em leque
    c.save();
    c.beginPath(); c.arc(G.sx, G.sy, G.Rs * 1.08, Math.PI, 0); c.closePath();
    c.fillStyle = 'rgba(120,30,70,0.35)'; c.fill();
    c.beginPath(); c.arc(G.sx, G.sy, G.Rs, Math.PI, 0); c.closePath();
    c.fillStyle = chromeGrad(c, G.sx - G.Rs, G.sy - G.Rs, G.sx + G.Rs, G.sy); c.fill();
    c.beginPath(); c.arc(G.sx, G.sy, G.Rs * 0.94, Math.PI, 0); c.closePath();
    const fg = c.createRadialGradient(G.sx, G.sy, G.Rs * 0.1, G.sx, G.sy, G.Rs);
    fg.addColorStop(0, '#24212a'); fg.addColorStop(1, '#0a080c'); c.fillStyle = fg; c.fill();
    c.restore();
    const ang = v => (174 - 168 * v / 250) * Math.PI / 180;
    for (let v = 0; v <= 250; v += 10) {
      const a = ang(v), major = v % 50 === 0, rr = G.Rs * 0.9, l = major ? G.Rs * 0.1 : G.Rs * 0.05;
      c.beginPath(); c.moveTo(G.sx + Math.cos(a) * rr, G.sy - Math.sin(a) * rr);
      c.lineTo(G.sx + Math.cos(a) * (rr - l), G.sy - Math.sin(a) * (rr - l));
      c.strokeStyle = '#f6f0e4'; c.lineWidth = major ? Math.max(1.5, G.Rs * 0.02) : 1; c.stroke();
    }
    c.fillStyle = '#f6f0e4'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `600 ${Math.round(G.Rs * 0.11)}px "Helvetica Neue", Arial, sans-serif`;
    [0, 50, 100, 150, 200, 250].forEach(v => { const a = ang(v), lr = G.Rs * 0.68; c.fillText(String(v), G.sx + Math.cos(a) * lr, G.sy - Math.sin(a) * lr); });
    c.fillStyle = '#a99a9f'; c.font = `500 ${Math.round(G.Rs * 0.08)}px "Helvetica Neue", Arial, sans-serif`;
    c.fillText('KM/H', G.sx, G.sy - G.Rs * 0.4);
    c.fillStyle = chromeGrad(c, 0, G.sy, 0, G.sy + G.Rs * 0.05); c.fillRect(G.sx - G.Rs, G.sy, G.Rs * 2, G.Rs * 0.05);
    // conta-giros e os quatro relógios pequenos
    realGaugeStatic(c, G.tx, G.ty, G.rT, { start: 225, sweep: 270, max: 8000, minor: 500, major: 1000,
      labels: [0, 2000, 4000, 6000, 8000], labelDiv: 1000, red: car.spec.redline, unit: 'RPM', unitY: 0.38, labelSize: 0.2, face: ['#28242b', '#0b090c'] });
    const names = { temp: 'TEMP', fuel: T('lFuel'), oil: T('lOil'), amp: 'BAT' };
    const ends = { temp: ['C', 'H'], fuel: ['E', 'F'], oil: ['0', '80'], amp: ['-', '+'] };
    G.small.forEach(([x, k]) => {
      const r = G.rSm;
      ringChrome(c, x, G.ty, r, r * 0.12);
      c.beginPath(); c.arc(x, G.ty, r * 0.88, 0, Math.PI * 2); c.fillStyle = '#100d11'; c.fill();
      for (let i = 0; i <= 4; i++) {
        const a = (150 - 30 * i) * Math.PI / 180;
        c.beginPath(); c.moveTo(x + Math.cos(a) * r * 0.8, G.ty + r * 0.25 - Math.sin(a) * r * 0.8);
        c.lineTo(x + Math.cos(a) * r * 0.62, G.ty + r * 0.25 - Math.sin(a) * r * 0.62);
        c.strokeStyle = '#f6f0e4'; c.lineWidth = Math.max(1, r * 0.06); c.stroke();
      }
      c.font = `700 ${Math.round(r * 0.3)}px "Helvetica Neue", Arial, sans-serif`; c.fillStyle = '#f6f0e4';
      c.fillText(ends[k][0], x - r * 0.55, G.ty + r * 0.45); c.fillText(ends[k][1], x + r * 0.55, G.ty + r * 0.45);
      c.fillStyle = '#7a1347'; c.font = `700 ${Math.round(r * 0.36)}px "Helvetica Neue", Arial, sans-serif`;
      c.fillText(names[k], x, G.ty + r * 1.45);
    });
    // placa cromada das luzes
    rrect(c, G.plateX, G.top, G.plateW, G.bottom - G.top, G.plateW * 0.08);
    c.fillStyle = chromeGrad(c, G.plateX, G.top, G.plateX + G.plateW, G.bottom); c.fill();
    rrect(c, G.plateX + 3, G.top + 3, G.plateW - 6, G.bottom - G.top - 6, G.plateW * 0.06);
    c.fillStyle = '#141114'; c.fill();
  }
  function realCorvetteDynamic(c, G, d, bulb, sweep, blink, blinkFast) {
    const f = d.warning_flags;
    const sF = Math.max(0, Math.min(1, bulb ? sweep : d.needleSpeed / 250));
    realOdometer(c, G.sx - G.Rs * 0.25, G.sy + G.Rs * 0.15, G.Rs * 0.083, G.Rs * 0.12, d.odometer_km);
    realNeedle(c, G.sx, G.sy, G.Rs, 174 - 168 * sF, 0.86, '#ff3355');
    realArrow(c, G.sx - G.Rs * 0.5, G.sy - G.Rs * 0.16, G.Rs * 0.07, -1, bulb || ((d.turn_signal === 1 || d.turn_signal === 3) && blink));
    realArrow(c, G.sx + G.Rs * 0.5, G.sy - G.Rs * 0.16, G.Rs * 0.07, 1, bulb || ((d.turn_signal === 2 || d.turn_signal === 3) && blink));
    const rF = Math.max(0, Math.min(1, bulb ? sweep : d.needleRpm / 8000));
    realNeedle(c, G.tx, G.ty, G.rT, 225 - 270 * rF, 0.82, '#ff3355');
    glassGlare(c, G.tx, G.ty, G.rT);
    const oil = d.engine_rpm > 300 ? Math.min(0.85, 0.25 + d.engine_rpm / 6000 * 0.55) : 0;
    const fr = {
      fuel: (f & FLAG_FUEL_SENSOR) ? -0.06 : (bulb ? sweep : d.fuel_level_percent / 100),
      temp: (f & FLAG_TEMP_SENSOR) ? -0.06 : (bulb ? sweep : (d.coolant_temp_celsius - 40) / 90),
      oil: bulb ? sweep : oil, amp: bulb ? sweep : (d.engine_rpm > 1200 ? 0.62 : 0.42)
    };
    G.small.forEach(([x, k]) => realNeedle(c, x, G.ty + G.rSm * 0.25, G.rSm, 150 - 120 * Math.max(-0.06, Math.min(1.04, fr[k])), 0.72, '#ff3355'));
    // rádio = mostrador de mensagens
    const ww = Math.min(G.midR - G.midL, G.rT * 5.2);
    realMessage(c, G.tx - ww / 2, G.top + G.winH * 0.1, ww, G.winH * 0.85, d, bulb, 'radio');
    chromeKnob(c, G.tx - ww / 2 - G.winH * 0.6, G.top + G.winH * 0.52, G.winH * 0.32);
    chromeKnob(c, G.tx + ww / 2 + G.winH * 0.6, G.top + G.winH * 0.52, G.winH * 0.32);
    // luzes: 2 colunas de 4 na placa
    const lamps = lampStates(d, bulb, blink, blinkFast);
    const cw = (G.plateW - 12) / 2, lh = Math.min((G.bottom - G.top - 12) / 4.6, cw * 0.42);
    lamps.forEach((l, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = G.plateX + 6 + col * cw + cw * 0.06, y = G.top + 6 + (G.bottom - G.top - 12) / 4 * (row + 0.5) - lh / 2;
      realLamp(c, x, y, cw * 0.88, lh, l.label, l.on, l.c);
    });
  }

  // desenha o painel realista num canvas de alta resolução (w x h em pixels reais)
  function drawRealCluster(c, w, h) {
    if (!disp || w < 20 || h < 20) return;
    const key = car.id + w + 'x' + h + lang;
    const G = car.id === 'corvette' ? realCorvetteGeo(w, h) : realCamaroGeo(w, h);
    if (key !== hiKey || !hiStatic) {
      hiStatic = document.createElement('canvas'); hiStatic.width = w; hiStatic.height = h;
      const sc = hiStatic.getContext('2d');
      if (car.id === 'corvette') realCorvetteStatic(sc, G); else realCamaroStatic(sc, G);
      hiKey = key;
    }
    c.clearRect(0, 0, w, h);
    c.drawImage(hiStatic, 0, 0);
    const now = simMs;
    const bulb = now < bulbUntil;
    const sweep = bulb ? Math.sin(Math.PI * Math.min(1, 1 - (bulbUntil - now) / 1500)) : 0;
    const blink = Math.floor(now / 333) % 2 === 0, blinkFast = Math.floor(now / 200) % 2 === 0;
    if (car.id === 'corvette') realCorvetteDynamic(c, G, disp, bulb, sweep, blink, blinkFast);
    else realCamaroDynamic(c, G, disp, bulb, sweep, blink, blinkFast);
  }

  // no jogo (modo real): um canvas liso por cima da faixa do painel
  function syncHiCanvas() {
    if (!canvas) return null;
    const want = visual === 'real';
    if (!want) { if (hiCanvas) hiCanvas.style.display = 'none'; return null; }
    if (!hiCanvas) {
      hiCanvas = document.createElement('canvas');
      hiCanvas.className = 'cluster-hi';
      hiCanvas.style.position = 'absolute'; hiCanvas.style.pointerEvents = 'none';
      hiCtx = hiCanvas.getContext('2d');
    }
    if (hiCanvas.parentElement !== canvas.parentElement) canvas.parentElement.appendChild(hiCanvas);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = W * pixelScale, cssH = CH * pixelScale;
    const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
    if (hiCanvas.width !== pw || hiCanvas.height !== ph) { hiCanvas.width = pw; hiCanvas.height = ph; }
    hiCanvas.style.display = 'block';
    hiCanvas.style.width = cssW + 'px'; hiCanvas.style.height = cssH + 'px';
    hiCanvas.style.left = canvas.offsetLeft + 'px';
    hiCanvas.style.top = (canvas.offsetTop + RH * pixelScale) + 'px';
    return hiCanvas;
  }

  function fitText(s, maxW) {
    s = norm(s);
    while (s.length > 1 && textW(s) > maxW) s = s.slice(0, -1);
    return s;
  }

  function currentMessage(d, bulbCheck) {
    const f = d.warning_flags;
    if (bulbCheck) return { text: T('msgBulb') };
    if (fuelPickup > 0) return { text: '+' + CAN_REFILL + '% ' + T('fuel') + ' ' + Math.round(veh.fuel) + '%' };
    if (f & FLAG_CAN_M1_TIMEOUT) return { text: T('msgCanM1'), warn: true };
    if (f & FLAG_SIGNAL_OOR) return { text: T('msgOor'), warn: true };
    if (f & FLAG_CAN_M2_TIMEOUT) return { text: T('msgCanM2'), warn: true };
    if (f & FLAG_TEMP_SENSOR) return { text: T('msgTempS'), warn: true };
    if (f & FLAG_COOLANT_HOT) return { text: T('msgHot') + ' ' + Math.round(d.coolant_temp_celsius) + '°C', warn: true };
    if (f & FLAG_FUEL_SENSOR) return { text: T('msgFuelS'), warn: true };
    if (veh.fuel <= 0) return { text: T('msgNoFuel'), warn: true };
    if (f & FLAG_OIL_PRESS_LOW) return { text: T('msgStall'), warn: true };
    if (f & FLAG_SEATBELT_WARN) return { text: T('msgBelt'), warn: true };
    // RF-06: rotação incompatível com a marcha (passou da faixa vermelha)
    if (d.engine_rpm >= car.spec.redline) return { text: T('msgRev'), warn: true };
    if (f & FLAG_LOW_FUEL) return { text: T('msgReserve') + ' ' + Math.round(d.fuel_level_percent) + '%', warn: true };
    if (countdownActive || (f & FLAG_HANDBRAKE_ON)) return { text: T('msgHand') };
    if (gameMode === 'PASSEIO' && speed > PASSEIO_SPEED_LIMIT) return { text: T('msgLimit'), warn: true };
    if (boostActive) return { text: T('msgBoost') };
    // computador de bordo: alterna trip e consumo a cada 3 s
    if (Math.floor(simMs / 3000) % 2 === 1 && d.instant_fuel_economy > 0) {
      return { text: T('msgEcon') + ' ' + d.instant_fuel_economy.toFixed(1) + ' KM/L' };
    }
    return { text: T('trip') + ' ' + d.trip_a_km.toFixed(1) + ' KM  ' + Math.round(d.coolant_temp_celsius) + '°C' };
  }

  /* --- Quadro das tarefas do RTOS (tecla R) --- */
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

  /* --- Contagem, resultado e pause --- */
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
    y += 5 * s + 8;
    const bs = W >= 260 ? 2 : 1;
    const gap = 8;
    // os dois botões lado a lado, centralizados
    const wRes = textW(T('resume'), bs) + 9 * bs, wQuit = textW(T('quit'), bs) + 9 * bs;
    const total = wRes + gap + wQuit;
    hit.resume = pixelButton(T('resume'), W / 2 - total / 2 + wRes / 2, y, bs, '#3ddc4a', '#0b2a12');
    hit.quit = pixelButton(T('quit'), W / 2 + total / 2 - wQuit / 2, y, bs, '#ffbb00', '#1c0326');
    y += 11 * bs + 6;
    text(fitText(T('keysHint'), W - 6), W / 2, y, '#94a3b8', 1, 'center'); y += 11;
    text(T('tests'), W / 2, y, '#ffbb00', 1, 'center'); y += 9;
    const items = [[T('kCan'), faults.can], [T('kTemp'), faults.tempSensor], [T('kFan'), faults.fan], [T('kFuel'), faults.fuelSensor],
      [T('kOor'), faults.oor], [T('kBelt'), faults.belt], [T('kHaz'), hazard], [T('kStall'), faults.stall], [T('kRtos'), showRtos]];
    const rowsFit = Math.max(1, Math.floor((H - 2 - y) / 8));
    const cols = items.length > rowsFit && W >= 300 ? 2 : 1;
    const colW = cols === 2 ? Math.floor((W - 16) / 2) : Math.min(W - 10, 170);
    const x00 = cols === 2 ? 6 : R(W / 2 - colW / 2);
    const y0 = y;
    items.forEach(([label, on], i) => {
      const c = cols === 2 ? Math.floor(i / Math.ceil(items.length / 2)) : 0;
      const yy = y0 + (cols === 2 ? i % Math.ceil(items.length / 2) : i) * 8;
      const x0 = x00 + c * (colW + 4);
      if (yy + 5 > H - 2) return;
      text(fitText(label, colW - 30), x0, yy, '#cbd5e1');
      text(on ? T('on') : T('off'), x0 + colW, yy, on ? '#3ddc4a' : '#64748b', 1, 'right');
    });
  }

  /* --- O que o site.js enxerga --- */
  window.UTFPRGame = {
    init: init,
    start: start,
    setLang: setLang,
    setVisualMode: setVisualMode,
    stop: stop,
    togglePause: togglePause,
    exitToMenu: exitToMenu,
    isRunning: isRunning,
    isPaused: isPaused,
    getFuelCans: function () { return fuelCans.map(c => ({ seg: c.segIndex, lane: c.lane })); },
    getPlayer: function () { return { seg: Math.floor(position / SEGMENT_LENGTH), lane: playerLane, fuel: veh.fuel }; },
    startBench: startBench,
    getBenchState: function () { return Object.assign({ drive: benchDrive }, bench); },
    onBenchTurn: function (fn) { benchOnTurn = fn; },
    stopBench: stopBench,
    benchSet: benchSet,
    isShowingResult: function () { return gameOverActive; },
    // usado pra depurar e pra tirar dados pro relatório
    getIcmSnapshot: function () { return disp ? JSON.parse(JSON.stringify(disp)) : null; },
    getTelemetry: function () { return telemetry.slice(); },
    // tudo que a aba "Tarefas OSEK / Sinal CAN / Verificações" da bancada precisa
    getOsekView: function () {
      if (!icm) return null;
      return {
        simMs: simMs,
        tasks: TASK_DEFS.map(t => Object.assign({ id: t.id, prio: t.prio, period: t.period, deadline: t.deadline, cost: t.cost, color: t.color },
          { count: taskStats[t.id].count, hist: taskStats[t.id].hist.slice(), minP: taskStats[t.id].minP, maxP: taskStats[t.id].maxP,
            lastResp: taskStats[t.id].lastResp, maxResp: taskStats[t.id].maxResp, misses: taskStats[t.id].misses })),
        jobs: jobLog.slice(),
        lastM1: icm.lastM1 || null, lastM2: icm.lastM2 || null,
        rawRpm: icm.rawRpm, rawSpeed: icm.rawSpeed, rpm: icm.engine_rpm, speed: icm.vehicle_speed_kmh,
        needleRpm: disp ? disp.needleRpm : 0, needleSpeed: disp ? disp.needleSpeed : 0,
        m1Age: icm.last_m1_time_ms ? simMs - icm.last_m1_time_ms : null,
        m2Age: icm.last_m2_time_ms ? simMs - icm.last_m2_time_ms : null,
        flags: icm.warning_flags, dtc: icm.active_dtc, dtcHistory: icm.dtcHistory.slice(),
        resourceErrors: resourceErrors, maxLocks: maxLocks, dispMin: dispMin, dispMax: dispMax,
        canFault: faults.can, oorFault: faults.oor
      };
    },
    getTaskStats: function () { const o = {}; Object.keys(taskStats).forEach(k => { o[k] = taskStats[k].count; }); return o; },
    injectFault: function (name, on) { if (name in faults) faults[name] = !!on; }
  };

})();
