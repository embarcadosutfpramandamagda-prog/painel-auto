/*
 * osek_sil.h - núcleo OSEK/VDX simulado, pra rodar o src/tasks.c no PC (SIL).
 *
 * Imita o que o Trampoline faz com a configuração do oil/icm.oil:
 *   - SystemCounter de 1 ms e alarmes que ativam as tarefas periódicas;
 *   - escalonamento preemptivo por prioridade (SCHEDULE = FULL);
 *   - tarefa estendida com WaitEvent/SetEvent/ClearEvent;
 *   - ISR de categoria 2 acima de todas as tarefas;
 *   - ICM_Resource com priority ceiling (OSEK PCP);
 *   - ACTIVATION = 1: ativar uma tarefa que ainda não terminou é erro (E_OS_LIMIT).
 *
 * Diferença pro sistema de verdade: o corpo da tarefa roda inteiro quando ela
 * começa (os dados mudam nesse instante) e o tempo de CPU dela é um custo
 * configurado (WCET estimado, em sim/icm_sil_cfg.c). O escalonamento, as
 * preempções e os bloqueios por recurso são simulados em cima desse custo,
 * em microssegundos. É o suficiente pra conferir períodos, prazos, latência e
 * a ordem das tarefas, que é o que a análise de tempo real pede.
 */
#ifndef OSEK_SIL_H
#define OSEK_SIL_H

#include <stdint.h>
#include <stdbool.h>
#include "osek_sil_cfg.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef uint8_t StatusType;
typedef int TaskType;
typedef uint32_t EventMaskType;
typedef int ResourceType;

#define E_OK          0
#define E_OS_ACCESS   1
#define E_OS_LIMIT    4
#define E_OS_NOFUNC   5
#define E_OS_RESOURCE 6
#define E_OS_STATE    7

/* corpo das tarefas e ISRs (mesmo nome que o Trampoline gera) */
#define TASK(name) void name##_function(void)
#define ISR(name)  void name##_function(void)
#define DeclareTask(t)
#define DeclareEvent(e)
#define DeclareResource(r)

StatusType SIL_ActivateTask(TaskType t);
StatusType SIL_SetEvent(TaskType t, EventMaskType m);
StatusType SIL_ClearEvent(EventMaskType m);
bool       SIL_MustWait(EventMaskType m);     /* true = evento não chegou: a tarefa vai pra WAITING */
StatusType SIL_GetResource(ResourceType r);
StatusType SIL_ReleaseResource(ResourceType r);
void       SIL_TerminateTask(void);

#define ActivateTask(t)      SIL_ActivateTask(t)
#define SetEvent(t, m)       SIL_SetEvent((t), (m))
#define ClearEvent(m)        SIL_ClearEvent(m)
#define GetResource(r)       SIL_GetResource(r)
#define ReleaseResource(r)   SIL_ReleaseResource(r)
/* WaitEvent: se o evento não chegou, a tarefa sai da CPU (WAITING) e volta a
 * executar daqui quando o SetEvent chegar. No SIL isso é "sair da função":
 * na próxima vez ela começa de novo no WaitEvent, que agora passa. */
#define WaitEvent(m)         do { if (SIL_MustWait(m)) return; } while (0)
#define TerminateTask()      do { SIL_TerminateTask(); return; } while (0)

/* --- configuração (gerada a partir do .oil por tools/oil2sil.py) --- */
typedef enum { SIL_SUSPENDED = 0, SIL_READY, SIL_RUNNING, SIL_WAITING } SIL_State_t;

typedef struct {
    const char *name;
    int priority;          /* do .oil; ISR fica acima de todas as tarefas */
    bool is_isr;
    bool extended;         /* tem EVENT: pode ficar WAITING */
    bool autostart;
    bool uses_resource;
    uint32_t period_ms;    /* do ALARM (0 = disparada por evento ou interrupção) */
    uint32_t offset_ms;    /* ALARMTIME */
    uint32_t cost_us;      /* tempo de CPU estimado (WCET) */
    uint32_t cs_us;        /* desse tempo, quanto é dentro do ICM_Resource */
    void (*body)(void);
} SIL_ProcCfg_t;

extern const SIL_ProcCfg_t SIL_PROCS[SIL_PROC_COUNT];
extern const int SIL_RESOURCE_CEILING;

/* --- resultado da simulação --- */
typedef struct {
    uint32_t t_us;
    uint8_t proc;
    uint8_t state;         /* SIL_State_t */
} SIL_TraceEvent_t;

typedef struct {
    uint8_t proc;
    uint32_t release_us, start_us, finish_us;
    uint32_t blocked_us;   /* tempo esperando uma tarefa de prioridade menor sair do recurso */
    uint16_t preemptions;
} SIL_Job_t;

typedef struct {
    uint32_t releases, jobs, missed, lost_activations, preemptions;
    uint32_t min_resp_us, max_resp_us, max_blocked_us;
    uint64_t sum_resp_us;
    uint32_t min_period_us, max_period_us;   /* intervalo medido entre ativações */
    uint32_t last_release_us;
    uint32_t max_start_jitter_us;            /* atraso entre a ativação e o começo */
    uint64_t busy_us;
} SIL_Stats_t;

typedef struct {
    uint32_t duration_ms;
    double cost_scale;     /* 1.0 = custos nominais; maior pra forçar sobrecarga */
    bool record_trace;
    uint32_t trace_window_ms;   /* só grava os estados até aqui (o SVG usa o primeiro segundo) */
    void (*on_tick)(uint32_t now_ms);   /* chamado no começo de cada ms (lado do "hardware") */
    bool (*hw_irq)(uint32_t now_ms);    /* true = controlador CAN pediu interrupção neste ms */
} SIL_Config_t;

typedef struct {
    SIL_Stats_t stats[SIL_PROC_COUNT];
    SIL_TraceEvent_t *trace; uint32_t trace_len, trace_cap;
    SIL_Job_t *jobs; uint32_t jobs_len, jobs_cap;
    uint64_t idle_us, total_us;
    uint32_t resource_violations;    /* alguém rodou com prioridade <= teto enquanto o recurso estava preso */
    uint32_t api_errors;             /* GetResource sem Release, Release sem Get... */
    uint32_t max_resource_holders;   /* deve ser 1 */
    uint64_t trace_hash;             /* FNV do trace inteiro (determinismo) */
} SIL_Result_t;

void SIL_Run(const SIL_Config_t *cfg, SIL_Result_t *res);
void SIL_FreeResult(SIL_Result_t *res);
const char *SIL_StateName(int s);
uint32_t SIL_NowUs(void);

#ifdef __cplusplus
}
#endif

#endif /* OSEK_SIL_H */
