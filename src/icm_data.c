/*
 * icm_data.c - o dado compartilhado do painel e o que cada tarefa faz com ele.
 *
 * No Trampoline o lock é o ICM_Resource (priority ceiling). Compilando fora
 * dele (testes no PC e simulação SIL) usamos um mutex do pthread no lugar,
 * assim o mesmo arquivo roda nos dois lugares.
 *
 * A lógica aqui é a mesma do painel do site (web/js/jogo.js): se mudar uma,
 * mudar a outra.
 */
#include "icm_data.h"
#include <string.h>

#if defined(TRAMPOLINE_RTOS)
#include "tpl_os.h"
DeclareResource(ICM_Resource);
#define OS_GET_RESOURCE()     GetResource(ICM_Resource)
#define OS_RELEASE_RESOURCE() ReleaseResource(ICM_Resource)
#elif defined(ICM_SIL)
#include "osek_sil.h"
#define OS_GET_RESOURCE()     GetResource(ICM_Resource)
#define OS_RELEASE_RESOURCE() ReleaseResource(ICM_Resource)
#else
#include <pthread.h>
static pthread_mutex_t g_icm_mutex = PTHREAD_MUTEX_INITIALIZER;
#define OS_GET_RESOURCE()     pthread_mutex_lock(&g_icm_mutex)
#define OS_RELEASE_RESOURCE() pthread_mutex_unlock(&g_icm_mutex)
#endif

static ICM_Data_t g_icm_data;

/* último valor bruto válido; o filtro da Task_Processing anda em direção a ele */
static float g_raw_rpm = 0.0f;
static float g_raw_speed = 0.0f;
static float g_raw_fuel = 85.0f;
static float g_raw_temp = 90.0f;

/* chamada uma vez antes do StartOS (ainda não tem tarefa rodando), por isso sem o recurso */
void ICM_Init(void) {
    memset(&g_icm_data, 0, sizeof(ICM_Data_t));
    g_icm_data.fuel_level_percent = 85.0f;
    g_icm_data.coolant_temp_celsius = 90.0f;
    g_icm_data.fuel_sensor_ok = true;
    g_icm_data.temp_sensor_ok = true;
    g_icm_data.seatbelt_buckled = true;
    g_icm_data.engine_state = 2;
    g_icm_data.odometer_km = 12450.0f;
    g_icm_data.trip_a_km = 42.5f;
    g_icm_data.instant_fuel_economy = 14.2f;
    g_icm_data.warning_flags = FLAG_NONE;
    strcpy(g_icm_data.active_dtc, "NONE");
    g_raw_rpm = 0.0f;
    g_raw_speed = 0.0f;
    g_raw_fuel = 85.0f;
    g_raw_temp = 90.0f;
}

void ICM_LockResource(void) {
    OS_GET_RESOURCE();
}

void ICM_UnlockResource(void) {
    OS_RELEASE_RESOURCE();
}

/* quem desenha o painel pega uma cópia inteira, nunca lê o global direto */
void ICM_GetDataCopy(ICM_Data_t *dest) {
    if (dest == NULL) return;
    OS_GET_RESOURCE();
    memcpy(dest, &g_icm_data, sizeof(ICM_Data_t));
    OS_RELEASE_RESOURCE();
}

/* M1: bytes 0-1 são o rpm com resolução de 0.25.
 * RS-05: acima de 8500 rpm o valor é descartado e o painel fica com o último válido. */
void ICM_ProcessCAN_M1(const CAN_Msg_M1_t *msg, uint32_t timestamp) {
    if (!msg) return;
    OS_GET_RESOURCE();
    uint16_t raw = ((uint16_t)msg->rpm_high << 8) | msg->rpm_low;
    float rpm = (float)raw * 0.25f;
    if (rpm > ICM_RPM_OUT_OF_RANGE) {
        g_icm_data.signal_out_of_range = true;
        g_icm_data.frames_rejected++;
    } else {
        g_raw_rpm = (rpm > 8000.0f) ? 8000.0f : rpm;
        g_icm_data.signal_out_of_range = false;
    }
    g_icm_data.engine_state = msg->engine_state;
    g_icm_data.last_m1_time_ms = timestamp;   /* o frame chegou, então não é timeout */
    g_icm_data.frames_m1++;
    OS_RELEASE_RESOURCE();
}

/* M2: bytes 0-1 são a velocidade com resolução de 0.05 km/h */
void ICM_ProcessCAN_M2(const CAN_Msg_M2_t *msg, uint32_t timestamp) {
    if (!msg) return;
    OS_GET_RESOURCE();
    uint16_t raw = ((uint16_t)msg->speed_high << 8) | msg->speed_low;
    float kmh = (float)raw * 0.05f;
    if (kmh > ICM_SPEED_OUT_OF_RANGE) {
        g_icm_data.signal_out_of_range = true;      /* descarta, fica a velocidade anterior */
        g_icm_data.frames_rejected++;
    } else {
        g_raw_speed = (kmh > 250.0f) ? 250.0f : kmh;
    }
    g_icm_data.gear = msg->current_gear;
    g_icm_data.brake_pedal_active = (msg->brake_pedal != 0);
    g_icm_data.handbrake_active = (msg->handbrake != 0);
    g_icm_data.last_m2_time_ms = timestamp;
    g_icm_data.frames_m2++;
    OS_RELEASE_RESOURCE();
}

/* frame cru, do jeito que sai do controlador: separa pelo ID */
void ICM_DecodeFrame(const CAN_Frame_t *frame) {
    if (!frame) return;
    if (frame->id == CAN_ID_M1_ENGINE) {
        CAN_Msg_M1_t m1;
        memset(&m1, 0, sizeof(m1));
        m1.rpm_high = frame->data[0];
        m1.rpm_low  = frame->data[1];
        m1.throttle_percent = frame->data[2];
        m1.engine_state = frame->data[3];
        ICM_ProcessCAN_M1(&m1, frame->timestamp_ms);
    } else if (frame->id == CAN_ID_M2_VEHICLE) {
        CAN_Msg_M2_t m2;
        memset(&m2, 0, sizeof(m2));
        m2.speed_high = frame->data[0];
        m2.speed_low  = frame->data[1];
        m2.current_gear = (int8_t)frame->data[2];
        m2.brake_pedal = frame->data[3];
        m2.handbrake = frame->data[4];
        ICM_ProcessCAN_M2(&m2, frame->timestamp_ms);
    }
    /* outros IDs: não são pro painel, ignora */
}

float ICM_FuelVoltsToPercent(float v) {
    float p = (v - ICM_FUEL_V_MIN) / (ICM_FUEL_V_MAX - ICM_FUEL_V_MIN) * 100.0f;
    if (p < 0.0f) p = 0.0f;
    if (p > 100.0f) p = 100.0f;
    return p;
}

float ICM_TempVoltsToCelsius(float v) {
    return 40.0f + (v - ICM_TEMP_V_MIN) / (ICM_TEMP_V_MAX - ICM_TEMP_V_MIN) * 80.0f;
}

/* Task_Acquisition, a cada 10 ms: tensão do ADC -> valida -> escala.
 * Sensor fora da faixa elétrica = fio solto ou em curto: não atualiza o valor
 * (fica o último bom) e marca a falha pro diagnóstico. */
void ICM_AcquireSensors(const ICM_SensorInputs_t *in, uint32_t now_ms) {
    if (!in) return;
    bool fuel_ok = in->fuel_volts >= ICM_FUEL_V_FAIL_LO && in->fuel_volts <= ICM_FUEL_V_FAIL_HI;
    bool temp_ok = in->temp_volts >= ICM_TEMP_V_FAIL_LO && in->temp_volts <= ICM_TEMP_V_FAIL_HI;
    OS_GET_RESOURCE();
    g_icm_data.fuel_sensor_ok = fuel_ok;
    g_icm_data.temp_sensor_ok = temp_ok;
    if (fuel_ok) g_raw_fuel = ICM_FuelVoltsToPercent(in->fuel_volts);
    if (temp_ok) g_raw_temp = ICM_TempVoltsToCelsius(in->temp_volts);
    g_icm_data.turn_signal = in->turn;
    g_icm_data.seatbelt_buckled = in->seatbelt_buckled;
    g_icm_data.headlights_high_beam = in->headlights_high_beam;
    g_icm_data.last_sensor_time_ms = now_ms;
    OS_RELEASE_RESOURCE();
}

/* atalho usado pelos testes antigos: valores já em unidade física */
void ICM_UpdateSensorInputs(float fuel_pct, float temp_c, TurnSignal_t turn, bool seatbelt) {
    OS_GET_RESOURCE();
    g_raw_fuel = fuel_pct;
    g_raw_temp = temp_c;
    g_icm_data.fuel_sensor_ok = true;
    g_icm_data.temp_sensor_ok = true;
    g_icm_data.turn_signal = turn;
    g_icm_data.seatbelt_buckled = seatbelt;
    OS_RELEASE_RESOURCE();
}

/*
 * Task_Processing, a cada 20 ms. Filtro passa-baixas simples:
 * valor += alfa * (bruto - valor). Velocidade e rpm respondem rápido;
 * combustível e temperatura bem devagar, pra o ponteiro não ficar tremendo.
 */
void ICM_FilterAndScale(void) {
    OS_GET_RESOURCE();
    const float alpha_speed = 0.25f;
    const float alpha_rpm   = 0.35f;
    const float alpha_fuel  = 0.05f;
    const float alpha_temp  = 0.05f;

    g_icm_data.vehicle_speed_kmh += alpha_speed * (g_raw_speed - g_icm_data.vehicle_speed_kmh);
    g_icm_data.engine_rpm        += alpha_rpm   * (g_raw_rpm   - g_icm_data.engine_rpm);
    g_icm_data.fuel_level_percent   += alpha_fuel  * (g_raw_fuel  - g_icm_data.fuel_level_percent);
    g_icm_data.coolant_temp_celsius += alpha_temp  * (g_raw_temp  - g_icm_data.coolant_temp_celsius);
    OS_RELEASE_RESOURCE();
}

/*
 * Task_Diagnostics, a cada 100 ms. Liga as luzes de aviso e escolhe o DTC
 * que aparece no painel. Só mostramos um DTC por vez; a ordem dos ifs é a
 * prioridade (falha de comunicação primeiro). Tudo que acontecer fica no
 * dtc_history.
 */
void ICM_EvaluateDiagnostics(uint32_t now_ms) {
    OS_GET_RESOURCE();
    g_icm_data.current_time_ms = now_ms;
    uint16_t flags = FLAG_NONE;
    uint8_t seen = 0;
    char dtc[8] = "NONE";

    /* last_m1 == 0 quer dizer que nunca chegou nada: aí ainda não é timeout */
    if (g_icm_data.last_m1_time_ms > 0 && (now_ms - g_icm_data.last_m1_time_ms) > CAN_M1_TIMEOUT_MS) {
        flags |= (FLAG_CAN_M1_TIMEOUT | FLAG_MIL_CHECK_ENG);
        strcpy(dtc, "U0100");
        seen |= DTC_U0100;
        g_icm_data.engine_rpm = 0.0f;   /* fail-safe: sem dado confiável, mostra zero */
        g_raw_rpm = 0.0f;
    }

    if (g_icm_data.last_m2_time_ms > 0 && (now_ms - g_icm_data.last_m2_time_ms) > CAN_M2_TIMEOUT_MS) {
        flags |= (FLAG_CAN_M2_TIMEOUT | FLAG_MIL_CHECK_ENG);
        if (strcmp(dtc, "NONE") == 0) strcpy(dtc, "U0101");
        seen |= DTC_U0101;
        g_icm_data.vehicle_speed_kmh = 0.0f;
        g_raw_speed = 0.0f;
    }

    if (!g_icm_data.temp_sensor_ok) {
        flags |= (FLAG_TEMP_SENSOR | FLAG_MIL_CHECK_ENG);
        if (strcmp(dtc, "NONE") == 0) strcpy(dtc, "P0115");
        seen |= DTC_P0115;
    } else if (g_icm_data.coolant_temp_celsius >= ICM_COOLANT_HOT_C) {
        flags |= FLAG_COOLANT_HOT;
        if (strcmp(dtc, "NONE") == 0) strcpy(dtc, "P0115");
        seen |= DTC_P0115;
    }

    if (!g_icm_data.fuel_sensor_ok) {
        flags |= (FLAG_FUEL_SENSOR | FLAG_MIL_CHECK_ENG);
        if (strcmp(dtc, "NONE") == 0) strcpy(dtc, "P0460");
        seen |= DTC_P0460;
    } else if (g_icm_data.fuel_level_percent <= ICM_FUEL_RESERVE_PCT) {
        flags |= FLAG_LOW_FUEL;
    }

    if (g_icm_data.handbrake_active) {
        flags |= FLAG_HANDBRAKE_ON;
    }

    if (!g_icm_data.seatbelt_buckled) {
        flags |= FLAG_SEATBELT_WARN;
    }

    /* motor parado (e o M1 chegando): sem pressão de óleo e bateria sem carga */
    if (g_icm_data.last_m1_time_ms > 0 && !(flags & FLAG_CAN_M1_TIMEOUT) && g_icm_data.engine_state == 0) {
        flags |= (FLAG_OIL_PRESS_LOW | FLAG_BATTERY_FAULT);
    }

    if (g_icm_data.signal_out_of_range) {
        flags |= (FLAG_SIGNAL_OOR | FLAG_MIL_CHECK_ENG);
        if (strcmp(dtc, "NONE") == 0) strcpy(dtc, "U0401");
        seen |= DTC_U0401;
    }

    g_icm_data.warning_flags = flags;
    g_icm_data.dtc_history |= seen;
    strncpy(g_icm_data.active_dtc, dtc, sizeof(g_icm_data.active_dtc) - 1);
    g_icm_data.active_dtc[sizeof(g_icm_data.active_dtc) - 1] = '\0';
    OS_RELEASE_RESOURCE();
}

/* Task_Logging, a cada 1 s: soma a distância no odômetro e no trip */
void ICM_UpdateLogging(float delta_time_s) {
    OS_GET_RESOURCE();
    double dist_km = ((double)g_icm_data.vehicle_speed_kmh / 3600.0) * delta_time_s;
    g_icm_data.odometer_km += dist_km;
    g_icm_data.trip_a_km += dist_km;
    if (g_icm_data.vehicle_speed_kmh > 5.0f && g_icm_data.engine_rpm > 500.0f) {
        /* consumo aproximado de um V8 dos anos 60: uns 6 a 8 km/L na estrada */
        g_icm_data.instant_fuel_economy = 8.0f * (g_icm_data.vehicle_speed_kmh / (g_icm_data.engine_rpm * 0.035f + 10.0f));
    } else {
        g_icm_data.instant_fuel_economy = 0.0f;
    }
    OS_RELEASE_RESOURCE();
}

/* RF-05: 1,5 Hz e 50 % de ciclo -> acesa nos primeiros 333 ms de cada 667 ms */
bool ICM_TurnLampOn(uint32_t now_ms) {
    return (now_ms % ICM_TURN_PERIOD_MS) < (ICM_TURN_PERIOD_MS / 2u);
}

const char *ICM_DtcName(ICM_DtcBit_t bit) {
    switch (bit) {
    case DTC_U0100: return "U0100";
    case DTC_U0101: return "U0101";
    case DTC_P0115: return "P0115";
    case DTC_P0460: return "P0460";
    case DTC_U0401: return "U0401";
    default: return "NONE";
    }
}
