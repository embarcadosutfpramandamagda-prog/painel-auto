/*
 * icm_data.h - dado compartilhado do painel (ICM_Data) e as funções que
 * as tarefas usam pra ler e escrever nele.
 *
 * Todo acesso passa pelo ICM_Resource (GetResource/ReleaseResource),
 * então ninguém lê o struct pela metade enquanto outra tarefa escreve.
 *
 * Caminho de cada sinal (slide do Projeto 2):
 *   Receive (ISR2_CAN / Task_Acquisition) -> Validate (faixa) -> Scale (resolução)
 *   -> Filter (Task_Processing) -> Display (Task_Display)
 */
#ifndef ICM_DATA_H
#define ICM_DATA_H

#include <stdint.h>
#include <stdbool.h>
#include "can_types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    TURN_NONE = 0,
    TURN_LEFT = 1,
    TURN_RIGHT = 2,
    TURN_HAZARD = 3     /* pisca-alerta */
} TurnSignal_t;

/* luzes de aviso, uma por bit em warning_flags */
typedef enum {
    FLAG_NONE           = 0,
    FLAG_MIL_CHECK_ENG  = (1 << 0),  /* luz da injeção (check engine) */
    FLAG_CAN_M1_TIMEOUT = (1 << 1),  /* parou de chegar M1 (rpm) */
    FLAG_CAN_M2_TIMEOUT = (1 << 2),  /* parou de chegar M2 (velocidade) */
    FLAG_COOLANT_HOT    = (1 << 3),  /* motor a 115 °C ou mais */
    FLAG_LOW_FUEL       = (1 << 4),  /* reserva: 10 % ou menos */
    FLAG_BATTERY_FAULT  = (1 << 5),  /* motor parado: alternador sem carregar */
    FLAG_OIL_PRESS_LOW  = (1 << 6),  /* motor parado: sem pressão de óleo */
    FLAG_HANDBRAKE_ON   = (1 << 7),
    FLAG_SEATBELT_WARN  = (1 << 8),
    FLAG_FUEL_SENSOR    = (1 << 9),  /* sensor de combustível fora da faixa (P0460) */
    FLAG_TEMP_SENSOR    = (1 << 10), /* sensor de temperatura fora da faixa (P0115) */
    FLAG_SIGNAL_OOR     = (1 << 11)  /* RS-05: valor do CAN fora da faixa, descartado (U0401) */
} ICM_WarningFlags_t;

/* RS-05: acima disso o valor do CAN é lixo e é descartado */
#define ICM_RPM_OUT_OF_RANGE   8500.0f
#define ICM_SPEED_OUT_OF_RANGE 260.0f

/* limites de diagnóstico (REQUISITOS_ICM.md, RS-03 e RS-04) */
#define ICM_COOLANT_HOT_C      115.0f
#define ICM_FUEL_RESERVE_PCT   10.0f

/* faixa elétrica dos sensores (DICIONARIO_SINAIS.md, seção 3) */
#define ICM_FUEL_V_MIN   0.5f    /* 0 %   */
#define ICM_FUEL_V_MAX   4.5f    /* 100 % */
#define ICM_FUEL_V_FAIL_LO 0.3f
#define ICM_FUEL_V_FAIL_HI 4.7f
#define ICM_TEMP_V_MIN   0.2f    /* 40 °C  */
#define ICM_TEMP_V_MAX   4.8f    /* 120 °C */
#define ICM_TEMP_V_FAIL_LO 0.1f
#define ICM_TEMP_V_FAIL_HI 4.9f

/* RF-05: seta a 1,5 Hz com 50 % de ciclo */
#define ICM_TURN_PERIOD_MS 667u

/* códigos de falha guardados no histórico (um bit cada) */
typedef enum {
    DTC_U0100 = (1 << 0),   /* perdeu M1 (ECM) */
    DTC_U0101 = (1 << 1),   /* perdeu M2 (TCM) */
    DTC_P0115 = (1 << 2),   /* temperatura: sensor ou superaquecimento */
    DTC_P0460 = (1 << 3),   /* sensor de combustível */
    DTC_U0401 = (1 << 4)    /* dado inválido no CAN */
} ICM_DtcBit_t;

/* o que a Task_Acquisition lê dos pinos a cada 10 ms */
typedef struct {
    float        fuel_volts;        /* ADC do sensor de nível */
    float        temp_volts;        /* ADC do NTC do motor */
    TurnSignal_t turn;              /* chave de seta / pisca-alerta */
    bool         seatbelt_buckled;
    bool         headlights_high_beam;
} ICM_SensorInputs_t;

typedef struct {
    /* vem do CAN */
    float    engine_rpm;             /* 0 a 8000 rpm (filtrado) */
    float    vehicle_speed_kmh;      /* 0 a 250 km/h (filtrado) */
    int8_t   gear;                   /* -1 ré, 0 neutro, 1..6 */
    bool     brake_pedal_active;
    bool     handbrake_active;
    uint8_t  engine_state;           /* 0 desligado, 1 partida, 2 funcionando, 3 sobregiro */

    /* sensores ligados direto no módulo */
    float    fuel_level_percent;     /* 0 a 100 % (filtrado) */
    float    coolant_temp_celsius;   /* 40 a 120 °C (filtrado) */
    bool     fuel_sensor_ok;
    bool     temp_sensor_ok;
    TurnSignal_t turn_signal;
    bool     headlights_high_beam;
    bool     seatbelt_buckled;

    /* computador de bordo */
    double   odometer_km;            /* double: em float, 12 mil km + 0,01 km por segundo perdia 2 % (ver teste RF07) */
    double   trip_a_km;
    float    instant_fuel_economy;   /* km/L */

    /* diagnóstico */
    uint32_t last_m1_time_ms;        /* quando chegou o último M1 */
    uint32_t last_m2_time_ms;
    uint32_t last_sensor_time_ms;    /* última amostra da Task_Acquisition */
    uint32_t current_time_ms;
    uint32_t frames_m1;              /* contadores, pra conferir períodos */
    uint32_t frames_m2;
    uint32_t frames_rejected;        /* RS-05 */
    uint16_t warning_flags;          /* combinação de ICM_WarningFlags_t */
    uint8_t  dtc_history;            /* combinação de ICM_DtcBit_t: tudo que já aconteceu */
    char     active_dtc[8];          /* "U0100", "P0115"... ou "NONE" */
    bool     signal_out_of_range;    /* chegou valor fora da faixa no último frame */
} ICM_Data_t;

/* acesso ao dado compartilhado */
void ICM_Init(void);
void ICM_LockResource(void);
void ICM_UnlockResource(void);
void ICM_GetDataCopy(ICM_Data_t *dest);

/* chamadas pelas tarefas (ver src/tasks.c) */
void ICM_ProcessCAN_M1(const CAN_Msg_M1_t *msg, uint32_t timestamp);
void ICM_ProcessCAN_M2(const CAN_Msg_M2_t *msg, uint32_t timestamp);
void ICM_DecodeFrame(const CAN_Frame_t *frame);      /* escolhe M1/M2 pelo ID */
void ICM_AcquireSensors(const ICM_SensorInputs_t *in, uint32_t now_ms);
void ICM_UpdateSensorInputs(float fuel_pct, float temp_c, TurnSignal_t turn, bool seatbelt);
void ICM_FilterAndScale(void);
void ICM_EvaluateDiagnostics(uint32_t now_ms);
void ICM_UpdateLogging(float delta_time_s);

/* funções puras (não mexem no dado compartilhado) */
bool ICM_TurnLampOn(uint32_t now_ms);                /* RF-05: fase do pisca */
float ICM_FuelVoltsToPercent(float v);
float ICM_TempVoltsToCelsius(float v);
const char *ICM_DtcName(ICM_DtcBit_t bit);

#ifdef __cplusplus
}
#endif

#endif /* ICM_DATA_H */
