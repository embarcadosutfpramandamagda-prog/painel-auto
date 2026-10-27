/*
 * vehicle_sim.c - carro, barramento CAN e sensores simulados (ver vehicle_sim.h).
 *
 * Tudo determinístico: mesmo roteiro, mesmos frames, no mesmo ms. É isso que
 * deixa os testes de temporização repetíveis.
 */
#include "vehicle_sim.h"
#include <string.h>

#define CAN_HW_FIFO 8          /* mailboxes do controlador */

static VSim_Faults_t g_faults;
static VSim_State_t g_state;
static const VSim_Event_t *g_events;
static unsigned g_event_count, g_next_event;

static CAN_Frame_t g_fifo[CAN_HW_FIFO];
static unsigned g_head, g_tail, g_count;
static uint32_t g_sent_m1, g_sent_m2;

/* percurso: velocidade alvo (km/h) em cada trecho de tempo (ms). Repete a cada 40 s. */
static float target_speed(uint32_t t) {
    uint32_t c = t % 40000u;
    if (c < 3000u)  return 0.0f;                         /* motor ligado, parado */
    if (c < 15000u) return 120.0f * (float)(c - 3000u) / 12000.0f;   /* acelera até 120 */
    if (c < 25000u) return 120.0f;                       /* estrada */
    if (c < 32000u) return 120.0f - 80.0f * (float)(c - 25000u) / 7000.0f; /* desacelera pra 40 */
    if (c < 37000u) return 40.0f;                        /* cidade */
    return 40.0f * (float)(40000u - c) / 3000.0f;        /* para */
}

/* câmbio automático de 3 marchas (Camaro 69, TH400): rpm = velocidade x relação */
static void gearbox(float kmh, float throttle, int8_t *gear, float *rpm) {
    static const float ratio[4] = { 0.0f, 2.48f * 3.55f, 1.48f * 3.55f, 1.00f * 3.55f };
    const float tire_m = 2.07f;
    int8_t g = *gear < 1 ? 1 : *gear;
    float r = (kmh / 3.6f) / tire_m * 60.0f * ratio[g];
    if (g < 3 && r > 4200.0f) g++;
    else if (g > 1 && r < 1500.0f) g--;
    r = (kmh / 3.6f) / tire_m * 60.0f * ratio[g];
    float idle = 750.0f + throttle * 600.0f;
    *gear = (kmh < 1.0f) ? 0 : g;
    *rpm = r < idle ? idle : r;
}

void VSim_Init(void) {
    memset(&g_faults, 0, sizeof(g_faults));
    memset(&g_state, 0, sizeof(g_state));
    g_state.fuel_percent = 62.0f;
    g_state.coolant_celsius = 60.0f;
    g_state.rpm = 750.0f;
    g_events = NULL; g_event_count = 0; g_next_event = 0;
    g_head = g_tail = g_count = 0;
    g_sent_m1 = g_sent_m2 = 0;
}

void VSim_SetScenario(const VSim_Event_t *events, unsigned count) {
    g_events = events; g_event_count = count; g_next_event = 0;
}

static void apply_event(const VSim_Event_t *e) {
    uint32_t m = e->mask;
    if (m & VS_CAN_MUTE)    g_faults.can_mute = e->set.can_mute;
    if (m & VS_M2_MUTE)     g_faults.m2_only_mute = e->set.m2_only_mute;
    if (m & VS_TEMP_OPEN)   g_faults.temp_sensor_open = e->set.temp_sensor_open;
    if (m & VS_FUEL_OPEN)   g_faults.fuel_sensor_open = e->set.fuel_sensor_open;
    if (m & VS_RPM_GARBAGE) g_faults.rpm_garbage = e->set.rpm_garbage;
    if (m & VS_FAN_FAIL)    g_faults.fan_failure = e->set.fan_failure;
    if (m & VS_BELT_OFF)    g_faults.seatbelt_off = e->set.seatbelt_off;
    if (m & VS_ENGINE_OFF)  g_faults.engine_off = e->set.engine_off;
    if (m & VS_HANDBRAKE)   g_faults.handbrake = e->set.handbrake;
    if (m & VS_TURN)        g_faults.turn = e->set.turn;
}

/* controlador CAN: frame entra na FIFO de hardware (se encher, o mais novo se perde) */
static bool can_hw_receive(const CAN_Frame_t *f) {
    if (g_count >= CAN_HW_FIFO) return false;
    g_fifo[g_head] = *f;
    g_head = (g_head + 1u) % CAN_HW_FIFO;
    g_count++;
    return true;
}

bool VSim_CanRead(CAN_Frame_t *out) {
    if (g_count == 0u) return false;
    *out = g_fifo[g_tail];
    g_tail = (g_tail + 1u) % CAN_HW_FIFO;
    g_count--;
    return true;
}

unsigned VSim_CanPending(void) { return g_count; }

static void physics_1ms(uint32_t now_ms) {
    const float dt = 0.001f;
    float tgt = g_faults.engine_off ? 0.0f : target_speed(now_ms);
    float err = tgt - g_state.speed_kmh;
    g_state.throttle = err > 0.5f ? (err > 10.0f ? 1.0f : err / 10.0f) : 0.0f;
    g_state.brake = err < -3.0f;
    /* aceleração limitada: ~0-100 em 8 s, freada a 7 m/s² */
    float acc_kmh_s = err > 0.0f ? 12.0f : -25.0f;
    float step = acc_kmh_s * dt;
    if ((err > 0.0f && step > err) || (err < 0.0f && step < err)) step = err;
    g_state.speed_kmh += step;
    if (g_state.speed_kmh < 0.0f) g_state.speed_kmh = 0.0f;

    if (g_faults.engine_off) { g_state.rpm += (0.0f - g_state.rpm) * 0.01f; g_state.gear = 0; }
    else gearbox(g_state.speed_kmh, g_state.throttle, &g_state.gear, &g_state.rpm);

    /* consumo: um pouco parado, mais com o pé embaixo */
    if (!g_faults.engine_off && g_state.fuel_percent > 0.0f)
        g_state.fuel_percent -= dt * (0.004f + 0.02f * g_state.throttle);

    /* temperatura: esquenta até 88 °C; sem ventoinha vai até 121 °C */
    float t_target = g_faults.engine_off ? 60.0f : (g_faults.fan_failure ? 124.0f : 88.0f);
    g_state.coolant_celsius += (t_target - g_state.coolant_celsius) * dt / (g_faults.fan_failure ? 1.5f : 4.0f);
}

static void bus_1ms(uint32_t now_ms, bool *irq) {
    CAN_Frame_t f;
    if (now_ms > 0u && now_ms % CAN_M1_PERIOD_MS == 0u) {
        g_sent_m1++;
        if (!g_faults.can_mute) {
            float rpm = g_faults.rpm_garbage ? 9999.0f : g_state.rpm;
            uint16_t raw = (uint16_t)(rpm / 0.25f + 0.5f);
            memset(&f, 0, sizeof(f));
            f.id = CAN_ID_M1_ENGINE; f.dlc = 8; f.timestamp_ms = now_ms;
            f.data[0] = (uint8_t)(raw >> 8); f.data[1] = (uint8_t)(raw & 0xFFu);
            f.data[2] = (uint8_t)(g_state.throttle * 200.0f);
            f.data[3] = g_faults.engine_off ? 0u : (g_state.rpm > 7000.0f ? 3u : 2u);
            if (can_hw_receive(&f)) *irq = true;
        }
    }
    if (now_ms > 0u && now_ms % CAN_M2_PERIOD_MS == 0u) {
        g_sent_m2++;
        if (!g_faults.can_mute && !g_faults.m2_only_mute) {
            uint16_t raw = (uint16_t)(g_state.speed_kmh / 0.05f + 0.5f);
            memset(&f, 0, sizeof(f));
            f.id = CAN_ID_M2_VEHICLE; f.dlc = 8; f.timestamp_ms = now_ms;
            f.data[0] = (uint8_t)(raw >> 8); f.data[1] = (uint8_t)(raw & 0xFFu);
            f.data[2] = (uint8_t)g_state.gear;
            f.data[3] = g_state.brake ? 1u : 0u;
            f.data[4] = g_faults.handbrake ? 1u : 0u;
            if (can_hw_receive(&f)) *irq = true;
        }
    }
}

bool VSim_Step1ms(uint32_t now_ms) {
    bool irq = false;
    while (g_events && g_next_event < g_event_count && g_events[g_next_event].at_ms <= now_ms) {
        apply_event(&g_events[g_next_event]);
        g_next_event++;
    }
    physics_1ms(now_ms);
    bus_1ms(now_ms, &irq);
    return irq;
}

VSim_Faults_t *VSim_Faults(void) { return &g_faults; }
const VSim_State_t *VSim_State(void) { return &g_state; }

/* ADC: mesma conversão do DICIONARIO_SINAIS.md, ao contrário. Fio solto = 4,97 V. */
void VSim_ReadSensors(ICM_SensorInputs_t *in) {
    in->fuel_volts = g_faults.fuel_sensor_open ? 4.92f
        : ICM_FUEL_V_MIN + g_state.fuel_percent / 100.0f * (ICM_FUEL_V_MAX - ICM_FUEL_V_MIN);
    float t = g_state.coolant_celsius < 40.0f ? 40.0f : g_state.coolant_celsius;
    in->temp_volts = g_faults.temp_sensor_open ? 4.97f
        : ICM_TEMP_V_MIN + (t - 40.0f) / 80.0f * (ICM_TEMP_V_MAX - ICM_TEMP_V_MIN);
    if (in->temp_volts > 4.85f && !g_faults.temp_sensor_open) in->temp_volts = 4.85f; /* sensor satura em ~121 °C */
    in->turn = g_faults.turn;
    in->seatbelt_buckled = !g_faults.seatbelt_off;
    in->headlights_high_beam = false;
}

uint32_t VSim_FramesSent(uint32_t can_id) {
    return can_id == CAN_ID_M1_ENGINE ? g_sent_m1 : (can_id == CAN_ID_M2_VEHICLE ? g_sent_m2 : 0u);
}

/* roteiro da demonstração (30 s): cada requisito de falha aparece uma vez */
static const VSim_Event_t g_demo[] = {
    {  2000, VS_TURN,        { .turn = TURN_LEFT },       "seta esquerda" },
    {  4500, VS_TURN,        { .turn = TURN_NONE },       "seta desliga" },
    {  6000, VS_CAN_MUTE,    { .can_mute = true },        "barramento CAN mudo" },
    {  8600, VS_CAN_MUTE,    { .can_mute = false },       "barramento volta" },
    { 10000, VS_RPM_GARBAGE, { .rpm_garbage = true },     "ECM manda 9999 rpm" },
    { 11200, VS_RPM_GARBAGE, { .rpm_garbage = false },    "ECM volta ao normal" },
    { 12000, VS_TEMP_OPEN,   { .temp_sensor_open = true },"sensor de temperatura solto" },
    { 13000, VS_TEMP_OPEN,   { .temp_sensor_open = false },"sensor de temperatura ok" },
    { 14000, VS_FUEL_OPEN,   { .fuel_sensor_open = true },"sensor de combustivel solto" },
    { 15000, VS_FUEL_OPEN,   { .fuel_sensor_open = false },"sensor de combustivel ok" },
    { 16000, VS_FAN_FAIL,    { .fan_failure = true },     "ventoinha queimou" },
    { 20500, VS_FAN_FAIL,    { .fan_failure = false },    "ventoinha trocada" },
    { 21000, VS_TURN,        { .turn = TURN_HAZARD },     "pisca-alerta" },
    { 22000, VS_BELT_OFF,    { .seatbelt_off = true },    "cinto solto" },
    { 24000, VS_BELT_OFF | VS_TURN, { .seatbelt_off = false, .turn = TURN_NONE }, "cinto ok, alerta desliga" },
    { 26000, VS_ENGINE_OFF | VS_HANDBRAKE, { .engine_off = true, .handbrake = true }, "motor desligado, freio de mao" },
};

const VSim_Event_t *VSim_DemoScenario(unsigned *count) {
    if (count) *count = (unsigned)(sizeof(g_demo) / sizeof(g_demo[0]));
    return g_demo;
}
