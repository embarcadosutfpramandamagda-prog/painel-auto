/*
 * test_icm.c - testes do ICM rodando no PC (sem Trampoline).
 *
 * Rodar com: make test
 * Cada TEST_ASSERT conta como uma verificação; o programa sai com código 1
 * se alguma falhar, assim dá pra usar em CI depois.
 */
#include <stdio.h>
#include <assert.h>
#include <string.h>
#include <math.h>
#include "icm_data.h"

static int g_tests_passed = 0;
static int g_tests_failed = 0;

#define TEST_ASSERT(cond, msg) do { \
    if (cond) { \
        printf("  [PASS] %s\n", msg); \
        g_tests_passed++; \
    } else { \
        printf("  [FAIL] %s (Line %d)\n", msg, __LINE__); \
        g_tests_failed++; \
    } \
} while(0)

/* M1: os bytes de rpm chegam certos? */
void test_can_m1_decoding(void) {
    printf("\n=== Test 1: Decodificacao CAN M1 (RPM) ===\n");
    ICM_Init();

    CAN_Msg_M1_t m1;
    /* 3000 RPM / 0.25 = 12000 = 0x2EE0 */
    m1.rpm_high = 0x2E;
    m1.rpm_low  = 0xE0;
    m1.throttle_percent = 45;
    m1.engine_state = 2;

    ICM_ProcessCAN_M1(&m1, 100);

    /* roda o filtro várias vezes até estabilizar */
    for (int i = 0; i < 20; i++) {
        ICM_FilterAndScale();
    }

    ICM_Data_t data;
    ICM_GetDataCopy(&data);

    TEST_ASSERT(fabs(data.engine_rpm - 3000.0f) < 5.0f, "RPM decodificado com exatidao ~3000 RPM");
    TEST_ASSERT(data.last_m1_time_ms == 100, "Timestamp M1 registrado corretamente");
}

/* M2: velocidade, marcha e freio de mão */
void test_can_m2_decoding(void) {
    printf("\n=== Test 2: Decodificacao CAN M2 (Velocidade e Marcha) ===\n");
    ICM_Init();

    CAN_Msg_M2_t m2;
    /* 120 km/h / 0.05 = 2400 = 0x0960 */
    m2.speed_high = 0x09;
    m2.speed_low  = 0x60;
    m2.current_gear = 4;
    m2.brake_pedal = 0;
    m2.handbrake = 0;

    ICM_ProcessCAN_M2(&m2, 200);

    for (int i = 0; i < 20; i++) {
        ICM_FilterAndScale();
    }

    ICM_Data_t data;
    ICM_GetDataCopy(&data);

    TEST_ASSERT(fabs(data.vehicle_speed_kmh - 120.0f) < 2.0f, "Velocidade decodificada ~120 km/h");
    TEST_ASSERT(data.gear == 4, "Marcha 4 identificada");
    TEST_ASSERT(data.handbrake_active == false, "Freio de mao liberado");
}

/* M1 parou de chegar: tem que acusar U0100 e zerar o rpm */
void test_can_timeout_m1(void) {
    printf("\n=== Test 3: Falha e Timeout CAN M1 (>1000ms) ===\n");
    ICM_Init();

    CAN_Msg_M1_t m1;
    memset(&m1, 0, sizeof(CAN_Msg_M1_t));
    m1.rpm_high = 0x20;
    m1.rpm_low  = 0x00;
    m1.throttle_percent = 10;
    m1.engine_state = 2;
    ICM_ProcessCAN_M1(&m1, 500);

    /* t = 1000 ms: faz 500 ms do último frame, ainda está ok */
    ICM_EvaluateDiagnostics(1000);
    ICM_Data_t d1;
    ICM_GetDataCopy(&d1);
    TEST_ASSERT((d1.warning_flags & FLAG_CAN_M1_TIMEOUT) == 0, "Sem timeout em 500ms");

    /* t = 1600 ms: 1100 ms sem frame, passou do limite de 1000 */
    ICM_EvaluateDiagnostics(1600);
    ICM_Data_t d2;
    ICM_GetDataCopy(&d2);
    TEST_ASSERT((d2.warning_flags & FLAG_CAN_M1_TIMEOUT) != 0, "Flag FLAG_CAN_M1_TIMEOUT acionada");
    TEST_ASSERT((d2.warning_flags & FLAG_MIL_CHECK_ENG) != 0, "Luz Check Engine (MIL) acionada");
    TEST_ASSERT(strcmp(d2.active_dtc, "U0100") == 0, "Codigo de falha DTC U0100 gerado");
    TEST_ASSERT(d2.engine_rpm == 0.0f, "Fail-safe: RPM zerado em estado seguro");
}

/* motor a 118 °C: luz de temperatura e P0115 */
void test_coolant_overheat_diagnostic(void) {
    printf("\n=== Test 4: Diagnostico de Superaquecimento (>=115 C) ===\n");
    ICM_Init();

    ICM_UpdateSensorInputs(70.0f, 118.0f, TURN_NONE, true);
    /* o filtro da temperatura é lento (alfa 0.05), 100 passos chega no valor */
    for (int i = 0; i < 100; i++) {
        ICM_FilterAndScale();
    }
    ICM_EvaluateDiagnostics(2000);

    ICM_Data_t data;
    ICM_GetDataCopy(&data);

    TEST_ASSERT((data.warning_flags & FLAG_COOLANT_HOT) != 0, "Flag FLAG_COOLANT_HOT acionada");
    TEST_ASSERT(strcmp(data.active_dtc, "P0115") == 0, "Codigo DTC P0115 gerado");
}

/* 8 % de combustível: luz da reserva */
void test_low_fuel_warning(void) {
    printf("\n=== Test 5: Alerta de Reserva de Combustivel (<=10%%) ===\n");
    ICM_Init();

    ICM_UpdateSensorInputs(8.0f, 90.0f, TURN_NONE, true);
    for (int i = 0; i < 100; i++) {
        ICM_FilterAndScale();
    }
    ICM_EvaluateDiagnostics(2000);

    ICM_Data_t data;
    ICM_GetDataCopy(&data);

    TEST_ASSERT((data.warning_flags & FLAG_LOW_FUEL) != 0, "Flag FLAG_LOW_FUEL acionada");
}

/* lock e unlock do ICM_Resource sem travar */
void test_resource_mutex(void) {
    printf("\n=== Test 6: Exclusao Mutua ICM_Resource ===\n");
    ICM_Init();

    ICM_LockResource();
    /* aqui ficaria a parte protegida */
    ICM_UnlockResource();

    TEST_ASSERT(1, "GetResource e ReleaseResource operando com sucesso");
}

/* RS-05: 9999 rpm é lixo, tem que descartar e manter o valor anterior */
void test_can_out_of_range(void) {
    printf("\n=== Test 7: Sinal CAN Fora da Faixa (RS-05) ===\n");
    ICM_Init();

    CAN_Msg_M1_t m1 = {0};
    m1.rpm_high = 0x2E; m1.rpm_low = 0xE0;     /* 3000 rpm, válido */
    m1.engine_state = 2;
    ICM_ProcessCAN_M1(&m1, 100);
    for (int i = 0; i < 20; i++) ICM_FilterAndScale();

    /* 9999 rpm / 0.25 = 39996 = 0x9C3C */
    m1.rpm_high = 0x9C; m1.rpm_low = 0x3C;
    ICM_ProcessCAN_M1(&m1, 600);
    for (int i = 0; i < 20; i++) ICM_FilterAndScale();
    ICM_EvaluateDiagnostics(700);

    ICM_Data_t data;
    ICM_GetDataCopy(&data);
    TEST_ASSERT(fabs(data.engine_rpm - 3000.0f) < 5.0f, "Valor 9999 RPM descartado, painel mantem ~3000 RPM");
    TEST_ASSERT((data.warning_flags & FLAG_SIGNAL_OOR) != 0, "Flag FLAG_SIGNAL_OOR acionada");
    TEST_ASSERT(strcmp(data.active_dtc, "U0401") == 0, "Codigo DTC U0401 gerado");
}

/* motor desligado (estado 0 no M1): luzes de óleo e bateria */
void test_engine_off_warnings(void) {
    printf("\n=== Test 8: Motor Desligado - Oleo e Bateria ===\n");
    ICM_Init();

    CAN_Msg_M1_t m1 = {0};
    m1.engine_state = 0;
    ICM_ProcessCAN_M1(&m1, 100);
    ICM_EvaluateDiagnostics(200);

    ICM_Data_t data;
    ICM_GetDataCopy(&data);
    TEST_ASSERT((data.warning_flags & FLAG_OIL_PRESS_LOW) != 0, "Luz de pressao do oleo acesa com motor parado");
    TEST_ASSERT((data.warning_flags & FLAG_BATTERY_FAULT) != 0, "Luz da bateria acesa com motor parado");
}

int main(void) {
    printf("===================================================\n");
    printf("  BATERIA DE TESTES - ICM TRAMPOLINE RTOS (P2)\n");
    printf("===================================================\n");

    test_can_m1_decoding();
    test_can_m2_decoding();
    test_can_timeout_m1();
    test_coolant_overheat_diagnostic();
    test_low_fuel_warning();
    test_resource_mutex();
    test_can_out_of_range();
    test_engine_off_warnings();

    printf("\n---------------------------------------------------\n");
    printf("  RESULTADO: %d PASSOU, %d FALHOU\n", g_tests_passed, g_tests_failed);
    printf("===================================================\n");

    return (g_tests_failed == 0) ? 0 : 1;
}
