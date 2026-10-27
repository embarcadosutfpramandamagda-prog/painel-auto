/*
 * icm_tasks.h - o que o src/tasks.c expõe pra simulação e pros testes.
 */
#ifndef ICM_TASKS_H
#define ICM_TASKS_H

#include <stdint.h>
#include "icm_display.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t isr_can, can_rx, frames_decoded;
    uint32_t acquisition, processing, display, diagnostics, logging;
} ICM_TaskCounters_t;

void ICM_TasksInit(int verbose);
uint32_t ICM_NowMs(void);
void ICM_SetNowMs(uint32_t ms);
const ICM_DisplayFrame_t *ICM_LastFrame(void);
const ICM_TaskCounters_t *ICM_Counters(void);

#ifdef __cplusplus
}
#endif

#endif /* ICM_TASKS_H */
