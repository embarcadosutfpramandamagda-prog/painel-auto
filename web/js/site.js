/*
 * site.js - telas do tablet, garagem, ranking, idioma e modo pixel/real.
 *
 * O jogo em si fica no jogo.js (objeto global UTFPRGame); aqui só chamamos
 * UTFPRGame.start() e recebemos o resultado no fim da partida.
 *
 * As funções chamadas pelos onclick do index.html precisam continuar globais,
 * por isso o arquivo não está dentro de um módulo.
 */

let currentCarIndex = 0;
let isPixelMode = true;
let currentLang = 'pt';
let garageSubView = 'exterior';   // 'exterior' = o carro, 'interior' = o painel
let isGameRunning = false;

// showroom 360 (o mesmo ângulo vale pra garagem e pra escolha do carro, nos dois modos)
let virtualAngle = 30;
let dragVelocity = 0;
let isDraggingShowroom = false;
let dragLastX = 0;

/* --- Carros --- */

// cada carro tem uma pasta em web/img/carros/<id>/ com os mesmos nomes de arquivo
const CARS = [
  { id: 'camaro',   rankName: 'CAMARO 69',   numFrames: 12, startAngle: 30 },
  { id: 'corvette', rankName: 'CORVETTE 56', numFrames: 10, startAngle: 36 }
];

function carImg(car, file) { return `web/img/carros/${car.id}/${file}`; }
function carFrame(car, i) { return carImg(car, `giro-360/${String(i).padStart(2, '0')}.webp`); }
// versão pixel: as mesmas fotos do giro, passadas pra pixel art no mesmo enquadramento
function carFramePixel(car, i) { return carImg(car, `giro-360-pixel/${String(i).padStart(2, '0')}.png`); }

function preloadCarImages() {
  CARS.forEach(car => {
    for (let i = 0; i < car.numFrames; i++) { new Image().src = carFrame(car, i); new Image().src = carFramePixel(car, i); }
    ['interior-pixel.png', 'interior-real.jpg'].forEach(f => { new Image().src = carImg(car, f); });
  });
  new Image().src = 'web/img/cenarios/showroom-pixel.png';
}
// só depois que a página abriu, pra não atrasar a primeira tela
window.addEventListener('load', () => setTimeout(preloadCarImages, 300));

/* --- Textos PT / EN --- */

const I18N = {
  pt: {
    docTitle: 'Painel Automotivo com Trampoline e Controle em Tempo Real | UTFPR',
    title: 'Painel Automotivo com Trampoline e Controle em Tempo Real',
    play: 'JOGAR', ranking: 'CLASSIFICAÇÃO', garage: 'GARAGEM', start: 'INICIAR', back: 'VOLTAR',
    name: 'NOME', age: 'IDADE',
    m_passeio: 'PASSEIO', m_transito: 'TRÂNSITO', m_corrida: 'CORRIDA',
    rankTitle: '★ CLASSIFICAÇÃO ★', all: 'TODOS',
    rankEmpty: '★ NENHUM RECORDE REGISTRADO ★', rankEmptySub: 'SEJA O PRIMEIRO A JOGAR E ENTRAR NA CLASSIFICAÇÃO!',
    ageSuffix: 'a',
    drag: '⟲ ARRASTE PARA GIRAR 360°', panel: 'PAINEL',
    testIcm: 'TESTAR ICM', benchTitle: 'BANCADA DE TESTES DO ICM',
    benchSub: 'mesmo código do jogo: CAN M1/M2 → ISR2_CAN → tarefas OSEK → painel',
    bSpeed: 'VELOCIDADE (CAN M2)', bRpm: 'ROTAÇÃO (CAN M1)', bFuel: 'COMBUSTÍVEL', bTemp: 'TEMPERATURA',
    bTurnL: '◄ SETA', bTurnR: 'SETA ►', bHazard: 'PISCA-ALERTA', bHand: 'FREIO DE MÃO', bBelt: 'CINTO SOLTO',
    bStall: 'MOTOR DESLIGADO', bCan: 'CAN MUDO (U0100/U0101)', bTempS: 'SENSOR TEMP. (P0115)',
    bFuelS: 'SENSOR COMB. (P0460)', bOor: 'CAN FORA DA FAIXA (U0401)', bBulb: 'TESTE DE LUZES',
    stFrames: 'frames', stDtc: 'DTC ativo', stHist: 'histórico', stNone: 'nenhum',
    benchKeys: 'TECLADO: ↑ ACELERA · ↓ FREIA · ← → SETAS', modeDrive: 'DIRIGINDO PELO TECLADO', modeManual: 'VALORES DOS CONTROLES',
    tabCtl: 'CONTROLES', tabOsek: 'TAREFAS OSEK', tabCan: 'SINAL CAN', tabChk: 'VERIFICAÇÕES',
    tlTitle: 'LINHA DO TEMPO DA CPU (prioridade maior em cima)',
    tlLegend: '▮ executando · │ ativação (alarme / ISR) · estados OSEK: SUSPENDED → READY → RUNNING → WAITING (só a CAN_RX espera evento)',
    thTask: 'tarefa', thPrio: 'prio', thPer: 'período', thMeas: 'medido', thAct: 'ativ./s', thCost: 'CPU', thResp: 'resposta máx.',
    thDl: 'prazo', thMiss: 'perdidos', thState: 'estado', evt: 'evento',
    pRecv: 'RECEBE', pVal: 'VALIDA', pScale: 'ESCALA', pFilt: 'FILTRA', pDisp: 'MOSTRA',
    pOk: 'dentro da faixa', pRej: 'REJEITADO → mantém o último', pWait: 'aguardando frame…',
    fresh: 'IDADE DO DADO', timeoutAt: 'timeout em', safeVal: 'valor seguro 0 + aviso',
    chkLive: 'AO VIVO (este navegador)', chkFw: 'FIRMWARE C (SIL 30 s + GoogleTest)',
    cFunc: 'Functional Correctness', cPer: 'Task Periods', cDl: 'Deadline Compliance', cFresh: 'Data Freshness',
    cCan: 'CAN Timeout Handling', cRes: 'Resource Protection', cDet: 'Deterministic Dashboard Update',
    dFunc: 'M1 {a} e M2 {b} frames decodificados; fora da faixa rejeitado',
    dPer: 'períodos medidos iguais aos do OIL', dDl: '{m} prazos perdidos; pior resposta {r} µs',
    dFresh: 'M1 {a} ms (máx. 1000) · M2 {b} ms (máx. 2000)', dFreshF: 'dado velho detectado e sinalizado',
    dCanOk: 'barramento ok; ligue CAN MUDO para testar', dCanF: 'timeout detectado: aviso + valor seguro',
    dCanBad: 'CAN mudo mas sem aviso!', dRes: '{e} violações; no máx. {l} tarefa no ICM_Resource',
    dDet: 'quadros a cada {a}..{b} ms', waiting: 'aguardando…', noEvid: 'rode cmake --build build --target evidencias',
    tests: 'testes', passed: 'passaram',
    prevCar: 'Carro anterior', nextCar: 'Próximo carro',
    toPixel: 'Mudar para modo pixel', toReal: 'Mudar para modo foto real',
    toggleLang: 'Switch to English',
    chooseCar: 'ESCOLHA SEU CARRO', choose: 'ESCOLHER',
    cars: { camaro: 'Chevrolet Camaro Conversível', corvette: 'Chevrolet Corvette EV Conversível' }
  },
  en: {
    docTitle: 'Automotive Dashboard with Trampoline and Real-Time Control | UTFPR',
    title: 'Automotive Dashboard with Trampoline and Real-Time Control',
    play: 'PLAY', ranking: 'RANKING', garage: 'GARAGE', start: 'START', back: 'BACK',
    name: 'NAME', age: 'AGE',
    m_passeio: 'CRUISE', m_transito: 'TRAFFIC', m_corrida: 'RACE',
    rankTitle: '★ RANKING ★', all: 'ALL',
    rankEmpty: '★ NO RECORDS YET ★', rankEmptySub: 'BE THE FIRST TO PLAY AND MAKE THE RANKING!',
    ageSuffix: 'y',
    drag: '⟲ DRAG TO ROTATE 360°', panel: 'DASHBOARD',
    testIcm: 'TEST ICM', benchTitle: 'ICM TEST BENCH',
    benchSub: 'same code as the game: CAN M1/M2 → ISR2_CAN → OSEK tasks → cluster',
    bSpeed: 'SPEED (CAN M2)', bRpm: 'ENGINE SPEED (CAN M1)', bFuel: 'FUEL', bTemp: 'COOLANT TEMP',
    bTurnL: '◄ TURN', bTurnR: 'TURN ►', bHazard: 'HAZARD', bHand: 'PARKING BRAKE', bBelt: 'SEATBELT OFF',
    bStall: 'ENGINE OFF', bCan: 'CAN MUTE (U0100/U0101)', bTempS: 'TEMP SENSOR (P0115)',
    bFuelS: 'FUEL SENSOR (P0460)', bOor: 'CAN OUT OF RANGE (U0401)', bBulb: 'BULB CHECK',
    stFrames: 'frames', stDtc: 'active DTC', stHist: 'history', stNone: 'none',
    benchKeys: 'KEYBOARD: ↑ THROTTLE · ↓ BRAKE · ← → TURN', modeDrive: 'DRIVING WITH KEYBOARD', modeManual: 'SLIDER VALUES',
    tabCtl: 'CONTROLS', tabOsek: 'OSEK TASKS', tabCan: 'CAN SIGNAL', tabChk: 'VERIFICATION',
    tlTitle: 'CPU TIMELINE (higher priority on top)',
    tlLegend: '▮ running · │ activation (alarm / ISR) · OSEK states: SUSPENDED → READY → RUNNING → WAITING (only CAN_RX waits for an event)',
    thTask: 'task', thPrio: 'prio', thPer: 'period', thMeas: 'measured', thAct: 'act./s', thCost: 'CPU', thResp: 'max response',
    thDl: 'deadline', thMiss: 'missed', thState: 'state', evt: 'event',
    pRecv: 'RECEIVE', pVal: 'VALIDATE', pScale: 'SCALE', pFilt: 'FILTER', pDisp: 'DISPLAY',
    pOk: 'in range', pRej: 'REJECTED → keeps last value', pWait: 'waiting for frame…',
    fresh: 'DATA AGE', timeoutAt: 'timeout at', safeVal: 'safe value 0 + warning',
    chkLive: 'LIVE (this browser)', chkFw: 'C FIRMWARE (30 s SIL + GoogleTest)',
    cFunc: 'Functional Correctness', cPer: 'Task Periods', cDl: 'Deadline Compliance', cFresh: 'Data Freshness',
    cCan: 'CAN Timeout Handling', cRes: 'Resource Protection', cDet: 'Deterministic Dashboard Update',
    dFunc: 'M1 {a} and M2 {b} frames decoded; out of range rejected',
    dPer: 'measured periods equal the OIL ones', dDl: '{m} deadlines missed; worst response {r} µs',
    dFresh: 'M1 {a} ms (max 1000) · M2 {b} ms (max 2000)', dFreshF: 'stale data detected and flagged',
    dCanOk: 'bus ok; turn on CAN MUTE to test', dCanF: 'timeout detected: warning + safe value',
    dCanBad: 'CAN muted but no warning!', dRes: '{e} violations; at most {l} task inside ICM_Resource',
    dDet: 'frames every {a}..{b} ms', waiting: 'waiting…', noEvid: 'run cmake --build build --target evidencias',
    tests: 'tests', passed: 'passed',
    prevCar: 'Previous car', nextCar: 'Next car',
    toPixel: 'Switch to pixel mode', toReal: 'Switch to real photo mode',
    toggleLang: 'Mudar para português',
    chooseCar: 'CHOOSE YOUR CAR', choose: 'SELECT',
    cars: { camaro: 'Chevrolet Camaro Convertible', corvette: 'Chevrolet Corvette EV Convertible' }
  }
};

// o modo fica salvo em português no ranking; aqui só traduzimos na hora de mostrar
const MODE_KEYS = { 'PASSEIO': 'm_passeio', 'TRÂNSITO': 'm_transito', 'CORRIDA': 'm_corrida' };

function t(key) { return I18N[currentLang][key]; }
function modeLabel(mode) { return MODE_KEYS[mode] ? t(MODE_KEYS[mode]) : mode; }

// troca todos os textos marcados com data-i18n, data-i18n-ph (placeholder) e data-i18n-title
function applyLanguage() {
  document.documentElement.lang = currentLang === 'en' ? 'en' : 'pt-BR';
  document.title = t('docTitle');
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', t(el.dataset.i18nTitle));
  });
  const langBtn = document.getElementById('btnToggleLang');
  langBtn.title = t('toggleLang');
  langBtn.setAttribute('aria-label', t('toggleLang'));

  if (typeof UTFPRGame !== 'undefined') UTFPRGame.setLang(currentLang);
  fitButtonLabels();
  updateCarTexts();
  updatePixelButton();
  renderRanking();
}

// texto do botão pixel nunca sai do desenho: se a palavra for comprida (CLASSIFICAÇÃO)
// ou a fonte for mais larga, diminui a letra até caber em ~80% da largura do botão
function fitButtonLabels() {
  document.querySelectorAll('.btn-pixel-label').forEach(el => {
    el.style.fontSize = '';
    const box = el.parentElement;
    if (!box || !box.offsetWidth) return;
    const max = box.offsetWidth * 0.8;
    let fs = parseFloat(getComputedStyle(el).fontSize);
    for (let i = 0; i < 30 && el.scrollWidth > max && fs > 5; i++) { fs -= 0.5; el.style.fontSize = fs + 'px'; }
  });
}
window.addEventListener('resize', () => requestAnimationFrame(fitButtonLabels));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitButtonLabels);
// a fonte pixel do Google chega depois (carregamento sem travar), então ajusta de novo quando ela chegar
if (document.fonts) document.fonts.addEventListener('loadingdone', () => requestAnimationFrame(fitButtonLabels));
window.addEventListener('load', () => setTimeout(fitButtonLabels, 300));
// telas que estavam escondidas só têm tamanho quando aparecem
new MutationObserver(() => requestAnimationFrame(fitButtonLabels))
  .observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['class'] });

function toggleLanguage() {
  currentLang = currentLang === 'pt' ? 'en' : 'pt';
  playBeep(currentLang === 'en' ? 660 : 550, 'square', 0.1);
  try { localStorage.setItem('icm_lang', currentLang); } catch (e) {}
  applyLanguage();
}

/* --- Som dos botões --- */

// clique suave dos menus: senoide curtinha, volume baixo e o tom caindo um pouco
// (antes era uma onda quadrada, que cansava o ouvido). O "freq" só muda levemente o tom.
let uiAudio = null;
function playBeep(freq = 440) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!uiAudio) uiAudio = new AudioCtx();
    const ctx = uiAudio, t = ctx.currentTime;
    const f = Math.max(420, Math.min(900, 380 + freq * 0.55));
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 0.62, t + 0.07);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.045, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  } catch (e) {
    // navegador sem áudio: segue sem som
  }
}

/* --- Modo pixel / foto real --- */

function setPixelMode(pixel) {
  if (isPixelMode === pixel) return;
  isPixelMode = pixel;
  playBeep(isPixelMode ? 780 : 390, 'square', 0.12);
  try { localStorage.setItem('icm_pixel_mode', isPixelMode ? '1' : '0'); } catch (e) {}
  updateDisplayModes();   // a caixa do tablet tem a mesma altura nos dois modos (site.css), então a página não pula
}


function togglePixelMode() { setPixelMode(!isPixelMode); }

function updatePixelButton() {
  const btn = document.getElementById('btnTogglePixel');
  const label = isPixelMode ? t('toReal') : t('toPixel');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

// tudo que depende de "qual carro" + "pixel ou real" passa por aqui
function updateDisplayModes() {
  const car = CARS[currentCarIndex];
  document.body.classList.toggle('real-mode', !isPixelMode);
  updatePixelButton();

  // garagem: só uma das 4 camadas aparece por vez
  const layers = {
    garagePixelView:   isPixelMode && garageSubView === 'exterior',
    garageRealView:    !isPixelMode && garageSubView === 'exterior',
    interiorPixelView: isPixelMode && garageSubView === 'interior',
    interiorRealView:  !isPixelMode && garageSubView === 'interior',
    icmBenchView:      garageSubView === 'icm'
  };
  Object.entries(layers).forEach(([id, show]) => {
    document.getElementById(id).classList.toggle('show', show);
  });
  document.getElementById('viewMenuGarage').dataset.sub = garageSubView;

  document.getElementById('interiorPixelImg').src = carImg(car, 'interior-pixel.png');
  document.getElementById('interiorImg').src = carImg(car, 'interior-real.jpg');
  document.getElementById('carBrandLogo').src = carImg(car, 'logo.png');
  updateSpinFrames();
  updateCarTexts();

  // o jogo também troca o fundo (campus pixel ou foto)
  if (typeof UTFPRGame !== 'undefined') UTFPRGame.setVisualMode(!isPixelMode);
}

function updateCarTexts() {
  const name = t('cars')[CARS[currentCarIndex].id];
  document.getElementById('selectorTitle').textContent = name;
  document.getElementById('carPickName').textContent = name;
}

/* --- Navegação entre as telas do tablet --- */

const SCREENS = ['viewMenuMain', 'viewMenuPilot', 'viewMenuCar', 'viewMenuModes', 'viewMenuRanking', 'viewMenuGarage'];

function showScreen(id) {
  SCREENS.forEach(v => document.getElementById(v).classList.toggle('active', v === id));
}
function isScreenOpen(id) { return document.getElementById(id).classList.contains('active'); }

function openMainScreen() {
  playBeep(320, 'square', 0.08);
  if (garageSubView === 'icm') { stopBench(); garageSubView = 'exterior'; updateDisplayModes(); }
  showScreen('viewMenuMain');
}

function openPilotScreen() {
  playBeep(480, 'square', 0.08);
  showScreen('viewMenuPilot');
  // no computador o nome já vem selecionado pra digitar por cima;
  // no celular não, senão o teclado abre sozinho
  if (window.matchMedia && matchMedia('(pointer: fine)').matches) {
    setTimeout(() => {
      const f = document.getElementById('pilotNameField');
      f.focus();
      f.select();
    }, 0);
  }
}

// fluxo do JOGAR: nome/idade -> carro -> modo -> partida
function confirmPilot() { openCarScreen(); }

function openCarScreen() {
  playBeep(600, 'square', 0.1);
  updateDisplayModes();
  showScreen('viewMenuCar');
}

function confirmCar() { playBeep(700, 'square', 0.1); showScreen('viewMenuModes'); }

function openGarageScreen() {
  playBeep(440, 'square', 0.08);
  garageSubView = 'exterior';
  updateDisplayModes();
  showScreen('viewMenuGarage');
}

function setGarageSubView(view) {
  if (garageSubView === view) return;
  playBeep(view === 'interior' ? 560 : 500, 'square', 0.06);
  if (garageSubView === 'icm') stopBench();
  garageSubView = view;
  updateDisplayModes();
  if (view === 'icm') startBench();
}

function garageBack() {
  // ordem da garagem: carro → TESTAR ICM → PAINEL; o VOLTAR faz o caminho de volta
  if (garageSubView === 'interior') setGarageSubView('icm');
  else if (garageSubView === 'icm') setGarageSubView('exterior');
  else openMainScreen();
}

/* --- Bancada de testes do ICM (garagem > painel > testar ICM) --- */

let benchTimer = null;
const BENCH_UNITS = { kmh: ' km/h', rpm: ' rpm', fuel: ' %', temp: ' °C' };

function startBench() {
  if (typeof UTFPRGame === 'undefined') return;
  UTFPRGame.setLang(currentLang);
  UTFPRGame.startBench(document.getElementById('benchCanvas'), { carIndex: currentCarIndex, realMode: !isPixelMode });
  UTFPRGame.onBenchTurn(turn => {
    document.querySelectorAll('#icmBenchView .bench-tog[data-bench="turn"]').forEach(b => b.classList.toggle('on', +b.dataset.val === turn));
  });
  // volta os controles pro estado inicial
  document.querySelectorAll('#icmBenchView input[data-bench]').forEach(inp => {
    inp.value = inp.defaultValue;
    UTFPRGame.benchSet(inp.dataset.bench, +inp.value);
    updateBenchOut(inp);
  });
  document.querySelectorAll('#icmBenchView .bench-tog').forEach(b => b.classList.remove('on'));
  clearInterval(benchTimer);
  benchTimer = setInterval(() => { updateBenchStatus(); renderBenchTab(); }, 250);
  updateBenchStatus();
}

function stopBench() {
  clearInterval(benchTimer);
  if (typeof UTFPRGame !== 'undefined') UTFPRGame.stopBench();
}

function updateBenchOut(inp) {
  const out = document.querySelector(`#icmBenchView [data-out="${inp.dataset.bench}"]`);
  if (out) out.textContent = inp.value + BENCH_UNITS[inp.dataset.bench];
}

// linha de baixo: quantos frames chegaram, DTC ativo e histórico (vem direto do ICM simulado)
function updateBenchStatus() {
  const d = UTFPRGame.getIcmSnapshot();
  const el = document.getElementById('benchStatus');
  if (!d || !el) return;
  const dtc = d.active_dtc === 'NONE' ? t('stNone') : d.active_dtc;
  el.innerHTML = `M1 0x100: <b>${d.framesM1}</b> ${t('stFrames')} · M2 0x101: <b>${d.framesM2}</b> ${t('stFrames')} · ` +
    `${t('stDtc')}: <b class="${d.active_dtc === 'NONE' ? '' : 'warn'}">${dtc}</b> · ${t('stHist')}: ${d.dtcHistory.join(' ') || t('stNone')}`;
  // os controles acompanham o carro (dirigindo pelo teclado ou o combustível gastando)
  const st = UTFPRGame.getBenchState();
  document.querySelectorAll('#icmBenchView input[data-bench]').forEach(inp => {
    if (inp === benchDragging) return;
    const k = inp.dataset.bench;
    if (k === 'rpm' && !st.drive) return;
    inp.value = Math.round(st[k]);
    updateBenchOut(inp);
  });
  const mode = document.getElementById('benchMode');
  if (mode) { mode.textContent = st.drive ? t('modeDrive') : t('modeManual'); mode.classList.toggle('drive', st.drive); }
}
let benchDragging = null;

function setupBench() {
  document.querySelectorAll('#icmBenchView input[data-bench]').forEach(inp => {
    updateBenchOut(inp);
    inp.addEventListener('input', () => { UTFPRGame.benchSet(inp.dataset.bench, +inp.value); updateBenchOut(inp); });
    inp.addEventListener('pointerdown', () => { benchDragging = inp; });
    inp.addEventListener('pointerup', () => { benchDragging = null; inp.blur(); });
  });
  document.querySelectorAll('#icmBenchView .bench-tog').forEach(btn => btn.addEventListener('click', () => {
    playBeep(520);
    const key = btn.dataset.bench, val = +btn.dataset.val;
    if (key === 'bulb') { UTFPRGame.benchSet('bulb', 1); return; }      // botão de toque, não fica ligado
    if (key === 'turn') {
      // as duas setas são o mesmo sinal: ligar uma desliga a outra
      const on = !btn.classList.contains('on');
      document.querySelectorAll('#icmBenchView .bench-tog[data-bench="turn"]').forEach(b => b.classList.remove('on'));
      btn.classList.toggle('on', on);
      UTFPRGame.benchSet('turn', on ? val : 0);
      return;
    }
    const on = btn.classList.toggle('on');
    UTFPRGame.benchSet(key, on);
  }));
}

/* --- abas da bancada: tarefas OSEK, caminho do sinal CAN e verificações do slide 7 --- */
let benchTab = 'ctl', tlZoom = 100;
const fmt = (str, o) => str.replace(/\{(\w)\}/g, (_, k) => o[k]);
const hex = arr => arr.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

function setBenchTab(tab) {
  benchTab = tab;
  document.querySelectorAll('#icmBenchView .bench-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('#icmBenchView .bench-panel').forEach(p => { p.hidden = p.dataset.panel !== tab; });
  renderBenchTab();
}

function renderBenchTab() {
  if (benchTab === 'ctl' || typeof UTFPRGame === 'undefined' || !UTFPRGame.getOsekView) return;
  const v = UTFPRGame.getOsekView();
  if (!v) return;
  if (benchTab === 'osek') { drawTimeline(v); drawTaskTable(v); }
  else if (benchTab === 'can') drawCanPipe(v);
  else if (benchTab === 'chk') drawChecks(v);
}

// estado OSEK de cada tarefa no instante atual da simulação
function osekState(task, v) {
  const nowUs = v.simMs * 1000 + 999;
  const j = v.jobs.filter(x => x.id === task.id).pop();
  if (j && j.start <= nowUs && nowUs < j.end) return 'RUNNING';
  if (j && j.release <= nowUs && nowUs < j.start) return 'READY';
  if (task.id === 'Task_CAN_RX') return 'WAITING';
  return 'SUSPENDED';
}

function drawTimeline(v) {
  const cv = document.getElementById('benchTimeline');
  if (!cv) return;
  const W = Math.max(200, Math.round(cv.clientWidth * (window.devicePixelRatio || 1)));
  const rowH = Math.round(Math.max(W / 70, 13 * (window.devicePixelRatio || 1))), labW = Math.round(W * 0.11), H = rowH * v.tasks.length + rowH * 1.4;
  if (cv.width !== W || cv.height !== Math.round(H)) { cv.width = W; cv.height = Math.round(H); }
  const g = cv.getContext('2d');
  g.fillStyle = '#05070b'; g.fillRect(0, 0, W, H);
  const span = tlZoom * 1000, t1 = (v.simMs + 1) * 1000, t0 = t1 - span;
  const x = us => labW + (us - t0) / span * (W - labW - 4);
  // grade a cada 10 ms (ou 100 ms no zoom de 1 s)
  const step = tlZoom === 100 ? 10000 : 100000;
  g.font = `${Math.round(rowH * 0.62)}px monospace`;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    g.strokeStyle = '#1e293b'; g.beginPath(); g.moveTo(x(t), 0); g.lineTo(x(t), rowH * v.tasks.length); g.stroke();
    g.fillStyle = '#64748b'; g.fillText((t / 1000) + ' ms', x(t) + 2, H - rowH * 0.35);
  }
  v.tasks.forEach((tk, i) => {
    const y = i * rowH;
    g.fillStyle = i % 2 ? '#0b1018' : '#080b11'; g.fillRect(labW, y, W - labW, rowH);
    g.fillStyle = tk.color; g.fillText(tk.id.replace('Task_', ''), 4, y + rowH * 0.72);
    v.jobs.forEach(j => {
      if (j.id !== tk.id || j.end < t0) return;
      const xr = x(j.release);
      g.fillStyle = '#94a3b8'; g.fillRect(xr, y + 1, 1, rowH - 2);                        // ativação
      g.fillStyle = tk.color;
      g.fillRect(x(j.start), y + rowH * 0.2, Math.max(2, x(j.end) - x(j.start)), rowH * 0.6);  // executando
    });
  });
}

function drawTaskTable(v) {
  const tb = document.getElementById('benchTaskTable');
  if (!tb) return;
  const rows = v.tasks.map(tk => {
    const per = tk.period ? tk.period + ' ms' : (tk.id === 'ISR2_CAN' ? 'IRQ' : t('evt'));
    const meas = tk.period ? (tk.minP ? (tk.minP === tk.maxP ? tk.minP + ' ms' : tk.minP + '..' + tk.maxP + ' ms') : '…') : '—';
    const ok = !tk.period || !tk.minP || (tk.minP === tk.period && tk.maxP === tk.period);
    const st = osekState(tk, v);
    return `<tr><td style="color:${tk.color}">${tk.id}</td><td>${tk.prio}</td><td>${per}</td>` +
      `<td class="${ok ? 'ok' : 'warn'}">${meas}</td><td>${tk.hist.length}</td><td>${tk.cost} µs</td>` +
      `<td>${tk.maxResp} µs</td><td>${tk.deadline} ms</td><td class="${tk.misses ? 'warn' : 'ok'}">${tk.misses}</td>` +
      `<td><span class="st st-${st.toLowerCase()}">${st}</span></td></tr>`;
  }).join('');
  tb.innerHTML = `<tr><th>${t('thTask')}</th><th>${t('thPrio')}</th><th>${t('thPer')}</th><th>${t('thMeas')}</th>` +
    `<th>${t('thAct')}</th><th>${t('thCost')}</th><th>${t('thResp')}</th><th>${t('thDl')}</th><th>${t('thMiss')}</th><th>${t('thState')}</th></tr>` + rows;
}

function canRow(label, f, scaleTxt, filtTxt, dispTxt, age, tmo, unit) {
  const steps = f ? [
    [t('pRecv'), `${label}<br><small>${hex(f.bytes)}</small>`, ''],
    [t('pVal'), f.valid ? t('pOk') : t('pRej'), f.valid ? 'ok' : 'bad'],
    [t('pScale'), scaleTxt, ''],
    [t('pFilt'), filtTxt, ''],
    [t('pDisp'), dispTxt, '']
  ] : [[t('pRecv'), label + '<br><small>' + t('pWait') + '</small>', '']];
  const pct = age == null ? 0 : Math.min(100, age / tmo * 100);
  const late = age != null && age > tmo;
  return `<div class="can-row">` + steps.map((s, i) =>
    `<div class="can-step ${s[2]}"><b>${s[0]}</b><span>${s[1]}</span></div>` + (i < steps.length - 1 ? '<i>→</i>' : '')).join('') +
    `</div><div class="can-fresh"><span>${t('fresh')} ${label.split(' ')[0]}: <b class="${late ? 'warn' : ''}">${age == null ? '—' : age + ' ms'}</b> · ${t('timeoutAt')} ${tmo} ms${late ? ' → ' + t('safeVal') : ''}</span>` +
    `<div class="bar"><div style="width:${pct}%;background:${late ? '#ff6b6b' : pct > 60 ? '#ffd43b' : '#3ddc4a'}"></div></div></div>`;
}

function drawCanPipe(v) {
  const el = document.getElementById('benchCanPipe');
  if (!el) return;
  const a = v.lastM1, b = v.lastM2;
  el.innerHTML =
    canRow('M1 0x100 ECM', a, a ? `${a.raw} × 0.25 = ${a.value.toFixed(0)} rpm` : '', `${Math.round(v.rawRpm)} → ${Math.round(v.rpm)} rpm`,
      `${Math.round(v.needleRpm)} rpm`, v.m1Age, 1000) +
    canRow('M2 0x101 TCM', b, b ? `${b.raw} × 0.05 = ${b.value.toFixed(1)} km/h` : '', `${Math.round(v.rawSpeed)} → ${Math.round(v.speed)} km/h`,
      `${Math.round(v.needleSpeed)} km/h`, v.m2Age, 2000);
}

function chkLi(ok, name, detail) {
  const cls = ok === null ? 'wait' : ok ? 'ok' : 'bad';
  return `<li class="${cls}"><b>${ok === null ? '…' : ok ? '✔' : '✘'}</b> <span>${name}</span><small>${detail}</small></li>`;
}

function drawChecks(v) {
  const live = document.getElementById('benchChkLive'), fw = document.getElementById('benchChkFw');
  if (!live || !fw) return;
  const per = v.tasks.filter(x => x.period);
  const perReady = per.every(x => x.minP);
  const perOk = per.every(x => !x.minP || (x.minP === x.period && x.maxP === x.period));
  const misses = v.tasks.reduce((s, x) => s + x.misses, 0), worst = Math.max(...v.tasks.map(x => x.maxResp));
  const m1to = !!(v.flags & 2), m2to = !!(v.flags & 4);
  const fresh = (v.m1Age != null && v.m1Age <= 1000) && (v.m2Age != null && v.m2Age <= 2000);
  const snap = UTFPRGame.getIcmSnapshot();
  const canOk = v.canFault ? (m1to || (v.m1Age != null && v.m1Age <= 1000)) : true;
  live.innerHTML =
    chkLi(v.lastM1 && v.lastM2 ? true : null, t('cFunc'), fmt(t('dFunc'), { a: snap.framesM1, b: snap.framesM2 })) +
    chkLi(perReady ? perOk : null, t('cPer'), t('dPer')) +
    chkLi(misses === 0, t('cDl'), fmt(t('dDl'), { m: misses, r: worst })) +
    chkLi(fresh ? true : (m1to || m2to) ? true : null, t('cFresh'), fresh ? fmt(t('dFresh'), { a: v.m1Age, b: v.m2Age }) : t('dFreshF')) +
    chkLi(canOk, t('cCan'), v.canFault ? (m1to ? t('dCanF') : (canOk ? t('waiting') : t('dCanBad'))) : t('dCanOk')) +
    chkLi(v.resourceErrors === 0 && v.maxLocks <= 1, t('cRes'), fmt(t('dRes'), { e: v.resourceErrors, l: v.maxLocks })) +
    chkLi(v.dispMin ? v.dispMin === 50 && v.dispMax === 50 : null, t('cDet'), fmt(t('dDet'), { a: v.dispMin || '…', b: v.dispMax || '…' }));
  const r = window.SIL_RESUMO;
  if (!r) { fw.innerHTML = chkLi(null, '—', t('noEvid')); return; }
  fw.innerHTML = r.verificacoes.map(c => chkLi(c.ok, c.nome, c.detalhe)).join('') +
    (r.gtest || []).map(g => chkLi(g.falhas === 0, g.suite, `${g.total - g.falhas}/${g.total} ${t('tests')} ${t('passed')}`)).join('') +
    `<li class="meta"><small>hash ${r.hash} · ${(r.utilizacao * 100).toFixed(2)} % CPU · ${r.gerado_em || ''}</small></li>`;
}

function setupBenchTabs() {
  document.querySelectorAll('#icmBenchView .bench-tab').forEach(b => b.addEventListener('click', () => { playBeep(520); setBenchTab(b.dataset.tab); }));
  document.querySelectorAll('#icmBenchView [data-zoom]').forEach(b => b.addEventListener('click', () => {
    tlZoom = +b.dataset.zoom;
    document.querySelectorAll('#icmBenchView [data-zoom]').forEach(x => x.classList.toggle('on', x === b));
    renderBenchTab();
  }));
}

function prevCar() {
  playBeep(400, 'square', 0.06);
  currentCarIndex = (currentCarIndex - 1 + CARS.length) % CARS.length;
  virtualAngle = CARS[currentCarIndex].startAngle;
  updateDisplayModes();
}

function nextCar() {
  playBeep(400, 'square', 0.06);
  currentCarIndex = (currentCarIndex + 1) % CARS.length;
  virtualAngle = CARS[currentCarIndex].startAngle;
  updateDisplayModes();
}

/* --- Partida e ranking --- */

// Ranking compartilhado: as partidas ficam no Firestore (Firebase, projeto jogo-27a51),
// então todo mundo que joga aparece na mesma classificação. O navegador guarda uma cópia
// e uma fila do que ainda não foi enviado: sem internet a partida não se perde e sobe depois.
const RANKING_KEY = 'utfpr_topgear_ranking_v5';        // cópia local (também serve quando está offline)
const RANKING_PENDING_KEY = 'utfpr_topgear_ranking_pending';
try { ['utfpr_topgear_ranking_v3', 'utfpr_topgear_ranking_v2', 'utfpr_topgear_ranking'].forEach(k => localStorage.removeItem(k)); } catch (e) {}
const FIREBASE = { projectId: 'jogo-27a51', apiKey: '' };   // apiKey é opcional na API REST
const FS_URL = 'https://firestore.googleapis.com/v1/projects/' + FIREBASE.projectId + '/databases/(default)/documents/ranking';
const fsKey = (sep) => FIREBASE.apiKey ? sep + 'key=' + encodeURIComponent(FIREBASE.apiKey) : '';
let rankingFilter = 'ALL';
let rankingOnline = false;           // true quando a lista veio do Firebase
let rankingList = loadRanking();

function loadJson(key) {
  try { const raw = localStorage.getItem(key); if (raw) return JSON.parse(raw); } catch (e) {}
  return [];
}
function loadRanking() { return loadJson(RANKING_KEY); }
function saveRanking() {
  try { localStorage.setItem(RANKING_KEY, JSON.stringify(rankingList)); } catch (e) {}
}
function savePending(list) {
  try { localStorage.setItem(RANKING_PENDING_KEY, JSON.stringify(list)); } catch (e) {}
}

// documento do Firestore <-> registro do ranking
function toFirestore(e) {
  return { fields: {
    name: { stringValue: String(e.name).slice(0, 12) },
    age: { integerValue: String(Math.max(0, Math.min(120, e.age | 0))) },
    car: { stringValue: String(e.car).slice(0, 40) },
    mode: { stringValue: e.mode },
    score: { integerValue: String(Math.max(0, Math.min(100000, e.score | 0))) },
    ts: { timestampValue: new Date(e.ts || Date.now()).toISOString() }
  } };
}
function fromFirestore(doc) {
  const f = doc.fields || {};
  const v = (k) => f[k] ? (f[k].stringValue ?? f[k].integerValue ?? f[k].timestampValue) : undefined;
  return { id: doc.name, name: v('name') || '?', age: +v('age') || 0, car: v('car') || '', mode: v('mode') || '',
    score: +v('score') || 0, ts: Date.parse(v('ts')) || 0 };
}

async function sendEntry(entry) {
  const res = await fetch(FS_URL + fsKey('?'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toFirestore(entry)) });
  if (!res.ok) throw new Error('firestore ' + res.status);
}

// manda o que ficou na fila (partidas jogadas sem internet)
async function flushPending() {
  let pending = loadJson(RANKING_PENDING_KEY);
  while (pending.length) {
    try { await sendEntry(pending[0]); } catch (e) { return false; }
    pending.shift();
    savePending(pending);
  }
  return true;
}

async function syncRankingOnce() {
  try {
    await flushPending();
    const all = [];
    let token = '';
    for (let page = 0; page < 10; page++) {   // até 3000 partidas
      const res = await fetch(FS_URL + '?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : '') + fsKey('&'));
      if (!res.ok) throw new Error('firestore ' + res.status);
      const data = await res.json();
      (data.documents || []).forEach(d => all.push(fromFirestore(d)));
      if (!data.nextPageToken) break;
      token = data.nextPageToken;
    }
    // o que ainda não subiu continua aparecendo
    rankingList = all.concat(loadJson(RANKING_PENDING_KEY));
    rankingOnline = true;
    saveRanking();
  } catch (e) {
    rankingOnline = false;     // sem internet (ou Firebase fora): fica a cópia local
  }
  if (isScreenOpen('viewMenuRanking')) renderRanking();
}

// uma sincronização por vez (senão a mesma partida poderia subir duas vezes)
let rankingSync = null, rankingSyncAgain = false;
function fetchOnlineRanking() {
  if (rankingSync) { rankingSyncAgain = true; return rankingSync; }
  rankingSync = syncRankingOnce().finally(() => {
    rankingSync = null;
    if (rankingSyncAgain) { rankingSyncAgain = false; fetchOnlineRanking(); }
  });
  return rankingSync;
}

function addToRanking(entry) {
  entry.ts = Date.now();
  rankingList.push(entry);
  saveRanking();
  const pending = loadJson(RANKING_PENDING_KEY);
  pending.push(entry);
  savePending(pending);
  fetchOnlineRanking();
}

fetchOnlineRanking();

function startGame(mode) {
  playBeep(720, 'triangle', 0.14);
  const nameInput = document.getElementById('pilotNameField');
  const ageInput = document.getElementById('pilotAgeField');
  const pilotName = nameInput.value.trim().toUpperCase() || 'PILOTO';
  const pilotAge = parseInt(ageInput.value, 10) || 21;
  const car = CARS[currentCarIndex];

  const overlay = document.getElementById('gameCanvasOverlay');
  overlay.classList.add('active');
  isGameRunning = true;

  UTFPRGame.init(document.getElementById('gameCanvas'));
  UTFPRGame.setLang(currentLang);
  UTFPRGame.start(mode, {
    name: pilotName,
    age: pilotAge,
    car: car.rankName,
    carIndex: currentCarIndex,
    realMode: !isPixelMode
  }, function (result) {
    overlay.classList.remove('active');
    isGameRunning = false;

    // saiu pelo Q no pause: não entra no ranking
    if (result.aborted) {
      showScreen('viewMenuMain');
      return;
    }

    addToRanking({
      name: result.playerInfo.name,
      age: result.playerInfo.age,
      car: result.playerInfo.car,
      mode: result.mode,
      score: result.score
    });
    openRankingScreen();
  });
}

function openRankingScreen() {
  playBeep(440, 'square', 0.08);
  showScreen('viewMenuRanking');
  renderRanking();
  fetchOnlineRanking();     // atualiza com as partidas de todo mundo
}

function filterRanking(filter) {
  playBeep(520, 'square', 0.06);
  rankingFilter = filter;
  document.querySelectorAll('#menuRankFilters .rank-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.f === filter);
  });
  renderRanking();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// taça do pódio (ouro, prata e bronze), desenhada em pixels pra combinar com os dois modos
const TROPHY_COLORS = {
  gold:   ['#fff3a3', '#facc15', '#b8860b'],
  silver: ['#ffffff', '#cbd5e1', '#7b8794'],
  bronze: ['#ffd2a8', '#d98a4e', '#8a4b22']
};
function trophySvg(kind) {
  const [hi, mid, dark] = TROPHY_COLORS[kind];
  return `<svg class="trophy" viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true">
    <rect x="2" y="1" width="8" height="1" fill="${hi}"/>
    <rect x="2" y="2" width="8" height="3" fill="${mid}"/><rect x="3" y="2" width="1" height="3" fill="${hi}"/>
    <rect x="3" y="5" width="6" height="1" fill="${mid}"/><rect x="4" y="6" width="4" height="1" fill="${dark}"/>
    <rect x="0" y="2" width="2" height="1" fill="${mid}"/><rect x="0" y="3" width="1" height="1" fill="${mid}"/><rect x="1" y="4" width="1" height="1" fill="${mid}"/>
    <rect x="10" y="2" width="2" height="1" fill="${mid}"/><rect x="11" y="3" width="1" height="1" fill="${mid}"/><rect x="10" y="4" width="1" height="1" fill="${mid}"/>
    <rect x="5" y="7" width="2" height="2" fill="${dark}"/>
    <rect x="3" y="9" width="6" height="1" fill="${mid}"/><rect x="2" y="10" width="8" height="1" fill="${dark}"/>
  </svg>`;
}

function renderRanking() {
  const box = document.getElementById('menuRankingRows');

  const top = rankingList
    .filter(item => rankingFilter === 'ALL' || item.mode === rankingFilter)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);          // a tabela rola; mostra até 50 jogadores

  if (top.length === 0) {
    box.innerHTML = `
      <div class="rank-empty">
        ${t('rankEmpty')}<br>
        <span>${t('rankEmptySub')}</span>
      </div>`;
    return;
  }

  // o nome vem do campo de texto, por isso o escapeHtml
  const podium = ['gold', 'silver', 'bronze'];
  box.innerHTML = top.map((entry, i) => `
    <div class="rank-p-row ${podium[i] || ''}">
      <span class="rank-pos">${i < 3 ? trophySvg(podium[i]) : ''}#${i + 1}</span>
      <span>${escapeHtml(entry.name)} (${escapeHtml(entry.age)}${t('ageSuffix')})</span>
      <span>${escapeHtml(entry.car)}</span>
      <span>${escapeHtml(modeLabel(entry.mode))}</span>
      <span style="text-align:right;font-weight:bold;color:#facc15;">${escapeHtml(entry.score)}</span>
    </div>`).join('');
}

/* --- Showroom 360 (modo real) --- */

// o ângulo é contínuo; a cada quadro escolhemos a foto mais próxima dele
function showroomLoop() {
  if (!isDraggingShowroom && Math.abs(dragVelocity) > 0.0001) {
    virtualAngle = (virtualAngle + dragVelocity + 360) % 360;
    dragVelocity *= 0.92;   // inércia: vai parando sozinho depois de soltar
  }
  updateSpinFrames();
  requestAnimationFrame(showroomLoop);
}

// troca a foto só quando muda de ângulo (as quatro imagens andam juntas)
function updateSpinFrames() {
  const car = CARS[currentCarIndex];
  const frame = Math.floor((virtualAngle / 360) * car.numFrames) % car.numFrames;
  const set = (id, src) => { const img = document.getElementById(id); if (img && !img.src.endsWith(src)) img.src = src; };
  set('hangarCarImg', carFrame(car, frame));
  set('carPickRealCar', carFrame(car, frame));
  set('garagePixelCar', carFramePixel(car, frame));
  set('carPickPixelCar', carFramePixel(car, frame));
}

function setupShowroomDrag() {
  let viewport = null;   // quem está sendo arrastado agora
  document.querySelectorAll('.spin360').forEach(el => el.addEventListener('pointerdown', (e) => {
    viewport = el;
    isDraggingShowroom = true;
    dragLastX = e.clientX;
    dragVelocity = 0;
    el.classList.add('is-dragging');
    document.querySelectorAll('.spin360').forEach(v => v.classList.add('used'));
    if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
  }));
  window.addEventListener('pointermove', (e) => {
    if (!isDraggingShowroom) return;
    const dx = e.clientX - dragLastX;
    dragLastX = e.clientX;
    const delta = -dx * 0.55;
    virtualAngle = (virtualAngle + delta + 360) % 360;
    dragVelocity = delta * 0.45;
  });
  const stopDrag = (e) => {
    if (!isDraggingShowroom || !viewport) return;
    isDraggingShowroom = false;
    viewport.classList.remove('is-dragging');
    try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  window.addEventListener('pointerup', stopDrag);
  window.addEventListener('pointercancel', stopDrag);
}

/* --- Teclado --- */

function setupKeyboard() {
  // Enter no nome pula pra idade; Enter na idade segue pro carro
  document.getElementById('pilotNameField').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const age = document.getElementById('pilotAgeField');
    age.focus();
    age.select();
  });
  document.getElementById('pilotAgeField').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.target.blur();
    confirmPilot();
  });

  // setas trocam de carro na escolha e na garagem; durante o jogo quem cuida do teclado é o jogo.js
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (isGameRunning) return;

    if (isScreenOpen('viewMenuCar')) {
      if (e.key === 'ArrowLeft') prevCar();
      if (e.key === 'ArrowRight') nextCar();
      if (e.key === 'Enter') confirmCar();
      if (e.key === 'Escape') openPilotScreen();
      return;
    }
    if (!isScreenOpen('viewMenuGarage')) return;
    if (e.key === 'Escape') { garageBack(); return; }
    if (garageSubView !== 'exterior') return;
    if (e.key === 'ArrowLeft') prevCar();
    if (e.key === 'ArrowRight') nextCar();
  });
}

/* --- Início --- */

window.addEventListener('DOMContentLoaded', () => {
  // idioma e modo escolhidos da última vez neste navegador
  try {
    if (localStorage.getItem('icm_lang') === 'en') currentLang = 'en';
    if (localStorage.getItem('icm_pixel_mode') === '0') isPixelMode = false;
  } catch (e) {}

  setupKeyboard();
  setupShowroomDrag();
  setupBench();
  setupBenchTabs();
  updateDisplayModes();
  applyLanguage();
  showroomLoop();
});
