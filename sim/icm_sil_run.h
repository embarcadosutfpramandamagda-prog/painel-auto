/*
 * icm_sil_run.h - uma execução completa do ICM no SIL, com as verificações
 * do slide do Projeto 2 (períodos, prazos, frescor, timeout do CAN, recurso,
 * atualização determinística do painel). Usado pelo icm_sil e pelos testes.
 */
#ifndef ICM_SIL_RUN_H
#define ICM_SIL_RUN_H

#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include "osek_sil.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t seconds;        /* duração simulada */
    double cost_scale;       /* 1.0 = WCET nominal */
    int verbose;             /* 1 = painel no terminal, 2 = + telemetria */
    int scenario;            /* 1 = roteiro de falhas, 0 = carro andando sem falha */
    uint32_t trace_window_ms;
} ICM_SilOptions_t;

typedef struct {
    const char *name;        /* nome do item no slide */
    bool ok;
    char detail[160];
} ICM_SilCheck_t;

typedef struct {
    const char *what;        /* falha injetada */
    const char *expect;      /* reação esperada */
    uint32_t injected_ms, detected_ms, limit_ms;   /* detected_ms = 0: não detectou */
    bool ok;
} ICM_SilFault_t;

typedef struct {
    double R_us;             /* tempo de resposta no pior caso (análise) */
    double B_us;             /* bloqueio pelo recurso */
    double U;                /* utilização C/T */
    uint32_t T_us;           /* período ou intervalo mínimo */
} ICM_SilRta_t;

#define ICM_SIL_MAX_CHECKS 16
#define ICM_SIL_MAX_FAULTS 12

typedef struct {
    ICM_SilOptions_t opt;
    SIL_Result_t res;
    ICM_SilRta_t rta[SIL_PROC_COUNT];
    double U_total;
    ICM_SilCheck_t checks[ICM_SIL_MAX_CHECKS]; int n_checks, checks_failed;
    ICM_SilFault_t faults[ICM_SIL_MAX_FAULTS]; int n_faults;
    uint32_t frames_display, display_interval_min, display_interval_max;
    uint32_t max_m1_age_ok_ms, max_m2_age_ok_ms;   /* frescor nos trechos sem falha de CAN */
    uint32_t can_latency_max_us;                   /* frame no barramento -> decodificado */
    uint32_t m1_sent, m2_sent, m1_decoded, m2_decoded, rejected;
    /* amostras a cada 50 ms pro site (velocidade, rpm, flags) */
    uint32_t n_samples;
    float *s_speed, *s_rpm, *s_fuel, *s_temp; uint16_t *s_flags;
} ICM_SilRun_t;

void ICM_SilDefaultOptions(ICM_SilOptions_t *o);
void ICM_SilRun(const ICM_SilOptions_t *o, ICM_SilRun_t *run);
void ICM_SilPrintSummary(const ICM_SilRun_t *run, FILE *f);
void ICM_SilWriteReports(const ICM_SilRun_t *run, const char *dir);
void ICM_SilFree(ICM_SilRun_t *run);

#ifdef __cplusplus
}
#endif

#endif /* ICM_SIL_RUN_H */
