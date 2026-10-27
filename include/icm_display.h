/*
 * icm_display.h - o quadro que a Task_Display monta a cada 50 ms.
 *
 * É o "estado do painel": posição dos ponteiros, luzes acesas, texto do
 * mostrador de mensagens e odômetro. Quem desenha (o terminal na simulação,
 * ou o driver do display na placa) só copia isso pra tela, não decide nada.
 */
#ifndef ICM_DISPLAY_H
#define ICM_DISPLAY_H

#include <stdint.h>
#include <stdbool.h>
#include "icm_data.h"

#ifdef __cplusplus
extern "C" {
#endif

#define ICM_BULB_CHECK_MS   1500u   /* ao ligar, acende tudo por 1,5 s */
#define ICM_NEEDLE_STEP_KMH (250.0f / 16.0f)   /* ponteiro: escala toda em ~0,8 s */
#define ICM_NEEDLE_STEP_RPM (8000.0f / 10.0f)  /* conta-giros: ~0,5 s */

typedef struct {
    uint32_t frame_no;          /* quantos quadros já foram montados */
    uint32_t time_ms;           /* quando este quadro foi montado */

    float needle_speed_kmh;     /* ponteiros com velocidade limitada (motor de passo) */
    float needle_rpm;
    float fuel_percent;         /* < 0 = sensor com falha (ponteiro abaixo do E) */
    float coolant_celsius;      /* < 0 = sensor com falha */

    bool lamp_turn_left, lamp_turn_right;
    bool lamp_mil, lamp_can, lamp_temp, lamp_fuel;
    bool lamp_brake, lamp_belt, lamp_oil, lamp_battery;

    char gear[6];               /* "P", "N", "D1"... */
    char speed_text[6];         /* número no LCD, ou "---" sem M2 */
    char message[28];           /* mensagem do mostrador */
    bool message_warn;          /* mensagem de alerta (cor diferente) */

    double odometer_km;
    double trip_km;

    uint32_t m1_age_ms;         /* frescor: idade do último M1 */
    uint32_t m2_age_ms;         /* frescor: idade do último M2 */
} ICM_DisplayFrame_t;

/* monta o próximo quadro a partir de uma cópia do ICM_Data.
 * 'prev' é o quadro anterior (pra limitar a velocidade dos ponteiros), pode ser NULL. */
void ICM_BuildDisplayFrame(const ICM_Data_t *d, const ICM_DisplayFrame_t *prev,
                           ICM_DisplayFrame_t *out, uint32_t now_ms);

/* uma linha de texto com o painel (simulação no terminal) */
void ICM_FormatDisplayLine(const ICM_DisplayFrame_t *f, char *buf, unsigned size);

#ifdef __cplusplus
}
#endif

#endif /* ICM_DISPLAY_H */
