/*
 * can_types.h - mensagens CAN que o painel recebe.
 *
 * Os IDs, períodos e o layout dos bytes estão descritos no
 * docs/DICIONARIO_SINAIS.md. Se mudar alguma coisa aqui, atualizar lá
 * (e no web/js/jogo.js, que simula o mesmo barramento).
 */
#ifndef CAN_TYPES_H
#define CAN_TYPES_H

#include <stdint.h>
#include <stdbool.h>

#define CAN_ID_M1_ENGINE  0x100  /* M1: rotação do motor, enviada pelo ECM */
#define CAN_ID_M2_VEHICLE 0x101  /* M2: velocidade e marcha, enviada pelo TCM */

#define CAN_M1_PERIOD_MS  500
#define CAN_M2_PERIOD_MS  1000

/* timeout = 2x o período: perder um frame só não acusa falha */
#define CAN_M1_TIMEOUT_MS 1000
#define CAN_M2_TIMEOUT_MS 2000

/* M1 (0x100) - 8 bytes */
typedef struct {
    uint8_t rpm_high;          /* rpm em unidades de 0.25 (byte alto) */
    uint8_t rpm_low;
    uint8_t throttle_percent;  /* acelerador, 0 a 100 % */
    uint8_t engine_state;      /* 0 desligado, 1 partida, 2 funcionando, 3 sobregiro */
    uint8_t reserved[4];
} CAN_Msg_M1_t;

/* M2 (0x101) - 8 bytes */
typedef struct {
    uint8_t speed_high;        /* velocidade em unidades de 0.05 km/h (byte alto) */
    uint8_t speed_low;
    int8_t  current_gear;      /* -1 ré, 0 neutro, 1 a 6 */
    uint8_t brake_pedal;       /* 1 = pisando no freio */
    uint8_t handbrake;         /* 1 = freio de mão puxado */
    uint8_t reserved[3];
} CAN_Msg_M2_t;

/* frame genérico, do jeito que sai do controlador CAN */
typedef struct {
    uint32_t id;
    uint8_t  dlc;
    uint8_t  data[8];
    uint32_t timestamp_ms;
} CAN_Frame_t;

#endif /* CAN_TYPES_H */
