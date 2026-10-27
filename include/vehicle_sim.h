/*
 * vehicle_sim.h - o "resto do carro" que o painel precisa pra funcionar.
 *
 * Na placa isso seria o ECM e o TCM mandando frames no barramento e os
 * sensores ligados no ADC. Aqui é tudo simulado:
 *   - um percurso fixo (acelera, cruza, freia...) que dá velocidade e rpm;
 *   - ECM manda M1 (0x100) a cada 500 ms e TCM manda M2 (0x101) a cada 1000 ms;
 *   - o controlador CAN guarda os frames numa FIFO de hardware e levanta a interrupção;
 *   - o ADC devolve tensão de combustível e temperatura;
 *   - falhas podem ser ligadas na hora ou por roteiro (cenário) com tempo marcado.
 */
#ifndef VEHICLE_SIM_H
#define VEHICLE_SIM_H

#include <stdint.h>
#include <stdbool.h>
#include "can_types.h"
#include "icm_data.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool can_mute;           /* barramento mudo: ECM e TCM param de mandar (U0100 / U0101) */
    bool m2_only_mute;       /* só o TCM para (só U0101) */
    bool temp_sensor_open;   /* NTC com fio solto (P0115) */
    bool fuel_sensor_open;   /* boia com fio solto (P0460) */
    bool rpm_garbage;        /* ECM manda 9999 rpm (U0401, RS-05) */
    bool fan_failure;        /* ventoinha queimada: motor esquenta (P0115 por temperatura) */
    bool seatbelt_off;
    bool engine_off;         /* motor desligado: óleo e bateria */
    bool handbrake;
    TurnSignal_t turn;
} VSim_Faults_t;

typedef struct {
    float speed_kmh;
    float rpm;
    float throttle;          /* 0 a 1 */
    int8_t gear;
    bool brake;
    float fuel_percent;
    float coolant_celsius;
} VSim_State_t;

/* um passo do roteiro: em at_ms, aplica 'set' (os campos marcados em 'mask') */
typedef enum {
    VS_CAN_MUTE = 1 << 0, VS_M2_MUTE = 1 << 1, VS_TEMP_OPEN = 1 << 2, VS_FUEL_OPEN = 1 << 3,
    VS_RPM_GARBAGE = 1 << 4, VS_FAN_FAIL = 1 << 5, VS_BELT_OFF = 1 << 6, VS_ENGINE_OFF = 1 << 7,
    VS_HANDBRAKE = 1 << 8, VS_TURN = 1 << 9
} VSim_FaultMask_t;

typedef struct {
    uint32_t at_ms;
    uint32_t mask;
    VSim_Faults_t set;
    const char *label;       /* aparece no log */
} VSim_Event_t;

void VSim_Init(void);
void VSim_SetScenario(const VSim_Event_t *events, unsigned count);
const VSim_Event_t *VSim_DemoScenario(unsigned *count);   /* roteiro usado na demonstração */

/* avança 1 ms: física, roteiro e barramento. Devolve true se o controlador
 * CAN levantou interrupção de recepção neste ms. */
bool VSim_Step1ms(uint32_t now_ms);

VSim_Faults_t *VSim_Faults(void);
const VSim_State_t *VSim_State(void);

/* "hardware" visto pelo firmware */
bool VSim_CanRead(CAN_Frame_t *out);         /* lê a FIFO do controlador (dentro da ISR) */
unsigned VSim_CanPending(void);
void VSim_ReadSensors(ICM_SensorInputs_t *in);

/* contadores do lado do transmissor, pra conferir o que chegou */
uint32_t VSim_FramesSent(uint32_t can_id);

#ifdef __cplusplus
}
#endif

#endif /* VEHICLE_SIM_H */
